# Multi-Provider TTS Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Rime, Inworld, Cartesia, Smallest.ai, and Groq PlayAI as first-class TTS providers in the ESP32 voice plugin, with full onboarding wizard support.

**Architecture:** Flat one-file-per-provider pattern, identical to the existing `elevenlabs.ts`. Each file implements `TtsProvider`, auto-registers via `ttsRegistry.register()`, and is imported in `index.ts`. No new npm dependencies — WebSocket providers use `ws` (already installed); Groq PlayAI uses Node.js built-in `https`.

**Tech Stack:** TypeScript ESM, `ws` package for WebSocket, Node.js `https` for Groq, `@clack/prompts` for onboarding wizard, Zod for config schema.

**Reference:** Always read `extensions/esp32-voice/src/tts/elevenlabs.ts` before writing any provider. It is the canonical implementation. Do not modify it.

**Design doc:** `docs/plans/2026-02-25-multi-tts-provider-design.md`

---

## Task 1: Add Rime TTS Provider

**Files:**
- Create: `extensions/esp32-voice/src/tts/rime.ts`
- Modify: `extensions/esp32-voice/index.ts` (add import line)

**Step 1: Read the reference**

Read `extensions/esp32-voice/src/tts/elevenlabs.ts` in full before writing anything.

**Step 2: Create `extensions/esp32-voice/src/tts/rime.ts`**

```typescript
/**
 * Rime streaming Text-to-Speech provider.
 *
 * Uses Rime's WebSocket API for real-time TTS.
 * Sends text and receives binary PCM audio (24kHz, 16-bit mono).
 *
 * WebSocket URL: wss://users.rime.ai/v1/rime-tts
 * Docs: https://rime.ai/docs
 */

import WebSocket from "ws";
import type {
  TtsProvider,
  TtsProviderConfig,
  TtsProviderMeta,
  TtsAudioCallback,
  TtsDoneCallback,
} from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const RIME_WS_URL = "wss://users.rime.ai/v1/rime-tts";

const DEFAULT_VOICE_ID = "arcas";
const DEFAULT_MODEL_ID = "mist";

export class RimeTtsProvider implements TtsProvider {
  readonly id = "rime";
  readonly name = "Rime";
  readonly streaming = true;
  readonly outputSampleRate = 24000;

  onAudio: TtsAudioCallback | null = null;
  onDone: TtsDoneCallback | null = null;

  private apiKey: string;
  private voiceId: string;
  private modelId: string;
  private ws: WebSocket | null = null;
  private doneResolve: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  // Serialises onAudio calls so pacing sleeps in voice-session are respected
  private audioChain: Promise<void> = Promise.resolve();
  private isFinalReceived = false;

  constructor(config: TtsProviderConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId ?? DEFAULT_VOICE_ID;
    this.modelId = config.model ?? DEFAULT_MODEL_ID;
  }

  async connect(): Promise<void> {
    const url = `${RIME_WS_URL}?voice=${this.voiceId}&modelId=${this.modelId}&audioFormat=pcm&samplingRate=24000&reduceLatency=true`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      this.donePromise = new Promise<void>((res) => {
        this.doneResolve = res;
      });
      this.audioChain = Promise.resolve();
      this.isFinalReceived = false;

      this.ws.on("open", () => {
        console.log("[rime-tts] Connected");
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[rime-tts] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[rime-tts] Connection closed");
        if (!this.isFinalReceived) {
          this.audioChain
            .then(() => this.fireDone())
            .catch(() => this.fireDone());
        }
      });
    });
  }

  async synthesize(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("[rime-tts] Not connected");
    }
    this.ws.send(JSON.stringify({ text }));
  }

  async flush(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ operation: "eos" }));
    }
    if (this.donePromise) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn("[rime-tts] Timeout waiting for audio completion");
          resolve();
        }, 30000);
      });
      await Promise.race([this.donePromise, timeout]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    // Rime sends binary PCM frames directly — no JSON wrapper, no base64
    if (data instanceof Buffer && data.length > 0) {
      // Check if it's JSON (could be a status/done message)
      try {
        const msg = JSON.parse(data.toString());
        if (msg.done || msg.eos) {
          console.log("[rime-tts] Stream complete");
          this.isFinalReceived = true;
          this.audioChain
            .then(() => this.fireDone())
            .catch(() => this.fireDone());
        }
        return;
      } catch {
        // Not JSON — it's raw PCM audio bytes
      }

      if (this.onAudio) {
        const cb = this.onAudio;
        this.audioChain = this.audioChain
          .then(() => cb(data))
          .catch((err) => console.error("[rime-tts] Audio callback error:", err));
      }
    }
  }

  private fireDone(): void {
    if (this.onDone) {
      const result = this.onDone();
      if (result instanceof Promise) {
        result.catch((err) => console.error("[rime-tts] Done callback error:", err));
      }
    }
    if (this.doneResolve) {
      this.doneResolve();
      this.doneResolve = null;
    }
  }
}

export const rimeMeta: TtsProviderMeta = {
  id: "rime",
  name: "Rime",
  description: "Streaming TTS with native PCM output and reduce_latency mode. Low latency for voice assistants.",
  streaming: true,
  envVar: "RIME_API_KEY",
  defaultVoiceId: DEFAULT_VOICE_ID,
  defaultModel: DEFAULT_MODEL_ID,
  outputSampleRate: 24000,
  docsUrl: "https://rime.ai/docs",
};

ttsRegistry.register(rimeMeta, (config) => new RimeTtsProvider(config));
```

