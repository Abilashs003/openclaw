/**
 * Per-client voice session orchestrator.
 *
 * Ported from cheekoclaw_bridge/voice_session.py
 *
 * Wires together:
 *   Client WebSocket ↔ Opus codec ↔ STT Provider ↔ OpenClaw Agent ↔ TTS Provider
 *
 * State machine: IDLE → LISTENING → PROCESSING_STT → QUERYING_LLM → STREAMING_TTS → IDLE
 *
 * Each session manages its own STT/TTS provider instances, OpenClaw connection,
 * and Opus encoding/decoding state.
 */

import type WebSocket from "ws";
import { sttRegistry } from "../stt/stt-registry.js";
import { ttsRegistry } from "../tts/tts-registry.js";
import type { SttProvider } from "../stt/stt-provider.js";
import type { TtsProvider } from "../tts/tts-provider.js";
import { deviceOtpManager } from "../device/device-otp.js";
import { SileroVad } from "../vad/silero-vad.js";

// ── TTS provider → env var mapping ───────────────────────────────
// Maps each TTS provider ID to the environment variables it reads for
// API key, voice ID, and model. Used by both auto-hello and hello-message
// config resolution paths so the correct credentials are picked up.
const TTS_ENV_MAP: Record<string, { apiKey: string; voiceId?: string; model?: string }> = {
  "elevenlabs":  { apiKey: "ELEVENLABS_API_KEY",   voiceId: "ELEVENLABS_VOICE_ID",   model: "ELEVENLABS_MODEL_ID" },
  "rime":        { apiKey: "RIME_API_KEY",          voiceId: "RIME_VOICE_ID" },
  "inworld":     { apiKey: "INWORLD_API_KEY",       voiceId: "INWORLD_VOICE_ID" },
  "cartesia":    { apiKey: "CARTESIA_API_KEY",      voiceId: "CARTESIA_VOICE_ID" },
  "smallest-ai": { apiKey: "SMALLEST_AI_API_KEY",   voiceId: "SMALLEST_AI_VOICE_ID" },
  "groq-playai": { apiKey: "GROQ_API_KEY",          voiceId: "GROQ_VOICE_ID" },
};

/** Resolve TTS env vars for a given provider ID. */
function resolveTtsEnv(providerId: string): { apiKey: string; voiceId?: string; model?: string } {
  const env = TTS_ENV_MAP[providerId] ?? TTS_ENV_MAP["elevenlabs"];
  return {
    apiKey:  process.env[env.apiKey] ?? "",
    voiceId: env.voiceId ? process.env[env.voiceId] : undefined,
    model:   env.model   ? process.env[env.model]   : undefined,
  };
}

// ── Opus Encoder (lazy-loaded) ────────────────────────────────
// opusscript is a pure JS/WASM Opus encoder — no native binary needed.
// It converts PCM audio from TTS into Opus frames that the ESP32 can decode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let opusEncoderInstance: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getOpusEncoder(): Promise<any> {
  if (opusEncoderInstance) return opusEncoderInstance;

  try {
    // opusscript is pure JS/WASM — works without native binaries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    // Application.AUDIO = 2048 (best for voice/music), VOIP = 2049
    opusEncoderInstance = new Ctor(OUTPUT_SAMPLE_RATE, 1, Ctor.Application.VOIP);
    // Set 32kbps bitrate — matches cheekoclaw_bridge (OPUS_SET_BITRATE_REQUEST = 4002)
    try { opusEncoderInstance.encoderCTL(4002, 32000); } catch { /* best effort */ }
    console.log(`[opus] Encoder initialized via opusscript: ${OUTPUT_SAMPLE_RATE}Hz mono 32kbps VOIP`);
    return opusEncoderInstance;
  } catch (err) {
    console.error("[opus] Failed to load opusscript:", err);
    throw new Error("Opus encoder not available. Install opusscript.");
  }
}

// ── Opus Decoder (lazy-loaded) ────────────────────────────────
// Decodes incoming Opus frames from ESP32 to 16kHz PCM for Silero VAD.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let opusDecoderInstance: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getOpusDecoder(): Promise<any> {
  if (opusDecoderInstance) return opusDecoderInstance;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    // Decode at 16kHz mono — matches ESP32 incoming audio sample rate
    opusDecoderInstance = new Ctor(INPUT_SAMPLE_RATE, 1, Ctor.Application.VOIP);
    console.log(`[opus] Decoder initialized via opusscript: ${INPUT_SAMPLE_RATE}Hz mono`);
    return opusDecoderInstance;
  } catch (err) {
    console.error("[opus] Failed to load opusscript for decoding:", err);
    throw new Error("Opus decoder not available. Install opusscript.");
  }
}

// Same sentence boundary regex as the gateway (cheeko-chat.ts)
const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+/;

// Silence pause between sentences in milliseconds
const SENTENCE_PAUSE_MS = 300;

// Opus frame parameters — matches cheekoclaw_bridge/audio_codec.py exactly.
// 24kHz output, 60ms frames, 1440 samples/frame, 2880 bytes PCM/frame.
const OUTPUT_SAMPLE_RATE = 24000;
const OUTPUT_FRAME_MS = 60;
const OUTPUT_SAMPLES_PER_FRAME = (OUTPUT_SAMPLE_RATE * OUTPUT_FRAME_MS) / 1000; // 1440
const OUTPUT_FRAME_BYTES = OUTPUT_SAMPLES_PER_FRAME * 2; // 2880 bytes (16-bit PCM)

