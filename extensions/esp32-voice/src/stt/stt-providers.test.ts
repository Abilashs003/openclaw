// extensions/esp32-voice/src/stt/stt-providers.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── WS Mock (hoisted so it's available before imports) ──────────────────────
const { MockWs } = vi.hoisted(() => {
  class MockWs {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly CONNECTING = 0;
    static last: InstanceType<typeof MockWs> | null = null;

    readyState = 1;
    CONNECTING = 0;
    url: string;
    options: unknown;
    sent: (string | Buffer)[] = [];
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

    send(data: string | Buffer) {
      this.sent.push(data);
    }

    close() {
      this.readyState = MockWs.CLOSED;
      this._emit("close");
    }

    terminate() {
      this.readyState = MockWs.CLOSED;
    }

    _emit(event: string, ...args: unknown[]) {
      for (const fn of this._h.get(event) ?? []) fn(...args);
    }
  }
  return { MockWs };
});

vi.mock("ws", () => ({ default: MockWs }));

// ── OpusScript Mock ─────────────────────────────────────────────────────────
const { MockOpusScript } = vi.hoisted(() => {
  class MockOpusScript {
    static Application = { VOIP: 2049 };
    decode(_data: Buffer, samples: number) {
      // Return a buffer of samples*2 bytes (PCM16 = 2 bytes per sample)
      return Buffer.alloc(samples * 2);
    }
  }
  return { MockOpusScript };
});

vi.mock("opusscript", () => ({ default: MockOpusScript }));

// ── Fetch Mock (for AssemblyAI and Gladia) ──────────────────────────────────
const mockFetch = vi.fn();

// ── Provider imports (auto-register on import) ──────────────────────────────
import { sttRegistry } from "./stt-registry.js";
import { SonioxSttProvider, sonioxMeta } from "./soniox.js";
import { ElevenLabsSttProvider, elevenlabsSttMeta } from "./elevenlabs-stt.js";
import { AssemblyAiSttProvider, assemblyAiMeta } from "./assemblyai.js";
import { GladiaSttProvider, gladiaMeta } from "./gladia.js";

const API_KEY = "test-api-key-123";

beforeEach(() => {
  // Re-stub fetch before each test (unstubGlobals: true resets after each)
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.useRealTimers();
  mockFetch.mockReset();
});

/** Wait a tick for async import("opusscript") and/or fetch to complete */
const tick = () => new Promise<void>((r) => setTimeout(r, 10));

/** Open a mocked WS — call after provider.connect() starts and after tick() */
function openWs() {
  const ws = MockWs.last!;
  ws._emit("open");
  return ws;
}

// ── 1. Registry ─────────────────────────────────────────────────────────────
describe("STT Registry — all 4 new providers registered", () => {
  it.each([
    ["soniox", sonioxMeta],
    ["elevenlabs-stt", elevenlabsSttMeta],
    ["assemblyai", assemblyAiMeta],
    ["gladia", gladiaMeta],
  ] as const)("%s is in the registry", (id, meta) => {
    expect(sttRegistry.has(id)).toBe(true);
    const m = sttRegistry.getMeta(id)!;
    expect(m.id).toBe(id);
    expect(m.name).toBe(meta.name);
    expect(m.envVar).toBe(meta.envVar);
  });

  it.each(["soniox", "elevenlabs-stt", "assemblyai", "gladia"] as const)(
    "%s streaming: true",
    (id) => expect(sttRegistry.getMeta(id)!.streaming).toBe(true),
  );

  it.each([
    ["soniox", "SONIOX_API_KEY"],
    ["elevenlabs-stt", "ELEVENLABS_STT_API_KEY"],
    ["assemblyai", "ASSEMBLYAI_API_KEY"],
    ["gladia", "GLADIA_API_KEY"],
  ] as const)("%s has correct envVar", (id, envVar) =>
    expect(sttRegistry.getMeta(id)!.envVar).toBe(envVar),
  );

  it("sttRegistry.create() returns correct class instances", () => {
    expect(sttRegistry.create("soniox", { apiKey: API_KEY })).toBeInstanceOf(SonioxSttProvider);
    expect(sttRegistry.create("elevenlabs-stt", { apiKey: API_KEY })).toBeInstanceOf(ElevenLabsSttProvider);
    expect(sttRegistry.create("assemblyai", { apiKey: API_KEY })).toBeInstanceOf(AssemblyAiSttProvider);
    expect(sttRegistry.create("gladia", { apiKey: API_KEY })).toBeInstanceOf(GladiaSttProvider);
  });
});