**Step 3: Add import to `extensions/esp32-voice/index.ts`**

After the existing `import "./src/tts/elevenlabs.js";` line, add:
```typescript
import "./src/tts/rime.js";
```

**Step 4: Verify TypeScript compiles**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing errors unrelated to rime.ts)

**Step 5: Commit**

```bash
git add extensions/esp32-voice/src/tts/rime.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Rime TTS provider"
```

---

## Task 2: Add Inworld TTS Provider

**Files:**
- Create: `extensions/esp32-voice/src/tts/inworld.ts`
- Modify: `extensions/esp32-voice/index.ts` (add import line)

**Step 1: Create `extensions/esp32-voice/src/tts/inworld.ts`**

```typescript
/**
 * Inworld streaming Text-to-Speech provider.
 *
 * Uses Inworld's WebSocket API for real-time TTS.
 * Sends text and receives binary LINEAR16 PCM audio (24kHz, 16-bit mono).
 * Latency: <120ms P90 with tts-1.5-mini model.
 *
 * Docs: https://inworld.ai/tts-api
 */

import WebSocket from "ws";
import type {
  TtsProvider,
  TtsProviderConfig,
  TtsProviderMeta,
  TtsAudioCallback,
  TtsDoneCallback,
} from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const INWORLD_WS_URL = "wss://api.inworld.ai/tts/v1/stream";

const DEFAULT_VOICE = "inworld.neutral";
const DEFAULT_MODEL = "tts-1.5-mini";

export class InworldTtsProvider implements TtsProvider {
  readonly id = "inworld";
  readonly name = "Inworld";
  readonly streaming = true;
  readonly outputSampleRate = 24000;

  onAudio: TtsAudioCallback | null = null;
  onDone: TtsDoneCallback | null = null;

  private apiKey: string;
  private voice: string;
  private model: string;
  private ws: WebSocket | null = null;
  private doneResolve: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  private audioChain: Promise<void> = Promise.resolve();
  private isFinalReceived = false;

  constructor(config: TtsProviderConfig) {
    this.apiKey = config.apiKey;
    this.voice = config.voiceId ?? DEFAULT_VOICE;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(INWORLD_WS_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "X-TTS-Voice": this.voice,
          "X-TTS-Model": this.model,
          "X-TTS-SampleRate": "24000",
          "X-TTS-Encoding": "LINEAR16",
        },
      });

      this.donePromise = new Promise<void>((res) => {
        this.doneResolve = res;
      });
      this.audioChain = Promise.resolve();
      this.isFinalReceived = false;

      this.ws.on("open", () => {
        console.log("[inworld-tts] Connected");
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[inworld-tts] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[inworld-tts] Connection closed");
        if (!this.isFinalReceived) {
          this.audioChain
            .then(() => this.fireDone())
            .catch(() => this.fireDone());
        }
      });
    });
  }

  async synthesize(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("[inworld-tts] Not connected");
    }
    this.ws.send(JSON.stringify({ text }));
  }

  async flush(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ end: true }));
    }
    if (this.donePromise) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn("[inworld-tts] Timeout waiting for audio completion");
          resolve();
        }, 30000);
      });
      await Promise.race([this.donePromise, timeout]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    // Try JSON first (status / done messages)
    try {
      const msg = JSON.parse(data.toString());
      if (msg.done || msg.end) {
        console.log("[inworld-tts] Stream complete");
        this.isFinalReceived = true;
        this.audioChain
          .then(() => this.fireDone())
          .catch(() => this.fireDone());
      }
      return;
    } catch {
      // Binary PCM (LINEAR16) audio data
    }

    if (data.length > 0 && this.onAudio) {
      const cb = this.onAudio;
      this.audioChain = this.audioChain
        .then(() => cb(data))
        .catch((err) => console.error("[inworld-tts] Audio callback error:", err));
    }
  }

  private fireDone(): void {
    if (this.onDone) {
      const result = this.onDone();
      if (result instanceof Promise) {
        result.catch((err) => console.error("[inworld-tts] Done callback error:", err));
      }
    }
    if (this.doneResolve) {
      this.doneResolve();
      this.doneResolve = null;
    }
  }
}

export const inworldMeta: TtsProviderMeta = {
  id: "inworld",
  name: "Inworld",
  description: "Ultra-low latency streaming TTS (<120ms). WebSocket with LINEAR16 PCM. Designed for voice agents.",
  streaming: true,
  envVar: "INWORLD_API_KEY",
  defaultVoiceId: DEFAULT_VOICE,
  defaultModel: DEFAULT_MODEL,
  outputSampleRate: 24000,
  docsUrl: "https://inworld.ai/tts-api",
};

ttsRegistry.register(inworldMeta, (config) => new InworldTtsProvider(config));
```

