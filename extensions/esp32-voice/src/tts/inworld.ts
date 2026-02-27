/**
 * Inworld streaming Text-to-Speech provider.
 *
 * Uses Inworld's bidirectional WebSocket API (voice:streamBidirectional).
 * Sends text and receives base64 LINEAR16 PCM audio (24kHz, 16-bit mono).
 *
 * Protocol:
 *   1. Connect → send create context
 *   2. synthesize() → send_text
 *   3. flush() → flush_context, wait for flushCompleted
 *   4. close() → close_context + ws.close()
 *
 * Docs: https://inworld.ai/tts-api
 */

import { randomUUID } from "crypto";
import WebSocket from "ws";
import type {
  TtsProvider,
  TtsProviderConfig,
  TtsProviderMeta,
  TtsAudioCallback,
  TtsDoneCallback,
} from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const INWORLD_WS_URL = "wss://api.inworld.ai/tts/v1/voice:streamBidirectional";

const DEFAULT_VOICE = "Ashley";
const DEFAULT_MODEL = "inworld-tts-1.5-mini";

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
  private contextId: string | null = null;
  private flushResolve: (() => void) | null = null;
  private flushPromise: Promise<void> | null = null;
  private audioChain: Promise<void> = Promise.resolve();
  private isFinalReceived = false;

  constructor(config: TtsProviderConfig) {
    this.apiKey = config.apiKey;
    this.voice = config.voiceId ?? DEFAULT_VOICE;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async connect(): Promise<void> {
    this.contextId = randomUUID();
    this.audioChain = Promise.resolve();
    this.isFinalReceived = false;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(INWORLD_WS_URL, {
        headers: {
          Authorization: `Basic ${this.apiKey}`,
        },
      });

      this.ws.on("open", () => {
        // Send create context with voice/model config
        const createMsg = {
          create: {
            voiceId: this.voice,
            modelId: this.model,
            audioConfig: {
              audioEncoding: "LINEAR16",
              sampleRateHertz: 24000,
            },
          },
          contextId: this.contextId,
        };
        this.ws!.send(JSON.stringify(createMsg));
        // Resolve immediately after sending create — contextCreated will arrive async
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
    this.ws.send(JSON.stringify({
      send_text: { text },
      contextId: this.contextId,
    }));
  }

  async flush(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.flushPromise = new Promise<void>((res) => {
        this.flushResolve = res;
      });
      this.ws.send(JSON.stringify({
        flush_context: {},
        contextId: this.contextId,
      }));
    } else {
      this.flushPromise = Promise.resolve();
    }

    if (this.flushPromise) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn("[inworld-tts] Timeout waiting for audio completion");
          resolve();
        }, 30000);
      });
      await Promise.race([this.flushPromise, timeout]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({
            close_context: {},
            contextId: this.contextId,
          }));
        } catch { /* ignore */ }
        try { this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
      } else if (this.ws.readyState === this.ws.CONNECTING) {
        try { this.ws.terminate(); } catch { /* ignore */ }
        this.ws = null;
      }
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      // API error response — fail fast instead of waiting for timeout
      if (msg.error) {
        console.error("[inworld-tts] API error:", msg.error.message ?? JSON.stringify(msg.error));
        if (this.flushResolve) { this.flushResolve(); this.flushResolve = null; }
        this.fireDone();
        return;
      }

      const result = msg.result;
      if (!result) return;

      // Audio chunk
      if (result.audioChunk?.audioContent && this.onAudio) {
        const pcm = Buffer.from(result.audioChunk.audioContent as string, "base64");
        if (pcm.length > 0) {
          const cb = this.onAudio;
          this.audioChain = this.audioChain
            .then(() => cb(pcm))
            .catch((err) => console.error("[inworld-tts] Audio callback error:", err));
        }
      }

      // Flush completed signal
      if (result.flushCompleted !== undefined) {
        console.log("[inworld-tts] Stream complete");
        this.isFinalReceived = true;
        this.audioChain
          .then(() => {
            this.fireDone();
            if (this.flushResolve) {
              this.flushResolve();
              this.flushResolve = null;
            }
          })
          .catch(() => {
            this.fireDone();
            if (this.flushResolve) {
              this.flushResolve();
              this.flushResolve = null;
            }
          });
      }
    } catch {
      // Ignore non-JSON messages
    }
  }

  private fireDone(): void {
    if (this.onDone) {
      const result = this.onDone();
      if (result instanceof Promise) {
        result.catch((err) => console.error("[inworld-tts] Done callback error:", err));
      }
    }
  }
}

export const inworldMeta: TtsProviderMeta = {
  id: "inworld",
  name: "Inworld",
  description: "Ultra-low latency streaming TTS (<120ms). Bidirectional WebSocket with LINEAR16 PCM. Designed for voice agents.",
  streaming: true,
  envVar: "INWORLD_API_KEY",
  defaultVoiceId: DEFAULT_VOICE,
  defaultModel: DEFAULT_MODEL,
  outputSampleRate: 24000,
  docsUrl: "https://inworld.ai/tts-api",
};

ttsRegistry.register(inworldMeta, (config) => new InworldTtsProvider(config));
