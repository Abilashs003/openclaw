// extensions/esp32-voice/src/tts/tts-providers.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── WS Mock (hoisted so it's available before imports) ──────────────────────
const { MockWs } = vi.hoisted(() => {
  class MockWs {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static last: InstanceType<typeof MockWs> | null = null;

    readyState = 1;
    url: string;
    options: unknown;
    sent: string[] = [];
    private _h = new Map<string, ((...a: unknown[]) => void)[]>();

    constructor(url: string, options?: unknown) {
      this.url = url;
      this.options = options;
      MockWs.last = this;
    }

    on(event: string, fn: (...a: unknown[]) => void) {
      if (!this._h.has(event)) this._h.set(event, []);
      this._h.get(event)!.push(fn);
    }

    off(_event: string, _fn: (...a: unknown[]) => void) { /* no-op */ }
    removeListener(_event: string, _fn: (...a: unknown[]) => void) { /* no-op */ }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.readyState = MockWs.CLOSED;
      this._emit("close");
    }

    _emit(event: string, ...args: unknown[]) {
      for (const fn of this._h.get(event) ?? []) fn(...args);
    }
  }
  return { MockWs };
});

vi.mock("ws", () => ({ default: MockWs }));

// ── HTTPS Mock (for Groq PlayAI) ─────────────────────────────────────────────
const { httpConfig, mockReq, httpsRequestFn } = vi.hoisted(() => {
  const httpConfig = {
    statusCode: 200,
    data: Buffer.alloc(0) as Buffer,
  };

  const mockReq = {
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    _reset() {
      this.on.mockClear();
      this.write.mockClear();
      this.end.mockClear();
    },
  };

  const httpsRequestFn = vi.fn(
    (_options: unknown, callback: (res: unknown) => void) => {
      const res = {
        statusCode: httpConfig.statusCode,
        on(event: string, fn: unknown) {
          if (event === "data")
            setImmediate(() => (fn as (d: Buffer) => void)(httpConfig.data));
          if (event === "end") setImmediate(() => (fn as () => void)());
        },
      };
      setImmediate(() => callback(res));
      return mockReq;
    },
  );

  return { httpConfig, mockReq, httpsRequestFn };
});

vi.mock("https", () => ({ default: { request: httpsRequestFn } }));

// ── Provider imports (auto-register on import) ──────────────────────────────
import { ttsRegistry } from "./tts-registry.js";
import { RimeTtsProvider, rimeMeta } from "./rime.js";
import { InworldTtsProvider, inworldMeta } from "./inworld.js";
import { CartesiaTtsProvider, cartesiaMeta } from "./cartesia.js";
import { SmallestAiTtsProvider, smallestAiMeta } from "./smallest-ai.js";
import { GroqPlayAiTtsProvider, groqPlayAiMeta } from "./groq-playai.js";

const API_KEY = "test-api-key-123";

afterEach(() => {
  vi.useRealTimers();
});

// Helper: fire the WebSocket "open" event so connect() resolves
function openWs() {
  MockWs.last!._emit("open");
}

// ── 1. Registry ──────────────────────────────────────────────────────────────
describe("TTS Registry — all providers registered", () => {
  it.each([
    ["rime", rimeMeta],
    ["inworld", inworldMeta],
    ["cartesia", cartesiaMeta],
    ["smallest-ai", smallestAiMeta],
    ["groq-playai", groqPlayAiMeta],
  ] as const)("%s is in the registry", (id, meta) => {
    expect(ttsRegistry.has(id)).toBe(true);
    const m = ttsRegistry.getMeta(id)!;
    expect(m.id).toBe(id);
    expect(m.name).toBe(meta.name);
    expect(m.envVar).toBe(meta.envVar);
    expect(m.outputSampleRate).toBe(meta.outputSampleRate);
  });

  it.each(["rime", "inworld", "cartesia", "smallest-ai"] as const)(
    "%s streaming: true",
    (id) => expect(ttsRegistry.getMeta(id)!.streaming).toBe(true),
  );

  it("groq-playai streaming: false", () =>
    expect(ttsRegistry.getMeta("groq-playai")!.streaming).toBe(false));

  it.each([
    ["rime", "RIME_API_KEY"],
    ["inworld", "INWORLD_API_KEY"],
    ["cartesia", "CARTESIA_API_KEY"],
    ["smallest-ai", "SMALLEST_AI_API_KEY"],
    ["groq-playai", "GROQ_API_KEY"],
  ] as const)("%s has correct envVar", (id, envVar) =>
    expect(ttsRegistry.getMeta(id)!.envVar).toBe(envVar),
  );

  it("ttsRegistry.create() returns correct class instances", () => {
    expect(ttsRegistry.create("rime", { apiKey: API_KEY })).toBeInstanceOf(RimeTtsProvider);
    expect(ttsRegistry.create("inworld", { apiKey: API_KEY })).toBeInstanceOf(InworldTtsProvider);
    expect(ttsRegistry.create("cartesia", { apiKey: API_KEY })).toBeInstanceOf(CartesiaTtsProvider);
    expect(ttsRegistry.create("smallest-ai", { apiKey: API_KEY })).toBeInstanceOf(SmallestAiTtsProvider);
    expect(ttsRegistry.create("groq-playai", { apiKey: API_KEY })).toBeInstanceOf(GroqPlayAiTtsProvider);
  });
});