// Incoming audio parameters (ESP32 → server): 16kHz, 1ch
// Frame duration varies by firmware (XiaoZhi uses 20ms, others may use 60ms).
// The actual frame duration is read from the hello handshake and stored per-session.
const INPUT_SAMPLE_RATE = 16000;
const DEFAULT_INPUT_FRAME_MS = 60;

export type VoiceSessionState =
  | "idle"
  | "listening"
  | "processing_stt"
  | "querying_llm"
  | "streaming_tts";

interface SessionConfig {
  /** OpenClaw Gateway WebSocket URL. */
  openclawUrl: string;
  /** OpenClaw Gateway auth token. */
  openclawToken: string;
  /** STT provider ID. */
  sttProvider: string;
  /** STT API key. */
  sttApiKey: string;
  /** STT model. */
  sttModel?: string;
  /** TTS provider ID. */
  ttsProvider: string;
  /** TTS API key. */
  ttsApiKey: string;
  /** TTS voice ID. */
  ttsVoiceId?: string;
  /** TTS model ID. */
  ttsModel?: string;
  /** Language code. */
  language: string;
}

/**
 * Represents a single voice session with an ESP32 or voice client.
 *
 * The session is created when a client connects to the `/voice/stream`
 * WebSocket endpoint and destroyed when the connection closes.
 */
export class VoiceSession {
  readonly sessionId: string;

  private ws: WebSocket;
  private state: VoiceSessionState = "idle";
  private cfg: SessionConfig | null = null;
  private isEsp32 = false;
  private deviceId = "unknown";

  // STT/TTS provider instances (created per utterance)
  private stt: SttProvider | null = null;
  private tts: TtsProvider | null = null;

  // Listening mode from the ESP32 listen start message:
  //   "manual"   — push-to-talk (button held). Only speech_end drives processing.
  //   "auto"     — auto-stop VAD mode. Deepgram speech_final drives processing.
  //   "realtime" — continuous real-time mode.
  private listenMode: "manual" | "auto" | "realtime" = "auto";

  // OpenClaw: dispatched via runtime.channel.reply.dispatchReplyFromConfig (in-process, no WS needed)
  private openclawConnected = false;
  private openclawWs: WebSocket | null = null; // kept for cleanup compat

  // Processing task abort support
  private processingAbortController: AbortController | null = null;

  // Silero VAD for local speech-end detection
  private vad: SileroVad | null = null;
  private vadReady = false;

  // Input audio frame duration from ESP32 hello (default 60ms, XiaoZhi sends 20ms)
  private inputFrameMs = DEFAULT_INPUT_FRAME_MS;

  constructor(ws: WebSocket, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;

    // Initialize Silero VAD in background (non-blocking)
    this.initVad();
  }

  private initVad(): void {
    const vad = new SileroVad({
      speechThreshold: 0.5,
      silenceDurationMs: 600,
      minSpeechDurationMs: 250,
    });

    vad.init()
      .then(() => {
        this.vad = vad;
        this.vadReady = true;

        // Wire VAD speech-end to trigger processUtterance
        this.vad!.onSpeechEnd = () => {
          if (this.state === "listening") {
            this.log("info", "Silero VAD speech_end → triggering processUtterance");
            this.processUtterance().catch((err) =>
              this.log("error", `processUtterance error from VAD: ${err}`)
            );
          }
        };

        this.log("info", "Silero VAD initialized");
      })
      .catch((err) => {
        this.log("warn", `Silero VAD init failed (falling back to Deepgram VAD): ${err}`);
      });
  }

  /**
   * Handle an incoming message (binary audio or JSON control message).
   */
  async handleMessage(data: Buffer | string): Promise<void> {
    if (Buffer.isBuffer(data)) {
      // XiaoZhi firmware sends JSON control messages as binary WebSocket frames.
      // Try to detect JSON by checking if the buffer starts with '{'.
      if (data.length > 0 && data[0] === 0x7b) { // 0x7b = '{'
        try {
          const text = data.toString("utf8");
          JSON.parse(text); // validate it's real JSON
          await this.handleJson(text);
          return;
        } catch {
          // Not JSON — fall through to audio handling
        }
      }
      await this.handleAudio(data);
    } else {
      await this.handleJson(data);
    }
  }

  /**
   * End the current voice session but keep the WebSocket and OpenClaw Gateway
   * connection alive for reuse. Called on goodbye or before session restart.
   */
  async endSession(): Promise<void> {
    if (this.processingAbortController) {
      this.processingAbortController.abort();
      this.processingAbortController = null;
    }
    if (this.stt) {
      await this.stt.close();
      this.stt = null;
    }
    if (this.tts) {
      await this.tts.close();
      this.tts = null;
    }
    if (this.vad) {
      await this.vad.destroy();
      this.vad = null;
      this.vadReady = false;
    }
    this.setState("idle");
    this.log("info", "Session ended (connection kept alive)");
  }

  /**
   * Full cleanup — only called when the WebSocket actually closes.
   * Destroys everything including the OpenClaw Gateway connection.
   */
  async cleanup(): Promise<void> {
    await this.endSession();
    if (this.openclawWs) {
      try {
        this.openclawWs.close();
      } catch {
        // Ignore
      }
      this.openclawWs = null;
      this.openclawConnected = false;
    }
    this.log("info", "Connection fully cleaned up");
  }

  // ── Private Handlers ──────────────────────────────────────────

