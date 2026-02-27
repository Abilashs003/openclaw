/**
 * Rime streaming Text-to-Speech provider.
 *
 * Uses Rime's WebSocket API for real-time TTS.
 * Text tokens are sent as plain-text frames; audio arrives as binary PCM frames.
 * End-of-stream is signalled by sending the "<EOS>" token.
 *
 * WebSocket URL: wss://users-ws.rime.ai/ws
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

const RIME_WS_URL = "wss://users-ws.rime.ai/ws";

const DEFAULT_VOICE_ID = "luna";
const DEFAULT_MODEL_ID = "mistv2";

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
    const url = `${RIME_WS_URL}?speaker=${this.voiceId}&modelId=${this.modelId}&audioFormat=pcm&samplingRate=24000`;

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

      this.ws.on("message", (data: Buffer, isBinary: boolean) => {
        this.handleMessage(data, isBinary);
      });

      this.ws.on("error", (err) => {
        console.error("[rime-tts] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[rime-tts] Connection closed");
        // Server closes after <EOS> — treat close as done signal
        this.isFinalReceived = true;
        this.audioChain
          .then(() => this.fireDone())
          .catch(() => this.fireDone());
      });
    });
  }

  async synthesize(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("[rime-tts] Not connected");
    }
    // Send plain text token (not JSON)
    this.ws.send(text);
  }

  async flush(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // End-of-stream token — server will finish synthesis and close the connection
      this.ws.send("<EOS>");
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

  private handleMessage(data: Buffer, isBinary: boolean): void {
    // Rime sends binary PCM audio frames
    if (isBinary && data.length > 0 && this.onAudio) {
      const cb = this.onAudio;
      this.audioChain = this.audioChain
        .then(() => cb(data))
        .catch((err) => console.error("[rime-tts] Audio callback error:", err));
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
  description: "Real-time streaming TTS via WebSocket. Text tokens stream in, raw PCM audio streams back. Very low latency.",
  streaming: true,
  envVar: "RIME_API_KEY",
  defaultVoiceId: DEFAULT_VOICE_ID,
  defaultModel: DEFAULT_MODEL_ID,
  outputSampleRate: 24000,
  docsUrl: "https://rime.ai/docs",
};

ttsRegistry.register(rimeMeta, (config) => new RimeTtsProvider(config));
