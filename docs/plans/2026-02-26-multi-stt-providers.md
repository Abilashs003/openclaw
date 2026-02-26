# Multi-Provider STT Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 4 new STT providers (Soniox, ElevenLabs, AssemblyAI, Gladia) to the ESP32 voice extension, mirroring the existing TTS multi-provider architecture.

**Architecture:** Each provider implements the `SttProvider` interface, auto-registers with `sttRegistry`, and handles its own Opus→PCM conversion internally when needed. No interface changes.

**Tech Stack:** TypeScript (ESM), ws, opusscript, Vitest

**Design Doc:** `docs/plans/2026-02-26-multi-stt-providers-design.md`

---

## Task 1: Soniox STT Provider

**Files:**
- Create: `extensions/esp32-voice/src/stt/soniox.ts`

**Step 1: Create `soniox.ts` with full implementation**

Follow the exact pattern from `deepgram.ts`. Key differences: Soniox needs Opus→PCM decode, sends config JSON on open, sends PCM binary frames.

```typescript
/**
 * Soniox v4 streaming Speech-to-Text provider.
 *
 * Uses Soniox's WebSocket API for real-time speech recognition.
 * Receives Opus frames from the ESP32, decodes to PCM16 internally,
 * and streams PCM to Soniox.
 *
 * WebSocket URL: wss://stt-rt.soniox.com/transcribe-websocket
 * Docs: https://soniox.com/docs/stt/api-reference/websocket-api
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

export class SonioxSttProvider implements SttProvider {
  readonly id = "soniox";
  readonly name = "Soniox";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private decoder: any = null;
  private audioQueue: Buffer[] = [];
  private configSent = false;
  private finalTranscript = "";
  private lastPartialTranscript = "";
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "stt-rt-v4";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    // Initialize Opus decoder for Opus→PCM16 conversion
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    this.decoder = new Ctor(16000, 1, Ctor.Application.VOIP);

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(SONIOX_WS_URL);

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.configSent = false;
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        // Send config message with API key and audio format
        const config = {
          api_key: this.apiKey,
          model: this.model,
          audio_format: "pcm_s16le",
          sample_rate: 16000,
          num_audio_channels: 1,
          language: this.language,
        };
        this.ws!.send(JSON.stringify(config));
        this.configSent = true;

        // Flush buffered audio
        if (this.audioQueue.length > 0) {
          console.log(`[soniox-stt] Connected — flushing ${this.audioQueue.length} buffered frames`);
          for (const frame of this.audioQueue) {
            this.ws!.send(frame);
          }
          this.audioQueue = [];
        } else {
          console.log("[soniox-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[soniox-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[soniox-stt] Connection closed");
        this.audioQueue = [];
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      });
    });
  }

  async sendAudio(audioData: Buffer): Promise<void> {
    if (this.ws === null) return;

    // Decode Opus → PCM16 (320 samples = 20ms at 16kHz)
    let pcm: Buffer;
    try {
      const decoded = this.decoder.decode(audioData, 320);
      pcm = Buffer.from(decoded);
    } catch {
      return; // Skip malformed Opus frames
    }

    if (this.ws.readyState === WebSocket.OPEN && this.configSent) {
      this.ws.send(pcm);
    } else {
      this.audioQueue.push(pcm);
    }
  }

  async finalize(): Promise<string> {
    if (!this.finalizeResolve) {
      return this.finalTranscript || this.lastPartialTranscript;
    }

    if (this.finalizePromise) {
      // Send empty frame to signal end of audio
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(Buffer.alloc(0));
      }

      const TOTAL_TIMEOUT_MS = 6000;
      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[soniox-stt] Timeout waiting for final transcript (using: "${fallback}")`);
          if (this.finalizeResolve) {
            this.finalizeResolve(fallback);
            this.finalizeResolve = null;
          }
          resolve(fallback);
        }, TOTAL_TIMEOUT_MS);
      });

      return Promise.race([this.finalizePromise, timeoutPromise]);
    }

    return this.finalTranscript || this.lastPartialTranscript;
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        if (this.ws.readyState === this.ws.CONNECTING) {
          this.ws.terminate();
        } else {
          this.ws.close();
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      // Soniox sends tokens with text and final flag
      // Response format: { tokens: [{text, is_final}], ...} or {fw: [...]}
      if (msg.fw) {
        // Final words array
        const text = msg.fw.map((w: any) => w.t).join("").trim();
        if (text) {
          this.finalTranscript = this.finalTranscript
            ? this.finalTranscript + " " + text
            : text;
          this.lastPartialTranscript = "";
          if (this.onTranscript) {
            const result = this.onTranscript(text, true);
            if (result instanceof Promise) result.catch(() => {});
          }
        }
      } else if (msg.nfw) {
        // Non-final (partial) words
        const text = msg.nfw.map((w: any) => w.t).join("").trim();
        if (text) {
          this.lastPartialTranscript = text;
          if (this.onTranscript) {
            const result = this.onTranscript(text, false);
            if (result instanceof Promise) result.catch(() => {});
          }
        }
      } else if (msg.finished !== undefined) {
        // Stream finished
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
        if (this.onSpeechEnd) {
          const result = this.onSpeechEnd();
          if (result instanceof Promise) result.catch(() => {});
        }
      }
    } catch { /* ignore parse errors */ }
  }
}

