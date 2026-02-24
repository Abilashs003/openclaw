/**
 * Silero VAD (Voice Activity Detection) processor.
 *
 * Uses the Silero VAD v5 ONNX model to detect speech start/end
 * in real-time from 16kHz mono PCM audio.
 *
 * The model processes 512-sample windows (32ms at 16kHz) and returns
 * a speech probability (0–1). This module tracks state transitions
 * (silence → speech → silence) and fires callbacks on speech end.
 *
 * Reference: https://github.com/snakers4/silero-vad
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// onnxruntime-node is lazily imported to avoid hard failure if not installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ort: any = null;

async function getOrt() {
  if (ort) return ort;
  ort = await import("onnxruntime-node");
  return ort;
}

// ── Configuration ──────────────────────────────────────────────

export interface SileroVadConfig {
  /** Speech probability threshold (0–1). Default: 0.5 */
  speechThreshold?: number;
  /** How long silence (ms) after speech before triggering speech end. Default: 600 */
  silenceDurationMs?: number;
  /** Minimum speech duration (ms) to count as valid speech. Default: 250 */
  minSpeechDurationMs?: number;
  /** Path to the ONNX model file. Auto-detected if not provided. */
  modelPath?: string;
}

const DEFAULT_CONFIG: Required<SileroVadConfig> = {
  speechThreshold: 0.5,
  silenceDurationMs: 600,
  minSpeechDurationMs: 250,
  modelPath: "",
};

// ── Constants ──────────────────────────────────────────────────

/** Silero VAD expects 16kHz audio */
const SAMPLE_RATE = 16000;

/** Window size in samples — Silero v5 uses 512 samples at 16kHz (32ms) */
const WINDOW_SIZE = 512;

/** LSTM hidden state size for Silero v5 */
const STATE_SIZE = 128;

// ── VAD Processor ──────────────────────────────────────────────

export type VadEvent = "speech_start" | "speech_end";

export class SileroVad {
  private config: Required<SileroVadConfig>;

  // ONNX session
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;

  // LSTM hidden state — persisted across inference calls
  // Silero VAD ONNX uses a single combined state tensor [2, 1, 128]
  private state: Float32Array;

  // Speech state tracking
  private isSpeaking = false;
  private speechStartedAt = 0;
  private lastSpeechAt = 0;
  private silenceCheckTimer: ReturnType<typeof setInterval> | null = null;

  // PCM buffer for accumulating audio into 512-sample windows
  private pcmBuffer: Float32Array = new Float32Array(0);

  // Callbacks
  onSpeechStart: (() => void | Promise<void>) | null = null;
  onSpeechEnd: (() => void | Promise<void>) | null = null;

  constructor(config?: SileroVadConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Initialize LSTM state to zeros [2, 1, 128]
    this.state = new Float32Array(2 * 1 * STATE_SIZE);
  }