**Step 2: Add import to `extensions/esp32-voice/index.ts`**

After the `rime.js` import line, add:
```typescript
import "./src/tts/inworld.js";
```

**Step 3: Verify TypeScript compiles**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -30
```

**Step 4: Commit**

```bash
git add extensions/esp32-voice/src/tts/inworld.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Inworld TTS provider"
```

---

## Task 3: Add Cartesia TTS Provider

**Files:**
- Create: `extensions/esp32-voice/src/tts/cartesia.ts`
- Modify: `extensions/esp32-voice/index.ts` (add import line)

**Step 1: Create `extensions/esp32-voice/src/tts/cartesia.ts`**

```typescript
/**
 * Cartesia streaming Text-to-Speech provider.
 *
 * Uses Cartesia's WebSocket API for real-time TTS.
 * Sends text chunks and receives binary PCM audio (24kHz, 16-bit mono).
 * Latency: ~80ms. Production-grade, widely used in voice agent frameworks.
 *
 * WebSocket URL: wss://api.cartesia.ai/tts/websocket
 * Docs: https://docs.cartesia.ai
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";
import type {
  TtsProvider,
  TtsProviderConfig,
  TtsProviderMeta,
  TtsAudioCallback,
  TtsDoneCallback,
} from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const CARTESIA_WS_URL = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_API_VERSION = "2024-06-10";

const DEFAULT_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091"; // Barbershop Man
const DEFAULT_MODEL_ID = "sonic-english";

export class CartesiaTtsProvider implements TtsProvider {
  readonly id = "cartesia";
  readonly name = "Cartesia";
  readonly streaming = true;
  readonly outputSampleRate = 24000;

  onAudio: TtsAudioCallback | null = null;
  onDone: TtsDoneCallback | null = null;

  private apiKey: string;
  private voiceId: string;
  private modelId: string;
  private contextId: string = randomUUID();
  private ws: WebSocket | null = null;
  private doneResolve: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  private audioChain: Promise<void> = Promise.resolve();
  private isFinalReceived = false;

  constructor(config: TtsProviderConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId ?? DEFAULT_VOICE_ID;
    this.modelId = config.model ?? DEFAULT_MODEL_ID;
  }

  async connect(): Promise<void> {
    const url = `${CARTESIA_WS_URL}?api_key=${this.apiKey}&cartesia_version=${CARTESIA_API_VERSION}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.contextId = randomUUID();
      this.donePromise = new Promise<void>((res) => {
        this.doneResolve = res;
      });
      this.audioChain = Promise.resolve();
      this.isFinalReceived = false;

      this.ws.on("open", () => {
        console.log("[cartesia-tts] Connected");
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[cartesia-tts] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[cartesia-tts] Connection closed");
        if (!this.isFinalReceived) {
          this.audioChain
            .then(() => this.fireDone())
            .catch(() => this.fireDone());
        }
      });
    });
  }

  async synthesize(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("[cartesia-tts] Not connected");
    }

    const msg = {
      model_id: this.modelId,
      transcript: text,
      voice: { mode: "id", id: this.voiceId },
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: 24000,
      },
      context_id: this.contextId,
      continue: true,
    };

    this.ws.send(JSON.stringify(msg));
  }

  async flush(): Promise<void> {
    // Send final chunk with continue: false to signal end of input
    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg = {
        model_id: this.modelId,
        transcript: "",
        voice: { mode: "id", id: this.voiceId },
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: 24000,
        },
        context_id: this.contextId,
        continue: false,
      };
      this.ws.send(JSON.stringify(msg));
    }

    if (this.donePromise) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn("[cartesia-tts] Timeout waiting for audio completion");
          resolve();
        }, 30000);
      });
      await Promise.race([this.donePromise, timeout]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      // Cartesia sends audio as base64 in JSON envelope
      if (msg.type === "chunk" && msg.data) {
        const pcm = Buffer.from(msg.data, "base64");
        if (pcm.length > 0 && this.onAudio) {
          const cb = this.onAudio;
          this.audioChain = this.audioChain
            .then(() => cb(pcm))
            .catch((err) => console.error("[cartesia-tts] Audio callback error:", err));
        }
      }

      if (msg.type === "done") {
        console.log("[cartesia-tts] Stream complete");
        this.isFinalReceived = true;
        this.audioChain
          .then(() => this.fireDone())
          .catch(() => this.fireDone());
      }
    } catch {
      // Binary fallback — treat as raw PCM
      if (data.length > 0 && this.onAudio) {
        const cb = this.onAudio;
        this.audioChain = this.audioChain
          .then(() => cb(data))
          .catch((err) => console.error("[cartesia-tts] Audio callback error:", err));
      }
    }
  }

  private fireDone(): void {
    if (this.onDone) {
      const result = this.onDone();
      if (result instanceof Promise) {
        result.catch((err) => console.error("[cartesia-tts] Done callback error:", err));
      }
    }
    if (this.doneResolve) {
      this.doneResolve();
      this.doneResolve = null;
    }
  }
}

export const cartesiaMeta: TtsProviderMeta = {
  id: "cartesia",
  name: "Cartesia",
  description: "Production-grade streaming TTS with ~80ms latency. WebSocket with PCM output.",
  streaming: true,
  envVar: "CARTESIA_API_KEY",
  defaultVoiceId: DEFAULT_VOICE_ID,
  defaultModel: DEFAULT_MODEL_ID,
  outputSampleRate: 24000,
  docsUrl: "https://docs.cartesia.ai",
};

ttsRegistry.register(cartesiaMeta, (config) => new CartesiaTtsProvider(config));
```

**Step 2: Add import to `extensions/esp32-voice/index.ts`**

```typescript
import "./src/tts/cartesia.js";
```

**Step 3: Verify TypeScript compiles**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -30
```

**Step 4: Commit**

```bash
git add extensions/esp32-voice/src/tts/cartesia.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Cartesia TTS provider"
```

---

## Task 4: Add Smallest.ai TTS Provider

**Files:**
- Create: `extensions/esp32-voice/src/tts/smallest-ai.ts`
- Modify: `extensions/esp32-voice/index.ts` (add import line)

**Step 1: Create `extensions/esp32-voice/src/tts/smallest-ai.ts`**

```typescript
/**
 * Smallest.ai (Waves) streaming Text-to-Speech provider.
 *
 * Uses Smallest.ai's WebSocket API for real-time TTS.
 * Returns raw PCM audio at 24kHz (confirmed via docs).
 *
 * Note: 20-second inactivity timeout — connection is per-utterance.
 *
 * Docs: https://waves-docs.smallest.ai
 */