export const sonioxMeta: SttProviderMeta = {
  id: "soniox",
  name: "Soniox",
  description: "Ultra-low latency streaming STT with v4 real-time model. Sub-200ms latency at $0.12/hr.",
  streaming: true,
  envVar: "SONIOX_API_KEY",
  defaultModel: "stt-rt-v4",
  docsUrl: "https://soniox.com/docs/stt/api-reference/websocket-api",
};

function createSonioxStt(config: SttProviderConfig): SttProvider {
  return new SonioxSttProvider(config);
}

sttRegistry.register(sonioxMeta, createSonioxStt);
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to soniox.ts

**Step 3: Commit**

```bash
git add extensions/esp32-voice/src/stt/soniox.ts
git commit -m "feat(esp32-voice): add Soniox STT provider"
```

---

## Task 2: ElevenLabs STT Provider

**Files:**
- Create: `extensions/esp32-voice/src/stt/elevenlabs-stt.ts`

**Step 1: Create `elevenlabs-stt.ts` with full implementation**

Key differences from Soniox: auth via `xi-api-key` header, audio sent as base64 JSON (not binary), partial/committed transcript events.

```typescript
/**
 * ElevenLabs Scribe v2 streaming Speech-to-Text provider.
 *
 * Uses ElevenLabs' WebSocket API for real-time speech recognition.
 * Receives Opus frames from the ESP32, decodes to PCM16 internally,
 * then base64-encodes and sends as JSON messages.
 *
 * WebSocket URL: wss://api.elevenlabs.io/v1/speech-to-text/realtime
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const ELEVENLABS_STT_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export class ElevenLabsSttProvider implements SttProvider {
  readonly id = "elevenlabs-stt";
  readonly name = "ElevenLabs STT";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private decoder: any = null;
  private audioQueue: string[] = []; // base64 chunks buffered before open
  private finalTranscript = "";
  private lastPartialTranscript = "";
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "scribe_v2_realtime";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    this.decoder = new Ctor(16000, 1, Ctor.Application.VOIP);

    const url = `${ELEVENLABS_STT_WS_URL}?model_id=${this.model}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { "xi-api-key": this.apiKey },
      });

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        // Flush buffered audio
        if (this.audioQueue.length > 0) {
          console.log(`[elevenlabs-stt] Connected — flushing ${this.audioQueue.length} buffered chunks`);
          for (const chunk of this.audioQueue) {
            this.ws!.send(JSON.stringify({
              type: "input_audio_chunk",
              audio_chunk: chunk,
            }));
          }
          this.audioQueue = [];
        } else {
          console.log("[elevenlabs-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[elevenlabs-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[elevenlabs-stt] Connection closed");
        this.audioQueue = [];
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      });
    });
  }

  async sendAudio(audioData: Buffer): Promise<void> {
    if (this.ws === null) return;

    // Decode Opus → PCM16, then base64 encode for JSON transport
    let b64: string;
    try {
      const decoded = this.decoder.decode(audioData, 320);
      b64 = Buffer.from(decoded).toString("base64");
    } catch {
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "input_audio_chunk",
        audio_chunk: b64,
      }));
    } else {
      this.audioQueue.push(b64);
    }
  }

  async finalize(): Promise<string> {
    if (!this.finalizeResolve) {
      return this.finalTranscript || this.lastPartialTranscript;
    }

    if (this.finalizePromise) {
      const TOTAL_TIMEOUT_MS = 6000;
      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[elevenlabs-stt] Timeout waiting for final transcript (using: "${fallback}")`);
          if (this.finalizeResolve) {
            this.finalizeResolve(fallback);
            this.finalizeResolve = null;
          }
          resolve(fallback);
        }, TOTAL_TIMEOUT_MS);
      });

      return Promise.race([this.finalizePromise, timeoutPromise]);
    }

    return this.finalTranscript || this.lastPartialTranscript;
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        if (this.ws.readyState === this.ws.CONNECTING) {
          this.ws.terminate();
        } else {
          this.ws.close();
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "partial_transcript") {
        const text = msg.text?.trim() ?? "";
        if (text) {
          this.lastPartialTranscript = text;
          if (this.onTranscript) {
            const result = this.onTranscript(text, false);
            if (result instanceof Promise) result.catch(() => {});
          }
        }
      } else if (msg.type === "committed_transcript") {
        const text = msg.text?.trim() ?? "";
        if (text) {
          this.finalTranscript = this.finalTranscript
            ? this.finalTranscript + " " + text
            : text;
          this.lastPartialTranscript = "";
          if (this.onTranscript) {
            const result = this.onTranscript(text, true);
            if (result instanceof Promise) result.catch(() => {});
          }
        }
        // committed_transcript in auto-commit mode = speech end
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
        if (this.onSpeechEnd) {
          const result = this.onSpeechEnd();
          if (result instanceof Promise) result.catch(() => {});
        }
      }
    } catch { /* ignore parse errors */ }
  }
}

export const elevenlabsSttMeta: SttProviderMeta = {
  id: "elevenlabs-stt",
  name: "ElevenLabs STT",
  description: "Real-time streaming STT with Scribe v2. ~150ms latency, 90+ languages.",
  streaming: true,
  envVar: "ELEVENLABS_STT_API_KEY",
  defaultModel: "scribe_v2_realtime",
  docsUrl: "https://elevenlabs.io/docs/api-reference/speech-to-text",
};

function createElevenLabsStt(config: SttProviderConfig): SttProvider {
  return new ElevenLabsSttProvider(config);
}

sttRegistry.register(elevenlabsSttMeta, createElevenLabsStt);
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add extensions/esp32-voice/src/stt/elevenlabs-stt.ts
git commit -m "feat(esp32-voice): add ElevenLabs STT provider"
```

---

## Task 3: AssemblyAI STT Provider

**Files:**
- Create: `extensions/esp32-voice/src/stt/assemblyai.ts`

**Step 1: Create `assemblyai.ts` with full implementation**

Key difference: two-step connection — REST call for temp token, then WebSocket. Uses global `fetch()` (Node 18+).

```typescript
/**
 * AssemblyAI Universal Streaming Speech-to-Text provider.
 *
 * Uses AssemblyAI's v3 streaming WebSocket API for real-time speech recognition.
 * Requires a two-step connection: first acquire a temporary token via REST,
 * then connect to the WebSocket with that token.
 *
 * REST: POST https://api.assemblyai.com/v3/streaming/token
 * WS:   wss://streaming.assemblyai.com/v3/ws
 * Docs: https://www.assemblyai.com/docs/api-reference/streaming-api
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const ASSEMBLYAI_TOKEN_URL = "https://api.assemblyai.com/v3/streaming/token";
const ASSEMBLYAI_WS_URL = "wss://streaming.assemblyai.com/v3/ws";

export class AssemblyAiSttProvider implements SttProvider {
  readonly id = "assemblyai";
  readonly name = "AssemblyAI";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private decoder: any = null;
  private audioQueue: Buffer[] = [];
  private finalTranscript = "";
  private lastPartialTranscript = "";
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "universal";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    // 1. Initialize Opus decoder
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    this.decoder = new Ctor(16000, 1, Ctor.Application.VOIP);

    // 2. Acquire temporary streaming token
    const tokenRes = await fetch(ASSEMBLYAI_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!tokenRes.ok) {
      throw new Error(`[assemblyai-stt] Token request failed: HTTP ${tokenRes.status}`);
    }

    const tokenData = (await tokenRes.json()) as { token?: string };
    const token = tokenData.token;
    if (!token) {
      throw new Error("[assemblyai-stt] No token in response");
    }

    // 3. Connect WebSocket with temp token
    const params = new URLSearchParams({
      sample_rate: "16000",
      encoding: "pcm_s16le",
      token,
    });
    const url = `${ASSEMBLYAI_WS_URL}?${params.toString()}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        if (this.audioQueue.length > 0) {
          console.log(`[assemblyai-stt] Connected — flushing ${this.audioQueue.length} buffered frames`);
          for (const frame of this.audioQueue) {
            this.ws!.send(frame);
          }
          this.audioQueue = [];
        } else {
          console.log("[assemblyai-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[assemblyai-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[assemblyai-stt] Connection closed");
        this.audioQueue = [];
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      });
    });
  }

  async sendAudio(audioData: Buffer): Promise<void> {
    if (this.ws === null) return;

    let pcm: Buffer;
    try {
      const decoded = this.decoder.decode(audioData, 320);
      pcm = Buffer.from(decoded);
    } catch {
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    } else {
      this.audioQueue.push(pcm);
    }
  }

  async finalize(): Promise<string> {
    if (!this.finalizeResolve) {
      return this.finalTranscript || this.lastPartialTranscript;
    }

    if (this.finalizePromise) {
      // Send session termination
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "sendSessionTermination" }));
      }

      const TOTAL_TIMEOUT_MS = 6000;
      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[assemblyai-stt] Timeout waiting for final transcript (using: "${fallback}")`);
          if (this.finalizeResolve) {
            this.finalizeResolve(fallback);
            this.finalizeResolve = null;
          }
          resolve(fallback);
        }, TOTAL_TIMEOUT_MS);
      });

      return Promise.race([this.finalizePromise, timeoutPromise]);
    }

    return this.finalTranscript || this.lastPartialTranscript;
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        if (this.ws.readyState === this.ws.CONNECTING) {
          this.ws.terminate();
        } else {
          this.ws.close();
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      // AssemblyAI v3: receiveTurn with words array
      if (msg.type === "receiveTurn") {
        const words = msg.turn?.words ?? [];
        const text = words.map((w: any) => w.text).join(" ").trim();
        const isFinal = msg.turn?.end_of_turn ?? false;

        if (text) {
          if (this.onTranscript) {
            const result = this.onTranscript(text, isFinal);
            if (result instanceof Promise) result.catch(() => {});
          }

          if (isFinal) {
            this.finalTranscript = this.finalTranscript
              ? this.finalTranscript + " " + text
              : text;
            this.lastPartialTranscript = "";

            if (this.finalizeResolve) {
              this.finalizeResolve(this.finalTranscript);
              this.finalizeResolve = null;
            }
            if (this.onSpeechEnd) {
              const result = this.onSpeechEnd();
              if (result instanceof Promise) result.catch(() => {});
            }
          } else {
            this.lastPartialTranscript = text;
          }
        }
      } else if (msg.type === "sessionTerminated") {
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      }
    } catch { /* ignore parse errors */ }
  }
}

export const assemblyAiMeta: SttProviderMeta = {
  id: "assemblyai",
  name: "AssemblyAI",
  description: "Real-time streaming STT with immutable transcripts. 307ms P50 latency, $0.15/hr.",
  streaming: true,
  envVar: "ASSEMBLYAI_API_KEY",
  defaultModel: "universal",
  docsUrl: "https://www.assemblyai.com/docs/api-reference/streaming-api",
};

function createAssemblyAiStt(config: SttProviderConfig): SttProvider {
  return new AssemblyAiSttProvider(config);
}

sttRegistry.register(assemblyAiMeta, createAssemblyAiStt);
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add extensions/esp32-voice/src/stt/assemblyai.ts
git commit -m "feat(esp32-voice): add AssemblyAI STT provider"
```

