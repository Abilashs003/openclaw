/**
 * Live Microphone → Silero VAD Test
 *
 * Records from your PC mic, Opus encodes → decodes (simulating ESP32),
 * and feeds into Silero VAD to detect speech start/end in real-time.
 *
 * No OpenClaw, no gateway, no ESP32 needed — just your mic.
 *
 * Requirements:
 *   npm install node-record-lpcm16  (for mic capture)
 *
 * Run: node test-vad-mic.mjs
 * Then speak into your mic. You should see speech start/end events.
 * Press Ctrl+C to stop.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import * as ort from "onnxruntime-node";

const thisDir = dirname(fileURLToPath(import.meta.url));
const modelPath = join(thisDir, "models", "silero_vad.onnx");

// ── Audio Constants ───────────────────────────────────────────
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_MS = 60;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 960
const FRAME_BYTES = SAMPLES_PER_FRAME * 2; // 1920 bytes (16-bit)

// ── VAD Constants ─────────────────────────────────────────────
const WINDOW_SIZE = 512;
const STATE_SIZE = 128;
const SPEECH_THRESHOLD = 0.5;
const SILENCE_DURATION_MS = 600;
const MIN_SPEECH_DURATION_MS = 250;

// ── Silero VAD state ──────────────────────────────────────────
let vadState = new Float32Array(2 * 1 * STATE_SIZE);
let vadBuffer = new Float32Array(0);
let isSpeaking = false;
let speechStartedAt = 0;
let lastSpeechAt = 0;
let speechCount = 0;

function int16ToFloat32(pcm) {
  const float = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 32768.0;
  return float;
}

// ── Main ──────────────────────────────────────────────────────

console.log("=== Live Mic → Silero VAD Test ===\n");

// 1. Load model
console.log("[1] Loading Silero VAD model...");
const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
});
console.log("[1] Model loaded\n");

// 2. Load opus
console.log("[2] Loading opusscript...");
const OpusScript = (await import("opusscript")).default;
const opusEncoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
const opusDecoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
console.log("[2] Opus ready\n");

// 3. Start mic recording using SoX (sox/rec command)
//    Works on Windows (if SoX installed), macOS, Linux
//    Alternative: use ffmpeg or arecord
console.log("[3] Starting microphone capture...");
console.log("    Trying: sox, arecord, ffmpeg (whichever is available)\n");

let micProcess = null;
let pcmAccumulator = Buffer.alloc(0);
const startTime = Date.now();

// Try different recording tools
function startRecording() {
  // Try SoX first (cross-platform)
  try {
    // Windows: sox should work if installed
    // macOS/Linux: rec command (part of sox)
    const isWin = process.platform === "win32";

    if (isWin) {
      // Try ffmpeg on Windows (most commonly available)
      micProcess = spawn("ffmpeg", [
        "-f", "dshow",
        "-i", "audio=External Microphone (Realtek(R) Audio)",
        "-ar", String(SAMPLE_RATE),
        "-ac", String(CHANNELS),
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "pipe:1"
      ], { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      // macOS/Linux: use sox's rec command
      micProcess = spawn("rec", [
        "-q",           // quiet
        "-r", String(SAMPLE_RATE),
        "-c", String(CHANNELS),
        "-b", "16",     // 16-bit
        "-e", "signed-integer",
        "-t", "raw",    // raw PCM output
        "-"             // stdout
      ], { stdio: ["ignore", "pipe", "pipe"] });
    }

    micProcess.on("error", (err) => {
      console.error(`\n[MIC] Recording tool not found: ${err.message}`);
      console.error("[MIC] Install one of:");
      console.error("  Windows: choco install ffmpeg   or   choco install sox");
      console.error("  macOS:   brew install sox");
      console.error("  Linux:   apt install sox");
      console.error("\nAlternatively, use the ESP32 device to test with real audio.");
      process.exit(1);
    });

    micProcess.stderr.on("data", () => {
      // Suppress ffmpeg/sox stderr
    });

    return true;
  } catch {
    return false;
  }
}

startRecording();

if (!micProcess) {
  console.error("Could not start mic recording");
  process.exit(1);
}

console.log("===========================================");
console.log("  SPEAK INTO YOUR MIC NOW!");
console.log("  You should see speech start/end events.");
console.log("  Press Ctrl+C to stop.");
console.log("===========================================\n");

// Silence check interval
const silenceChecker = setInterval(() => {
  if (!isSpeaking) return;
  const now = Date.now();
  const silenceDuration = now - lastSpeechAt;
  const speechDuration = lastSpeechAt - speechStartedAt;

  if (silenceDuration >= SILENCE_DURATION_MS && speechDuration >= MIN_SPEECH_DURATION_MS) {
    isSpeaking = false;
    speechCount++;
    const elapsed = ((now - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] << SPEECH END (duration: ${speechDuration}ms, silence: ${silenceDuration}ms) [#${speechCount}]`);
    console.log(`          → This would trigger processUtterance()\n`);
  }
}, 100);

// Process mic audio
micProcess.stdout.on("data", async (chunk) => {
  // Accumulate PCM data
  pcmAccumulator = Buffer.concat([pcmAccumulator, chunk]);

  // Process complete frames
  while (pcmAccumulator.length >= FRAME_BYTES) {
    const frame = pcmAccumulator.subarray(0, FRAME_BYTES);
    pcmAccumulator = pcmAccumulator.subarray(FRAME_BYTES);

    // === Opus encode (simulates ESP32) ===
    let opusData;
    try {
      opusData = opusEncoder.encode(frame, SAMPLES_PER_FRAME);
    } catch { continue; }

    // === Opus decode (simulates server receiving) ===
    let decodedPCM;
    try {
      decodedPCM = opusDecoder.decode(Buffer.from(opusData), SAMPLES_PER_FRAME);
    } catch { continue; }

    // === Feed to VAD ===
    const int16 = new Int16Array(decodedPCM.buffer, decodedPCM.byteOffset, decodedPCM.byteLength / 2);
    const floatPCM = int16ToFloat32(int16);

    const newBuf = new Float32Array(vadBuffer.length + floatPCM.length);
    newBuf.set(vadBuffer);
    newBuf.set(floatPCM, vadBuffer.length);
    vadBuffer = newBuf;

    while (vadBuffer.length >= WINDOW_SIZE) {
      const window = vadBuffer.slice(0, WINDOW_SIZE);
      vadBuffer = vadBuffer.slice(WINDOW_SIZE);

      const feeds = {
        input: new ort.Tensor("float32", window, [1, WINDOW_SIZE]),
        state: new ort.Tensor("float32", vadState, [2, 1, STATE_SIZE]),
        sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
      };

      const result = await session.run(feeds);
      vadState = new Float32Array(result.stateN.data);
      const prob = result.output.data[0];

      const now = Date.now();
      const elapsed = ((now - startTime) / 1000).toFixed(1);

      if (prob >= SPEECH_THRESHOLD) {
        lastSpeechAt = now;
        if (!isSpeaking) {
          isSpeaking = true;
          speechStartedAt = now;
          console.log(`[${elapsed}s] >> SPEECH START (prob: ${prob.toFixed(3)})`);
        }
      }

      // Periodic probability display (every ~500ms)
      if (Math.random() < 0.05) {
        const bar = "█".repeat(Math.round(prob * 20)).padEnd(20, "░");
        process.stdout.write(`\r[${elapsed}s] [${bar}] ${prob.toFixed(3)} ${isSpeaking ? "SPEAKING" : "silence "}  `);
      }
    }
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  console.log("\n\nStopping...");
  clearInterval(silenceChecker);
  if (micProcess) micProcess.kill();
  await session.release();
  console.log(`\nDetected ${speechCount} speech utterance(s).`);
  process.exit(0);
});

micProcess.on("close", async () => {
  clearInterval(silenceChecker);
  await session.release();
  console.log(`\nMic closed. Detected ${speechCount} speech utterance(s).`);
});
