/**
 * AssemblyAI Universal Streaming Speech-to-Text provider.
 *
 * Uses AssemblyAI's v3 streaming WebSocket API for real-time speech recognition.
 * Connects directly with API key in Authorization header (no token needed
 * for server-side usage).
 *
 * WS: wss://streaming.assemblyai.com/v3/ws
 * Docs: https://www.assemblyai.com/docs/api-reference/streaming-api
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const ASSEMBLYAI_WS_URL = "wss://streaming.assemblyai.com/v3/ws";

export class AssemblyAiSttProvider implements SttProvider {
  readonly id = "assemblyai";
  readonly name = "AssemblyAI";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private decoder: any = null;
  private audioQueue: Buffer[] = [];
  private pcmBuffer: Buffer[] = []; // buffer PCM frames to meet 50ms minimum
  private pcmBufferSamples = 0;
  private finalTranscript = "";
  private lastPartialTranscript = "";
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;
  private finalizeTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "universal";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    // Initialize Opus decoder
    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    this.decoder = new Ctor(16000, 1, Ctor.Application.VOIP);

    // Connect directly with API key (no token needed for server-side)
    const params = new URLSearchParams({
      sample_rate: "16000",
      encoding: "pcm_s16le",
      format_turns: "true",
    });
    const url = `${ASSEMBLYAI_WS_URL}?${params.toString()}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { Authorization: this.apiKey },
      });

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.pcmBuffer = [];
      this.pcmBufferSamples = 0;
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        if (this.audioQueue.length > 0) {
          console.log(`[assemblyai-stt] Connected — flushing ${this.audioQueue.length} buffered frames`);
          for (const frame of this.audioQueue) {
            this.ws!.send(frame);
          }
          this.audioQueue = [];
        } else {
          console.log("[assemblyai-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[assemblyai-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString() || "";
        console.log(`[assemblyai-stt] Connection closed (code=${code}, reason="${reasonStr}")`);
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

    let pcm: Buffer;
    try {
      const decoded = this.decoder.decode(audioData, 320);
      pcm = Buffer.from(decoded);
    } catch {
      return;
    }

    // AssemblyAI v3 requires frames ≥ 50ms. ESP32 sends 20ms frames,
    // so buffer 3 frames (60ms / 960 samples) before sending.
    this.pcmBuffer.push(pcm);
    this.pcmBufferSamples += 320; // 320 samples = 20ms at 16kHz
    if (this.pcmBufferSamples < 960) return; // wait until ≥ 60ms

    const combined = Buffer.concat(this.pcmBuffer);
    this.pcmBuffer = [];
    this.pcmBufferSamples = 0;

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(combined);
    } else {
      if (this.audioQueue.length < 500) {
        this.audioQueue.push(combined);
      }
    }
  }

  async finalize(): Promise<string> {
    if (!this.finalizeResolve) {
      return this.finalTranscript || this.lastPartialTranscript;
    }

    if (this.finalizePromise) {
      // Flush any remaining buffered PCM
      if (this.pcmBuffer.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        const remaining = Buffer.concat(this.pcmBuffer);
        this.ws.send(remaining);
        this.pcmBuffer = [];
        this.pcmBufferSamples = 0;
      }

      // Send session termination (v3 format)
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "Terminate" }));
      }

      const TOTAL_TIMEOUT_MS = 6000;
      const timeoutPromise = new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[assemblyai-stt] Timeout waiting for final transcript (using: "${fallback}")`);
          if (this.finalizeResolve) {
            this.finalizeResolve(fallback);
            this.finalizeResolve = null;
          }
          resolve(fallback);
        }, TOTAL_TIMEOUT_MS);
        this.finalizeTimers.push(timer);
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
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.on("error", () => {});
      try {
        if (ws.readyState === ws.CONNECTING) {
          ws.terminate();
        } else {
          ws.close();
        }
      } catch { /* ignore */ }
    }
    this.decoder = null;
  }

  private handleMessage(data: Buffer): void {
    try {
      const raw = data.toString();
      const msg = JSON.parse(raw);

      if (msg.error || msg.type === "error") {
        console.error("[assemblyai-stt] Server error:", raw.slice(0, 500));
        return;
      }

      // AssemblyAI v3: "Turn" messages with transcript string
      if (msg.type === "Turn") {
        const text = (msg.transcript ?? "").trim();
        const isFinal = msg.end_of_turn ?? false;

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

            if (this.finalizeResolve) {
              this.finalizeResolve(this.finalTranscript);
              this.finalizeResolve = null;
            }
            if (this.onSpeechEnd) {
              const result = this.onSpeechEnd();
              if (result instanceof Promise) result.catch(() => {});
            }
          } else {
            this.lastPartialTranscript = text;
          }
        }
      } else if (msg.type === "Termination") {
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      }
    } catch (err) {
      console.error("[assemblyai-stt] Failed to parse message:", data.toString().slice(0, 200), err);
    }
  }
}

export const assemblyAiMeta: SttProviderMeta = {
  id: "assemblyai",
  name: "AssemblyAI",
  description: "Real-time streaming STT with immutable transcripts. 307ms P50 latency, $0.15/hr.",
  streaming: true,
  envVar: "ASSEMBLYAI_API_KEY",
  defaultModel: "universal",
  docsUrl: "https://www.assemblyai.com/docs/api-reference/streaming-api",
};

function createAssemblyAiStt(config: SttProviderConfig): SttProvider {
  return new AssemblyAiSttProvider(config);
}

sttRegistry.register(assemblyAiMeta, createAssemblyAiStt);