---

## Task 4: Gladia STT Provider

**Files:**
- Create: `extensions/esp32-voice/src/stt/gladia.ts`

**Step 1: Create `gladia.ts` with full implementation**

Key difference: two-step (REST init → WS), but sends Opus natively (no decode needed). Uses global `fetch()`.

```typescript
/**
 * Gladia Solaria streaming Speech-to-Text provider.
 *
 * Uses Gladia's live transcription API for real-time speech recognition.
 * Two-step connection: POST to init session → connect to returned WS URL.
 * Accepts Opus audio natively — no conversion needed.
 *
 * REST: POST https://api.gladia.io/v2/live
 * Docs: https://docs.gladia.io/chapters/speech-to-text-api/pages/live-speech-recognition
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const GLADIA_INIT_URL = "https://api.gladia.io/v2/live";

export class GladiaSttProvider implements SttProvider {
  readonly id = "gladia";
  readonly name = "Gladia";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private audioQueue: Buffer[] = [];
  private finalTranscript = "";
  private lastPartialTranscript = "";
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "solaria";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    // 1. Init session via REST
    const initRes = await fetch(GLADIA_INIT_URL, {
      method: "POST",
      headers: {
        "x-gladia-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        encoding: "opus",
        sample_rate: 16000,
        channels: 1,
        model: this.model,
        language: this.language,
      }),
    });

    if (!initRes.ok) {
      throw new Error(`[gladia-stt] Session init failed: HTTP ${initRes.status}`);
    }

    const initData = (await initRes.json()) as { url?: string };
    const wsUrl = initData.url;
    if (!wsUrl) {
      throw new Error("[gladia-stt] No WebSocket URL in init response");
    }

    // 2. Connect to session WebSocket
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        if (this.audioQueue.length > 0) {
          console.log(`[gladia-stt] Connected — flushing ${this.audioQueue.length} buffered frames`);
          for (const frame of this.audioQueue) {
            this.ws!.send(frame);
          }
          this.audioQueue = [];
        } else {
          console.log("[gladia-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[gladia-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[gladia-stt] Connection closed");
        this.audioQueue = [];
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      });
    });
  }

  async sendAudio(audioData: Buffer): Promise<void> {
    if (this.ws === null) return;

    // Gladia accepts Opus natively — send raw frames
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioData);
    } else {
      this.audioQueue.push(audioData);
    }
  }

  async finalize(): Promise<string> {
    if (!this.finalizeResolve) {
      return this.finalTranscript || this.lastPartialTranscript;
    }

    if (this.finalizePromise) {
      // Signal end of audio
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "stop_recording" }));
      }

      const TOTAL_TIMEOUT_MS = 6000;
      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[gladia-stt] Timeout waiting for final transcript (using: "${fallback}")`);
          if (this.finalizeResolve) {
            this.finalizeResolve(fallback);
            this.finalizeResolve = null;
          }
          resolve(fallback);
        }, TOTAL_TIMEOUT_MS);
      });

      return Promise.race([this.finalizePromise, timeoutPromise]);
    }

    return this.finalTranscript || this.lastPartialTranscript;
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        if (this.ws.readyState === this.ws.CONNECTING) {
          this.ws.terminate();
        } else {
          this.ws.close();
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "transcript" && msg.data) {
        const text = msg.data.transcription?.trim() ?? "";
        const isFinal = msg.data.is_final ?? false;

        if (text) {
          if (this.onTranscript) {
            const result = this.onTranscript(text, isFinal);
            if (result instanceof Promise) result.catch(() => {});
          }

          if (isFinal) {
            this.finalTranscript = this.finalTranscript
              ? this.finalTranscript + " " + text
              : text;
            this.lastPartialTranscript = "";
          } else {
            this.lastPartialTranscript = text;
          }
        }

        // Check for speech-end signal
        if (msg.data.speech_end || (isFinal && msg.data.utterance_end)) {
          if (this.finalizeResolve) {
            this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
            this.finalizeResolve = null;
          }
          if (this.onSpeechEnd) {
            const result = this.onSpeechEnd();
            if (result instanceof Promise) result.catch(() => {});
          }
        }
      } else if (msg.type === "post_final_transcript") {
        // Session done
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      }
    } catch { /* ignore parse errors */ }
  }
}

