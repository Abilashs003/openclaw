# Multi-Provider TTS Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Rime, Inworld, Cartesia, Smallest.ai, and Groq PlayAI as first-class TTS providers in the ESP32 voice plugin, with full onboarding wizard support and TDD test coverage.

**Architecture:** Flat one-file-per-provider pattern, identical to `elevenlabs.ts`. Each file implements `TtsProvider`, auto-registers via `ttsRegistry.register()`, and is imported in `index.ts`. No new runtime dependencies — WebSocket providers use `ws` (already installed); Groq PlayAI uses Node.js built-in `https`.

**Tech Stack:** TypeScript ESM, `ws` for WebSocket, Node.js `https` for Groq, Vitest for tests (ESM-native), `vi.mock` for WebSocket mocking, Zod for config schema, `@clack/prompts` for onboarding.

**Reference:** Always read `extensions/esp32-voice/src/tts/elevenlabs.ts` before writing any provider. It is the canonical implementation. Do not modify it.

**Design doc:** `docs/plans/2026-02-25-multi-tts-provider-design.md`

---

## Task 0: Set up Vitest test infrastructure

**Files:**
- Modify: `extensions/esp32-voice/package.json` (add vitest + scripts)
- Create: `extensions/esp32-voice/vitest.config.ts`
- Create: `extensions/esp32-voice/src/tts/__tests__/helpers/mock-ws.ts`

**Step 1: Add Vitest to package.json**

Edit `extensions/esp32-voice/package.json`. Add `scripts` block and vitest to devDependencies:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
},
```

Add to `devDependencies`:
```json
"vitest": "^2.0.0"
```

**Step 2: Create `extensions/esp32-voice/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
});
```

**Step 3: Install vitest**

```bash
cd extensions/esp32-voice && pnpm install
```

**Step 4: Create shared mock WebSocket helper**

Create `extensions/esp32-voice/src/tts/__tests__/helpers/mock-ws.ts`:

```typescript
/**
 * Shared mock WebSocket factory for TTS provider tests.
 *
 * Usage:
 *   vi.mock("ws");
 *   import WebSocket from "ws";
 *   const { mockWs, triggerOpen, triggerMessage, triggerClose } = setupMockWs();
 */
import { vi } from "vitest";

export interface MockWsHandle {
  mockWs: {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    readyState: number;
    on: ReturnType<typeof vi.fn>;
  };
  triggerOpen: () => void;
  triggerMessage: (data: Buffer | string) => void;
  triggerClose: () => void;
  triggerError: (err: Error) => void;
}

export function setupMockWs(): MockWsHandle {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  const mockWs = {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // WebSocket.OPEN
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
  };

  const trigger = (event: string, ...args: unknown[]) => {
    (handlers[event] ?? []).forEach((h) => h(...args));
  };

  return {
    mockWs,
    triggerOpen: () => trigger("open"),
    triggerMessage: (data: Buffer | string) =>
      trigger("message", typeof data === "string" ? Buffer.from(data) : data),
    triggerClose: () => trigger("close"),
    triggerError: (err: Error) => trigger("error", err),
  };
}
```

**Step 5: Run tests to verify setup**

```bash
cd extensions/esp32-voice && pnpm test
```

Expected: `0 tests, 0 failures` (no test files yet — just confirming Vitest runs)

**Step 6: Commit**

```bash
git add extensions/esp32-voice/package.json extensions/esp32-voice/vitest.config.ts extensions/esp32-voice/src/tts/__tests__/helpers/mock-ws.ts
git commit -m "test(esp32-voice): set up Vitest test infrastructure with mock WebSocket helper"
```

---

## Task 1: Add Rime TTS Provider (TDD)

**Files:**
- Create: `extensions/esp32-voice/src/tts/__tests__/rime.test.ts`
- Create: `extensions/esp32-voice/src/tts/rime.ts`
- Modify: `extensions/esp32-voice/index.ts`

**Step 1: Write the failing test**

Create `extensions/esp32-voice/src/tts/__tests__/rime.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupMockWs } from "./helpers/mock-ws.js";

vi.mock("ws");