import WebSocket from "ws";
import type {
  TtsProvider,
  TtsProviderConfig,
  TtsProviderMeta,
  TtsAudioCallback,
  TtsDoneCallback,
} from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const SMALLEST_WS_URL = "wss://waves-api.smallest.ai/api/v1/lightning/get_speech";

const DEFAULT_VOICE_ID = "emily";
const DEFAULT_MODEL_ID = "lightning";

export class SmallestAiTtsProvider implements TtsProvider {
  readonly id = "smallest-ai";
  readonly name = "Smallest.ai";
  readonly streaming = true;
  readonly outputSampleRate = 24000;

  onAudio: TtsAudioCallback | null = null;
  onDone: TtsDoneCallback | null = null;

  private apiKey: string;
  private voiceId: string;
  private modelId: string;
  private textBuffer: string[] = [];
  private ws: WebSocket | null = null;
  private doneResolve: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  private audioChain: Promise<void> = Promise.resolve();
  private isFinalReceived = false;

  constructor(config: TtsProviderConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId ?? DEFAULT_VOICE_ID;
    this.modelId = config.model ?? DEFAULT_MODEL_ID;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(SMALLEST_WS_URL, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      this.textBuffer = [];
      this.donePromise = new Promise<void>((res) => {
        this.doneResolve = res;
      });
      this.audioChain = Promise.resolve();
      this.isFinalReceived = false;

      this.ws.on("open", () => {
        console.log("[smallest-ai-tts] Connected");
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[smallest-ai-tts] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[smallest-ai-tts] Connection closed");
        if (!this.isFinalReceived) {
          this.audioChain
            .then(() => this.fireDone())
            .catch(() => this.fireDone());
        }
      });
    });
  }

  async synthesize(text: string): Promise<void> {
    // Buffer text — Smallest.ai sends everything in the flush request
    this.textBuffer.push(text);
  }

  async flush(): Promise<void> {
    const fullText = this.textBuffer.join(" ").trim();
    this.textBuffer = [];

    if (this.ws?.readyState === WebSocket.OPEN && fullText) {
      const msg = {
        text: fullText,
        voice_id: this.voiceId,
        model: this.modelId,
        sample_rate: 24000,
        add_wav_header: false,  // raw PCM, no header
      };
      this.ws.send(JSON.stringify(msg));
    }

    if (this.donePromise) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn("[smallest-ai-tts] Timeout waiting for audio completion");
          resolve();
        }, 30000);
      });
      await Promise.race([this.donePromise, timeout]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      // Audio chunk: raw PCM bytes (not base64 — Smallest.ai docs confirm raw PCM)
      if (msg.audio && this.onAudio) {
        const pcm = Buffer.isBuffer(msg.audio)
          ? msg.audio
          : Buffer.from(msg.audio as string, "base64");
        if (pcm.length > 0) {
          const cb = this.onAudio;
          this.audioChain = this.audioChain
            .then(() => cb(pcm))
            .catch((err) => console.error("[smallest-ai-tts] Audio callback error:", err));
        }
      }

      if (msg.status === "complete" || msg.done) {
        console.log("[smallest-ai-tts] Stream complete");
        this.isFinalReceived = true;
        this.audioChain
          .then(() => this.fireDone())
          .catch(() => this.fireDone());
      }
    } catch {
      // Binary fallback — raw PCM bytes
      if (data.length > 0 && this.onAudio) {
        const cb = this.onAudio;
        this.audioChain = this.audioChain
          .then(() => cb(data))
          .catch((err) => console.error("[smallest-ai-tts] Audio callback error:", err));
      }
    }
  }

  private fireDone(): void {
    if (this.onDone) {
      const result = this.onDone();
      if (result instanceof Promise) {
        result.catch((err) => console.error("[smallest-ai-tts] Done callback error:", err));
      }
    }
    if (this.doneResolve) {
      this.doneResolve();
      this.doneResolve = null;
    }
  }
}

