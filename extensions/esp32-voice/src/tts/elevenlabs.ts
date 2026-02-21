/**
 * ElevenLabs streaming Text-to-Speech provider.
 *
 * Ported from cheekoclaw_bridge/elevenlabs_tts.py
 *
 * Uses ElevenLabs' WebSocket API for real-time text-to-speech.
 * Sends text and receives base64-encoded PCM audio (24kHz, 16-bit mono).
 *
 * WebSocket URL: wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
 */

import WebSocket from "ws";
import type { TtsProvider, TtsProviderConfig, TtsProviderMeta, TtsAudioCallback, TtsDoneCallback } from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const ELEVENLABS_WS_URL = "wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input";

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = "elevenlabs";
  readonly name = "ElevenLabs";
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
  // Serialises onAudio calls: each chunk waits for the previous one to finish
  // (including any pacing sleeps) before being dispatched. Without this, all
  // chunks are fired in parallel and the pacing in the callback is bypassed.
  private audioChain: Promise<void> = Promise.resolve();
  private isFinalReceived = false;

  constructor(config: TtsProviderConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId ?? DEFAULT_VOICE_ID;
    this.modelId = config.model ?? DEFAULT_MODEL_ID;
  }

  async connect(): Promise<void> {
    const url =
      ELEVENLABS_WS_URL.replace("{voice_id}", this.voiceId) +
      `?model_id=${this.modelId}&output_format=pcm_24000`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { "xi-api-key": this.apiKey },
      });

      this.donePromise = new Promise<void>((res) => {
        this.doneResolve = res;
      });
      // Reset chain and final flag for this connection
      this.audioChain = Promise.resolve();
      this.isFinalReceived = false;

      this.ws.on("open", async () => {
        console.log("[elevenlabs-tts] Connected");

        // Send BOS (beginning of stream) message
        const bos = {
          text: " ",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
          generation_config: {
            flush: true,
          },
        };

        this.ws!.send(JSON.stringify(bos));
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[elevenlabs-tts] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[elevenlabs-tts] Connection closed");
        // If isFinal already triggered the chain drain, fireDone will be a no-op.
        // Otherwise (unexpected close) drain the chain first then fire done.
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
      throw new Error("[elevenlabs-tts] Not connected");
    }

    const msg = {
      text,
      generation_config: { flush: true },
    };

    this.ws.send(JSON.stringify(msg));
  }

  async flush(): Promise<void> {
    // Send EOS (end of stream) — empty text signals end of input
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ text: "" }));
    }

    // Wait for all audio to be delivered
    if (this.donePromise) {
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn("[elevenlabs-tts] Timeout waiting for audio completion");
          resolve();
        }, 30000);
      });
      await Promise.race([this.donePromise, timeoutPromise]);
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      // Audio chunk: base64-encoded PCM.
      // Chain onto audioChain so each chunk is processed *after* the previous
      // one finishes — including any pacing sleeps in the onAudio callback.
      const audioB64: string | undefined = msg.audio;
      if (audioB64) {
        const pcmBytes = Buffer.from(audioB64, "base64");
        if (pcmBytes.length > 0 && this.onAudio) {
          const cb = this.onAudio;
          this.audioChain = this.audioChain
            .then(() => cb(pcmBytes))
            .catch((err) => console.error("[elevenlabs-tts] Audio callback error:", err));
        }
      }

      // isFinal: ElevenLabs signals all audio has been sent.
      // We must wait for the entire audioChain to drain before firing done,
      // so the caller (flush) only unblocks after all pacing sleeps complete.
      if (msg.isFinal) {
        console.log("[elevenlabs-tts] Stream complete (isFinal)");
        this.isFinalReceived = true;
        this.audioChain
          .then(() => this.fireDone())
          .catch(() => this.fireDone());
      }
    } catch {
      // Ignore parse errors
    }
  }

  private fireDone(): void {
    if (this.onDone) {
      const result = this.onDone();
      if (result instanceof Promise) {
        result.catch((err) => console.error("[elevenlabs-tts] Done callback error:", err));
      }
    }
    if (this.doneResolve) {
      this.doneResolve();
      this.doneResolve = null;
    }
  }
}

/** ElevenLabs TTS provider metadata. */
export const elevenlabsMeta: TtsProviderMeta = {
  id: "elevenlabs",
  name: "ElevenLabs",
  description:
    "High-quality streaming TTS with natural-sounding voices. Supports WebSocket streaming for low latency.",
  streaming: true,
  envVar: "ELEVENLABS_API_KEY",
  defaultVoiceId: DEFAULT_VOICE_ID,
  defaultModel: DEFAULT_MODEL_ID,
  outputSampleRate: 24000,
  docsUrl: "https://elevenlabs.io/docs/api-reference/text-to-speech-websockets",
};

/** Factory function for creating ElevenLabs TTS instances. */
function createElevenLabsTts(config: TtsProviderConfig): TtsProvider {
  return new ElevenLabsTtsProvider(config);
}

// Auto-register with the TTS registry
ttsRegistry.register(elevenlabsMeta, createElevenLabsTts);