  private async handleAudio(opusFrame: Buffer): Promise<void> {
    // ── Auto-hello for firmware that sends binary before/without a JSON hello ──
    // XiaoZhi firmware sends raw Opus binary as first message, no JSON hello.
    // We auto-initialize from env vars and send the server hello immediately.
    if (!this.cfg) {
      this.isEsp32 = true;
      this.inputFrameMs = 20; // XiaoZhi firmware uses 20ms frames
      this.log("info", "First binary frame before hello — auto-initializing (XiaoZhi firmware, 20ms frames)");

      const gatewayUrl   = process.env.OPENCLAW_GATEWAY_URL   ?? "ws://127.0.0.1:18789";
      const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
      const autoTtsProvider = process.env.TTS_PROVIDER ?? "elevenlabs";
      const autoTtsEnv = resolveTtsEnv(autoTtsProvider);
      this.cfg = {
        openclawUrl:   gatewayUrl,
        openclawToken: gatewayToken,
        sttProvider: "deepgram",
        sttApiKey:   process.env.DEEPGRAM_API_KEY ?? "",
        sttModel:    process.env.DEEPGRAM_MODEL,
        ttsProvider: autoTtsProvider,
        ttsApiKey:   autoTtsEnv.apiKey,
        ttsVoiceId:  autoTtsEnv.voiceId,
        ttsModel:    autoTtsEnv.model,
        language:    "en",
      };

      // Send server hello — required before firmware starts sending audio
      await this.sendJson({
        type: "hello",
        transport: "websocket",
        session_id: this.sessionId,
        audio_params: {
          format: "opus",
          sample_rate: OUTPUT_SAMPLE_RATE,
          channels: 1,
          frame_duration: OUTPUT_FRAME_MS,
        },
      });
      this.log("info", `Auto-hello sent. STT key: ${this.cfg.sttApiKey ? "✓" : "MISSING"}, TTS key: ${this.cfg.ttsApiKey ? "✓" : "MISSING"}`);

      // Connect to Gateway in background
      if (gatewayUrl) {
        this.connectToOpenClaw().catch((err) => {
          this.log("error", `Background Gateway connect failed: ${err}`);
        });
      }
    }

    if (this.state === "idle") {
      // First audio frame while idle → auto-start listening
      await this.startListening();
    }

    if (this.state !== "listening" || !this.stt) {
      return;
    }

    // Send original Opus frames to Deepgram STT (unchanged — Deepgram decodes Opus natively)
    try {
      await this.stt.sendAudio(opusFrame);
    } catch (err) {
      this.log("error", `Audio send error: ${err}`);
    }

    // Decode Opus → PCM and feed to Silero VAD for local speech-end detection
    if (this.vadReady && this.vad) {
      try {
        const decoder = await getOpusDecoder();
        // Use the actual frame duration from the ESP32 hello (e.g. 20ms for XiaoZhi)
        // instead of a hardcoded 60ms, otherwise the decoder returns a buffer
        // padded with zeros that dilutes the speech signal below VAD threshold.
        const samplesPerFrame = (INPUT_SAMPLE_RATE * this.inputFrameMs) / 1000;
        const decoded = decoder.decode(opusFrame, samplesPerFrame);
        const pcmBuffer: Buffer = Buffer.from(decoded);
        // Convert Buffer (Int16) to Int16Array for VAD
        const pcmInt16 = new Int16Array(
          pcmBuffer.buffer,
          pcmBuffer.byteOffset,
          pcmBuffer.byteLength / 2
        );
        await this.vad.processAudio(pcmInt16);
      } catch (err) {
        // Non-fatal — VAD decode failure just means we fall back to Deepgram VAD
        this.log("debug", `VAD audio decode error: ${err}`);
      }
    }
  }


  private async handleJson(text: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    const msgType = msg.type as string;
    this.log("debug", `Received: ${msgType}`);

    switch (msgType) {
      case "hello":
        await this.handleHello(msg);
        break;
      case "listen":
        await this.handleListen(msg);
        break;
      case "speech_end":
        if (this.state === "listening") {
          await this.processUtterance();
        }
        break;
      case "abort":
        this.log("info", `Abort: ${(msg.reason as string) ?? "unknown"}`);
        await this.handleAbort();
        break;
      case "goodbye":
        await this.handleGoodbye();
        break;
      default:
        break;
    }
  }