// ── 2. Rime ──────────────────────────────────────────────────────────────────
describe("RimeTtsProvider", () => {
  let provider: RimeTtsProvider;

  beforeEach(() => {
    MockWs.last = null;
    provider = new RimeTtsProvider({ apiKey: API_KEY });
  });

  it("defaults: voice=luna, model=mistv2", () => {
    expect((provider as any).voiceId).toBe("luna");
    expect((provider as any).modelId).toBe("mistv2");
  });

  it("respects custom voiceId and model from config", () => {
    const p = new RimeTtsProvider({ apiKey: API_KEY, voiceId: "luna", model: "v3" });
    expect((p as any).voiceId).toBe("luna");
    expect((p as any).modelId).toBe("v3");
  });

  it("connect() opens WS to correct URL with Bearer auth", async () => {
    const connecting = provider.connect();
    openWs();
    await connecting;

    expect(MockWs.last!.url).toContain("wss://users-ws.rime.ai/ws");
    expect(MockWs.last!.url).toContain("speaker=luna");
    expect(MockWs.last!.url).toContain("audioFormat=pcm");
    expect((MockWs.last!.options as any).headers?.Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  it("connect() rejects on WebSocket error", async () => {
    const connecting = provider.connect();
    MockWs.last!._emit("error", new Error("ECONNREFUSED"));
    await expect(connecting).rejects.toThrow("ECONNREFUSED");
  });

  it("synthesize() sends plain text (not JSON)", async () => {
    const c = provider.connect();
    openWs();
    await c;
    await provider.synthesize("hello rime");
    expect(MockWs.last!.sent[0]).toBe("hello rime");
  });

  it("synthesize() throws when not connected", async () => {
    await expect(provider.synthesize("hi")).rejects.toThrow("[rime-tts] Not connected");
  });

  it("flush() sends '<EOS>' then resolves on connection close", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const flushing = provider.flush();
    expect(ws.sent[0]).toBe("<EOS>");
    // Rime closes connection after EOS — simulate that
    ws.close();
    await flushing;
  });

  it("flush() resolves after 30s timeout when server never closes", async () => {
    const c = provider.connect();
    openWs();
    await c;
    vi.useFakeTimers();

    const flushing = provider.flush();
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(flushing).resolves.toBeUndefined();
  });

  it("binary message → onAudio fires with the raw PCM buffer", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const pcm = Buffer.from([1, 2, 3, 4, 5]);
    const received: Buffer[] = [];
    provider.onAudio = (chunk) => { received.push(chunk as Buffer); };

    ws._emit("message", pcm, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(pcm);
  });

  it("connection close → onDone fires", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    let doneCalls = 0;
    provider.onDone = () => { doneCalls++; };
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(doneCalls).toBe(1);
  });

  it("audio chain is serialised — slow first chunk blocks second", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const order: number[] = [];
    provider.onAudio = async (chunk) => {
      if ((chunk as Buffer)[0] === 1) {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      } else {
        order.push(2);
      }
    };

    ws._emit("message", Buffer.from([1]), true);
    ws._emit("message", Buffer.from([2]), true);
    await new Promise((r) => setTimeout(r, 80));
    expect(order).toEqual([1, 2]);
  });

  it("close() terminates the WebSocket", async () => {
    const c = provider.connect();
    openWs();
    await c;
    await provider.close();
    expect(MockWs.last!.readyState).toBe(MockWs.CLOSED);
  });
});

