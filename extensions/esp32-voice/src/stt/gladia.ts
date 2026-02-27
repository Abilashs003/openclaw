/**
 * Gladia Solaria streaming Speech-to-Text provider.
 *
 * Uses Gladia's v2 live transcription API for real-time speech recognition.
 * Two-step connection: POST to init session → connect to returned WS URL.
 * Gladia v2 requires wav/pcm encoding — Opus frames are decoded internally.
 *
 * REST: POST https://api.gladia.io/v2/live
 * Docs: https://docs.gladia.io/api-reference/v2/live/websocket
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const GLADIA_INIT_URL = "https://api.gladia.io/v2/live";

export class GladiaSttProvider implements SttProvider {
  readonly id = "gladia";
  readonly name = "Gladia";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private decoder: any = null;
  private audioQueue: Buffer[] = [];
  private finalTranscript = "";
  private lastPartialTranscript = "";
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "solaria-1";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    // Initialize Opus decoder (Gladia v2 requires wav/pcm, not Opus)
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    this.decoder = new Ctor(16000, 1, Ctor.Application.VOIP);

    // 1. Init session via REST
    const initRes = await fetch(GLADIA_INIT_URL, {
      method: "POST",
      headers: {
        "x-gladia-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        encoding: "wav/pcm",
        bit_depth: 16,
        sample_rate: 16000,
        channels: 1,
        model: this.model,
        language_config: {
          languages: [this.language],
          code_switching: false,
        },
      }),
    });

    if (!initRes.ok) {
      const body = await initRes.text().catch(() => "");
      throw new Error(`[gladia-stt] Session init failed: HTTP ${initRes.status} ${body}`);
    }

    const initData = (await initRes.json()) as { url?: string };
    const wsUrl = initData.url;
    if (!wsUrl) {
      throw new Error("[gladia-stt] No WebSocket URL in init response");
    }

    // 2. Connect to session WebSocket
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        if (this.audioQueue.length > 0) {
          console.log(`[gladia-stt] Connected — flushing ${this.audioQueue.length} buffered frames`);
          for (const frame of this.audioQueue) {
            this.ws!.send(frame);
          }
          this.audioQueue = [];
        } else {
          console.log("[gladia-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[gladia-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString() || "";
        console.log(`[gladia-stt] Connection closed (code=${code}, reason="${reasonStr}")`);
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

    // Decode Opus → PCM16 (Gladia v2 requires wav/pcm, not Opus)
    let pcm: Buffer;
    try {
      const decoded = this.decoder.decode(audioData, 320);
      pcm = Buffer.from(decoded);
    } catch {
      return; // Skip malformed Opus frames
    }

    if (this.ws.readyState === WebSocket.OPEN) {
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
      // Signal end of audio
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "stop_recording" }));
      }

      const TOTAL_TIMEOUT_MS = 6000;
      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[gladia-stt] Timeout waiting for final transcript (using: "${fallback}")`);
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
      const raw = data.toString();
      const msg = JSON.parse(raw);

      if (msg.error || msg.type === "error") {
        console.error("[gladia-stt] Server error:", raw.slice(0, 500));
        return;
      }

      if (msg.type === "transcript" && msg.data) {
        // v2 format: msg.data.utterance.text (fallback to msg.data.transcription)
        const text = (msg.data.utterance?.text ?? msg.data.transcription ?? "").trim();
        const isFinal = msg.data.is_final ?? false;

        if (text) {
          if (this.onTranscript) {
            const result = this.onTranscript(text, isFinal);
            if (result instanceof Promise) result.catch(() => {});
          }

          if (isFinal) {
            this.finalTranscript = this.finalTranscript
              ? this.finalTranscript + " " + text
              : text;
            this.lastPartialTranscript = "";
          } else {
            this.lastPartialTranscript = text;
          }
        }

        // Check for speech-end signal
        if (msg.data.speech_end || (isFinal && msg.data.utterance_end)) {
          if (this.finalizeResolve) {
            this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
            this.finalizeResolve = null;
          }
          if (this.onSpeechEnd) {
            const result = this.onSpeechEnd();
            if (result instanceof Promise) result.catch(() => {});
          }
        }
      } else if (msg.type === "post_final_transcript") {
        // Session done
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      }
    } catch (err) {
      console.error("[gladia-stt] Failed to parse message:", data.toString().slice(0, 200), err);
    }
  }
}

export const gladiaMeta: SttProviderMeta = {
  id: "gladia",
  name: "Gladia",
  description: "Real-time streaming STT with Solaria model. 270ms latency, 100+ languages.",
  streaming: true,
  envVar: "GLADIA_API_KEY",
  defaultModel: "solaria-1",
  docsUrl: "https://docs.gladia.io/api-reference/v2/live/websocket",
};

function createGladiaStt(config: SttProviderConfig): SttProvider {
  return new GladiaSttProvider(config);
}

sttRegistry.register(gladiaMeta, createGladiaStt);
