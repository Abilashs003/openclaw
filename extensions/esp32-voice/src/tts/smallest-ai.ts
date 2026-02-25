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