// ── 2. Soniox ───────────────────────────────────────────────────────────────
describe("SonioxSttProvider", () => {
  let provider: SonioxSttProvider;

  beforeEach(() => {
    MockWs.last = null;
    provider = new SonioxSttProvider({ apiKey: API_KEY });
  });

  it("defaults: model=stt-rt-v4, language=en", () => {
    expect((provider as any).model).toBe("stt-rt-v4");
    expect((provider as any).language).toBe("en");
  });

  it("respects custom model and language from config", () => {
    const p = new SonioxSttProvider({ apiKey: API_KEY, model: "stt-rt-v5", language: "es" });
    expect((p as any).model).toBe("stt-rt-v5");
    expect((p as any).language).toBe("es");
  });

  it("connect() opens WS to wss://stt-rt.soniox.com/transcribe-websocket", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;
    expect(MockWs.last!.url).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
  });

  it("connect() sends config JSON on open with correct fields", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const configMsg = JSON.parse(MockWs.last!.sent[0] as string);
    expect(configMsg.api_key).toBe(API_KEY);
    expect(configMsg.model).toBe("stt-rt-v4");
    expect(configMsg.audio_format).toBe("pcm_s16le");
    expect(configMsg.sample_rate).toBe(16000);
    expect(configMsg.num_audio_channels).toBe(1);
    expect(configMsg.language).toBe("en");
  });

  it("connect() initializes Opus decoder", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;
    expect((provider as any).decoder).toBeDefined();
    expect((provider as any).decoder).toBeInstanceOf(MockOpusScript);
  });

  it("connect() rejects on WS error", async () => {
    const connecting = provider.connect();
    await tick();
    MockWs.last!._emit("error", new Error("ECONNREFUSED"));
    await expect(connecting).rejects.toThrow("ECONNREFUSED");
  });

  it("sendAudio() decodes Opus and sends PCM binary when WS is open", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const opusFrame = Buffer.from([0x01, 0x02, 0x03]);
    await provider.sendAudio(opusFrame);

    // sent[0] is config JSON, sent[1] should be the decoded PCM buffer
    expect(MockWs.last!.sent.length).toBe(2);
    const pcmSent = MockWs.last!.sent[1] as Buffer;
    expect(Buffer.isBuffer(pcmSent)).toBe(true);
    // MockOpusScript.decode(data, 320) returns Buffer.alloc(320*2) = 640 bytes
    expect(pcmSent.length).toBe(640);
  });

  it("sendAudio() buffers before WS open (config not yet sent)", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;

    // WS exists but readyState is OPEN by default in mock; however configSent is false
    // because open hasn't fired yet. Force readyState to CONNECTING to test buffering.
    ws.readyState = 0;
    await provider.sendAudio(Buffer.from([0x01]));
    // Nothing sent directly (buffered internally)
    // The WS mock has 0 sends (configSent is false, readyState is not OPEN)
    expect(ws.sent).toHaveLength(0);

    // Now open — config + buffered audio should flush
    ws.readyState = 1;
    ws._emit("open");
    await c;

    // sent[0] = config JSON, sent[1] = flushed buffered PCM
    expect(ws.sent.length).toBe(2);
    expect(typeof ws.sent[0]).toBe("string"); // config JSON
    expect(Buffer.isBuffer(ws.sent[1])).toBe(true); // PCM
  });

  it("handleMessage fw — fires onTranscript(text, true) and accumulates finalTranscript", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    provider.onTranscript = (text, isFinal) => {
      transcripts.push({ text, isFinal });
    };

    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      fw: [{ t: "hello " }, { t: "world" }],
    })));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].text).toBe("hello world");
    expect(transcripts[0].isFinal).toBe(true);
    expect((provider as any).finalTranscript).toBe("hello world");
  });

  it("handleMessage nfw — fires onTranscript(text, false)", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    provider.onTranscript = (text, isFinal) => {
      transcripts.push({ text, isFinal });
    };

    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      nfw: [{ t: "hel" }],
    })));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].text).toBe("hel");
    expect(transcripts[0].isFinal).toBe(false);
  });

  it("handleMessage finished — resolves finalize and fires onSpeechEnd", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    openWs();
    await c;

    // Set some final transcript first
    ws._emit("message", Buffer.from(JSON.stringify({
      fw: [{ t: "done" }],
    })));

    let speechEndCalled = false;
    provider.onSpeechEnd = () => { speechEndCalled = true; };

    // Trigger finished
    ws._emit("message", Buffer.from(JSON.stringify({ finished: true })));

    expect(speechEndCalled).toBe(true);
    // finalizeResolve should be null (resolved)
    expect((provider as any).finalizeResolve).toBeNull();
  });

  it("finalize() sends empty Buffer and resolves with transcript", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    openWs();
    await c;

    // Set some transcript
    ws._emit("message", Buffer.from(JSON.stringify({
      fw: [{ t: "hello" }],
    })));

    // Start finalize
    const finalizePromise = provider.finalize();

    // Check empty buffer was sent
    const lastSent = ws.sent[ws.sent.length - 1] as Buffer;
    expect(Buffer.isBuffer(lastSent)).toBe(true);
    expect(lastSent.length).toBe(0);

    // Trigger finished message to resolve
    ws._emit("message", Buffer.from(JSON.stringify({ finished: true })));

    const result = await finalizePromise;
    expect(result).toBe("hello");
  });

  it("finalize() timeout fallback (6s)", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    // Set partial transcript
    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      nfw: [{ t: "partial" }],
    })));

    vi.useFakeTimers();

    const finalizePromise = provider.finalize();
    await vi.advanceTimersByTimeAsync(6000);

    const result = await finalizePromise;
    expect(result).toBe("partial");
  });

  it("close() closes WS in OPEN state", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    await provider.close();
    expect(MockWs.last!.readyState).toBe(MockWs.CLOSED);
  });

  it("close() terminates WS in CONNECTING state", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    ws.readyState = 0;
    await provider.close();
    expect(ws.readyState).toBe(MockWs.CLOSED);
  });
});

