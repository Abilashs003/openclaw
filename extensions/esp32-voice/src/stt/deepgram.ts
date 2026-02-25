/**
 * Deepgram streaming Speech-to-Text provider.
 *
 * Ported from cheekoclaw_bridge/deepgram_stt.py
 *
 * Uses Deepgram's WebSocket API for real-time speech recognition.
 * Receives Opus frames from the ESP32 and streams them directly
 * to Deepgram (Deepgram supports Opus natively).
 *
 * WebSocket URL: wss://api.deepgram.com/v1/listen
 */

import WebSocket from "ws";
import type { SttProvider, SttProviderConfig, SttProviderMeta, SttTranscriptCallback } from "./stt-provider.js";
import { sttRegistry } from "./stt-registry.js";

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

export class DeepgramSttProvider implements SttProvider {
  readonly id = "deepgram";
  readonly name = "Deepgram";
  readonly streaming = true;

  onTranscript: SttTranscriptCallback | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  private apiKey: string;
  private model: string;
  private language: string;
  private ws: WebSocket | null = null;
  private audioQueue: Buffer[] = [];  // buffer for frames that arrive before WS is OPEN
  private finalTranscript = "";
  private lastPartialTranscript = "";  // fallback when CloseStream flushes with empty final
  private finalizeResolve: ((value: string) => void) | null = null;
  private finalizePromise: Promise<string> | null = null;

  constructor(config: SttProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "nova-2";
    this.language = config.language ?? "en";
  }