export const gladiaMeta: SttProviderMeta = {
  id: "gladia",
  name: "Gladia",
  description: "Real-time streaming STT with native Opus support. 270ms latency, 100+ languages.",
  streaming: true,
  envVar: "GLADIA_API_KEY",
  defaultModel: "solaria",
  docsUrl: "https://docs.gladia.io/chapters/speech-to-text-api/pages/live-speech-recognition",
};

function createGladiaStt(config: SttProviderConfig): SttProvider {
  return new GladiaSttProvider(config);
}

sttRegistry.register(gladiaMeta, createGladiaStt);
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add extensions/esp32-voice/src/stt/gladia.ts
git commit -m "feat(esp32-voice): add Gladia STT provider"
```

---

## Task 5: Integration — config-schema.ts

**Files:**
- Modify: `extensions/esp32-voice/src/config-schema.ts:18`

**Step 1: Change `sttProvider` from `z.string()` to `z.enum()`**

In `config-schema.ts`, replace line 18:
```typescript
// OLD:
sttProvider: z.string().optional().default("deepgram"),
// NEW:
sttProvider: z.enum([
  "deepgram",
  "soniox",
  "elevenlabs-stt",
  "assemblyai",
  "gladia",
]).optional().default("deepgram"),
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add extensions/esp32-voice/src/config-schema.ts
git commit -m "feat(esp32-voice): add STT provider enum to config schema"
```

---

## Task 6: Integration — voice-endpoint.ts

**Files:**
- Modify: `extensions/esp32-voice/src/voice/voice-endpoint.ts:23-29`

**Step 1: Add STT provider imports**

After the existing `import "../stt/deepgram.js";` (line 23), add:

```typescript
import "../stt/soniox.js";
import "../stt/elevenlabs-stt.js";
import "../stt/assemblyai.js";
import "../stt/gladia.js";
```

**Step 2: Update health check to report STT provider**

In the health check handler (line 298), change:

```typescript
// OLD:
sttConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
// NEW:
sttProvider: process.env.STT_PROVIDER ?? "deepgram",
sttConfigured: Boolean(
  process.env.DEEPGRAM_API_KEY || process.env.SONIOX_API_KEY ||
  process.env.ELEVENLABS_STT_API_KEY || process.env.ASSEMBLYAI_API_KEY ||
  process.env.GLADIA_API_KEY
),
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add extensions/esp32-voice/src/voice/voice-endpoint.ts
git commit -m "feat(esp32-voice): register all STT providers in voice-endpoint"
```

---

## Task 7: Integration — voice-session.ts auto-hello STT resolution

**Files:**
- Modify: `extensions/esp32-voice/src/voice/voice-session.ts:23-44,300-308`

**Step 1: Add STT_ENV_MAP alongside existing TTS_ENV_MAP**

After line 34 (end of TTS_ENV_MAP), add:

```typescript
// ── STT provider → env var mapping ───────────────────────────────
const STT_ENV_MAP: Record<string, { apiKey: string }> = {
  "deepgram":       { apiKey: "DEEPGRAM_API_KEY" },
  "soniox":         { apiKey: "SONIOX_API_KEY" },
  "elevenlabs-stt": { apiKey: "ELEVENLABS_STT_API_KEY" },
  "assemblyai":     { apiKey: "ASSEMBLYAI_API_KEY" },
  "gladia":         { apiKey: "GLADIA_API_KEY" },
};