// ── 3. Inworld ───────────────────────────────────────────────────────────────
describe("InworldTtsProvider", () => {
  let provider: InworldTtsProvider;

  beforeEach(() => {
    MockWs.last = null;
    provider = new InworldTtsProvider({ apiKey: API_KEY });
  });

  it("defaults: voice=Ashley, model=inworld-tts-1.5-mini", () => {
    expect((provider as any).voice).toBe("Ashley");
    expect((provider as any).model).toBe("inworld-tts-1.5-mini");
  });

  it("connect() opens WS with Basic auth to correct URL", async () => {
    const c = provider.connect();
    openWs();
    await c;

    const h = (MockWs.last!.options as any).headers;
    expect(MockWs.last!.url).toBe("wss://api.inworld.ai/tts/v1/voice:streamBidirectional");
    expect(h.Authorization).toBe(`Basic ${API_KEY}`);
  });

  it("connect() sends create context message on open", async () => {
    const c = provider.connect();
    openWs();
    await c;

    const msg = JSON.parse(MockWs.last!.sent[0]);
    expect(msg.create).toBeDefined();
    expect(msg.create.voiceId).toBe("Ashley");
    expect(msg.create.modelId).toBe("inworld-tts-1.5-mini");
    expect(msg.create.audioConfig.audioEncoding).toBe("LINEAR16");
    expect(msg.create.audioConfig.sampleRateHertz).toBe(24000);
    expect(msg.contextId).toBeDefined();
  });

  it("synthesize() sends send_text message", async () => {
    const c = provider.connect();
    openWs();
    await c;
    await provider.synthesize("inworld test");

    const msg = JSON.parse(MockWs.last!.sent[1]); // sent[0] is create
    expect(msg.send_text.text).toBe("inworld test");
    expect(msg.contextId).toBeDefined();
  });

  it("synthesize() throws when not connected", async () => {
    await expect(provider.synthesize("hi")).rejects.toThrow("[inworld-tts] Not connected");
  });

  it("flush() sends flush_context and resolves on flushCompleted", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const flushing = provider.flush();
    const flushMsg = JSON.parse(ws.sent[1]); // sent[0] is create
    expect(flushMsg.flush_context).toBeDefined();
    expect(flushMsg.contextId).toBeDefined();

    ws._emit("message", Buffer.from(JSON.stringify({ result: { flushCompleted: {} } })));
    await flushing;
  });

  it("flush() resolves after 30s timeout when server never signals done", async () => {
    const c = provider.connect();
    openWs();
    await c;
    vi.useFakeTimers();

    const flushing = provider.flush();
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(flushing).resolves.toBeUndefined();
  });

  it("audioChunk message → onAudio fires with decoded PCM", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const pcm = Buffer.from([10, 20, 30]);
    const received: Buffer[] = [];
    provider.onAudio = (chunk) => { received.push(chunk as Buffer); };

    ws._emit("message", Buffer.from(JSON.stringify({
      result: { audioChunk: { audioContent: pcm.toString("base64") } },
    })));
    await new Promise((r) => setTimeout(r, 10));
    expect(received[0]).toEqual(pcm);
  });

  it("flushCompleted → onDone fires", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    let doneCalls = 0;
    provider.onDone = () => { doneCalls++; };
    ws._emit("message", Buffer.from(JSON.stringify({ result: { flushCompleted: {} } })));
    await new Promise((r) => setTimeout(r, 10));
    expect(doneCalls).toBe(1);
  });

  it("audio chain is serialised — slow first chunk blocks second", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const order: number[] = [];
    provider.onAudio = async (chunk) => {
      if ((chunk as Buffer)[0] === 1) {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      } else {
        order.push(2);
      }
    };

    ws._emit("message", Buffer.from(JSON.stringify({
      result: { audioChunk: { audioContent: Buffer.from([1]).toString("base64") } },
    })));
    ws._emit("message", Buffer.from(JSON.stringify({
      result: { audioChunk: { audioContent: Buffer.from([2]).toString("base64") } },
    })));
    await new Promise((r) => setTimeout(r, 80));
    expect(order).toEqual([1, 2]);
  });

  it("unexpected close → onDone fires", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    let doneCalls = 0;
    provider.onDone = () => { doneCalls++; };
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(doneCalls).toBe(1);
  });

  it("connect() rejects on WebSocket error", async () => {
    const connecting = provider.connect();
    MockWs.last!._emit("error", new Error("inworld error"));
    await expect(connecting).rejects.toThrow("inworld error");
  });

  it("close() sends close_context and terminates the WebSocket", async () => {
    const c = provider.connect();
    openWs();
    await c;
    await provider.close();
    // close_context was sent (sent[1]) and WS is now null
    expect(MockWs.last!.readyState).toBe(MockWs.CLOSED);
  });
});