describe("RimeTtsProvider", () => {
  let WsMock: ReturnType<typeof vi.fn>;
  let mockWsHandle: ReturnType<typeof setupMockWs>;

  beforeEach(async () => {
    vi.resetModules();
    mockWsHandle = setupMockWs();
    const wsModule = await import("ws");
    WsMock = vi.fn(() => mockWsHandle.mockWs);
    (wsModule as unknown as { default: unknown }).default = WsMock;
  });

  it("connects with correct URL and Bearer auth header", async () => {
    const { RimeTtsProvider } = await import("../rime.js");
    const provider = new RimeTtsProvider({ apiKey: "test-key" });

    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    expect(WsMock).toHaveBeenCalledWith(
      expect.stringContaining("wss://users.rime.ai/v1/rime-tts"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      })
    );
  });

  it("sends text in synthesize()", async () => {
    const { RimeTtsProvider } = await import("../rime.js");
    const provider = new RimeTtsProvider({ apiKey: "test-key" });
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    await provider.synthesize("hello world");

    expect(mockWsHandle.mockWs.send).toHaveBeenCalledWith(
      expect.stringContaining("hello world")
    );
  });

  it("sends EOS in flush()", async () => {
    const { RimeTtsProvider } = await import("../rime.js");
    const provider = new RimeTtsProvider({ apiKey: "test-key" });
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    // Trigger done immediately
    const flushPromise = provider.flush();
    mockWsHandle.triggerMessage(JSON.stringify({ done: true }));
    await flushPromise;

    expect(mockWsHandle.mockWs.send).toHaveBeenCalledWith(
      expect.stringContaining("eos")
    );
  });

  it("delivers binary PCM frames via onAudio", async () => {
    const { RimeTtsProvider } = await import("../rime.js");
    const provider = new RimeTtsProvider({ apiKey: "test-key" });
    const onAudio = vi.fn();
    provider.onAudio = onAudio;

    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const pcmData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    mockWsHandle.triggerMessage(pcmData);
    // Allow audioChain to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(onAudio).toHaveBeenCalledWith(pcmData);
  });

  it("calls onDone after isFinal signal", async () => {
    const { RimeTtsProvider } = await import("../rime.js");
    const provider = new RimeTtsProvider({ apiKey: "test-key" });
    const onDone = vi.fn();
    provider.onDone = onDone;

    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const flushPromise = provider.flush();
    mockWsHandle.triggerMessage(JSON.stringify({ done: true }));
    await flushPromise;

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("has correct metadata: id, streaming, outputSampleRate", async () => {
    const { RimeTtsProvider } = await import("../rime.js");
    const p = new RimeTtsProvider({ apiKey: "k" });
    expect(p.id).toBe("rime");
    expect(p.streaming).toBe(true);
    expect(p.outputSampleRate).toBe(24000);
  });
});
```

**Step 2: Run test — verify it FAILS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/rime.test.ts
```

Expected: `FAIL — Cannot find module '../rime.js'`

**Step 3: Create `extensions/esp32-voice/src/tts/rime.ts`**

```typescript
/**
 * Rime streaming Text-to-Speech provider.
 *
 * Uses Rime's WebSocket API for real-time TTS.
 * Sends text and receives binary PCM audio (24kHz, 16-bit mono).
 * Uses reduceLatency=true for voice assistant use cases.
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

      this.donePromise = new Promise<void>((res) => { this.doneResolve = res; });
      this.audioChain = Promise.resolve();
      this.isFinalReceived = false;

      this.ws.on("open", () => { console.log("[rime-tts] Connected"); resolve(); });
      this.ws.on("message", (data: Buffer) => { this.handleMessage(data); });
      this.ws.on("error", (err) => { console.error("[rime-tts] WS error:", err.message); reject(err); });
      this.ws.on("close", () => {
        console.log("[rime-tts] Connection closed");
        if (!this.isFinalReceived) {
          this.audioChain.then(() => this.fireDone()).catch(() => this.fireDone());
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
      const timeout = new Promise<void>((r) => setTimeout(() => { console.warn("[rime-tts] Timeout"); r(); }, 30000));
      await Promise.race([this.donePromise, timeout]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.done || msg.eos) {
        console.log("[rime-tts] Stream complete");
        this.isFinalReceived = true;
        this.audioChain.then(() => this.fireDone()).catch(() => this.fireDone());
        return;
      }
    } catch {
      // Not JSON — binary PCM audio
    }
    if (data.length > 0 && this.onAudio) {
      const cb = this.onAudio;
      this.audioChain = this.audioChain
        .then(() => cb(data))
        .catch((err) => console.error("[rime-tts] Audio callback error:", err));
    }
  }

  private fireDone(): void {
    if (this.onDone) {
      const r = this.onDone();
      if (r instanceof Promise) r.catch((e) => console.error("[rime-tts] Done callback error:", e));
    }
    if (this.doneResolve) { this.doneResolve(); this.doneResolve = null; }
  }
}

export const rimeMeta: TtsProviderMeta = {
  id: "rime",
  name: "Rime",
  description: "Streaming TTS with native PCM output and reduceLatency mode for voice assistants.",
  streaming: true,
  envVar: "RIME_API_KEY",
  defaultVoiceId: DEFAULT_VOICE_ID,
  defaultModel: DEFAULT_MODEL_ID,
  outputSampleRate: 24000,
  docsUrl: "https://rime.ai/docs",
};

ttsRegistry.register(rimeMeta, (config) => new RimeTtsProvider(config));
```

**Step 4: Run tests — verify they PASS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/rime.test.ts
```

Expected: `6 tests passed`

**Step 5: TypeScript check**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors in rime.ts

**Step 6: Add import to `index.ts`**

After `import "./src/tts/elevenlabs.js";`, add:
```typescript
import "./src/tts/rime.js";
```

**Step 7: Commit**

```bash
git add extensions/esp32-voice/src/tts/rime.ts extensions/esp32-voice/src/tts/__tests__/rime.test.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Rime TTS provider with tests"
```

---

## Task 2: Add Inworld TTS Provider (TDD)

**Files:**
- Create: `extensions/esp32-voice/src/tts/__tests__/inworld.test.ts`
- Create: `extensions/esp32-voice/src/tts/inworld.ts`
- Modify: `extensions/esp32-voice/index.ts`

**Step 1: Write the failing test**

Create `extensions/esp32-voice/src/tts/__tests__/inworld.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupMockWs } from "./helpers/mock-ws.js";

vi.mock("ws");