/** Resolve STT env vars for a given provider ID. */
function resolveSttEnv(providerId: string): { apiKey: string } {
  const env = STT_ENV_MAP[providerId] ?? STT_ENV_MAP["deepgram"];
  return {
    apiKey: process.env[env.apiKey] ?? "",
  };
}
```

**Step 2: Update auto-hello path (line ~300-308)**

Replace the hardcoded Deepgram resolution:

```typescript
// OLD:
sttProvider: "deepgram",
sttApiKey:   process.env.DEEPGRAM_API_KEY ?? "",
sttModel:    process.env.DEEPGRAM_MODEL,

// NEW:
const autoSttProvider = process.env.STT_PROVIDER ?? "deepgram";
const autoSttEnv = resolveSttEnv(autoSttProvider);
// ... then in cfg:
sttProvider: autoSttProvider,
sttApiKey:   autoSttEnv.apiKey,
sttModel:    process.env.STT_MODEL,
```

**Step 3: Update hello-message path (line ~479-481)**

Replace:
```typescript
// OLD:
sttProvider: sttConfig?.provider ?? "deepgram",
sttApiKey: sttConfig?.apiKey ?? process.env.DEEPGRAM_API_KEY ?? "",
sttModel: sttConfig?.model ?? process.env.DEEPGRAM_MODEL,