export const smallestAiMeta: TtsProviderMeta = {
  id: "smallest-ai",
  name: "Smallest.ai",
  description: "Streaming TTS with raw PCM output at 24kHz. Competitive pricing and low latency.",
  streaming: true,
  envVar: "SMALLEST_AI_API_KEY",
  defaultVoiceId: DEFAULT_VOICE_ID,
  defaultModel: DEFAULT_MODEL_ID,
  outputSampleRate: 24000,
  docsUrl: "https://waves-docs.smallest.ai",
};

ttsRegistry.register(smallestAiMeta, (config) => new SmallestAiTtsProvider(config));
```

**Step 2: Add import to `extensions/esp32-voice/index.ts`**

```typescript
import "./src/tts/smallest-ai.js";
```

**Step 3: Verify TypeScript compiles**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -30
```

**Step 4: Commit**

```bash
git add extensions/esp32-voice/src/tts/smallest-ai.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Smallest.ai TTS provider"
```

---

## Task 5: Add Groq PlayAI TTS Provider (batch HTTP)

**Files:**
- Create: `extensions/esp32-voice/src/tts/groq-playai.ts`
- Modify: `extensions/esp32-voice/index.ts` (add import line)

**Step 1: Create `extensions/esp32-voice/src/tts/groq-playai.ts`**

```typescript
/**
 * Groq PlayAI Text-to-Speech provider (batch HTTP).
 *
 * Uses Groq's OpenAI-compatible REST API. Not streaming — full audio
 * is synthesized before delivery begins. Best used as a low-cost fallback.
 *
 * Audio: WAV response → strip 44-byte header → raw PCM (24kHz, 16-bit mono).
 * No new npm dependencies — uses Node.js built-in https module.
 *
 * Docs: https://console.groq.com/docs/text-to-speech
 */

import https from "https";
import type {
  TtsProvider,
  TtsProviderConfig,
  TtsProviderMeta,
  TtsAudioCallback,
  TtsDoneCallback,
} from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const WAV_HEADER_BYTES = 44;
const GROQ_TTS_HOST = "api.groq.com";
const GROQ_TTS_PATH = "/openai/v1/audio/speech";

const DEFAULT_VOICE = "Fritz-PlayAI";
const DEFAULT_MODEL = "playai-tts";

export class GroqPlayAiTtsProvider implements TtsProvider {
  readonly id = "groq-playai";
  readonly name = "Groq PlayAI";
  readonly streaming = false;  // batch HTTP — not streaming
  readonly outputSampleRate = 24000;

  onAudio: TtsAudioCallback | null = null;
  onDone: TtsDoneCallback | null = null;

  private apiKey: string;
  private voice: string;
  private model: string;
  private textBuffer: string[] = [];

  constructor(config: TtsProviderConfig) {
    this.apiKey = config.apiKey;
    this.voice = config.voiceId ?? DEFAULT_VOICE;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  // No-op: HTTP is stateless
  async connect(): Promise<void> {
    console.log("[groq-playai-tts] Ready (batch HTTP mode)");
  }

  async synthesize(text: string): Promise<void> {
    this.textBuffer.push(text);
  }

  async flush(): Promise<void> {
    const fullText = this.textBuffer.join(" ").trim();
    this.textBuffer = [];

    if (!fullText) {
      this.fireDone();
      return;
    }

    const wavBuffer = await this.fetchWav(fullText);

    // Strip WAV header (44 bytes) to get raw PCM
    const pcm = wavBuffer.subarray(WAV_HEADER_BYTES);

    // Deliver in chunks (same size as voice-session frame buffer)
    const CHUNK_SIZE = 4096;
    for (let offset = 0; offset < pcm.length; offset += CHUNK_SIZE) {
      const chunk = pcm.subarray(offset, offset + CHUNK_SIZE);
      if (this.onAudio) {
        await this.onAudio(chunk);
      }
    }

    this.fireDone();
  }

  // No-op: nothing to close for HTTP
  async close(): Promise<void> {}

  private fetchWav(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: "wav",
        sample_rate: 24000,
      });

      const req = https.request(
        {
          hostname: GROQ_TTS_HOST,
          path: GROQ_TTS_PATH,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`[groq-playai-tts] HTTP ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      );

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private fireDone(): void {
    if (this.onDone) {
      const result = this.onDone();
      if (result instanceof Promise) {
        result.catch((err) => console.error("[groq-playai-tts] Done callback error:", err));
      }
    }
  }
}