// ── 3. ElevenLabs STT ───────────────────────────────────────────────────────
describe("ElevenLabsSttProvider", () => {
  let provider: ElevenLabsSttProvider;

  beforeEach(() => {
    MockWs.last = null;
    provider = new ElevenLabsSttProvider({ apiKey: API_KEY });
  });

  it("defaults: model=scribe_v2_realtime", () => {
    expect((provider as any).model).toBe("scribe_v2_realtime");
  });

  it("respects custom model from config", () => {
    const p = new ElevenLabsSttProvider({ apiKey: API_KEY, model: "custom_model" });
    expect((p as any).model).toBe("custom_model");
  });

  it("connect() opens WS to correct URL with xi-api-key header", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    expect(MockWs.last!.url).toContain("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(MockWs.last!.url).toContain("model_id=scribe_v2_realtime");
    expect((MockWs.last!.options as any).headers["xi-api-key"]).toBe(API_KEY);
  });

  it("connect() initializes Opus decoder", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;
    expect((provider as any).decoder).toBeInstanceOf(MockOpusScript);
  });

  it("connect() rejects on WS error", async () => {
    const connecting = provider.connect();
    await tick();
    MockWs.last!._emit("error", new Error("elevenlabs error"));
    await expect(connecting).rejects.toThrow("elevenlabs error");
  });

  it("sendAudio() decodes Opus, base64-encodes, sends as JSON", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const opusFrame = Buffer.from([0x01, 0x02, 0x03]);
    await provider.sendAudio(opusFrame);

    const msg = JSON.parse(MockWs.last!.sent[0] as string);
    expect(msg.type).toBe("input_audio_chunk");
    expect(typeof msg.audio_chunk).toBe("string");
    // The base64 should decode to 640 bytes (320 samples * 2 bytes each)
    const decoded = Buffer.from(msg.audio_chunk, "base64");
    expect(decoded.length).toBe(640);
  });

  it("sendAudio() buffers base64 before WS open", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    // Set to CONNECTING so readyState !== OPEN
    ws.readyState = 0;

    await provider.sendAudio(Buffer.from([0x01]));
    // Nothing sent yet since readyState is not OPEN
    expect(ws.sent).toHaveLength(0);

    // Now open — buffered audio should flush
    ws.readyState = 1;
    ws._emit("open");
    await c;

    // Flushed buffered chunk
    expect(ws.sent.length).toBeGreaterThan(0);
    const msg = JSON.parse(ws.sent[0] as string);
    expect(msg.type).toBe("input_audio_chunk");
  });

  it("handleMessage partial_transcript — fires onTranscript(text, false)", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    provider.onTranscript = (text, isFinal) => {
      transcripts.push({ text, isFinal });
    };

    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "partial_transcript",
      text: "hel",
    })));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].text).toBe("hel");
    expect(transcripts[0].isFinal).toBe(false);
  });

  it("handleMessage committed_transcript — fires onTranscript(text, true), resolves finalize, fires onSpeechEnd", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    openWs();
    await c;

    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    provider.onTranscript = (text, isFinal) => {
      transcripts.push({ text, isFinal });
    };

    let speechEndCalled = false;
    provider.onSpeechEnd = () => { speechEndCalled = true; };

    ws._emit("message", Buffer.from(JSON.stringify({
      type: "committed_transcript",
      text: "hello world",
    })));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].text).toBe("hello world");
    expect(transcripts[0].isFinal).toBe(true);
    expect(speechEndCalled).toBe(true);
    expect((provider as any).finalTranscript).toBe("hello world");
  });

  it("finalize() resolves with transcript on committed_transcript", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    openWs();
    await c;

    const finalizePromise = provider.finalize();

    ws._emit("message", Buffer.from(JSON.stringify({
      type: "committed_transcript",
      text: "final text",
    })));

    const result = await finalizePromise;
    expect(result).toBe("final text");
  });

  it("finalize() timeout fallback (6s)", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    openWs();
    await c;

    // Set partial transcript
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "partial_transcript",
      text: "partial",
    })));

    vi.useFakeTimers();

    const finalizePromise = provider.finalize();
    await vi.advanceTimersByTimeAsync(6000);

    const result = await finalizePromise;
    expect(result).toBe("partial");
  });

  it("close() handles CONNECTING state (terminate)", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    ws.readyState = 0;
    await provider.close();
    expect(ws.readyState).toBe(MockWs.CLOSED);
  });

  it("close() handles OPEN state (close)", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;
    await provider.close();
    expect(MockWs.last!.readyState).toBe(MockWs.CLOSED);
  });
});

