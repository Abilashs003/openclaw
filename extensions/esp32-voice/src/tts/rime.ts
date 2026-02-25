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