  private async handleHello(msg: Record<string, unknown>): Promise<void> {
    // Detect ESP32 client
    this.isEsp32 = Boolean(msg.transport || msg.audio_params || typeof msg.version === "number");
    this.deviceId = (msg.deviceId as string) ?? "unknown";

    // Read input frame duration from hello audio_params (XiaoZhi sends 20ms, default 60ms)
    const audioParams = msg.audio_params as Record<string, unknown> | undefined;
    if (audioParams?.frame_duration) {
      this.inputFrameMs = Number(audioParams.frame_duration);
      this.log("info", `Input frame duration from hello: ${this.inputFrameMs}ms`);
    }

    this.log("info", `Hello received — full message: ${JSON.stringify(msg).slice(0, 500)}`);
    this.log("info", `Hello from ${this.isEsp32 ? "ESP32" : "voice_client"} device: ${this.deviceId}`);

    // ── Session restart: if we already have a config, this is a RE-HELLO ──
    // End current session state but keep Gateway connection alive for reuse.
    if (this.cfg) {
      this.log("info", "Re-hello on existing connection — restarting session (reusing Gateway)");
      await this.endSession();
    }

    // ── OTP pairing (optional — we never block the connection on failure) ──
    const otp = msg.otp as string | undefined;
    if (otp) {
      const result = deviceOtpManager.verifyOtp(otp, this.deviceId);
      if (result) {
        this.log("info", `Device "${this.deviceId}" paired via OTP`);
        await this.sendJson({
          type: "paired",
          deviceId: this.deviceId,
          deviceToken: result.deviceToken,
        });
      } else {
        // ⚠️  Don't return — just warn and continue.
        // Returning here would block the hello response and cause
        // "Failed to receive server hello" on the firmware side.
        this.log("warn", `OTP "${otp}" invalid or expired — allowing connection anyway (dev mode)`);
      }
    }

    // ── Extract per-session config from hello ──
    const oc = msg.openclaw as Record<string, string> | undefined;
    const sttConfig = msg.stt as Record<string, string> | undefined;
    const ttsConfig = msg.tts as Record<string, string> | undefined;

    // Resolve OpenClaw Gateway URL — fall back to localhost if not in hello
    const resolvedOpenclawUrl =
      oc?.url?.trim() ||
      process.env.OPENCLAW_GATEWAY_URL ||
      "ws://127.0.0.1:18789";
    const resolvedOpenclawToken =
      oc?.token?.trim() ||
      process.env.OPENCLAW_GATEWAY_TOKEN ||
      "";

    if (!oc?.url) {
      this.log("info", `No openclaw URL in hello, falling back to ${resolvedOpenclawUrl}`);
    }

    const helloTtsProvider = ttsConfig?.provider ?? process.env.TTS_PROVIDER ?? "elevenlabs";
    const helloTtsEnv = resolveTtsEnv(helloTtsProvider);
    this.cfg = {
      openclawUrl: resolvedOpenclawUrl,
      openclawToken: resolvedOpenclawToken,
      sttProvider: sttConfig?.provider ?? "deepgram",
      sttApiKey: sttConfig?.apiKey ?? process.env.DEEPGRAM_API_KEY ?? "",
      sttModel: sttConfig?.model ?? process.env.DEEPGRAM_MODEL,
      ttsProvider: helloTtsProvider,
      ttsApiKey: ttsConfig?.apiKey ?? helloTtsEnv.apiKey,
      ttsVoiceId: ttsConfig?.voiceId ?? helloTtsEnv.voiceId,
      ttsModel: ttsConfig?.model ?? helloTtsEnv.model,
      language: (msg.language as string) ?? "en",
    };

    // ── Send hello response FIRST ──────────────────────────────────────────
    // The ESP32 firmware has a short timeout (a few seconds) for the server
    // hello. We must reply immediately — BEFORE connecting to the Gateway,
    // which can take time and would cause "Failed to receive server hello".
    if (this.isEsp32) {
      await this.sendJson({
        type: "hello",
        transport: "websocket",
        session_id: this.sessionId,
        audio_params: {
          format: "opus",
          sample_rate: OUTPUT_SAMPLE_RATE,
          channels: 1,
          frame_duration: OUTPUT_FRAME_MS,
        },
      });
    } else {
      await this.sendJson({
        type: "hello",
        sessionId: this.sessionId,
      });
    }
    // ── Connect to OpenClaw Gateway (only if not already connected) ──────
    // If this is a re-hello on the same connection, the Gateway WS is already
    // alive — skip the expensive Ed25519 handshake and reuse it instantly.
    if (this.openclawConnected && this.openclawWs) {
      this.log("info", "Hello response sent — reusing existing OpenClaw Gateway connection ✓");
    } else {
      this.log("info", "Hello response sent — connecting to OpenClaw Gateway in background");
      // Do NOT await this — the firmware is already past the hello handshake
      // and ready for audio. Gateway connection failure is handled gracefully
      // inside processUtterance().
      if (this.cfg.openclawUrl) {
        this.connectToOpenClaw().catch((err) => {
          this.log("error", `Background Gateway connect failed: ${err}`);
        });
      }
    }
  }


  private async handleListen(msg: Record<string, unknown>): Promise<void> {
    const listenState = msg.state as string;

    if (listenState === "start") {
      // Read listening mode sent by the ESP32:
      //   "manual"   → push-to-talk (button held) — VAD must NOT auto-submit
      //   "auto"     → device-side VAD auto-stop — VAD drives submission
      //   "realtime" → continuous realtime mode
      const rawMode = msg.mode as string | undefined;
      if (rawMode === "manual" || rawMode === "auto" || rawMode === "realtime") {
        this.listenMode = rawMode;
      } else {
        this.listenMode = "auto"; // safe default
      }
      this.log("info", `Listen start (mode=${this.listenMode})`);
      // If stuck in a non-idle state, force-abort before starting new listen.
      // This recovers from states like streaming_tts or querying_llm that may
      // have gotten stuck due to provider timeouts or network issues.
      if (this.state !== "idle") {
        this.log("warn", `Force-aborting stuck state '${this.state}' for new listen`);
        await this.handleAbort();
      }
      await this.startListening();
    } else if (listenState === "stop") {
      this.log("info", "Listen stop");
      if (this.state === "listening") {
        await this.processUtterance();
      }
    }
  }

  private async handleAbort(): Promise<void> {
    // Cancel processing
    if (this.processingAbortController) {
      this.processingAbortController.abort();
      this.processingAbortController = null;
    }

    // Close STT
    if (this.stt) {
      await this.stt.close();
      this.stt = null;
    }

    // Close TTS
    if (this.tts) {
      await this.tts.close();
      this.tts = null;
    }

    // Signal stop to client
    if (this.isEsp32) {
      await this.sendJson({ type: "tts", state: "stop" });
    } else {
      await this.sendJson({ type: "audio_end" });
    }

    this.setState("idle");
    this.log("info", "Abort complete, back to idle");
  }

  private async handleGoodbye(): Promise<void> {
    this.log("info", "Goodbye received — ending session, keeping connection alive");

    // End the voice session (close STT/TTS) but keep WS + Gateway alive
    await this.endSession();

    // Acknowledge the goodbye so the ESP32 knows we received it
    await this.sendJson({
      type: "goodbye",
      session_id: this.sessionId,
    });

    this.log("info", "Session ended gracefully — ready for new hello on same connection");
  }

