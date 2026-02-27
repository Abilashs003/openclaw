/**
 * Diagnostic test: Streams a real WAV file to Soniox and logs all messages.
 *
 * Usage: npx tsx extensions/esp32-voice/src/stt/soniox-wav-test.ts
 *
 * Requires: SONIOX_API_KEY in ~/.openclaw/.env or environment
 */

import fs from "fs";
import path from "path";
import WebSocket from "ws";
import dotenv from "dotenv";

// Load env from ~/.openclaw/.env
const envPath = path.join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw", ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const API_KEY = process.env.SONIOX_API_KEY;
if (!API_KEY) {
  console.error("SONIOX_API_KEY not set");
  process.exit(1);
}

const WAV_PATH = path.resolve("final.wav");
if (!fs.existsSync(WAV_PATH)) {
  console.error(`WAV file not found: ${WAV_PATH}`);
  process.exit(1);
}

const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

async function main() {
  console.log(`[test] Reading WAV file: ${WAV_PATH}`);
  const wavBuffer = fs.readFileSync(WAV_PATH);

  // Skip WAV header (44 bytes) to get raw PCM
  const pcmData = wavBuffer.subarray(44);
  console.log(`[test] WAV size: ${wavBuffer.length} bytes, PCM size: ${pcmData.length} bytes`);

  // WAV is stereo 16kHz s16le — downmix to mono
  const sampleCount = pcmData.length / 4; // 2 channels * 2 bytes per sample
  const monoBuffer = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const left = pcmData.readInt16LE(i * 4);
    const right = pcmData.readInt16LE(i * 4 + 2);
    const mono = Math.round((left + right) / 2);
    monoBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), i * 2);
  }
  console.log(`[test] Mono PCM: ${monoBuffer.length} bytes (${(monoBuffer.length / 2 / 16000).toFixed(2)}s)`);

  return new Promise<void>((resolve) => {
    const ws = new WebSocket(SONIOX_WS_URL);
    let messageCount = 0;

    ws.on("open", () => {
      console.log("[test] WebSocket connected");

      // Send config
      const config = {
        api_key: API_KEY,
        model: "stt-rt-preview",
        audio_format: "s16le",
        sample_rate: 16000,
        num_channels: 1,
        language_hints: ["en"],
      };
      console.log("[test] Sending config:", JSON.stringify(config, null, 2));
      ws.send(JSON.stringify(config));

      // Stream audio in 60ms chunks (960 samples = 1920 bytes)
      const chunkSize = 1920;
      let offset = 0;
      let chunkCount = 0;

      const sendInterval = setInterval(() => {
        if (offset >= monoBuffer.length) {
          clearInterval(sendInterval);
          console.log(`[test] All audio sent (${chunkCount} chunks)`);

          // Signal end of audio
          console.log("[test] Sending empty frame to signal end");
          ws.send(Buffer.alloc(0));

          // Wait a bit for final response, then close
          setTimeout(() => {
            console.log(`[test] Closing after ${messageCount} messages received`);
            ws.close();
          }, 5000);
          return;
        }

        const end = Math.min(offset + chunkSize, monoBuffer.length);
        const chunk = monoBuffer.subarray(offset, end);
        ws.send(chunk);
        offset = end;
        chunkCount++;
      }, 60); // Send every 60ms to match real-time pace
    });

    ws.on("message", (data: Buffer) => {
      messageCount++;
      const raw = data.toString();
      try {
        const msg = JSON.parse(raw);

        if (msg.error_code || msg.error_message) {
          console.error(`[test] ERROR: code=${msg.error_code} message="${msg.error_message}"`);
        } else if (msg.finished) {
          console.log(`[test] FINISHED: total_audio_proc_ms=${msg.total_audio_proc_ms}`);
        } else if (msg.tokens && msg.tokens.length > 0) {
          const text = msg.tokens.map((t: any) => t.text).join("");
          const isFinal = msg.tokens.some((t: any) => t.is_final);
          console.log(`[test] ${isFinal ? "FINAL" : "PARTIAL"}: "${text.trim()}"`);
        } else {
          console.log(`[test] MSG #${messageCount}: ${raw.slice(0, 300)}`);
        }
      } catch {
        console.log(`[test] RAW MSG #${messageCount}: ${raw.slice(0, 300)}`);
      }
    });

    ws.on("error", (err) => {
      console.error("[test] WebSocket error:", err.message);
    });

    ws.on("close", (code, reason) => {
      console.log(`[test] Connection closed (code=${code}, reason="${reason?.toString() || ""}")`);
      console.log(`[test] Total messages received: ${messageCount}`);
      resolve();
    });
  });
}

main().catch(console.error);