  /**
   * Initialize the ONNX model. Must be called before processAudio().
   */
  async init(): Promise<void> {
    const ortModule = await getOrt();
    const InferenceSession = ortModule.InferenceSession;

    // Resolve model path
    let modelPath = this.config.modelPath;
    if (!modelPath) {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      modelPath = join(thisDir, "..", "..", "models", "silero_vad.onnx");
    }

    this.session = await InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });

    // Reset states
    this.resetState();

    // Start silence check timer
    this.silenceCheckTimer = setInterval(() => {
      this.checkSilenceTimeout();
    }, 100);

    console.log("[silero-vad] Model loaded and ready");
  }

  /**
   * Process incoming PCM audio data.
   *
   * @param pcm - Int16Array or Float32Array of 16kHz mono PCM audio.
   *              Int16 samples are automatically converted to float32 [-1, 1].
   */
  async processAudio(pcm: Int16Array | Float32Array): Promise<void> {
    if (!this.session) {
      throw new Error("SileroVad not initialized. Call init() first.");
    }

    // Convert Int16 to Float32 if needed
    let floatPcm: Float32Array;
    if (pcm instanceof Int16Array) {
      floatPcm = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        floatPcm[i] = pcm[i] / 32768.0;
      }
    } else {
      floatPcm = pcm;
    }

    // Append to buffer
    const newBuffer = new Float32Array(this.pcmBuffer.length + floatPcm.length);
    newBuffer.set(this.pcmBuffer);
    newBuffer.set(floatPcm, this.pcmBuffer.length);
    this.pcmBuffer = newBuffer;

    // Process complete 512-sample windows
    while (this.pcmBuffer.length >= WINDOW_SIZE) {
      const window = this.pcmBuffer.slice(0, WINDOW_SIZE);
      this.pcmBuffer = this.pcmBuffer.slice(WINDOW_SIZE);

      const probability = await this.infer(window);
      this.updateState(probability);
    }
  }

  /**
   * Run a single inference on a 512-sample window.
   * Returns speech probability (0–1).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async infer(window: Float32Array): Promise<number> {
    const ortModule = await getOrt();
    const Tensor = ortModule.Tensor;

    // Input tensor: [1, 512]
    const inputTensor = new Tensor("float32", window, [1, WINDOW_SIZE]);

    // Sample rate tensor
    const srTensor = new Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);

    // Combined LSTM state tensor: [2, 1, 128]
    const stateTensor = new Tensor("float32", this.state, [2, 1, STATE_SIZE]);

    const feeds = {
      input: inputTensor,
      state: stateTensor,
      sr: srTensor,
    };

    const results = await this.session.run(feeds);

    // Update LSTM state from output
    const stateN = results.stateN;
    if (stateN?.data) this.state = new Float32Array(stateN.data);

    // Speech probability is the output tensor
    const output = results.output;
    return output.data[0] as number;
  }

  /**
   * Update speech/silence state based on probability.
   */
  private updateState(probability: number): void {
    const now = Date.now();

    if (probability >= this.config.speechThreshold) {
      // Speech detected
      this.lastSpeechAt = now;

      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartedAt = now;
        console.log(`[silero-vad] Speech started (prob: ${probability.toFixed(3)})`);

        if (this.onSpeechStart) {
          const result = this.onSpeechStart();
          if (result instanceof Promise) {
            result.catch((err) => console.error("[silero-vad] onSpeechStart error:", err));
          }
        }
      }
    }
    // Silence is handled by checkSilenceTimeout() timer
  }

  /**
   * Periodically check if silence duration has exceeded threshold.
   */
  private checkSilenceTimeout(): void {
    if (!this.isSpeaking) return;

    const now = Date.now();
    const silenceDuration = now - this.lastSpeechAt;
    const speechDuration = this.lastSpeechAt - this.speechStartedAt;

    if (silenceDuration >= this.config.silenceDurationMs) {
      // Silence threshold exceeded after speech
      if (speechDuration >= this.config.minSpeechDurationMs) {
        console.log(
          `[silero-vad] Speech ended (speech: ${speechDuration}ms, silence: ${silenceDuration}ms)`
        );

        this.isSpeaking = false;

        if (this.onSpeechEnd) {
          const result = this.onSpeechEnd();
          if (result instanceof Promise) {
            result.catch((err) => console.error("[silero-vad] onSpeechEnd error:", err));
          }
        }
      } else {
        // Too short — treat as noise
        console.log(`[silero-vad] Ignoring short speech (${speechDuration}ms < ${this.config.minSpeechDurationMs}ms)`);
        this.isSpeaking = false;
      }
    }
  }

  /**
   * Reset LSTM state and speech tracking. Call between sessions.
   */
  resetState(): void {
    this.state = new Float32Array(2 * 1 * STATE_SIZE);
    this.isSpeaking = false;
    this.speechStartedAt = 0;
    this.lastSpeechAt = 0;
    this.pcmBuffer = new Float32Array(0);
  }

  /**
   * Clean up resources.
   */
  async destroy(): Promise<void> {
    if (this.silenceCheckTimer) {
      clearInterval(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.resetState();
    console.log("[silero-vad] Destroyed");
  }
}