  // ── Voice Pipeline ────────────────────────────────────────────

  private async startListening(): Promise<void> {
    if (this.state !== "idle" || !this.cfg) return;

    // Validate STT provider
    if (!this.cfg.sttApiKey) {
      await this.sendJson({
        type: "error",
        message: `STT API key not configured (provider: ${this.cfg.sttProvider})`,
      });
      return;
    }

    if (!sttRegistry.has(this.cfg.sttProvider)) {
      await this.sendJson({
        type: "error",
        message: `STT provider "${this.cfg.sttProvider}" not available`,
      });
      return;
    }

    this.setState("listening");

    // Reset VAD state for new utterance
    if (this.vad) {
      this.vad.resetState();
    }

    // Create STT provider instance
    this.stt = sttRegistry.create(this.cfg.sttProvider, {
      apiKey: this.cfg.sttApiKey,
      model: this.cfg.sttModel,
      language: this.cfg.language,
    });

    // Set up transcript callback
    this.stt.onTranscript = async (text: string, isFinal: boolean) => {
      this.log("debug", `STT [${isFinal ? "FINAL" : "partial"}]: ${text}`);
      await this.sendJson({
        type: "transcript",
        text,
        partial: !isFinal,
      });
    };

    // Set up VAD end-of-speech callback (fired by Deepgram speech_final).
    //
    // For "auto" and "realtime" modes: VAD drives processUtterance() — the
    // device trusts the server to detect end of speech.
    //
    // For "manual" mode (push-to-talk, button held): do NOT auto-process on
    // VAD. The user may pause mid-sentence while still holding the button.
    // Only speech_end (button release) should trigger processUtterance().
    if (this.stt.onSpeechEnd !== undefined) {
      if (this.listenMode === "manual") {
        this.stt.onSpeechEnd = null; // disable VAD auto-submit for push-to-talk
        this.log("info", "VAD auto-submit disabled (manual/push-to-talk mode)");
      } else {
        this.stt.onSpeechEnd = () => {
          if (this.state === "listening") {
            this.log("info", `VAD speech_final → triggering processUtterance (mode=${this.listenMode})`);
            this.processUtterance().catch((err) => this.log("error", `processUtterance error: ${err}`));
          }
        };
      }
    }

    await this.stt.connect();
  }

