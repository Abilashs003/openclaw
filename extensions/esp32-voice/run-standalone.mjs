/**
 * Standalone Voice Server Runner
 *
 * Starts ONLY the ESP32 voice WebSocket server (port 8765)
 * WITHOUT needing the full OpenClaw gateway setup.
 *
 * The voice pipeline (Mic → Opus → VAD → STT → TTS) works standalone.
 * LLM queries go to the already-running gateway at ws://127.0.0.1:18789.
 *
 * Usage:
 *   npx tsx run-standalone.mjs
 *
 * Environment (auto-loaded from ~/.openclaw/.env):
 *   DEEPGRAM_API_KEY    — for speech-to-text
 *   ELEVENLABS_API_KEY  — for text-to-speech
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Load ~/.openclaw/.env ──────────────────────────────────────
const envPath = join(
  process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"),
  ".env"
);

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
  console.log(`[standalone] Loaded env from ${envPath}`);
} else {
  console.warn(`[standalone] No .env found at ${envPath}`);
}

// ── Verify keys ────────────────────────────────────────────────
console.log(`[standalone] DEEPGRAM_API_KEY:   ${process.env.DEEPGRAM_API_KEY ? "✓ set" : "✗ MISSING"}`);
console.log(`[standalone] ELEVENLABS_API_KEY: ${process.env.ELEVENLABS_API_KEY ? "✓ set" : "✗ MISSING"}`);
console.log(`[standalone] GEMINI_API_KEY:     ${process.env.GEMINI_API_KEY ? "✓ set" : "✗ MISSING"}`);
console.log("");

// ── Start the voice server ─────────────────────────────────────
// This imports voice-endpoint.ts which auto-imports STT/TTS providers
const { startStandaloneVoiceServer } = await import("./src/voice/voice-endpoint.js");

const port = parseInt(process.env.ESP32_VOICE_PORT ?? "8765", 10);
const { httpServer } = startStandaloneVoiceServer(port);

console.log("");
console.log("===========================================");
console.log("  Voice server is running!");
console.log(`  WebSocket: ws://0.0.0.0:${port}/`);
console.log("");
console.log("  Now run the test client in another terminal:");
console.log("  npx tsx test-full-client.mjs");
console.log("===========================================");
console.log("");

// Keep alive + cleanup
process.on("SIGINT", () => {
  console.log("\nShutting down voice server...");
  httpServer.close();
  process.exit(0);
});