// NEW:
const helloSttProvider = sttConfig?.provider ?? process.env.STT_PROVIDER ?? "deepgram";
const helloSttEnv = resolveSttEnv(helloSttProvider);
// ... then in cfg:
sttProvider: helloSttProvider,
sttApiKey: sttConfig?.apiKey ?? helloSttEnv.apiKey,
sttModel: sttConfig?.model ?? process.env.STT_MODEL,
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add extensions/esp32-voice/src/voice/voice-session.ts
git commit -m "feat(esp32-voice): dynamic STT provider resolution in voice-session"
```

---

## Task 8: Unit Tests

**Files:**
- Create: `extensions/esp32-voice/src/stt/stt-providers.test.ts`

**Step 1: Create the unit test file**

Mirror the TTS test pattern exactly. Use `vi.hoisted()` + `vi.mock("ws")` + `vi.mock("opusscript")`. Mock `fetch` globally for AssemblyAI and Gladia.

The test file should contain these describe blocks:
1. **STT Registry** — all 4 new providers registered correctly
2. **SonioxSttProvider** — connect (sends config JSON), sendAudio (decodes Opus→PCM), handleMessage (partial/final tokens), finalize (empty frame + timeout), close, error handling
3. **ElevenLabsSttProvider** — connect (xi-api-key header), sendAudio (decode + base64 + JSON), handleMessage (partial_transcript / committed_transcript), finalize (timeout), close
4. **AssemblyAiSttProvider** — connect (fetch token + WS), sendAudio (decode → PCM binary), handleMessage (receiveTurn), finalize (sendSessionTermination + timeout), close
5. **GladiaSttProvider** — connect (fetch init + WS URL), sendAudio (raw Opus binary), handleMessage (transcript events), finalize (stop_recording + timeout), close

Each describe block: ~12-15 tests covering:
- Constructor defaults
- `connect()` opens correct URL with correct auth
- `connect()` rejects on WS error
- `sendAudio()` buffers before WS open, sends after
- `sendAudio()` for Opus providers: verifies decode was called with (opusFrame, 320)
- `handleMessage()` — partial transcript fires `onTranscript(text, false)`
- `handleMessage()` — final transcript fires `onTranscript(text, true)` + accumulates
- `finalize()` sends close signal, resolves with transcript
- `finalize()` timeout fallback to last partial
- `onSpeechEnd` fires on end-of-speech events
- `close()` terminates WS, handles CONNECTING state
- Error handling for malformed JSON messages

**Step 2: Run tests to verify they all pass**

Run: `npx vitest run extensions/esp32-voice/src/stt/stt-providers.test.ts`
Expected: All ~60 tests PASS

**Step 3: Commit**

```bash
git add extensions/esp32-voice/src/stt/stt-providers.test.ts
git commit -m "test(esp32-voice): add unit tests for all 4 new STT providers"
```

---

## Task 9: Live Integration Tests

**Files:**
- Create: `extensions/esp32-voice/src/stt/stt-providers.live.test.ts`

**Step 1: Create the live test file**

Mirror TTS live test pattern. Use `describe.skipIf(!process.env.XXX)` for conditional execution. Each test: connect → send audio frames → finalize → assert non-empty transcript.

For test audio: generate Opus frames in the test using opusscript by encoding a known PCM buffer (sine wave or silence with speech-like characteristics). Or send real speech Opus frames if a fixture file exists.

```typescript
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