// ── 4. Cartesia ──────────────────────────────────────────────────────────────
describe("CartesiaTtsProvider", () => {
  let provider: CartesiaTtsProvider;

  beforeEach(() => {
    MockWs.last = null;
    provider = new CartesiaTtsProvider({ apiKey: API_KEY });
  });

  it("defaults: voice=a0e99841-..., model=sonic-english", () => {
    expect((provider as any).voiceId).toBe("a0e99841-438c-4a64-b679-ae501e7d6091");
    expect((provider as any).modelId).toBe("sonic-english");
  });

  it("connect() embeds api_key and version in URL (no auth header)", async () => {
    const c = provider.connect();
    openWs();
    await c;

    expect(MockWs.last!.url).toContain(`api_key=${API_KEY}`);
    expect(MockWs.last!.url).toContain("cartesia_version=2024-06-10");
    expect(MockWs.last!.options).toBeUndefined();
  });

  it("synthesize() sends correct JSON with continue: true", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    await provider.synthesize("cartesia test");
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.transcript).toBe("cartesia test");
    expect(msg.continue).toBe(true);
    expect(msg.output_format.container).toBe("raw");
    expect(msg.output_format.encoding).toBe("pcm_s16le");
    expect(msg.output_format.sample_rate).toBe(24000);
    expect(msg.voice.mode).toBe("id");
    expect(msg.voice.id).toBe("a0e99841-438c-4a64-b679-ae501e7d6091");
  });

  it("synthesize() throws when not connected", async () => {
    await expect(provider.synthesize("hi")).rejects.toThrow("[cartesia-tts] Not connected");
  });

  it("flush() sends empty transcript with continue: false", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const flushing = provider.flush();
    const eos = JSON.parse(ws.sent[0]);
    expect(eos.transcript).toBe("");
    expect(eos.continue).toBe(false);

    ws._emit("message", Buffer.from(JSON.stringify({ type: "done" })));
    await flushing;
  });

  it("flush() resolves after 30s timeout when server never signals done", async () => {
    const c = provider.connect();
    openWs();
    await c;
    vi.useFakeTimers();

    const flushing = provider.flush();
    // advance past the 30s timeout
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(flushing).resolves.toBeUndefined();
  });

  it("{ type: 'chunk', data: base64 } → onAudio with decoded PCM", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const pcm = Buffer.from([0xaa, 0xbb, 0xcc]);
    const received: Buffer[] = [];
    provider.onAudio = (chunk) => { received.push(chunk as Buffer); };

    ws._emit(
      "message",
      Buffer.from(JSON.stringify({ type: "chunk", data: pcm.toString("base64") })),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(received[0]).toEqual(pcm);
  });

  it("{ type: 'done' } → onDone fires", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    let doneCalls = 0;
    provider.onDone = () => { doneCalls++; };
    ws._emit("message", Buffer.from(JSON.stringify({ type: "done" })));
    await new Promise((r) => setTimeout(r, 10));
    expect(doneCalls).toBe(1);
  });

  it("unexpected close → onDone fires", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    let doneCalls = 0;
    provider.onDone = () => { doneCalls++; };
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(doneCalls).toBe(1);
  });

  it("audio chain serialised — slow first chunk blocks second", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const order: number[] = [];
    provider.onAudio = async (chunk) => {
      if ((chunk as Buffer)[0] === 0xaa) {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      } else {
        order.push(2);
      }
    };

    const p1 = Buffer.from([0xaa]);
    const p2 = Buffer.from([0xbb]);
    ws._emit("message", Buffer.from(JSON.stringify({ type: "chunk", data: p1.toString("base64") })));
    ws._emit("message", Buffer.from(JSON.stringify({ type: "chunk", data: p2.toString("base64") })));
    await new Promise((r) => setTimeout(r, 80));
    expect(order).toEqual([1, 2]);
  });

  it("close() terminates the WebSocket", async () => {
    const c = provider.connect();
    openWs();
    await c;
    await provider.close();
    expect(MockWs.last!.readyState).toBe(MockWs.CLOSED);
  });

  it("connect() rejects on WebSocket error", async () => {
    const connecting = provider.connect();
    MockWs.last!._emit("error", new Error("cartesia error"));
    await expect(connecting).rejects.toThrow("cartesia error");
  });
});

