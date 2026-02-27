/**
 * ElevenLabs Scribe v2 streaming Speech-to-Text provider.
 *
 * Uses ElevenLabs' WebSocket API for real-time speech recognition.
 * Receives Opus frames from the ESP32, decodes to PCM16 internally,
 * then base64-encodes and sends as JSON messages.
 *
 * WebSocket URL: wss://api.elevenlabs.io/v1/speech-to-text/realtime
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const ELEVENLABS_STT_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export class ElevenLabsSttProvider implements SttProvider {
  readonly id = "elevenlabs-stt";
  readonly name = "ElevenLabs STT";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private decoder: any = null;
  private audioQueue: string[] = []; // base64 chunks buffered before open
  private finalTranscript = "";
  private lastPartialTranscript = "";
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;
  private finalizeTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "scribe_v2_realtime";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    this.decoder = new Ctor(16000, 1, Ctor.Application.VOIP);

    const url = `${ELEVENLABS_STT_WS_URL}?model_id=${this.model}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { "xi-api-key": this.apiKey },
      });

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        // Flush buffered audio
        if (this.audioQueue.length > 0) {
          console.log(`[elevenlabs-stt] Connected — flushing ${this.audioQueue.length} buffered chunks`);
          for (const chunk of this.audioQueue) {
            this.ws!.send(JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: chunk,
              commit: false,
              sample_rate: 16000,
            }));
          }
          this.audioQueue = [];
        } else {
          console.log("[elevenlabs-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[elevenlabs-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString() || "";
        console.log(`[elevenlabs-stt] Connection closed (code=${code}, reason="${reasonStr}")`);
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

    // Decode Opus → PCM16, then base64 encode for JSON transport
    let b64: string;
    try {
      const decoded = this.decoder.decode(audioData, 320);
      b64 = Buffer.from(decoded).toString("base64");
    } catch {
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: b64,
        commit: false,
        sample_rate: 16000,
      }));
    } else {
      if (this.audioQueue.length < 500) {
        this.audioQueue.push(b64);
      }
    }
  }

  async finalize(): Promise<string> {
    if (!this.finalizeResolve) {
      return this.finalTranscript || this.lastPartialTranscript;
    }

    if (this.finalizePromise) {
      // Send commit signal — empty audio chunk with commit:true triggers committed_transcript
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
          sample_rate: 16000,
        }));
      }

      const TOTAL_TIMEOUT_MS = 6000;
      const timeoutPromise = new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[elevenlabs-stt] Timeout waiting for final transcript (using: "${fallback}")`);
          if (this.finalizeResolve) {
            this.finalizeResolve(fallback);
            this.finalizeResolve = null;
          }
          resolve(fallback);
        }, TOTAL_TIMEOUT_MS);
        this.finalizeTimers.push(timer);
        // Clear timeout if committed_transcript resolves first
        this.finalizePromise!.then(() => clearTimeout(timer));
      });

      return Promise.race([this.finalizePromise, timeoutPromise]);
    }

    return this.finalTranscript || this.lastPartialTranscript;
  }

  async close(): Promise<void> {
    for (const t of this.finalizeTimers) clearTimeout(t);
    this.finalizeTimers = [];
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
    this.decoder = null;
  }

  private handleMessage(data: Buffer): void {
    try {
      const raw = data.toString();
      const msg = JSON.parse(raw);

      const msgType = msg.message_type ?? msg.type;

      if (msg.error || msgType === "error" || msgType === "input_error") {
        console.error("[elevenlabs-stt] Server error:", raw.slice(0, 500));
        return;
      }

      if (msgType === "partial_transcript") {
        const text = msg.text?.trim() ?? "";
        if (text) {
          this.lastPartialTranscript = text;
          if (this.onTranscript) {
            const result = this.onTranscript(text, false);
            if (result instanceof Promise) result.catch(() => {});
          }
        }
      } else if (msgType === "committed_transcript") {
        const text = msg.text?.trim() ?? "";
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
        // committed_transcript in auto-commit mode = speech end
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
        if (this.onSpeechEnd) {
          const result = this.onSpeechEnd();
          if (result instanceof Promise) result.catch(() => {});
        }
      }
    } catch (err) {
      console.error("[elevenlabs-stt] Failed to parse message:", data.toString().slice(0, 200), err);
    }
  }
}

export const elevenlabsSttMeta: SttProviderMeta = {
  id: "elevenlabs-stt",
  name: "ElevenLabs STT",
  description: "Real-time streaming STT with Scribe v2. ~150ms latency, 90+ languages.",
  streaming: true,
  envVar: "ELEVENLABS_STT_API_KEY",
  defaultModel: "scribe_v2_realtime",
  docsUrl: "https://elevenlabs.io/docs/api-reference/speech-to-text",
};

function createElevenLabsStt(config: SttProviderConfig): SttProvider {
  return new ElevenLabsSttProvider(config);
}

sttRegistry.register(elevenlabsSttMeta, createElevenLabsStt);