describe("InworldTtsProvider", () => {
  let WsMock: ReturnType<typeof vi.fn>;
  let mockWsHandle: ReturnType<typeof setupMockWs>;

  beforeEach(async () => {
    vi.resetModules();
    mockWsHandle = setupMockWs();
    const wsModule = await import("ws");
    WsMock = vi.fn(() => mockWsHandle.mockWs);
    (wsModule as unknown as { default: unknown }).default = WsMock;
  });

  it("connects with Authorization header and TTS config headers", async () => {
    const { InworldTtsProvider } = await import("../inworld.js");
    const provider = new InworldTtsProvider({ apiKey: "iw-key", voiceId: "inworld.neutral" });

    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    expect(WsMock).toHaveBeenCalledWith(
      expect.stringContaining("inworld.ai"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer iw-key",
          "X-TTS-SampleRate": "24000",
        }),
      })
    );
  });

  it("sends text JSON in synthesize()", async () => {
    const { InworldTtsProvider } = await import("../inworld.js");
    const provider = new InworldTtsProvider({ apiKey: "k" });
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    await provider.synthesize("test text");
    expect(mockWsHandle.mockWs.send).toHaveBeenCalledWith(
      expect.stringContaining("test text")
    );
  });

  it("delivers binary PCM via onAudio callback", async () => {
    const { InworldTtsProvider } = await import("../inworld.js");
    const provider = new InworldTtsProvider({ apiKey: "k" });
    const onAudio = vi.fn();
    provider.onAudio = onAudio;
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const pcm = Buffer.from([0xAA, 0xBB, 0xCC]);
    mockWsHandle.triggerMessage(pcm);
    await new Promise((r) => setTimeout(r, 10));

    expect(onAudio).toHaveBeenCalledWith(pcm);
  });

  it("calls onDone on done signal", async () => {
    const { InworldTtsProvider } = await import("../inworld.js");
    const provider = new InworldTtsProvider({ apiKey: "k" });
    const onDone = vi.fn();
    provider.onDone = onDone;
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const flushPromise = provider.flush();
    mockWsHandle.triggerMessage(JSON.stringify({ done: true }));
    await flushPromise;

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("has correct metadata", async () => {
    const { InworldTtsProvider } = await import("../inworld.js");
    const p = new InworldTtsProvider({ apiKey: "k" });
    expect(p.id).toBe("inworld");
    expect(p.streaming).toBe(true);
    expect(p.outputSampleRate).toBe(24000);
  });
});
```

**Step 2: Run test — verify it FAILS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/inworld.test.ts
```

Expected: `FAIL — Cannot find module '../inworld.js'`

**Step 3: Create `extensions/esp32-voice/src/tts/inworld.ts`**

```typescript
/**
 * Inworld streaming Text-to-Speech provider.
 *
 * WebSocket streaming TTS with LINEAR16 PCM output.
 * Latency: <120ms P90 with tts-1.5-mini model.
 *
 * Docs: https://inworld.ai/tts-api
 */

import WebSocket from "ws";
import type { TtsProvider, TtsProviderConfig, TtsProviderMeta, TtsAudioCallback, TtsDoneCallback } from "./tts-provider.js";
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

      this.donePromise = new Promise<void>((res) => { this.doneResolve = res; });
      this.audioChain = Promise.resolve();
      this.isFinalReceived = false;

      this.ws.on("open", () => { console.log("[inworld-tts] Connected"); resolve(); });
      this.ws.on("message", (data: Buffer) => { this.handleMessage(data); });
      this.ws.on("error", (err) => { console.error("[inworld-tts] WS error:", err.message); reject(err); });
      this.ws.on("close", () => {
        console.log("[inworld-tts] Closed");
        if (!this.isFinalReceived) this.audioChain.then(() => this.fireDone()).catch(() => this.fireDone());
      });
    });
  }

  async synthesize(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("[inworld-tts] Not connected");
    this.ws.send(JSON.stringify({ text }));
  }

  async flush(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ end: true }));
    if (this.donePromise) {
      const timeout = new Promise<void>((r) => setTimeout(() => { console.warn("[inworld-tts] Timeout"); r(); }, 30000));
      await Promise.race([this.donePromise, timeout]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.done || msg.end) {
        console.log("[inworld-tts] Stream complete");
        this.isFinalReceived = true;
        this.audioChain.then(() => this.fireDone()).catch(() => this.fireDone());
        return;
      }
    } catch { /* binary PCM */ }
    if (data.length > 0 && this.onAudio) {
      const cb = this.onAudio;
      this.audioChain = this.audioChain.then(() => cb(data)).catch((e) => console.error("[inworld-tts] Audio error:", e));
    }
  }

  private fireDone(): void {
    if (this.onDone) { const r = this.onDone(); if (r instanceof Promise) r.catch((e) => console.error("[inworld-tts] Done error:", e)); }
    if (this.doneResolve) { this.doneResolve(); this.doneResolve = null; }
  }
}

export const inworldMeta: TtsProviderMeta = {
  id: "inworld", name: "Inworld",
  description: "Ultra-low latency streaming TTS (<120ms). WebSocket with LINEAR16 PCM. Built for voice agents.",
  streaming: true, envVar: "INWORLD_API_KEY",
  defaultVoiceId: DEFAULT_VOICE, defaultModel: DEFAULT_MODEL,
  outputSampleRate: 24000, docsUrl: "https://inworld.ai/tts-api",
};

ttsRegistry.register(inworldMeta, (config) => new InworldTtsProvider(config));
```