  private async processUtterance(): Promise<void> {
    // Guard against double-invocation (speech_end + onSpeechEnd VAD can both fire)
    if (this.state !== "listening") {
      this.log("debug", `processUtterance skipped — state is ${this.state}`);
      return;
    }
    this.setState("processing_stt");
    this.processingAbortController = new AbortController();

    try {
      // 1. Finalize STT to get final transcript
      let transcript = "";
      if (this.stt) {
        transcript = await this.stt.finalize();
        await this.stt.close();
        this.stt = null;
      }

      if (!transcript.trim()) {
        this.log("info", "Empty transcript, skipping");
        this.setState("idle");
        return;
      }

      this.log("info", `Transcript: ${transcript}`);

      // Send final transcript to client
      if (this.isEsp32) {
        await this.sendJson({ type: "stt", text: transcript });
      } else {
        await this.sendJson({ type: "transcript", text: transcript, partial: false });
      }

      // 2. Query OpenClaw LLM
      // If the Gateway connection is still in progress (non-blocking connect),
      // wait up to 5 seconds for it to complete before failing.
      if (!this.openclawConnected) {
        this.log("info", "Waiting for OpenClaw connection...");
        const waitMs = 5000;
        const pollMs = 100;
        let waited = 0;
        while (!this.openclawConnected && waited < waitMs) {
          await new Promise((r) => setTimeout(r, pollMs));
          waited += pollMs;
        }
      }
      if (!this.openclawConnected) {
        await this.sendJson({
          type: "error",
          message: "No OpenClaw connection (missing credentials or gateway unavailable)",
        });
        this.setState("idle");
        return;
      }

      this.setState("querying_llm");
      await this.sendJson({ type: "status", stage: "thinking" });
      this.log("info", `Querying OpenClaw: ${transcript.slice(0, 80)}`);

      let responseText: string;
      try {
        responseText = await this.sendToOpenClaw(transcript);
      } catch (err) {
        this.log("error", `OpenClaw error: ${err}`);
        responseText = "Sorry, I encountered an error processing your request.";
      }

      if (!responseText.trim()) {
        responseText = "I didn't get a response.";
      }

      this.log("info", `OpenClaw response (${responseText.length} chars): ${responseText.slice(0, 120)}`);

      // 3. Stream TTS audio back — sentence by sentence
      await this.streamTtsResponse(responseText);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.log("info", "Processing cancelled (abort)");
        return;
      }
      this.log("error", `Process error: ${err}`);
      await this.sendJson({ type: "error", message: String(err) });
    } finally {
      this.processingAbortController = null;
      this.setState("idle");
    }
  }

  private async streamTtsResponse(responseText: string): Promise<void> {
    if (!this.cfg) return;

    this.setState("streaming_tts");

    // Split into sentences (same regex as gateway)
    let sentences = responseText.split(SENTENCE_BOUNDARY_RE).filter((s) => s.trim());
    if (sentences.length === 0) sentences = [responseText];
    this.log("info", `TTS: ${sentences.length} sentence(s) to speak`);

    // Signal TTS start
    if (this.isEsp32) {
      await this.sendJson({ type: "tts", state: "start" });
    } else {
      await this.sendJson({ type: "response_text", text: responseText, partial: false });
      await this.sendJson({ type: "status", stage: "speaking" });
    }

    // Validate TTS provider
    if (!this.cfg.ttsApiKey) {
      await this.sendJson({
        type: "error",
        message: `TTS API key not configured (provider: ${this.cfg.ttsProvider})`,
      });
      return;
    }

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      this.log("info", `TTS sentence ${i + 1}/${sentences.length}: ${sentence.slice(0, 80)}`);

      // Per-sentence signal — matches cheekoclaw_bridge protocol
      if (this.isEsp32) {
        await this.sendJson({ type: "tts", state: "sentence_start", text: sentence });
      }

      // Synthesize and stream — awaited so sentences play sequentially
      await this.synthesizeAndStream(sentence);

      // Insert silence pause between sentences (not after last)
      if (i < sentences.length - 1) {
        this.log("debug", `Inserting ${SENTENCE_PAUSE_MS}ms silence`);
        await this.sendSilence(SENTENCE_PAUSE_MS);
      }
    }

    // Signal TTS complete
    if (this.isEsp32) {
      await this.sendJson({ type: "tts", state: "stop" });
    } else {
      await this.sendJson({ type: "audio_end" });
    }
    this.log("debug", "Audio stream complete");
  }

  private async synthesizeAndStream(text: string): Promise<void> {
    if (!this.cfg) return;

    const pcmBuffer: Buffer[] = [];
    let frameCount = 0;
    // Track next frame deadline for accurate real-time pacing.
    // 0 = not started yet; anchored to the moment the FIRST frame is sent
    // so subsequent frames are spaced exactly OUTPUT_FRAME_MS apart.
    let nextFrameAt = 0;

    // drainPromise: tracks the last pacing sleep so we can await it after flush().
    // This ensures synthesizeAndStream() doesn't return until ALL frames have
    // actually been sent AND their pacing delay has elapsed — i.e. the ESP32
    // has had enough time to play every frame before we start the next sentence.
    let drainPromise: Promise<void> = Promise.resolve();

    // Get Opus encoder for ESP32 clients (they expect Opus-encoded binary frames)
    let encoder: Awaited<ReturnType<typeof getOpusEncoder>> | null = null;
    if (this.isEsp32) {
      try {
        encoder = await getOpusEncoder();
        this.log("debug", "Using Opus encoding for ESP32 output");
      } catch (err) {
        this.log("error", `Opus encoder unavailable, sending raw PCM: ${err}`);
      }
    }

    // Create TTS provider instance for this sentence
    this.tts = ttsRegistry.create(this.cfg.ttsProvider, {
      apiKey: this.cfg.ttsApiKey,
      voiceId: this.cfg.ttsVoiceId,
      model: this.cfg.ttsModel,
      language: this.cfg.language,
    });
    this.log("info", `TTS using provider: ${this.cfg.ttsProvider} (voice: ${this.cfg.ttsVoiceId ?? "default"}, model: ${this.cfg.ttsModel ?? "default"})`);

    // Collect PCM audio, Opus-encode if ESP32, send as binary frames
    this.tts.onAudio = async (pcmChunk: Buffer) => {
      // Buffer PCM and send in fixed-size frames (paced at real-time rate)
      pcmBuffer.push(pcmChunk);
      const totalPcm = Buffer.concat(pcmBuffer);
      pcmBuffer.length = 0;

      let offset = 0;
      while (offset + OUTPUT_FRAME_BYTES <= totalPcm.length) {
        const pcmFrame = totalPcm.subarray(offset, offset + OUTPUT_FRAME_BYTES);
        offset += OUTPUT_FRAME_BYTES;

        // Encode PCM → Opus for ESP32, or send raw PCM for other clients
        let frameToSend: Buffer;
        if (encoder) {
          try {
            frameToSend = Buffer.from(encoder.encode(pcmFrame, OUTPUT_SAMPLES_PER_FRAME));
          } catch (err) {
            this.log("error", `Opus encode error: ${err}`);
            frameToSend = pcmFrame; // Fallback to raw PCM
          }
        } else {
          frameToSend = pcmFrame;
        }

        await this.sendBinary(frameToSend);

        // Anchor pacing to first frame send time (matches cheekoclaw_bridge last_send_time=0)
        if (nextFrameAt === 0) nextFrameAt = Date.now();
        frameCount++;

        // Accurate real-time pacing: sleep only the remaining time until next frame deadline.
        // We chain a new drainPromise so the caller can await the very last sleep.
        nextFrameAt += OUTPUT_FRAME_MS;
        const sleepMs = nextFrameAt - Date.now();
        if (sleepMs > 0) {
          drainPromise = new Promise<void>((resolve) => { setTimeout(resolve, sleepMs); });
          await drainPromise;
        } else {
          // No sleep needed but still mark drain as resolved
          drainPromise = Promise.resolve();
        }
      }

      // Keep remainder in buffer
      if (offset < totalPcm.length) {
        pcmBuffer.push(totalPcm.subarray(offset));
      }
    };

    try {
      await this.tts.connect();
      await this.tts.synthesize(text);
      await this.tts.flush();

      // Flush remaining PCM buffer (pad with silence to full frame size)
      if (pcmBuffer.length > 0) {
        const remaining = Buffer.concat(pcmBuffer);
        if (remaining.length > 0) {
          const padded = Buffer.alloc(OUTPUT_FRAME_BYTES);
          remaining.copy(padded);

          let frameToSend: Buffer;
          if (encoder) {
            try {
              frameToSend = Buffer.from(encoder.encode(padded, OUTPUT_SAMPLES_PER_FRAME));
            } catch {
              frameToSend = padded;
            }
          } else {
            frameToSend = padded;
          }

          await this.sendBinary(frameToSend);
          frameCount++;

          // Pace the final padded frame too
          nextFrameAt += OUTPUT_FRAME_MS;
          const sleepMs = nextFrameAt - Date.now();
          if (sleepMs > 0) {
            drainPromise = new Promise<void>((resolve) => { setTimeout(resolve, sleepMs); });
          }
        }
      }

      // Wait for the very last pacing sleep to complete before returning.
      // This is what ensures sentences play one-after-another on the ESP32.
      await drainPromise;

      this.log("debug", `TTS sent ${frameCount} ${encoder ? "Opus" : "PCM"} frames (paced at ${OUTPUT_FRAME_MS}ms)`);
    } finally {
      await this.tts.close();
      this.tts = null;
    }
  }

  private async sendSilence(durationMs: number): Promise<void> {
    const totalSamples = (OUTPUT_SAMPLE_RATE * durationMs) / 1000;
    const silenceBytes = totalSamples * 2; // 16-bit
    const silence = Buffer.alloc(silenceBytes);

    // Get Opus encoder for ESP32 silence frames
    let encoder: Awaited<ReturnType<typeof getOpusEncoder>> | null = null;
    if (this.isEsp32) {
      try {
        encoder = await getOpusEncoder();
      } catch {
        // Fall back to raw PCM
      }
    }

    let offset = 0;
    while (offset + OUTPUT_FRAME_BYTES <= silence.length) {
      const pcmFrame = silence.subarray(offset, offset + OUTPUT_FRAME_BYTES);

      let frameToSend: Buffer;
      if (encoder) {
        try {
          frameToSend = Buffer.from(encoder.encode(pcmFrame, OUTPUT_SAMPLES_PER_FRAME));
        } catch {
          frameToSend = pcmFrame;
        }
      } else {
        frameToSend = pcmFrame;
      }

      await this.sendBinary(frameToSend);
      offset += OUTPUT_FRAME_BYTES;
      await new Promise((resolve) => setTimeout(resolve, OUTPUT_FRAME_MS));
    }
  }

  // ── OpenClaw Communication ────────────────────────────────────
  // Connects using the device identity Ed25519 key stored in
  // ~/.openclaw/identity/device.json — implemented entirely in the
  // extension, no core code changes needed.

  private async connectToOpenClaw(): Promise<void> {
    if (!this.cfg?.openclawUrl) return;

    const { WebSocket: WS } = await import("ws");
    const nodeCrypto = await import("node:crypto");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");

    // ── Load device identity ──────────────────────────────────
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.default.join(os.default.homedir(), ".openclaw");
    const identityPath = path.default.join(stateDir, "identity", "device.json");
    let deviceIdentity: { deviceId: string; publicKeyPem: string; privateKeyPem: string } | null = null;

    try {
      if (fs.default.existsSync(identityPath)) {
        const raw = JSON.parse(fs.default.readFileSync(identityPath, "utf8"));
        if (raw?.version === 1 && raw.deviceId && raw.publicKeyPem && raw.privateKeyPem) {
          deviceIdentity = { deviceId: raw.deviceId, publicKeyPem: raw.publicKeyPem, privateKeyPem: raw.privateKeyPem };
          this.log("info", `Loaded device identity: ${deviceIdentity.deviceId.slice(0, 16)}...`);
        }
      }
    } catch (err) {
      this.log("warn", `Could not load device identity: ${err}`);
    }

    const token = this.cfg.openclawToken || process.env.OPENCLAW_GATEWAY_TOKEN;

    return new Promise<void>((resolve) => {
      this.openclawWs = new WS(this.cfg!.openclawUrl);

      this.openclawWs.on("open", () => {
        this.log("info", `Connected to OpenClaw at ${this.cfg!.openclawUrl}`);
      });

      // First message should be connect.challenge
      this.openclawWs!.once("message", (data: Buffer) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type !== "event" || frame.event !== "connect.challenge") {
            this.log("warn", `Unexpected first frame: ${JSON.stringify(frame).slice(0, 100)}`);
            resolve();
            return;
          }

          const nonce = frame.payload?.nonce as string | undefined;
          const role = "operator";
          const scopes = ["operator.read", "operator.write"];
          const clientId = "cli";
          const clientMode = "cli";

          // ── Build device signature ───────────────────────────
          let device: Record<string, unknown> | undefined;
          if (deviceIdentity) {
            const signedAtMs = Date.now();
            const payloadParts = nonce
              ? ["v2", deviceIdentity.deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), token ?? "", nonce]
              : ["v1", deviceIdentity.deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), token ?? ""];
            const payload = payloadParts.join("|");

            const privateKey = nodeCrypto.default.createPrivateKey(deviceIdentity.privateKeyPem);
            const signature = nodeCrypto.default.sign(null, Buffer.from(payload), privateKey).toString("base64url");

            // Extract raw 32-byte Ed25519 public key from SPKI DER
            const pubKey = nodeCrypto.default.createPublicKey(deviceIdentity.publicKeyPem);
            const spki = pubKey.export({ type: "spki", format: "der" }) as Buffer;
            const ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
            const rawPub = (spki.length === ED25519_PREFIX.length + 32 && spki.subarray(0, ED25519_PREFIX.length).equals(ED25519_PREFIX))
              ? spki.subarray(ED25519_PREFIX.length)
              : spki;

            device = {
              id: deviceIdentity.deviceId,
              publicKey: rawPub.toString("base64url"),
              signature,
              signedAt: signedAtMs,
              ...(nonce ? { nonce } : {}),
            };
          }

          const connectRequest = {
            type: "req",
            id: nodeCrypto.default.randomUUID(),
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: { id: clientId, version: "1.0.0", platform: "node", mode: clientMode, displayName: `ESP32 Voice [${this.deviceId}]` },
              role,
              scopes,
              caps: [],
              ...(token ? { auth: { token } } : {}),
              ...(device ? { device } : {}),
            },
          };

          this.openclawWs!.send(JSON.stringify(connectRequest));

          // Wait for the connect response
          this.openclawWs!.once("message", (resp: Buffer) => {
            try {
              const response = JSON.parse(resp.toString());
              if (response.type === "res" && response.ok) {
                this.log("info", "OpenClaw handshake complete");
                this.openclawConnected = true;
              } else {
                this.log("error", `OpenClaw handshake failed: ${response.error?.message ?? JSON.stringify(response)}`);
              }
            } catch {
              this.log("error", "OpenClaw handshake parse error");
            }
            resolve();
          });
        } catch {
          resolve();
        }
      });

      this.openclawWs.on("error", (err: Error) => {
        this.log("error", `OpenClaw connection error: ${err.message}`);
        this.openclawConnected = false;
        resolve();
      });

      this.openclawWs.on("close", () => {
        this.log("info", "OpenClaw connection closed");
        this.openclawConnected = false;
      });
    });
  }

  // Returns true if a gateway response is a heartbeat ack (HEARTBEAT_OK),
  // which should be ignored — the session is still waiting for the real reply.
  private isHeartbeatResponse(text: string): boolean {
    const lower = (text ?? "").trim().toLowerCase();
    if (!lower) return false;
    if (!lower.startsWith("heartbeat_ok")) return false;
    // Allow "HEARTBEAT_OK" alone or followed by punctuation/spaces — not a word char
    const suffix = lower.slice("heartbeat_ok".length);
    return suffix.length === 0 || !/[a-z0-9_]/.test(suffix[0]);
  }

  private async sendToOpenClaw(text: string): Promise<string> {
    if (!this.openclawWs || !this.openclawConnected) {
      throw new Error("Not connected to OpenClaw");
    }

    const chatRequest = {
      type: "req",
      id: crypto.randomUUID(),
      method: "chat.send",
      params: {
        sessionKey: "agent:main:main",
        message: text,
        idempotencyKey: crypto.randomUUID(),
      },
    };

    this.openclawWs.send(JSON.stringify(chatRequest));

    return new Promise<string>((resolve) => {
      let responseContent = "";
      const timeout = setTimeout(() => {
        resolve(responseContent || "Request timed out.");
      }, 120000);

      const messageHandler = (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type === "event") {
            if (event.event === "agent" && event.payload?.stream === "assistant" && event.payload?.data?.text) {
              const candidate = event.payload.data.text as string;
              // Skip heartbeat ack responses — they are internal gateway noise
              if (!this.isHeartbeatResponse(candidate)) {
                responseContent = candidate;
              }
            } else if (event.event === "chat") {
              const payload = event.payload ?? {};
              const state = payload.state;
              const messageObj = payload.message;
              let candidate = "";
              if (typeof messageObj?.content === "string") {
                candidate = messageObj.content;
              } else if (Array.isArray(messageObj?.content)) {
                const textBlocks = (messageObj.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === "text").map(b => b.text ?? "");
                if (textBlocks.length > 0) candidate = textBlocks.join("");
              }
              // Skip heartbeat ack responses — keep waiting for real content
              if (candidate && !this.isHeartbeatResponse(candidate)) {
                responseContent = candidate;
              }
              if (state === "final" || state === "done" || state === "complete") {
                // If the final response is a heartbeat ack, keep waiting
                if (this.isHeartbeatResponse(responseContent)) {
                  responseContent = "";
                  return;
                }
                const hasPendingTools = Array.isArray(messageObj?.content) &&
                  (messageObj.content as Array<{ type: string }>).some(b => b.type === "tool_use");
                if (!hasPendingTools) {
                  clearTimeout(timeout);
                  this.openclawWs?.off("message", messageHandler);
                  resolve(responseContent || "No response received");
                }
              } else if (state === "aborted" || state === "error") {
                clearTimeout(timeout);
                this.openclawWs?.off("message", messageHandler);
                resolve(responseContent || `Request ${state}`);
              }
            }
          }
        } catch { /* ignore parse errors */ }
      };

      this.openclawWs!.on("message", messageHandler);
    });
  }

  // ── Utilities ─────────────────────────────────────────────────

  private setState(newState: VoiceSessionState): void {
    const old = this.state;
    this.state = newState;
    this.log("debug", `State: ${old} → ${newState}`);
  }

  private async sendJson(obj: Record<string, unknown>): Promise<void> {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.log("error", `Send error (${obj.type}): ${err}`);
    }
  }

  private async sendBinary(data: Buffer): Promise<void> {
    try {
      this.ws.send(data);
    } catch (err) {
      this.log("error", `Binary send error: ${err}`);
    }
  }

  private log(level: string, msg: string): void {
    const prefix = `[${this.sessionId.slice(0, 8)}]`;
    switch (level) {
      case "error":
        console.error(`${prefix} ${msg}`);
        break;
      case "warn":
        console.warn(`${prefix} ${msg}`);
        break;
      case "debug":
        // Only log debug in development
        if (process.env.NODE_ENV !== "production") {
          console.log(`${prefix} [debug] ${msg}`);
        }
        break;
      default:
        console.log(`${prefix} ${msg}`);
    }
  }
}
