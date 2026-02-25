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