// ── 5. Smallest.ai ───────────────────────────────────────────────────────────
describe("SmallestAiTtsProvider", () => {
  let provider: SmallestAiTtsProvider;

  beforeEach(() => {
    MockWs.last = null;
    provider = new SmallestAiTtsProvider({ apiKey: API_KEY });
  });

  it("defaults: voice=ashley, model=lightning-v2", () => {
    expect((provider as any).voiceId).toBe("ashley");
    expect((provider as any).modelId).toBe("lightning-v2");
  });

  it("connect() opens WS with Bearer auth", async () => {
    const c = provider.connect();
    openWs();
    await c;

    expect(MockWs.last!.url).toBe("wss://waves-api.smallest.ai/api/v1/lightning-v2/get_speech/stream");
    expect((MockWs.last!.options as any).headers?.Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  it("synthesize() buffers text — no WS send", async () => {
    const c = provider.connect();
    openWs();
    await c;

    await provider.synthesize("hello");
    await provider.synthesize("world");
    expect(MockWs.last!.sent).toHaveLength(0);
  });

  it("flush() sends combined buffered text as one message", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    await provider.synthesize("hello");
    await provider.synthesize("world");

    const flushing = provider.flush();
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.text).toBe("hello world");
    expect(msg.voice_id).toBe("ashley");
    expect(msg.model).toBe("lightning-v2");
    expect(msg.sample_rate).toBe(24000);
    expect(msg.add_wav_header).toBe(false);

    ws._emit("message", Buffer.from(JSON.stringify({ status: "complete" })));
    await flushing;
  });

  it("flush() also resolves on { done: true } signal", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    await provider.synthesize("test");
    const flushing = provider.flush();
    ws._emit("message", Buffer.from(JSON.stringify({ done: true })));
    await flushing;
  });

  it("flush() resolves after 30s timeout when server never signals done", async () => {
    const c = provider.connect();
    openWs();
    await c;
    vi.useFakeTimers();
    await provider.synthesize("test");

    const flushing = provider.flush();
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(flushing).resolves.toBeUndefined();
  });

  it("JSON { audio: base64 } → onAudio with decoded buffer", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const pcm = Buffer.from([1, 2, 3, 4]);
    const received: Buffer[] = [];
    provider.onAudio = (chunk) => { received.push(chunk as Buffer); };

    ws._emit(
      "message",
      Buffer.from(JSON.stringify({ data: { audio: pcm.toString("base64") } })),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(received[0]).toEqual(pcm);
  });

  it("raw binary fallback → onAudio fires with full buffer", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const pcm = Buffer.from([0xff, 0xfe]);
    const received: Buffer[] = [];
    provider.onAudio = (chunk) => { received.push(chunk as Buffer); };
    ws._emit("message", pcm);
    await new Promise((r) => setTimeout(r, 10));
    expect(received[0]).toEqual(pcm);
  });

  it("unexpected close → onDone fires", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    let doneCalls = 0;
    provider.onDone = () => { doneCalls++; };
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(doneCalls).toBe(1);
  });

  it("close() terminates the WebSocket", async () => {
    const c = provider.connect();
    openWs();
    await c;
    await provider.close();
    expect(MockWs.last!.readyState).toBe(MockWs.CLOSED);
  });

  it("JSON done signal → onDone fires", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    let doneCalls = 0;
    provider.onDone = () => { doneCalls++; };
    ws._emit("message", Buffer.from(JSON.stringify({ status: "complete" })));
    await new Promise((r) => setTimeout(r, 10));
    expect(doneCalls).toBe(1);
  });

  it("audio chain is serialised — slow first chunk blocks second", async () => {
    const c = provider.connect();
    const ws = MockWs.last!;
    openWs();
    await c;

    const order: number[] = [];
    provider.onAudio = async (chunk) => {
      if ((chunk as Buffer)[0] === 1) {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      } else {
        order.push(2);
      }
    };

    ws._emit("message", Buffer.from([1]));
    ws._emit("message", Buffer.from([2]));
    await new Promise((r) => setTimeout(r, 80));
    expect(order).toEqual([1, 2]);
  });

  it("synthesize() throws when not connected", async () => {
    await expect(provider.synthesize("hi")).rejects.toThrow("[smallest-ai-tts] Not connected");
  });

  it("connect() rejects on WebSocket error", async () => {
    const connecting = provider.connect();
    MockWs.last!._emit("error", new Error("smallest error"));
    await expect(connecting).rejects.toThrow("smallest error");
  });
});