// ── 4. AssemblyAI ───────────────────────────────────────────────────────────
describe("AssemblyAiSttProvider", () => {
  let provider: AssemblyAiSttProvider;

  beforeEach(() => {
    MockWs.last = null;
    provider = new AssemblyAiSttProvider({ apiKey: API_KEY });
  });

  it("defaults: model=universal, language=en", () => {
    expect((provider as any).model).toBe("universal");
    expect((provider as any).language).toBe("en");
  });

  it("connect() opens WS directly with Authorization header (no token fetch)", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    // No fetch call — direct WS connection
    expect(mockFetch).not.toHaveBeenCalled();

    // Verify WS URL
    expect(MockWs.last!.url).toContain("wss://streaming.assemblyai.com/v3/ws");
    expect(MockWs.last!.url).toContain("sample_rate=16000");
    expect(MockWs.last!.url).toContain("encoding=pcm_s16le");
    expect(MockWs.last!.url).toContain("format_turns=true");

    // Verify auth header
    expect((MockWs.last!.options as any).headers.Authorization).toBe(API_KEY);
  });

  it("connect() initializes Opus decoder", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    expect((provider as any).decoder).toBeInstanceOf(MockOpusScript);
  });

  it("connect() rejects on WS error", async () => {
    const connecting = provider.connect();
    await tick();
    MockWs.last!._emit("error", new Error("assemblyai ws error"));
    await expect(connecting).rejects.toThrow("assemblyai ws error");
  });

  it("sendAudio() decodes Opus and sends PCM binary", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    await provider.sendAudio(Buffer.from([0x01]));

    // sent[0] is the PCM buffer (no config message for AssemblyAI — config is in URL)
    const pcmSent = MockWs.last!.sent[0] as Buffer;
    expect(Buffer.isBuffer(pcmSent)).toBe(true);
    expect(pcmSent.length).toBe(640);
  });

  it("sendAudio() buffers before WS open", async () => {
    const c = provider.connect();
    await tick();

    const ws = MockWs.last!;
    ws.readyState = 0;

    await provider.sendAudio(Buffer.from([0x01]));
    expect(ws.sent).toHaveLength(0);

    ws.readyState = 1;
    ws._emit("open");
    await c;

    // Flushed buffered frame
    expect(ws.sent.length).toBe(1);
    expect(Buffer.isBuffer(ws.sent[0])).toBe(true);
  });

  it("handleMessage Turn with end_of_turn: false — partial transcript", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    provider.onTranscript = (text, isFinal) => {
      transcripts.push({ text, isFinal });
    };

    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "Turn",
      transcript: "hello world",
      end_of_turn: false,
    })));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].text).toBe("hello world");
    expect(transcripts[0].isFinal).toBe(false);
  });

  it("handleMessage Turn with end_of_turn: true — final transcript, resolves finalize, fires onSpeechEnd", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    provider.onTranscript = (text, isFinal) => {
      transcripts.push({ text, isFinal });
    };

    let speechEndCalled = false;
    provider.onSpeechEnd = () => { speechEndCalled = true; };

    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "Turn",
      transcript: "hello world",
      end_of_turn: true,
    })));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].isFinal).toBe(true);
    expect(speechEndCalled).toBe(true);
    expect((provider as any).finalTranscript).toBe("hello world");
  });

  it("handleMessage Termination — resolves finalize", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const ws = MockWs.last!;

    // Start finalize — this sets up the race
    const finalizePromise = provider.finalize();

    // Send Termination
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "Termination",
    })));

    const result = await finalizePromise;
    expect(result).toBe("");
  });

  it("finalize() sends { type: 'Terminate' }", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const ws = MockWs.last!;
    const finalizePromise = provider.finalize();

    // Check that session termination was sent
    const termMsg = JSON.parse(ws.sent[0] as string);
    expect(termMsg.type).toBe("Terminate");

    // Resolve via Termination message
    ws._emit("message", Buffer.from(JSON.stringify({ type: "Termination" })));
    await finalizePromise;
  });

  it("finalize() timeout fallback (6s)", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;

    // Set partial transcript
    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "Turn",
      transcript: "partial",
      end_of_turn: false,
    })));

    vi.useFakeTimers();

    const finalizePromise = provider.finalize();
    await vi.advanceTimersByTimeAsync(6000);

    const result = await finalizePromise;
    expect(result).toBe("partial");
  });

  it("close() handles CONNECTING state (terminate)", async () => {
    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    ws.readyState = 0;
    await provider.close();
    expect(ws.readyState).toBe(MockWs.CLOSED);
  });

  it("close() handles OPEN state (close)", async () => {
    const c = provider.connect();
    await tick();
    openWs();
    await c;
    await provider.close();
    expect(MockWs.last!.readyState).toBe(MockWs.CLOSED);
  });
});