**Step 4: Run tests — verify they PASS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/inworld.test.ts
```

Expected: `5 tests passed`

**Step 5: Add import to index.ts, then commit**

```bash
# Add after rime.js import:
# import "./src/tts/inworld.js";

git add extensions/esp32-voice/src/tts/inworld.ts extensions/esp32-voice/src/tts/__tests__/inworld.test.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Inworld TTS provider with tests"
```

---

## Task 3: Add Cartesia TTS Provider (TDD)

**Files:**
- Create: `extensions/esp32-voice/src/tts/__tests__/cartesia.test.ts`
- Create: `extensions/esp32-voice/src/tts/cartesia.ts`
- Modify: `extensions/esp32-voice/index.ts`

**Step 1: Write the failing test**

Create `extensions/esp32-voice/src/tts/__tests__/cartesia.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupMockWs } from "./helpers/mock-ws.js";

vi.mock("ws");
vi.mock("crypto", () => ({ randomUUID: () => "test-uuid-1234" }));

describe("CartesiaTtsProvider", () => {
  let WsMock: ReturnType<typeof vi.fn>;
  let mockWsHandle: ReturnType<typeof setupMockWs>;

  beforeEach(async () => {
    vi.resetModules();
    mockWsHandle = setupMockWs();
    const wsModule = await import("ws");
    WsMock = vi.fn(() => mockWsHandle.mockWs);
    (wsModule as unknown as { default: unknown }).default = WsMock;
  });

  it("connects with api_key in URL query param", async () => {
    const { CartesiaTtsProvider } = await import("../cartesia.js");
    const provider = new CartesiaTtsProvider({ apiKey: "cart-key" });

    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const url: string = WsMock.mock.calls[0][0];
    expect(url).toContain("api.cartesia.ai/tts/websocket");
    expect(url).toContain("api_key=cart-key");
  });

  it("synthesize sends correct JSON with context_id and output_format", async () => {
    const { CartesiaTtsProvider } = await import("../cartesia.js");
    const provider = new CartesiaTtsProvider({ apiKey: "k", voiceId: "voice-123" });
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    await provider.synthesize("say this");

    const sent = JSON.parse(mockWsHandle.mockWs.send.mock.calls[0][0]);
    expect(sent.transcript).toBe("say this");
    expect(sent.context_id).toBe("test-uuid-1234");
    expect(sent.output_format.encoding).toBe("pcm_s16le");
    expect(sent.output_format.sample_rate).toBe(24000);
    expect(sent.continue).toBe(true);
  });

  it("flush sends continue:false final message", async () => {
    const { CartesiaTtsProvider } = await import("../cartesia.js");
    const provider = new CartesiaTtsProvider({ apiKey: "k" });
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const flushPromise = provider.flush();
    // Trigger done via JSON message
    mockWsHandle.triggerMessage(JSON.stringify({ type: "done" }));
    await flushPromise;

    const lastCall = mockWsHandle.mockWs.send.mock.calls.at(-1);
    const lastMsg = JSON.parse(lastCall[0]);
    expect(lastMsg.continue).toBe(false);
  });

  it("delivers base64 audio chunks via onAudio", async () => {
    const { CartesiaTtsProvider } = await import("../cartesia.js");
    const provider = new CartesiaTtsProvider({ apiKey: "k" });
    const onAudio = vi.fn();
    provider.onAudio = onAudio;
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const pcm = Buffer.from([0x10, 0x20, 0x30]);
    mockWsHandle.triggerMessage(JSON.stringify({ type: "chunk", data: pcm.toString("base64") }));
    await new Promise((r) => setTimeout(r, 10));

    expect(onAudio).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it("calls onDone on type:done message", async () => {
    const { CartesiaTtsProvider } = await import("../cartesia.js");
    const provider = new CartesiaTtsProvider({ apiKey: "k" });
    const onDone = vi.fn();
    provider.onDone = onDone;
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const flushPromise = provider.flush();
    mockWsHandle.triggerMessage(JSON.stringify({ type: "done" }));
    await flushPromise;

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("has correct metadata", async () => {
    const { CartesiaTtsProvider } = await import("../cartesia.js");
    const p = new CartesiaTtsProvider({ apiKey: "k" });
    expect(p.id).toBe("cartesia");
    expect(p.streaming).toBe(true);
    expect(p.outputSampleRate).toBe(24000);
  });
});
```

**Step 2: Run test — verify it FAILS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/cartesia.test.ts
```

**Step 3: Create `extensions/esp32-voice/src/tts/cartesia.ts`**

```typescript
/**
 * Cartesia streaming Text-to-Speech provider.
 *
 * ~80ms latency, WebSocket, binary PCM via base64 JSON envelope.
 * Docs: https://docs.cartesia.ai
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";
import type { TtsProvider, TtsProviderConfig, TtsProviderMeta, TtsAudioCallback, TtsDoneCallback } from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const CARTESIA_WS_URL = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_API_VERSION = "2024-06-10";
const DEFAULT_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091";
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
      this.donePromise = new Promise<void>((res) => { this.doneResolve = res; });
      this.audioChain = Promise.resolve();
      this.isFinalReceived = false;

      this.ws.on("open", () => { console.log("[cartesia-tts] Connected"); resolve(); });
      this.ws.on("message", (data: Buffer) => { this.handleMessage(data); });
      this.ws.on("error", (err) => { console.error("[cartesia-tts] WS error:", err.message); reject(err); });
      this.ws.on("close", () => {
        console.log("[cartesia-tts] Closed");
        if (!this.isFinalReceived) this.audioChain.then(() => this.fireDone()).catch(() => this.fireDone());
      });
    });
  }

  async synthesize(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("[cartesia-tts] Not connected");
    this.ws.send(JSON.stringify({
      model_id: this.modelId, transcript: text,
      voice: { mode: "id", id: this.voiceId },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
      context_id: this.contextId, continue: true,
    }));
  }

  async flush(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        model_id: this.modelId, transcript: "",
        voice: { mode: "id", id: this.voiceId },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
        context_id: this.contextId, continue: false,
      }));
    }
    if (this.donePromise) {
      const timeout = new Promise<void>((r) => setTimeout(() => { console.warn("[cartesia-tts] Timeout"); r(); }, 30000));
      await Promise.race([this.donePromise, timeout]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "chunk" && msg.data) {
        const pcm = Buffer.from(msg.data, "base64");
        if (pcm.length > 0 && this.onAudio) {
          const cb = this.onAudio;
          this.audioChain = this.audioChain.then(() => cb(pcm)).catch((e) => console.error("[cartesia-tts] Audio error:", e));
        }
      }
      if (msg.type === "done") {
        console.log("[cartesia-tts] Stream complete");
        this.isFinalReceived = true;
        this.audioChain.then(() => this.fireDone()).catch(() => this.fireDone());
      }
    } catch {
      if (data.length > 0 && this.onAudio) {
        const cb = this.onAudio;
        this.audioChain = this.audioChain.then(() => cb(data)).catch((e) => console.error("[cartesia-tts] Audio error:", e));
      }
    }
  }

  private fireDone(): void {
    if (this.onDone) { const r = this.onDone(); if (r instanceof Promise) r.catch((e) => console.error("[cartesia-tts] Done error:", e)); }
    if (this.doneResolve) { this.doneResolve(); this.doneResolve = null; }
  }
}

export const cartesiaMeta: TtsProviderMeta = {
  id: "cartesia", name: "Cartesia",
  description: "Production-grade streaming TTS with ~80ms latency. PCM via base64 JSON envelope.",
  streaming: true, envVar: "CARTESIA_API_KEY",
  defaultVoiceId: DEFAULT_VOICE_ID, defaultModel: DEFAULT_MODEL_ID,
  outputSampleRate: 24000, docsUrl: "https://docs.cartesia.ai",
};

ttsRegistry.register(cartesiaMeta, (config) => new CartesiaTtsProvider(config));
```

**Step 4: Run tests — verify they PASS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/cartesia.test.ts
```

Expected: `6 tests passed`

**Step 5: Add import + commit**

```bash
# Add to index.ts: import "./src/tts/cartesia.js";

git add extensions/esp32-voice/src/tts/cartesia.ts extensions/esp32-voice/src/tts/__tests__/cartesia.test.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Cartesia TTS provider with tests"
```

---

## Task 4: Add Smallest.ai TTS Provider (TDD)

**Files:**
- Create: `extensions/esp32-voice/src/tts/__tests__/smallest-ai.test.ts`
- Create: `extensions/esp32-voice/src/tts/smallest-ai.ts`
- Modify: `extensions/esp32-voice/index.ts`

**Step 1: Write the failing test**

Create `extensions/esp32-voice/src/tts/__tests__/smallest-ai.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupMockWs } from "./helpers/mock-ws.js";

vi.mock("ws");

describe("SmallestAiTtsProvider", () => {
  let WsMock: ReturnType<typeof vi.fn>;
  let mockWsHandle: ReturnType<typeof setupMockWs>;

  beforeEach(async () => {
    vi.resetModules();
    mockWsHandle = setupMockWs();
    const wsModule = await import("ws");
    WsMock = vi.fn(() => mockWsHandle.mockWs);
    (wsModule as unknown as { default: unknown }).default = WsMock;
  });

  it("connects with Bearer auth header", async () => {
    const { SmallestAiTtsProvider } = await import("../smallest-ai.js");
    const provider = new SmallestAiTtsProvider({ apiKey: "sa-key" });
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    expect(WsMock).toHaveBeenCalledWith(
      expect.stringContaining("smallest.ai"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sa-key" }) })
    );
  });

  it("buffers text in synthesize and sends in flush", async () => {
    const { SmallestAiTtsProvider } = await import("../smallest-ai.js");
    const provider = new SmallestAiTtsProvider({ apiKey: "k", voiceId: "emily" });
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    await provider.synthesize("hello");
    await provider.synthesize("world");

    // Trigger flush — sends buffered text
    const flushPromise = provider.flush();
    mockWsHandle.triggerMessage(JSON.stringify({ status: "complete" }));
    await flushPromise;

    const sent = JSON.parse(mockWsHandle.mockWs.send.mock.calls[0][0]);
    expect(sent.text).toContain("hello");
    expect(sent.text).toContain("world");
    expect(sent.sample_rate).toBe(24000);
    expect(sent.add_wav_header).toBe(false);
  });

  it("delivers raw PCM via onAudio", async () => {
    const { SmallestAiTtsProvider } = await import("../smallest-ai.js");
    const provider = new SmallestAiTtsProvider({ apiKey: "k" });
    const onAudio = vi.fn();
    provider.onAudio = onAudio;
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    // Trigger flush to send request
    const flushPromise = provider.flush();
    const pcm = Buffer.from([0xAA, 0xBB]);
    // Send audio chunk then complete
    mockWsHandle.triggerMessage(JSON.stringify({ audio: pcm.toString("base64") }));
    mockWsHandle.triggerMessage(JSON.stringify({ status: "complete" }));
    await flushPromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(onAudio).toHaveBeenCalled();
  });

  it("calls onDone on status:complete", async () => {
    const { SmallestAiTtsProvider } = await import("../smallest-ai.js");
    const provider = new SmallestAiTtsProvider({ apiKey: "k" });
    const onDone = vi.fn();
    provider.onDone = onDone;
    const connectPromise = provider.connect();
    mockWsHandle.triggerOpen();
    await connectPromise;

    const flushPromise = provider.flush();
    mockWsHandle.triggerMessage(JSON.stringify({ status: "complete" }));
    await flushPromise;

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("has correct metadata", async () => {
    const { SmallestAiTtsProvider } = await import("../smallest-ai.js");
    const p = new SmallestAiTtsProvider({ apiKey: "k" });
    expect(p.id).toBe("smallest-ai");
    expect(p.streaming).toBe(true);
    expect(p.outputSampleRate).toBe(24000);
  });
});
```

**Step 2: Run test — verify FAILS, then implement `smallest-ai.ts`** (follow same pattern as Rime/Inworld providers above, buffer text in `synthesize()`, send in `flush()`, handle `status: "complete"` as done signal, decode base64 audio chunks via `onAudio`)

**Step 3: Run tests — verify PASS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/smallest-ai.test.ts
```

**Step 4: Add import + commit**

```bash
git add extensions/esp32-voice/src/tts/smallest-ai.ts extensions/esp32-voice/src/tts/__tests__/smallest-ai.test.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Smallest.ai TTS provider with tests"
```

---

## Task 5: Add Groq PlayAI TTS Provider (TDD)

**Files:**
- Create: `extensions/esp32-voice/src/tts/__tests__/groq-playai.test.ts`
- Create: `extensions/esp32-voice/src/tts/groq-playai.ts`
- Modify: `extensions/esp32-voice/index.ts`

**Step 1: Write the failing test**

Create `extensions/esp32-voice/src/tts/__tests__/groq-playai.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("https");

describe("GroqPlayAiTtsProvider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is not streaming (batch HTTP)", async () => {
    const { GroqPlayAiTtsProvider } = await import("../groq-playai.js");
    const p = new GroqPlayAiTtsProvider({ apiKey: "k" });
    expect(p.streaming).toBe(false);
    expect(p.id).toBe("groq-playai");
    expect(p.outputSampleRate).toBe(24000);
  });

  it("connect() is a no-op (resolves immediately)", async () => {
    const { GroqPlayAiTtsProvider } = await import("../groq-playai.js");
    const p = new GroqPlayAiTtsProvider({ apiKey: "k" });
    await expect(p.connect()).resolves.toBeUndefined();
  });

  it("strips 44-byte WAV header and delivers raw PCM via onAudio", async () => {
    const https = await import("https");
    const { GroqPlayAiTtsProvider } = await import("../groq-playai.js");

    // Build a fake WAV: 44-byte header + 8 bytes PCM data
    const header = Buffer.alloc(44, 0x00);
    const pcmData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const fakeWav = Buffer.concat([header, pcmData]);

    // Mock https.request to return fakeWav
    vi.spyOn(https, "request").mockImplementation(((_opts, cb) => {
      const res = {
        statusCode: 200,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === "data") handler(fakeWav);
          if (event === "end") handler();
        }),
      };
      (cb as (res: unknown) => void)(res);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    }) as typeof https.request);

    const provider = new GroqPlayAiTtsProvider({ apiKey: "groq-key" });
    const onAudio = vi.fn();
    provider.onAudio = onAudio;

    await provider.synthesize("test");
    await provider.flush();

    // All calls to onAudio combined should equal the raw PCM (no header)
    const allPcm = Buffer.concat(onAudio.mock.calls.map((c) => c[0] as Buffer));
    expect(allPcm).toEqual(pcmData);
  });

  it("calls onDone after all PCM delivered", async () => {
    const https = await import("https");
    const { GroqPlayAiTtsProvider } = await import("../groq-playai.js");

    const fakeWav = Buffer.alloc(44 + 100, 0x00);
    vi.spyOn(https, "request").mockImplementation(((_opts, cb) => {
      const res = {
        statusCode: 200,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === "data") handler(fakeWav);
          if (event === "end") handler();
        }),
      };
      (cb as (res: unknown) => void)(res);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    }) as typeof https.request);

    const provider = new GroqPlayAiTtsProvider({ apiKey: "k" });
    const onDone = vi.fn();
    provider.onDone = onDone;

    await provider.synthesize("hello");
    await provider.flush();

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("sends correct request body to Groq API", async () => {
    const https = await import("https");
    const { GroqPlayAiTtsProvider } = await import("../groq-playai.js");

    let capturedBody = "";
    const mockReq = { on: vi.fn(), write: vi.fn((b: string) => { capturedBody = b; }), end: vi.fn() };

    vi.spyOn(https, "request").mockImplementation(((_opts, cb) => {
      const res = {
        statusCode: 200,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === "data") handler(Buffer.alloc(44));
          if (event === "end") handler();
        }),
      };
      (cb as (res: unknown) => void)(res);
      return mockReq;
    }) as typeof https.request);

    const provider = new GroqPlayAiTtsProvider({ apiKey: "k", voiceId: "Fritz-PlayAI" });
    await provider.synthesize("hello groq");
    await provider.flush();

    const body = JSON.parse(capturedBody);
    expect(body.model).toBe("playai-tts");
    expect(body.input).toContain("hello groq");
    expect(body.response_format).toBe("wav");
    expect(body.sample_rate).toBe(24000);
    expect(body.voice).toBe("Fritz-PlayAI");
  });
});
```

**Step 2: Run test — verify FAILS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/groq-playai.test.ts
```

**Step 3: Create `extensions/esp32-voice/src/tts/groq-playai.ts`**

(Follow the design doc: HTTP POST, strip 44-byte WAV header, chunk PCM via `onAudio`, call `onDone`. `connect()` and `close()` are no-ops.)

**Step 4: Run tests — verify PASS**

```bash
cd extensions/esp32-voice && pnpm test src/tts/__tests__/groq-playai.test.ts
```

Expected: `5 tests passed`

**Step 5: Add import + commit**

```bash
git add extensions/esp32-voice/src/tts/groq-playai.ts extensions/esp32-voice/src/tts/__tests__/groq-playai.test.ts extensions/esp32-voice/index.ts
git commit -m "feat(esp32-voice): add Groq PlayAI TTS provider with tests (batch HTTP)"
```

---

## Task 6: Run full test suite

**Step 1: Run all TTS provider tests together**

```bash
cd extensions/esp32-voice && pnpm test
```

Expected: all tests pass, 0 failures

**Step 2: TypeScript check**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors

**Step 3: Verify all 6 providers registered in index.ts**

```bash
grep "src/tts" extensions/esp32-voice/index.ts
```

Expected:
```
import "./src/tts/elevenlabs.js";
import "./src/tts/rime.js";
import "./src/tts/inworld.js";
import "./src/tts/cartesia.js";
import "./src/tts/smallest-ai.js";
import "./src/tts/groq-playai.js";
```

**Step 4: Commit**

```bash
git add -A
git commit -m "test(esp32-voice): verify all 6 TTS providers pass full test suite"
```

---

## Task 7: Update config-schema.ts

**Files:**
- Modify: `extensions/esp32-voice/src/config-schema.ts:23`

**Step 1: Read the file**

Read `extensions/esp32-voice/src/config-schema.ts`.

**Step 2: Replace `ttsProvider` field**

Change:
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

**Step 3: TypeScript check**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add extensions/esp32-voice/src/config-schema.ts
git commit -m "feat(esp32-voice): add all 6 TTS providers to config schema enum"
```

---

## Task 8: Update onboarding wizard

**Files:**
- Modify: `extensions/esp32-voice/src/onboarding.ts`

**Step 1: Read the full file**

Read `extensions/esp32-voice/src/onboarding.ts` in full.

**Step 2: Replace `stepTtsSetup` with multi-provider version**

Replace the entire function from `// ── Step 3 — TTS Setup` comment through the closing `}` (lines ~392–451).

New implementation:

```typescript
// ── Step 3 — TTS Setup (multi-provider) ───────────────────────────────────────

const TTS_PROVIDERS_INFO = [
  { value: "elevenlabs", label: "ElevenLabs", hint: "Streaming, ~300ms", envVar: "ELEVENLABS_API_KEY", docsUrl: "https://elevenlabs.io/app/settings/api-keys", defaultVoice: "21m00Tcm4TlvDq8ikWAM" },
  { value: "rime",       label: "Rime",       hint: "Streaming, native PCM, low latency", envVar: "RIME_API_KEY", docsUrl: "https://rime.ai/docs", defaultVoice: "arcas" },
  { value: "inworld",    label: "Inworld",    hint: "Streaming, <120ms, best latency", envVar: "INWORLD_API_KEY", docsUrl: "https://inworld.ai/tts-api", defaultVoice: "inworld.neutral" },
  { value: "cartesia",   label: "Cartesia",   hint: "Streaming, ~80ms, production-grade", envVar: "CARTESIA_API_KEY", docsUrl: "https://docs.cartesia.ai", defaultVoice: "a0e99841-438c-4a64-b679-ae501e7d6091" },
  { value: "smallest-ai", label: "Smallest.ai", hint: "Streaming, raw PCM, 24kHz", envVar: "SMALLEST_AI_API_KEY", docsUrl: "https://waves-docs.smallest.ai", defaultVoice: "emily" },
  { value: "groq-playai", label: "Groq PlayAI", hint: "Batch, cheapest, reuses GROQ_API_KEY", envVar: "GROQ_API_KEY", docsUrl: "https://console.groq.com/docs/text-to-speech", defaultVoice: "Fritz-PlayAI" },
] as const;

async function stepTtsSetup(prompter: WizardPrompter): Promise<void> {
  const currentProvider = getEnvValue("TTS_PROVIDER") ?? "elevenlabs";
  const selectedProvider = String(await prompter.select({
    message: "Which TTS provider do you want to use?",
    options: TTS_PROVIDERS_INFO.map((p) => ({ value: p.value, label: p.label, hint: p.hint })),
    initialValue: currentProvider,
  }));

  const info = TTS_PROVIDERS_INFO.find((p) => p.value === selectedProvider)!;
  const existingKey = getEnvValue(info.envVar);

  if (existingKey) {
    const update = await prompter.confirm({ message: `${info.label} API key already set (${existingKey.slice(0, 8)}...). Update it?`, initialValue: false });
    if (!update) { saveToEnv({ TTS_PROVIDER: selectedProvider }); await prompter.note(`✅ TTS provider set to ${info.label}.`, "TTS ready"); return; }
  } else {
    await prompter.note([`ESP32 Voice will use ${info.label} for TTS.`, "", `${formatDocsLink(info.docsUrl, `Get ${info.label} API key →`)}`].join("\n"), `TTS Setup — ${info.label}`);
  }

  const key = String(await prompter.text({ message: `${info.label} API key`, placeholder: "Your API key", validate: (v) => (!String(v ?? "").trim() ? "Required" : undefined) })).trim();
  const voiceId = String(await prompter.text({ message: `Voice ID (optional, Enter for default: ${info.defaultVoice})`, placeholder: info.defaultVoice, initialValue: "" })).trim();

  const toSave: Record<string, string> = { TTS_PROVIDER: selectedProvider, [info.envVar]: key };
  const voiceEnvKey = info.envVar.replace("_API_KEY", "_VOICE_ID");
  if (voiceId) toSave[voiceEnvKey] = voiceId;
  saveToEnv(toSave);
  await prompter.note(`✅ ${info.label} API key saved.`, "TTS ready");
}
```

**Step 3: Update `getStatus` TTS check** (find the hard-coded `ELEVENLABS_API_KEY` check, replace with dynamic lookup using `TTS_PROVIDER` env var + `TTS_PROVIDERS_INFO`)

**Step 4: Update summary line** (find `TTS : ElevenLabs`, replace with dynamic `${info.label}` lookup)

**Step 5: TypeScript check**

```bash
cd extensions/esp32-voice && npx tsc --noEmit 2>&1 | head -20
```

**Step 6: Commit**

```bash
git add extensions/esp32-voice/src/onboarding.ts
git commit -m "feat(esp32-voice): update onboarding wizard with multi-provider TTS selection"
```

---

## Task 9: Update .env.example and TTS_PROVIDERS.md

**Step 1: Append new provider section to `.env.example`**

Append to `extensions/esp32-voice/.env.example`:

```bash

# ── TTS Provider Selection ──────────────────────────────────────────────────────
# Options: elevenlabs | rime | inworld | cartesia | smallest-ai | groq-playai
TTS_PROVIDER=elevenlabs

# Rime — https://rime.ai
# RIME_API_KEY=<your-rime-api-key>
# RIME_VOICE_ID=arcas

# Inworld — https://inworld.ai/tts-api
# INWORLD_API_KEY=<your-inworld-api-key>
# INWORLD_VOICE_ID=inworld.neutral

# Cartesia — https://docs.cartesia.ai
# CARTESIA_API_KEY=<your-cartesia-api-key>
# CARTESIA_VOICE_ID=a0e99841-438c-4a64-b679-ae501e7d6091

# Smallest.ai — https://waves-docs.smallest.ai
# SMALLEST_AI_API_KEY=<your-smallest-ai-api-key>
# SMALLEST_AI_VOICE_ID=emily

# Groq PlayAI — https://console.groq.com/docs/text-to-speech
# GROQ_API_KEY=<your-groq-api-key>
# GROQ_VOICE_ID=Fritz-PlayAI
```

**Step 2: Update `TTS_PROVIDERS.md` — add implemented table**

In `extensions/esp32-voice/TTS_PROVIDERS.md`, add after the `## 5. Alternative Providers` heading:

```markdown
### Implemented Providers

| Provider | ID | Env Var | Streaming | Test file |
|----------|----|---------|-----------|-----------|
| Rime | `rime` | `RIME_API_KEY` | Yes | `src/tts/__tests__/rime.test.ts` |
| Inworld | `inworld` | `INWORLD_API_KEY` | Yes | `src/tts/__tests__/inworld.test.ts` |
| Cartesia | `cartesia` | `CARTESIA_API_KEY` | Yes | `src/tts/__tests__/cartesia.test.ts` |
| Smallest.ai | `smallest-ai` | `SMALLEST_AI_API_KEY` | Yes | `src/tts/__tests__/smallest-ai.test.ts` |
| Groq PlayAI | `groq-playai` | `GROQ_API_KEY` | No (batch) | `src/tts/__tests__/groq-playai.test.ts` |
```

**Step 3: Final full test run**

```bash
cd extensions/esp32-voice && pnpm test
```

Expected: all tests green

**Step 4: Commit**

```bash
git add extensions/esp32-voice/.env.example extensions/esp32-voice/TTS_PROVIDERS.md
git commit -m "docs(esp32-voice): update .env.example and TTS_PROVIDERS.md with all implemented providers"
```

---

## Final Verification

```bash
# All tests pass
cd extensions/esp32-voice && pnpm test

# TypeScript clean
npx tsc --noEmit

# All 6 providers imported
grep "src/tts" extensions/esp32-voice/index.ts
```