// ── 6. Groq PlayAI ───────────────────────────────────────────────────────────
describe("GroqPlayAiTtsProvider", () => {
  let provider: GroqPlayAiTtsProvider;

  beforeEach(() => {
    MockWs.last = null;
    httpsRequestFn.mockClear();
    mockReq._reset();
    httpConfig.statusCode = 200;
    // Default: 44-byte WAV header + 8192 bytes of PCM (0xAB)
    httpConfig.data = Buffer.concat([
      Buffer.alloc(44, 0),
      Buffer.alloc(8192, 0xab),
    ]);
    provider = new GroqPlayAiTtsProvider({ apiKey: API_KEY });
  });

  it("defaults: voice=troy, model=canopylabs/orpheus-v1-english", () => {
    expect((provider as any).voice).toBe("troy");
    expect((provider as any).model).toBe("canopylabs/orpheus-v1-english");
  });

  it("connect() is a no-op — no WS or HTTP", async () => {
    await provider.connect();
    expect(MockWs.last).toBeNull();
    expect(httpsRequestFn).not.toHaveBeenCalled();
  });

  it("synthesize() buffers text — no HTTP call", async () => {
    await provider.connect();
    await provider.synthesize("hello");
    await provider.synthesize("world");
    expect(httpsRequestFn).not.toHaveBeenCalled();
    expect((provider as any).textBuffer).toEqual(["hello", "world"]);
  });

  it("flush() with empty buffer calls onDone without HTTP", async () => {
    await provider.connect();
    let doneCalls = 0;
    provider.onDone = () => { doneCalls++; };
    await provider.flush();
    expect(httpsRequestFn).not.toHaveBeenCalled();
    expect(doneCalls).toBe(1);
  });

  it("flush() POSTs to api.groq.com with correct headers", async () => {
    await provider.connect();
    await provider.synthesize("groq test");
    provider.onAudio = () => {};
    provider.onDone = () => {};

    await provider.flush();

    expect(httpsRequestFn).toHaveBeenCalledOnce();
    const [opts] = httpsRequestFn.mock.calls[0] as [any, any];
    expect(opts.hostname).toBe("api.groq.com");
    expect(opts.path).toBe("/openai/v1/audio/speech");
    expect(opts.method).toBe("POST");
    expect(opts.headers?.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(opts.headers?.["Content-Type"]).toBe("application/json");
    expect(mockReq.write).toHaveBeenCalledOnce();
    const body = JSON.parse(mockReq.write.mock.calls[0][0] as string);
    expect(body.response_format).toBe("wav");
    expect(body.voice).toBe("troy");
    expect(body.model).toBe("canopylabs/orpheus-v1-english");
    expect(body.input).toBe("groq test");
  });

  it("flush() strips 44-byte WAV header — onAudio receives raw PCM", async () => {
    await provider.connect();
    await provider.synthesize("test");

    const received: Buffer[] = [];
    provider.onAudio = (chunk) => { received.push(chunk as Buffer); };
    provider.onDone = () => {};

    await provider.flush();

    const total = Buffer.concat(received);
    expect(total.length).toBe(8192);
    expect(total[0]).toBe(0xab);
  });

  it("flush() delivers audio in 4096-byte chunks", async () => {
    httpConfig.data = Buffer.concat([
      Buffer.alloc(44, 0),
      Buffer.alloc(10000, 0x01),
    ]);

    await provider.connect();
    await provider.synthesize("test");

    const sizes: number[] = [];
    provider.onAudio = (chunk) => { sizes.push((chunk as Buffer).length); };
    provider.onDone = () => {};

    await provider.flush();

    expect(sizes).toEqual([4096, 4096, 10000 - 8192]);
  });

  it("flush() calls onDone once after all audio delivered", async () => {
    await provider.connect();
    await provider.synthesize("test");

    let doneCalls = 0;
    provider.onAudio = () => {};
    provider.onDone = () => { doneCalls++; };

    await provider.flush();
    expect(doneCalls).toBe(1);
  });

  it("flush() rejects on HTTP non-200", async () => {
    httpConfig.statusCode = 500;
    httpConfig.data = Buffer.alloc(0);

    await provider.connect();
    await provider.synthesize("test");

    await expect(provider.flush()).rejects.toThrow("HTTP 500");
  });

  it("close() is a no-op", async () => {
    await expect(provider.close()).resolves.toBeUndefined();
  });
});