export const groqPlayAiMeta: TtsProviderMeta = {
  id: "groq-playai",
  name: "Groq PlayAI",
  description: "Batch HTTP TTS via Groq. Lowest cost option. Higher latency than streaming providers (full synthesis before playback).",
  streaming: false,
  envVar: "GROQ_API_KEY",
  defaultVoiceId: DEFAULT_VOICE,
  defaultModel: DEFAULT_MODEL,
  outputSampleRate: 24000,
  docsUrl: "https://console.groq.com/docs/text-to-speech",
};

ttsRegistry.register(groqPlayAiMeta, (config) => new GroqPlayAiTtsProvider(config));
```

**Step 2: Add import to `extensions/esp32-voice/index.ts`**

```typescript
import "./src/tts/groq-playai.js";
```

**Step 3: Verify TypeScript compiles**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -30
```

**Step 4: Commit**

```bash
git add extensions/esp32-voice/src/tts/groq-playai.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Groq PlayAI TTS provider (batch HTTP)"
```

---

## Task 6: Update config-schema.ts

**Files:**
- Modify: `extensions/esp32-voice/src/config-schema.ts:23`

**Step 1: Read the file**

Read `extensions/esp32-voice/src/config-schema.ts` in full.

**Step 2: Replace the ttsProvider field**

Change line 23 from:
```typescript
ttsProvider: z.string().optional().default("elevenlabs"),
```
To:
```typescript
ttsProvider: z.enum([
  "elevenlabs",
  "rime",
  "inworld",
  "cartesia",
  "smallest-ai",
  "groq-playai",
]).optional().default("elevenlabs"),
```

**Step 3: Verify TypeScript compiles**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -30
```

**Step 4: Commit**

```bash
git add extensions/esp32-voice/src/config-schema.ts
git commit -m "feat(esp32-voice): add all 6 TTS providers to config schema enum"
```

---

## Task 7: Update onboarding wizard (stepTtsSetup)

**Files:**
- Modify: `extensions/esp32-voice/src/onboarding.ts` (lines 392–451)

**Step 1: Read the full file**

Read `extensions/esp32-voice/src/onboarding.ts` in full to understand the helper functions available (`getEnvValue`, `saveToEnv`, `formatDocsLink`, `prompter.select`, `prompter.text`, `prompter.note`, `prompter.confirm`).

**Step 2: Replace `stepTtsSetup` with the multi-provider version**

Replace the entire `stepTtsSetup` function (lines 392–451) with:

```typescript
// ── Step 3 — TTS Setup (multi-provider) ───────────────────────────────────────