// ── 5. Gladia ───────────────────────────────────────────────────────────────
describe("GladiaSttProvider", () => {
  let provider: GladiaSttProvider;

  beforeEach(() => {
    MockWs.last = null;
    provider = new GladiaSttProvider({ apiKey: API_KEY });
  });

  it("defaults: model=solaria-1, language=en", () => {
    expect((provider as any).model).toBe("solaria-1");
    expect((provider as any).language).toBe("en");
  });

  it("connect() calls fetch for init with wav/pcm encoding, then opens WS to returned URL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc123" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
    expect(fetchUrl).toBe("https://api.gladia.io/v2/live");
    expect(fetchOpts.method).toBe("POST");
    expect(fetchOpts.headers["x-gladia-key"]).toBe(API_KEY);
    expect(fetchOpts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(fetchOpts.body);
    expect(body.encoding).toBe("wav/pcm");
    expect(body.bit_depth).toBe(16);
    expect(body.sample_rate).toBe(16000);
    expect(body.channels).toBe(1);
    expect(body.model).toBe("solaria-1");
    expect(body.language_config).toEqual({ languages: ["en"], code_switching: false });

    // Verify WS URL is the one from init response
    expect(MockWs.last!.url).toBe("wss://gladia.io/session/abc123");
  });

  it("connect() initializes Opus decoder (v2 requires wav/pcm)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    expect((provider as any).decoder).toBeInstanceOf(MockOpusScript);
  });

  it("connect() rejects if init fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });

    await expect(provider.connect()).rejects.toThrow("Session init failed: HTTP 403");
  });

  it("connect() rejects if no URL in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    await expect(provider.connect()).rejects.toThrow("No WebSocket URL in init response");
  });

  it("connect() rejects on WS error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const connecting = provider.connect();
    await tick();
    MockWs.last!._emit("error", new Error("gladia ws error"));
    await expect(connecting).rejects.toThrow("gladia ws error");
  });

  it("sendAudio() decodes Opus to PCM and sends binary (v2 requires wav/pcm)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    // Gladia v2 should have a decoder (decodes Opus→PCM)
    expect((provider as any).decoder).toBeInstanceOf(MockOpusScript);

    const opusFrame = Buffer.from([0x01, 0x02, 0x03]);
    await provider.sendAudio(opusFrame);

    // sent[0] should be decoded PCM (640 bytes = 320 samples * 2)
    const sent = MockWs.last!.sent[0] as Buffer;
    expect(Buffer.isBuffer(sent)).toBe(true);
    expect(sent.length).toBe(640);
  });

  it("sendAudio() buffers before WS open", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    ws.readyState = 0;

    await provider.sendAudio(Buffer.from([0x01, 0x02]));
    expect(ws.sent).toHaveLength(0);

    ws.readyState = 1;
    ws._emit("open");
    await c;

    // Flushed buffered frame (decoded PCM)
    expect(ws.sent.length).toBe(1);
    expect(Buffer.isBuffer(ws.sent[0])).toBe(true);
    expect((ws.sent[0] as Buffer).length).toBe(640);
  });

  it("handleMessage transcript with is_final: false — partial", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    provider.onTranscript = (text, isFinal) => {
      transcripts.push({ text, isFinal });
    };

    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "transcript",
      data: {
        transcription: "hel",
        is_final: false,
      },
    })));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].text).toBe("hel");
    expect(transcripts[0].isFinal).toBe(false);
  });

  it("handleMessage transcript with is_final: true — final, accumulates", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const transcripts: Array<{ text: string; isFinal: boolean }> = [];
    provider.onTranscript = (text, isFinal) => {
      transcripts.push({ text, isFinal });
    };

    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "transcript",
      data: {
        transcription: "hello world",
        is_final: true,
      },
    })));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].text).toBe("hello world");
    expect(transcripts[0].isFinal).toBe(true);
    expect((provider as any).finalTranscript).toBe("hello world");
  });

  it("handleMessage transcript with speech_end — resolves finalize, fires onSpeechEnd", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    let speechEndCalled = false;
    provider.onSpeechEnd = () => { speechEndCalled = true; };

    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "transcript",
      data: {
        transcription: "done",
        is_final: true,
        speech_end: true,
      },
    })));

    expect(speechEndCalled).toBe(true);
    // finalizeResolve should have been called
    expect((provider as any).finalizeResolve).toBeNull();
  });

  it("handleMessage post_final_transcript — resolves finalize", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    // Set some transcript first via a final message (without speech_end)
    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "transcript",
      data: {
        transcription: "test",
        is_final: true,
      },
    })));

    // finalizeResolve should still exist (no speech_end signal)
    expect((provider as any).finalizeResolve).not.toBeNull();

    // Now send post_final_transcript
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "post_final_transcript",
    })));

    expect((provider as any).finalizeResolve).toBeNull();
  });

  it("finalize() sends { type: 'stop_recording' }", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    const ws = MockWs.last!;
    const finalizePromise = provider.finalize();

    // Check stop_recording was sent
    const stopMsg = JSON.parse(ws.sent[0] as string);
    expect(stopMsg.type).toBe("stop_recording");

    // Resolve via post_final_transcript
    ws._emit("message", Buffer.from(JSON.stringify({ type: "post_final_transcript" })));
    await finalizePromise;
  });

  it("finalize() timeout fallback (6s)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;

    // Set partial transcript
    const ws = MockWs.last!;
    ws._emit("message", Buffer.from(JSON.stringify({
      type: "transcript",
      data: {
        transcription: "partial",
        is_final: false,
      },
    })));

    vi.useFakeTimers();

    const finalizePromise = provider.finalize();
    await vi.advanceTimersByTimeAsync(6000);

    const result = await finalizePromise;
    expect(result).toBe("partial");
  });

  it("close() handles CONNECTING state (terminate)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    const ws = MockWs.last!;
    ws.readyState = 0;
    await provider.close();
    expect(ws.readyState).toBe(MockWs.CLOSED);
  });

  it("close() handles OPEN state (close)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "wss://gladia.io/session/abc" }),
    });

    const c = provider.connect();
    await tick();
    openWs();
    await c;
    await provider.close();
    expect(MockWs.last!.readyState).toBe(MockWs.CLOSED);
  });
});
