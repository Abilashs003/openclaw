// extensions/esp32-voice/src/tts/tts-providers.live.test.ts
//
// Live integration tests — makes REAL API calls.
// Each provider suite is skipped when its env key is absent.
// Run with: vitest run tts-providers.live.test.ts
//
// This file is excluded from normal CI (vitest excludes *.live.test.ts).

import { describe, it, expect } from "vitest";
import { RimeTtsProvider } from "./rime.js";
import { InworldTtsProvider } from "./inworld.js";
import { CartesiaTtsProvider } from "./cartesia.js";
import { SmallestAiTtsProvider } from "./smallest-ai.js";
import { GroqPlayAiTtsProvider } from "./groq-playai.js";

// ── Rime ─────────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.RIME_API_KEY)("Rime (live)", () => {
  it("synthesizes speech end-to-end", { timeout: 30_000 }, async () => {
    const apiKey = process.env.RIME_API_KEY!;
    const provider = new RimeTtsProvider({ apiKey });

    const audioChunks: Buffer[] = [];
    let doneCalled = 0;

    provider.onAudio = (chunk) => audioChunks.push(chunk as Buffer);
    provider.onDone = () => doneCalled++;

    await provider.connect();
    await provider.synthesize("Hello, this is a test.");
    await provider.flush();
    await provider.close();

    expect(audioChunks.length).toBeGreaterThan(0);
    expect(audioChunks[0].length).toBeGreaterThan(0);
    const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBeGreaterThan(1000);
    expect(doneCalled).toBe(1);
  });
});

// ── Inworld ──────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.INWORLD_API_KEY)("Inworld (live)", () => {
  it("synthesizes speech end-to-end", { timeout: 30_000 }, async () => {
    const apiKey = process.env.INWORLD_API_KEY!;
    const provider = new InworldTtsProvider({ apiKey });

    const audioChunks: Buffer[] = [];
    let doneCalled = 0;

    provider.onAudio = (chunk) => audioChunks.push(chunk as Buffer);
    provider.onDone = () => doneCalled++;

    await provider.connect();
    await provider.synthesize("Hello, this is a test.");
    await provider.flush();
    await provider.close();

    expect(audioChunks.length).toBeGreaterThan(0);
    expect(audioChunks[0].length).toBeGreaterThan(0);
    const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBeGreaterThan(1000);
    expect(doneCalled).toBe(1);
  });
});

// ── Cartesia ─────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.CARTESIA_API_KEY)("Cartesia (live)", () => {
  it("synthesizes speech end-to-end", { timeout: 30_000 }, async () => {
    const apiKey = process.env.CARTESIA_API_KEY!;
    const provider = new CartesiaTtsProvider({ apiKey });

    const audioChunks: Buffer[] = [];
    let doneCalled = 0;

    provider.onAudio = (chunk) => audioChunks.push(chunk as Buffer);
    provider.onDone = () => doneCalled++;

    await provider.connect();
    await provider.synthesize("Hello, this is a test.");
    await provider.flush();
    await provider.close();

    expect(audioChunks.length).toBeGreaterThan(0);
    expect(audioChunks[0].length).toBeGreaterThan(0);
    const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBeGreaterThan(1000);
    expect(doneCalled).toBe(1);
  });
});

// ── Smallest.ai ──────────────────────────────────────────────────────────────

describe.skipIf(!process.env.SMALLEST_AI_API_KEY)("Smallest.ai (live)", () => {
  it("synthesizes speech end-to-end", { timeout: 30_000 }, async () => {
    const apiKey = process.env.SMALLEST_AI_API_KEY!;
    const provider = new SmallestAiTtsProvider({ apiKey });

    const audioChunks: Buffer[] = [];
    let doneCalled = 0;

    provider.onAudio = (chunk) => audioChunks.push(chunk as Buffer);
    provider.onDone = () => doneCalled++;

    await provider.connect();
    await provider.synthesize("Hello, this is a test.");
    await provider.flush();
    await provider.close();

    expect(audioChunks.length).toBeGreaterThan(0);
    expect(audioChunks[0].length).toBeGreaterThan(0);
    const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBeGreaterThan(1000);
    expect(doneCalled).toBe(1);
  });
});

// ── Groq PlayAI ──────────────────────────────────────────────────────────────

describe.skipIf(!process.env.GROQ_API_KEY)("Groq PlayAI (live)", () => {
  it("synthesizes speech end-to-end", { timeout: 30_000 }, async () => {
    const apiKey = process.env.GROQ_API_KEY!;
    const provider = new GroqPlayAiTtsProvider({ apiKey });

    const audioChunks: Buffer[] = [];
    let doneCalled = 0;

    provider.onAudio = (chunk) => audioChunks.push(chunk as Buffer);
    provider.onDone = () => doneCalled++;

    await provider.connect();
    await provider.synthesize("Hello, this is a test.");
    await provider.flush();
    await provider.close();

    expect(audioChunks.length).toBeGreaterThan(0);
    expect(audioChunks[0].length).toBeGreaterThan(0);
    const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBeGreaterThan(1000);
    expect(doneCalled).toBe(1);
  });
});
