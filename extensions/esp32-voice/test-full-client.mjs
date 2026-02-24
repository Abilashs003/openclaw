/**
 * Full ESP32 Voice Plugin Test Client
 *
 * Simulates an ESP32 device by:
 *   1. Connecting to the voice WebSocket server (ws://localhost:8765)
 *   2. Sending a hello handshake (same as ESP32 firmware)
 *   3. Capturing your PC mic via ffmpeg → 16kHz PCM
 *   4. Opus-encoding each 60ms frame and sending as binary WS frames
 *   5. Receiving and displaying server responses (transcripts, TTS audio)
 *
 * This tests the FULL pipeline: Mic → Opus → VAD → STT → LLM → TTS → Speaker
 *
 * Requirements:
 *   - ffmpeg installed (choco install ffmpeg)
 *   - OpenClaw gateway running (node dist/entry.js gateway)
 *   - npm install (in esp32-voice dir for opusscript, ws)
 *
 * Usage:
 *   node test-full-client.mjs
 *   node test-full-client.mjs --mic "Microphone Array (Realtek(R) Audio)"
 *   node test-full-client.mjs --port 8765
 *   node test-full-client.mjs --no-playback
 *
 * Then speak into your mic. You should see:
 *   - Speech detection (from Silero VAD)
 *   - Live transcription (from Deepgram)
 *   - LLM response text
 *   - TTS audio frames coming back
 *
 * Press Ctrl+C to stop.
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";

// ── Parse CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const WS_PORT = getArg("port") || "8765";
const WS_URL = `ws://127.0.0.1:${WS_PORT}/`;
const MIC_DEVICE = getArg("mic") || "External Microphone (Realtek(R) Audio)";
const ENABLE_PLAYBACK = !hasFlag("no-playback");
const DEVICE_ID = getArg("device-id") || "test-pc-client";

// ── Audio constants (must match voice-session.ts) ───────────────
const INPUT_SAMPLE_RATE = 16000;
const INPUT_CHANNELS = 1;
const INPUT_FRAME_MS = 60;
const INPUT_SAMPLES_PER_FRAME = (INPUT_SAMPLE_RATE * INPUT_FRAME_MS) / 1000; // 960
const INPUT_FRAME_BYTES = INPUT_SAMPLES_PER_FRAME * 2; // 1920 bytes (16-bit PCM)

const OUTPUT_SAMPLE_RATE = 24000;
const OUTPUT_FRAME_MS = 60;
const OUTPUT_SAMPLES_PER_FRAME = (OUTPUT_SAMPLE_RATE * OUTPUT_FRAME_MS) / 1000; // 1440

// ── State ──────────────────────────────────────────────────────
let ws = null;
let micProcess = null;
let playbackProcess = null;
let opusEncoder = null;
let opusDecoder = null;
let connected = false;
let sessionId = null;
let framesSent = 0;
let framesReceived = 0;
let pcmAccumulator = Buffer.alloc(0);
const startTime = Date.now();

function elapsed() {
  return ((Date.now() - startTime) / 1000).toFixed(1);
}

function log(tag, msg) {
  const ts = elapsed();
  console.log(`[${ts}s] [${tag}] ${msg}`);
}

// ── Load Opus codec ────────────────────────────────────────────
log("init", "Loading opusscript...");
const OpusScript = (await import("opusscript")).default;
opusEncoder = new OpusScript(INPUT_SAMPLE_RATE, INPUT_CHANNELS, OpusScript.Application.VOIP);
opusDecoder = new OpusScript(OUTPUT_SAMPLE_RATE, INPUT_CHANNELS, OpusScript.Application.VOIP);
log("init", "Opus codec ready");

// ── Start playback process (ffplay for received TTS audio) ─────
if (ENABLE_PLAYBACK) {
  try {
    playbackProcess = spawn("ffplay", [
      "-f", "s16le",
      "-ar", String(OUTPUT_SAMPLE_RATE),
      "-ac", "1",
      "-nodisp",
      "-autoexit",
      "-loglevel", "quiet",
      "-i", "pipe:0"
    ], { stdio: ["pipe", "ignore", "ignore"] });

    playbackProcess.on("error", () => {
      log("playback", "ffplay not found — TTS audio won't be played back");
      playbackProcess = null;
    });

    playbackProcess.on("close", () => {
      playbackProcess = null;
    });

    log("playback", "ffplay started for TTS audio output");
  } catch {
    log("playback", "Could not start ffplay — install ffmpeg for audio playback");
  }
}

// ── Connect to voice server ────────────────────────────────────
log("ws", `Connecting to ${WS_URL}...`);

ws = new WebSocket(WS_URL);

ws.on("open", () => {
  log("ws", "Connected! Sending hello...");

  // Send ESP32-style hello handshake
  const hello = {
    type: "hello",
    deviceId: DEVICE_ID,
    transport: "websocket",
    version: 1,
    audio_params: {
      format: "opus",
      sample_rate: INPUT_SAMPLE_RATE,
      channels: INPUT_CHANNELS,
    },
  };

  ws.send(JSON.stringify(hello));
  log("ws", `Hello sent: ${JSON.stringify(hello)}`);
});

ws.on("message", (data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  // Try to detect JSON (starts with '{') — server sends JSON as text or binary
  if (buf.length > 0 && buf[0] === 0x7b) {
    try {
      const msg = JSON.parse(buf.toString("utf8"));
      handleServerMessage(msg);
      return;
    } catch {
      // Not valid JSON — fall through to binary handling
    }
  }

  // Binary = TTS audio (Opus-encoded from server)
  framesReceived++;

  // Decode Opus → PCM and pipe to ffplay
  if (playbackProcess?.stdin?.writable && opusDecoder) {
    try {
      const pcm = opusDecoder.decode(buf, OUTPUT_SAMPLES_PER_FRAME);
      playbackProcess.stdin.write(pcm);
    } catch {
      // Decode error — skip frame
    }
  }

  // Log every 10th frame to avoid spam
  if (framesReceived % 10 === 1) {
    log("tts-audio", `Received ${framesReceived} Opus frames (${buf.length} bytes each)`);
  }
});

ws.on("close", (code, reason) => {
  log("ws", `Disconnected (code: ${code}, reason: ${reason})`);
  connected = false;
  cleanup();
});

ws.on("error", (err) => {
  log("ws", `Error: ${err.message}`);
  cleanup();
  process.exit(1);
});

// ── Handle server JSON messages ────────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case "hello":
      sessionId = msg.session_id;
      connected = true;
      log("server", `Hello received! Session: ${sessionId}`);
      log("server", `Audio params: ${JSON.stringify(msg.audio_params)}`);
      log("info", "");
      log("info", "===========================================");
      log("info", "  SPEAK INTO YOUR MIC NOW!");
      log("info", "  The full pipeline is active:");
      log("info", "  Mic → Opus → VAD → STT → LLM → TTS");
      log("info", "  Press Ctrl+C to stop.");
      log("info", "===========================================");
      log("info", "");

      // Start mic capture after handshake
      startMicCapture();
      break;

    case "paired":
      log("server", `Device paired! Token: ${msg.deviceToken?.slice(0, 8)}...`);
      break;

    case "transcript":
      if (msg.partial) {
        process.stdout.write(`\r[${elapsed()}s] [stt] Partial: ${msg.text}                    `);
      } else {
        console.log(`\n[${elapsed()}s] [stt] FINAL: "${msg.text}"`);
      }
      break;

    case "stt":
      console.log(`[${elapsed()}s] [stt] Transcript: "${msg.text}"`);
      break;

    case "status":
      log("status", `Stage: ${msg.stage}`);
      break;

    case "tts":
      if (msg.state === "start") {
        log("tts", "TTS streaming started — listen for audio...");
        framesReceived = 0;
      } else if (msg.state === "stop") {
        log("tts", `TTS complete (${framesReceived} frames received)`);
        log("info", "\n  Ready for next utterance — speak again!\n");
      } else if (msg.state === "sentence_start") {
        log("tts", `Speaking: "${msg.text}"`);
      }
      break;

    case "response_text":
      log("llm", `Response: "${msg.text?.slice(0, 200)}"`);
      break;

    case "error":
      log("ERROR", `Server error: ${msg.message}`);
      break;

    default:
      log("server", `${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`);
  }
}

// ── Start mic capture via ffmpeg ───────────────────────────────
function startMicCapture() {
  log("mic", `Starting capture: "${MIC_DEVICE}"`);
  log("mic", `Format: ${INPUT_SAMPLE_RATE}Hz, ${INPUT_CHANNELS}ch, 16-bit PCM`);

  micProcess = spawn("ffmpeg", [
    "-f", "dshow",
    "-i", `audio=${MIC_DEVICE}`,
    "-ar", String(INPUT_SAMPLE_RATE),
    "-ac", String(INPUT_CHANNELS),
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  micProcess.on("error", (err) => {
    log("mic", `Failed to start ffmpeg: ${err.message}`);
    log("mic", "Install ffmpeg: choco install ffmpeg");
    process.exit(1);
  });

  micProcess.stderr.on("data", () => {
    // Suppress ffmpeg stderr (progress info)
  });

  micProcess.stdout.on("data", (chunk) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;

    // Accumulate PCM data
    pcmAccumulator = Buffer.concat([pcmAccumulator, chunk]);

    // Process complete 60ms frames
    while (pcmAccumulator.length >= INPUT_FRAME_BYTES) {
      const frame = pcmAccumulator.subarray(0, INPUT_FRAME_BYTES);
      pcmAccumulator = pcmAccumulator.subarray(INPUT_FRAME_BYTES);

      // Opus encode (same as ESP32 firmware would do)
      try {
        const opusData = opusEncoder.encode(frame, INPUT_SAMPLES_PER_FRAME);
        ws.send(opusData);
        framesSent++;

        // Log periodically
        if (framesSent % 50 === 1) {
          log("mic", `Sent ${framesSent} Opus frames (${opusData.length} bytes/frame)`);
        }
      } catch {
        // Encode error — skip frame
      }
    }
  });

  micProcess.on("close", (code) => {
    log("mic", `ffmpeg exited (code: ${code})`);
  });
}

// ── Cleanup ────────────────────────────────────────────────────
function cleanup() {
  if (micProcess) {
    micProcess.kill();
    micProcess = null;
  }
  if (playbackProcess) {
    try { playbackProcess.stdin.end(); } catch {}
    playbackProcess.kill();
    playbackProcess = null;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
}

process.on("SIGINT", () => {
  console.log("\n\nStopping...");
  cleanup();
  console.log(`\nSent ${framesSent} audio frames, received ${framesReceived} TTS frames.`);
  process.exit(0);
});

// Keep alive
setInterval(() => {}, 60000);
