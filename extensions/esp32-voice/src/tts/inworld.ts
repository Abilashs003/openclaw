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
