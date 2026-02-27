/**
 * Soniox v4 streaming Speech-to-Text provider.
 *
 * Uses Soniox's WebSocket API for real-time speech recognition.
 * Receives Opus frames from the ESP32, decodes to PCM16 internally,
 * and streams PCM to Soniox.
 *
 * WebSocket URL: wss://stt-rt.soniox.com/transcribe-websocket
 * Docs: https://soniox.com/docs/stt/api-reference/websocket-api
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

export class SonioxSttProvider implements SttProvider {
  readonly id = "soniox";
  readonly name = "Soniox";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private decoder: any = null;
  private audioQueue: Buffer[] = [];
  private configSent = false;
  private finalTranscript = "";
  private lastPartialTranscript = "";
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "stt-rt-v4";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    // Initialize Opus decoder for Opus→PCM16 conversion
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    this.decoder = new Ctor(16000, 1, Ctor.Application.VOIP);

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(SONIOX_WS_URL);

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.configSent = false;
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        // Send config message with API key and audio format
        const config = {
          api_key: this.apiKey,
          model: this.model,
          audio_format: "pcm_s16le",
          sample_rate: 16000,
          num_audio_channels: 1,
          language: this.language,
        };
        this.ws!.send(JSON.stringify(config));
        this.configSent = true;

        // Flush buffered audio
        if (this.audioQueue.length > 0) {
          console.log(`[soniox-stt] Connected — flushing ${this.audioQueue.length} buffered frames`);
          for (const frame of this.audioQueue) {
            this.ws!.send(frame);
          }
          this.audioQueue = [];
        } else {
          console.log("[soniox-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[soniox-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[soniox-stt] Connection closed");
        this.audioQueue = [];
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      });
    });
  }

  async sendAudio(audioData: Buffer): Promise<void> {
    if (this.ws === null) return;

    // Decode Opus → PCM16 (320 samples = 20ms at 16kHz)
    let pcm: Buffer;
    try {
      const decoded = this.decoder.decode(audioData, 320);
      pcm = Buffer.from(decoded);
    } catch {
      return; // Skip malformed Opus frames
    }

    if (this.ws.readyState === WebSocket.OPEN && this.configSent) {
      this.ws.send(pcm);
    } else {
      this.audioQueue.push(pcm);
    }
  }

  async finalize(): Promise<string> {
    if (!this.finalizeResolve) {
      return this.finalTranscript || this.lastPartialTranscript;
    }

    if (this.finalizePromise) {
      // Send empty frame to signal end of audio
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(Buffer.alloc(0));
      }

      const TOTAL_TIMEOUT_MS = 6000;
      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[soniox-stt] Timeout waiting for final transcript (using: "${fallback}")`);
          if (this.finalizeResolve) {
            this.finalizeResolve(fallback);
            this.finalizeResolve = null;
          }
          resolve(fallback);
        }, TOTAL_TIMEOUT_MS);
      });

      return Promise.race([this.finalizePromise, timeoutPromise]);
    }

    return this.finalTranscript || this.lastPartialTranscript;
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        if (this.ws.readyState === this.ws.CONNECTING) {
          this.ws.terminate();
        } else {
          this.ws.close();
        }
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      // Soniox sends tokens with text and final flag
      // Response format: { tokens: [{text, is_final}], ...} or {fw: [...]}
      if (msg.fw) {
        // Final words array
        const text = msg.fw.map((w: any) => w.t).join("").trim();
        if (text) {
          this.finalTranscript = this.finalTranscript
            ? this.finalTranscript + " " + text
            : text;
          this.lastPartialTranscript = "";
          if (this.onTranscript) {
            const result = this.onTranscript(text, true);
            if (result instanceof Promise) result.catch(() => {});
          }
        }
      } else if (msg.nfw) {
        // Non-final (partial) words
        const text = msg.nfw.map((w: any) => w.t).join("").trim();
        if (text) {
          this.lastPartialTranscript = text;
          if (this.onTranscript) {
            const result = this.onTranscript(text, false);
            if (result instanceof Promise) result.catch(() => {});
          }
        }
      } else if (msg.finished !== undefined) {
        // Stream finished
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
        if (this.onSpeechEnd) {
          const result = this.onSpeechEnd();
          if (result instanceof Promise) result.catch(() => {});
        }
      }
    } catch { /* ignore parse errors */ }
  }
}

export const sonioxMeta: SttProviderMeta = {
  id: "soniox",
  name: "Soniox",
  description: "Ultra-low latency streaming STT with v4 real-time model. Sub-200ms latency at $0.12/hr.",
  streaming: true,
  envVar: "SONIOX_API_KEY",
  defaultModel: "stt-rt-v4",
  docsUrl: "https://soniox.com/docs/stt/api-reference/websocket-api",
};

function createSonioxStt(config: SttProviderConfig): SttProvider {
  return new SonioxSttProvider(config);
}

sttRegistry.register(sonioxMeta, createSonioxStt);