  async connect(): Promise<void> {
    const params = new URLSearchParams({
      encoding: "opus",
      sample_rate: "16000",
      channels: "1",
      model: this.model,
      language: this.language,
      interim_results: "true",
      punctuate: "true",
      // Enable server-side VAD: fires speech_final when speech ends.
      // 500ms silence = end of utterance. 300ms is too aggressive and
      // cuts off users who pause briefly mid-sentence.
      endpointing: "500",
      utterance_end_ms: "1500",
    });

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      this.finalTranscript = "";
      this.lastPartialTranscript = "";
      this.audioQueue = [];
      this.finalizePromise = new Promise<string>((res) => {
        this.finalizeResolve = res;
      });

      this.ws.on("open", () => {
        // Flush any audio frames that arrived before the connection was ready
        if (this.audioQueue.length > 0) {
          console.log(`[deepgram-stt] Connected — flushing ${this.audioQueue.length} buffered audio frames`);
          for (const frame of this.audioQueue) {
            this.ws!.send(frame);
          }
          this.audioQueue = [];
        } else {
          console.log("[deepgram-stt] Connected");
        }
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err) => {
        console.error("[deepgram-stt] WebSocket error:", err.message);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[deepgram-stt] Connection closed");
        this.audioQueue = [];  // discard any buffered frames
        // Resolve finalize if still pending — use partial as fallback
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
      });
    });
  }

  async sendAudio(audioData: Buffer): Promise<void> {
    if (this.ws === null) return;  // not started yet, ignore
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioData);
    } else {
      // WS exists but is still connecting — buffer the frame, flush on open
      this.audioQueue.push(audioData);
    }
  }

  async finalize(): Promise<string> {
    // If speech_final already fired before finalize was called, return immediately.
    if (!this.finalizeResolve) {
      return this.finalTranscript || this.lastPartialTranscript;
    }

    if (this.finalizePromise) {
      // DO NOT send CloseStream immediately.
      //
      // When CloseStream is sent right after speech_end, Deepgram flushes
      // its pipeline before it has finished processing the last audio frames,
      // returning an empty transcript. Instead we let Deepgram's own VAD
      // endpointing (300ms silence threshold) fire speech_final naturally —
      // that gives the full transcript.
      //
      // CloseStream is only sent as a fallback if Deepgram's VAD hasn't
      // fired within CLOSE_STREAM_DELAY_MS.
      const CLOSE_STREAM_DELAY_MS = 1200;
      const TOTAL_TIMEOUT_MS = 6000;

      let closeStreamSent = false;
      const closeTimer = setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN && this.finalizeResolve) {
          console.log("[deepgram-stt] VAD speech_final not received — sending CloseStream fallback");
          closeStreamSent = true;
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        }
      }, CLOSE_STREAM_DELAY_MS);

      const timeoutPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          clearTimeout(closeTimer);
          const fallback = this.finalTranscript || this.lastPartialTranscript;
          console.warn(`[deepgram-stt] Timeout waiting for final transcript (closeStream=${closeStreamSent}, using: "${fallback}")`);
          if (this.finalizeResolve) {
            this.finalizeResolve(fallback);
            this.finalizeResolve = null;
          }
          resolve(fallback);
        }, TOTAL_TIMEOUT_MS);
      });

      return Promise.race([this.finalizePromise, timeoutPromise]).then((result) => {
        clearTimeout(closeTimer);
        return result;
      });
    }

    return this.finalTranscript || this.lastPartialTranscript;
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
      const msgType = msg.type;

      if (msgType === "Results") {
        const alternatives = msg.channel?.alternatives ?? [];
        if (alternatives.length === 0) return;

        const text: string = alternatives[0].transcript ?? "";
        const isFinal: boolean = msg.is_final ?? false;
        const speechFinal: boolean = msg.speech_final ?? false;

        if (text.trim()) {
          // Fire transcript callback
          if (this.onTranscript) {
            const result = this.onTranscript(text, isFinal);
            if (result instanceof Promise) {
              result.catch((err) => console.error("[deepgram-stt] Transcript callback error:", err));
            }
          }

          // Accumulate final segments; track last partial as fallback
          if (isFinal) {
            if (this.finalTranscript) {
              this.finalTranscript += " " + text;
            } else {
              this.finalTranscript = text;
            }
            this.lastPartialTranscript = "";  // clear partial once we have a real final
          } else {
            this.lastPartialTranscript = text;  // keep latest partial as fallback
          }
        }

        // speech_final = server-side VAD detected end of utterance
        // Resolve finalize promise immediately so processUtterance can proceed.
        // Fallback: if Deepgram flushes with empty final (happens when CloseStream
        // is sent before is_final=true arrives), use the last seen partial instead.
        if (speechFinal && this.finalizeResolve) {
          const resolved = this.finalTranscript || this.lastPartialTranscript;
          console.log(`[deepgram-stt] speech_final — triggering utterance end (transcript: "${resolved}")`);
          this.finalizeResolve(resolved);
          this.finalizeResolve = null;
          // Fire onSpeechEnd so the session calls processUtterance
          if (this.onSpeechEnd) {
            const result = this.onSpeechEnd();
            if (result instanceof Promise) {
              result.catch((err) => console.error("[deepgram-stt] onSpeechEnd error:", err));
            }
          }
        }
      } else if (msgType === "UtteranceEnd") {
        // Fallback: Deepgram UtteranceEnd event (requires utterance_end_ms param)
        console.log("[deepgram-stt] UtteranceEnd received");
        if (this.finalizeResolve) {
          this.finalizeResolve(this.finalTranscript || this.lastPartialTranscript);
          this.finalizeResolve = null;
        }
        if (this.onSpeechEnd) {
          const result = this.onSpeechEnd();
          if (result instanceof Promise) {
            result.catch((err) => console.error("[deepgram-stt] onSpeechEnd (UtteranceEnd) error:", err));
          }
        }
      } else if (msgType === "Error") {
        console.error("[deepgram-stt] Error:", msg);
      }
      // Ignore "Metadata" and other message types
    } catch {
      // Ignore parse errors
    }
  }
}

/** Deepgram STT provider metadata. */
export const deepgramMeta: SttProviderMeta = {
  id: "deepgram",
  name: "Deepgram",
  description: "Fast, accurate streaming STT with Nova-2 model. Supports Opus input natively.",
  streaming: true,
  envVar: "DEEPGRAM_API_KEY",
  defaultModel: "nova-2",
  docsUrl: "https://developers.deepgram.com/docs/streaming",
};

/** Factory function for creating Deepgram STT instances. */
function createDeepgramStt(config: SttProviderConfig): SttProvider {
  return new DeepgramSttProvider(config);
}

// Auto-register with the STT registry
sttRegistry.register(deepgramMeta, createDeepgramStt);