const TTS_PROVIDERS_INFO = [
  {
    value: "elevenlabs",
    label: "ElevenLabs",
    hint: "Streaming, high quality, ~300ms",
    envVar: "ELEVENLABS_API_KEY",
    docsUrl: "https://elevenlabs.io/app/settings/api-keys",
    defaultVoice: "21m00Tcm4TlvDq8ikWAM",
    voiceHint: "21m00Tcm4TlvDq8ikWAM (Rachel)",
  },
  {
    value: "rime",
    label: "Rime",
    hint: "Streaming, native PCM, low latency",
    envVar: "RIME_API_KEY",
    docsUrl: "https://rime.ai/docs",
    defaultVoice: "arcas",
    voiceHint: "arcas",
  },
  {
    value: "inworld",
    label: "Inworld",
    hint: "Streaming, <120ms, best latency",
    envVar: "INWORLD_API_KEY",
    docsUrl: "https://inworld.ai/tts-api",
    defaultVoice: "inworld.neutral",
    voiceHint: "inworld.neutral",
  },
  {
    value: "cartesia",
    label: "Cartesia",
    hint: "Streaming, ~80ms, production-grade",
    envVar: "CARTESIA_API_KEY",
    docsUrl: "https://docs.cartesia.ai",
    defaultVoice: "a0e99841-438c-4a64-b679-ae501e7d6091",
    voiceHint: "a0e99841-... (Barbershop Man)",
  },
  {
    value: "smallest-ai",
    label: "Smallest.ai",
    hint: "Streaming, raw PCM, 24kHz",
    envVar: "SMALLEST_AI_API_KEY",
    docsUrl: "https://waves-docs.smallest.ai",
    defaultVoice: "emily",
    voiceHint: "emily",
  },
  {
    value: "groq-playai",
    label: "Groq PlayAI",
    hint: "Batch (cheapest), reuses GROQ_API_KEY",
    envVar: "GROQ_API_KEY",
    docsUrl: "https://console.groq.com/docs/text-to-speech",
    defaultVoice: "Fritz-PlayAI",
    voiceHint: "Fritz-PlayAI",
  },
] as const;

async function stepTtsSetup(prompter: WizardPrompter): Promise<void> {
  const currentProvider = getEnvValue("TTS_PROVIDER") ?? "elevenlabs";

  const selectedProvider = String(
    await prompter.select({
      message: "Which TTS provider do you want to use?",
      options: TTS_PROVIDERS_INFO.map((p) => ({
        value: p.value,
        label: `${p.label}`,
        hint: p.hint,
      })),
      initialValue: currentProvider,
    }),
  );

  const info = TTS_PROVIDERS_INFO.find((p) => p.value === selectedProvider)!;
  const existingKey = getEnvValue(info.envVar);

  if (existingKey) {
    const update = await prompter.confirm({
      message: `${info.label} API key already set (${existingKey.slice(0, 8)}...). Update it?`,
      initialValue: false,
    });
    if (!update) {
      saveToEnv({ TTS_PROVIDER: selectedProvider });
      await prompter.note(`✅ TTS provider set to ${info.label}.`, "TTS ready");
      return;
    }
  } else {
    await prompter.note(
      [
        `ESP32 Voice will use ${info.label} for Text-to-Speech (TTS).`,
        `You need a ${info.label} API key.`,
        "",
        `${formatDocsLink(info.docsUrl, `Get ${info.label} API key →`)}`,
      ].join("\n"),
      `TTS Setup — ${info.label}`,
    );
  }

  const key = String(
    await prompter.text({
      message: `${info.label} API key`,
      placeholder: "Your API key",
      validate: (v) => {
        if (!String(v ?? "").trim()) return "Required";
        return undefined;
      },
    }),
  ).trim();

  const voiceId = String(
    await prompter.text({
      message: `Voice ID (optional, press Enter for default: ${info.voiceHint})`,
      placeholder: info.defaultVoice,
      initialValue: getEnvValue(`${info.envVar.replace("_API_KEY", "")}_VOICE_ID`) ?? "",
    }),
  ).trim();

  const toSave: Record<string, string> = {
    TTS_PROVIDER: selectedProvider,
    [info.envVar]: key,
  };
  const voiceEnvKey = `${info.envVar.replace("_API_KEY", "")}_VOICE_ID`;
  if (voiceId) toSave[voiceEnvKey] = voiceId;
  saveToEnv(toSave);

  await prompter.note(`✅ ${info.label} API key saved.`, "TTS ready");
}
```

**Step 3: Update `getStatus` to check TTS_PROVIDER dynamically**

Find the `getStatus` function. Replace the hard-coded ElevenLabs check:
```typescript
// OLD:
const hasTTS = Boolean(getEnvValue("ELEVENLABS_API_KEY"));
lines.push(`  TTS (ElevenLabs): ${hasTTS ? "✅ configured" : "❌ missing key"}`);
```
With:
```typescript
// NEW:
const ttsProvider = getEnvValue("TTS_PROVIDER") ?? "elevenlabs";
const ttsMeta = TTS_PROVIDERS_INFO.find((p) => p.value === ttsProvider) ?? TTS_PROVIDERS_INFO[0];
const hasTTS = Boolean(getEnvValue(ttsMeta.envVar));
lines.push(`  TTS (${ttsMeta.label}): ${hasTTS ? "✅ configured" : "❌ missing key"}`);
```

**Step 4: Update the summary line** (line ~625)

Change:
```typescript
`  TTS          : ElevenLabs ${getEnvValue("ELEVENLABS_VOICE_ID") ?? "(default voice)"}`,
```
To:
```typescript
`  TTS          : ${ttsMeta?.label ?? "ElevenLabs"} (${getEnvValue(ttsMeta?.envVar?.replace("_API_KEY", "") + "_VOICE_ID") ?? "default voice"})`,
```

**Step 5: Verify TypeScript compiles**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -30
```