// Similar blocks for ElevenLabs, AssemblyAI, Gladia...
```

**Step 2: Run live tests (if keys available)**

Run: `npx vitest run --config vitest.live.config.ts`
Expected: Tests pass for providers with available API keys, skip for others

**Step 3: Commit**

```bash
git add extensions/esp32-voice/src/stt/stt-providers.live.test.ts
git commit -m "test(esp32-voice): add live integration tests for STT providers"
```

---

## Task 10: Final Verification

**Step 1: Run full unit test suite**

Run: `npx vitest run`
Expected: All tests pass (77 TTS + ~60 STT + any existing tests)

**Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Verify no regressions**

- Existing TTS tests still pass (77/77)
- Existing Deepgram tests still pass
- All 5 STT providers appear in `sttRegistry.list()`

**Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "chore(esp32-voice): final verification — all STT provider tests pass"
```

---

## Execution Notes

- **Task order matters:** Tasks 1-4 (providers) are independent and can run in parallel. Tasks 5-7 (integration) depend on providers existing. Task 8-9 (tests) depend on everything.
- **opusscript mock pattern:** Use `vi.mock("opusscript", () => ({ default: MockOpusScript }))` where `MockOpusScript` is a class with `decode(data, samples)` that returns a fixed `Buffer.alloc(640)`.
- **fetch mock pattern:** Use `vi.stubGlobal("fetch", vi.fn())` for AssemblyAI/Gladia two-step connections.
- **Timer pattern:** `vi.useFakeTimers()` AFTER `await connect()`, `afterEach(() => vi.useRealTimers())`.
