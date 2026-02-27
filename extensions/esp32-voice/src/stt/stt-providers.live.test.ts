// extensions/esp32-voice/src/stt/stt-providers.live.test.ts
//
// Live integration tests — makes REAL API calls.
// Each provider suite is skipped when its env key is absent.
// Run with: npx vitest run --config vitest.live.config.ts
//
// This file is excluded from normal CI (vitest excludes *.live.test.ts).

import { describe, it, expect } from "vitest";
import { SonioxSttProvider } from "./soniox.js";
import { ElevenLabsSttProvider } from "./elevenlabs-stt.js";
import { AssemblyAiSttProvider } from "./assemblyai.js";
import { GladiaSttProvider } from "./gladia.js";

// Helper: generate Opus frames from PCM silence (tests connectivity, not accuracy)
async function generateTestOpusFrames(count = 50): Promise<Buffer[]> {
  const OpusScript = (await import("opusscript")) as any;
  const Ctor = OpusScript.default ?? OpusScript;
  const encoder = new Ctor(16000, 1, Ctor.Application.VOIP);
  const frames: Buffer[] = [];
  // 20ms of silence at 16kHz = 320 samples = 640 bytes PCM16
  const silence = Buffer.alloc(640, 0);
  for (let i = 0; i < count; i++) {
    const encoded = encoder.encode(silence, 320);
    frames.push(Buffer.from(encoded));
  }
  return frames;
}

// Each test sends Opus-encoded silence frames. The transcript may be empty
// (silence), so we mainly verify the connection lifecycle works without errors.

describe.skipIf(!process.env.SONIOX_API_KEY)("Soniox (live)", () => {
  it("connects and processes audio", { timeout: 30_000 }, async () => {
    const provider = new SonioxSttProvider({ apiKey: process.env.SONIOX_API_KEY! });
    const frames = await generateTestOpusFrames();

    await provider.connect();
    for (const frame of frames) {
      await provider.sendAudio(frame);
    }
    const transcript = await provider.finalize();
    await provider.close();

    // Silence may produce empty transcript — main assertion is no errors
    expect(typeof transcript).toBe("string");
  });
});

describe.skipIf(!process.env.ELEVENLABS_STT_API_KEY)("ElevenLabs STT (live)", () => {
  it("connects and processes audio", { timeout: 30_000 }, async () => {
    const provider = new ElevenLabsSttProvider({ apiKey: process.env.ELEVENLABS_STT_API_KEY! });
    const frames = await generateTestOpusFrames();

    await provider.connect();
    for (const frame of frames) {
      await provider.sendAudio(frame);
    }
    const transcript = await provider.finalize();
    await provider.close();

    expect(typeof transcript).toBe("string");
  });
});

describe.skipIf(!process.env.ASSEMBLYAI_API_KEY)("AssemblyAI (live)", () => {
  it("connects and processes audio", { timeout: 30_000 }, async () => {
    const provider = new AssemblyAiSttProvider({ apiKey: process.env.ASSEMBLYAI_API_KEY! });
    const frames = await generateTestOpusFrames();

    await provider.connect();
    for (const frame of frames) {
      await provider.sendAudio(frame);
    }
    const transcript = await provider.finalize();
    await provider.close();

    expect(typeof transcript).toBe("string");
  });
});

describe.skipIf(!process.env.GLADIA_API_KEY)("Gladia (live)", () => {
  it("connects and processes audio", { timeout: 30_000 }, async () => {
    const provider = new GladiaSttProvider({ apiKey: process.env.GLADIA_API_KEY! });
    const frames = await generateTestOpusFrames();

    await provider.connect();
    for (const frame of frames) {
      await provider.sendAudio(frame);
    }
    const transcript = await provider.finalize();
    await provider.close();

    expect(typeof transcript).toBe("string");
  });
});