**Step 6: Commit**

```bash
git add extensions/esp32-voice/src/onboarding.ts
git commit -m "feat(esp32-voice): update onboarding wizard with multi-provider TTS selection"
```

---

## Task 8: Update .env.example

**Files:**
- Modify: `extensions/esp32-voice/.env.example`

**Step 1: Read `extensions/esp32-voice/.env.example`**

**Step 2: Add the new provider section after the ElevenLabs block**

Append this section to the end of the file:

```bash

# ── TTS Provider Selection ──────────────────────────────────────────────────────
# Choose your TTS provider. Options:
#   elevenlabs | rime | inworld | cartesia | smallest-ai | groq-playai
TTS_PROVIDER=elevenlabs

# ── Alternative TTS Providers (uncomment the one matching TTS_PROVIDER above) ──

# Rime — streaming, native PCM, low latency — https://rime.ai
# RIME_API_KEY=<your-rime-api-key>
# RIME_VOICE_ID=arcas

# Inworld — streaming, <120ms latency — https://inworld.ai/tts-api
# INWORLD_API_KEY=<your-inworld-api-key>
# INWORLD_VOICE_ID=inworld.neutral

# Cartesia — streaming, ~80ms, production-grade — https://docs.cartesia.ai
# CARTESIA_API_KEY=<your-cartesia-api-key>
# CARTESIA_VOICE_ID=a0e99841-438c-4a64-b679-ae501e7d6091

# Smallest.ai — streaming, raw PCM, 24kHz — https://waves-docs.smallest.ai
# SMALLEST_AI_API_KEY=<your-smallest-ai-api-key>
# SMALLEST_AI_VOICE_ID=emily

# Groq PlayAI — batch/cheapest, reuses GROQ_API_KEY if set for STT
# https://console.groq.com/docs/text-to-speech
# GROQ_API_KEY=<your-groq-api-key>
# GROQ_VOICE_ID=Fritz-PlayAI
```

**Step 3: Commit**

```bash
git add extensions/esp32-voice/.env.example
git commit -m "docs(esp32-voice): add alternative TTS provider env vars to .env.example"
```

---

## Task 9: Update TTS_PROVIDERS.md and prd.md

**Files:**
- Modify: `extensions/esp32-voice/TTS_PROVIDERS.md`
- Modify: `prd.md` (mark all tasks passes: true)

**Step 1: Read `extensions/esp32-voice/TTS_PROVIDERS.md`**

**Step 2: Add an "Implemented Providers" table at the top of section 5**

After the `## 5. Alternative Providers — Evaluation` heading, add:

```markdown
### Implemented Providers

All 5 providers below are implemented. Set `TTS_PROVIDER=<id>` in `~/.openclaw/.env` to activate.

| Provider | ID | Env Var | Streaming | Latency | File |
|----------|----|---------|-----------|---------|------|
| Rime | `rime` | `RIME_API_KEY` | Yes (WS) | Low | `src/tts/rime.ts` |
| Inworld | `inworld` | `INWORLD_API_KEY` | Yes (WS) | <120ms | `src/tts/inworld.ts` |
| Cartesia | `cartesia` | `CARTESIA_API_KEY` | Yes (WS) | ~80ms | `src/tts/cartesia.ts` |
| Smallest.ai | `smallest-ai` | `SMALLEST_AI_API_KEY` | Yes (WS) | Low | `src/tts/smallest-ai.ts` |
| Groq PlayAI | `groq-playai` | `GROQ_API_KEY` | No (batch) | High | `src/tts/groq-playai.ts` |

---
```

**Step 3: Commit**

```bash
git add extensions/esp32-voice/TTS_PROVIDERS.md
git commit -m "docs(esp32-voice): mark all 5 new TTS providers as implemented"
```

---

## Final Verification

After all tasks are complete, run:

```bash
cd extensions/esp32-voice && npx tsc --noEmit
```

Expected: clean compile (zero errors in new files).

Verify registry has all 6 providers by checking `index.ts` imports:

```bash
grep "src/tts" extensions/esp32-voice/index.ts
```

Expected output:
```
import "./src/tts/elevenlabs.js";
import "./src/tts/rime.js";
import "./src/tts/inworld.js";
import "./src/tts/cartesia.js";
import "./src/tts/smallest-ai.js";
import "./src/tts/groq-playai.js";
```
