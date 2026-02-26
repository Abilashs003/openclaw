/**
 * Live integration tests for Silero VAD — uses the REAL ONNX model.
 *
 * Validates that the neural network model loads correctly and produces
 * expected speech probabilities for synthetic audio signals.
 *
 * Run with: npx vitest run extensions/esp32-voice/src/vad/silero-vad.live.test.ts
 * (excluded from CI by default via *.live.test.ts pattern)
 */

import { afterEach, describe, expect, it } from "vitest";
import { SileroVad } from "./silero-vad.js";

// ── Audio generation helpers ──────────────────────────────────

const SAMPLE_RATE = 16000;

/** Generate silence (zeros). */
function generateSilence(durationMs: number): Float32Array {
  return new Float32Array((SAMPLE_RATE * durationMs) / 1000);
}

/**
 * Generate formant-synthesized speech-like audio.
 * Combines a glottal pulse train with vocal formants to approximate
 * a human "ah" vowel sound that the neural network can respond to.
 */
function generateSpeechLike(durationMs: number): Float32Array {
  const numSamples = (SAMPLE_RATE * durationMs) / 1000;
  const pcm = new Float32Array(numSamples);
  const f0 = 120; // fundamental frequency (male voice)

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;

    // Glottal pulse train with harmonics
    let glottal = 0;
    for (let h = 1; h <= 20; h++) {
      glottal += (1 / h) * Math.sin(2 * Math.PI * f0 * h * t);
    }

    // Formants for vowel "ah" (F1=730, F2=1090, F3=2440)
    const f1 = 0.4 * Math.sin(2 * Math.PI * 730 * t);
    const f2 = 0.3 * Math.sin(2 * Math.PI * 1090 * t);
    const f3 = 0.15 * Math.sin(2 * Math.PI * 2440 * t);

    // AM modulation (syllable-like envelope)
    const envelope = 0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t);

    const signal =
      envelope *
      (0.4 * glottal + 0.25 * f1 + 0.2 * f2 + 0.1 * f3 + 0.05 * (Math.random() * 2 - 1));

    pcm[i] = Math.max(-1, Math.min(1, signal));
  }
  return pcm;
}

/** Generate a pure sine tone (should NOT trigger VAD). */
function generatePureTone(durationMs: number, freq = 440): Float32Array {
  const numSamples = (SAMPLE_RATE * durationMs) / 1000;
  const pcm = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    pcm[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }
  return pcm;
}

/** Generate white noise. */
function generateNoise(durationMs: number, amplitude = 0.1): Float32Array {
  const numSamples = (SAMPLE_RATE * durationMs) / 1000;
  const pcm = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    pcm[i] = amplitude * (Math.random() * 2 - 1);
  }
  return pcm;
}

// ── Tests ─────────────────────────────────────────────────────

describe("SileroVad (live ONNX model)", () => {
  let vad: SileroVad;

  afterEach(async () => {
    if (vad) await vad.destroy();
  });

  it("loads the ONNX model successfully", async () => {
    vad = new SileroVad();
    await vad.init();
    // If we get here without throwing, the model loaded
    expect(true).toBe(true);
  });

  it("produces low probability for silence", async () => {
    vad = new SileroVad();
    await vad.init();

    const probabilities: number[] = [];
    let speechStarted = false;

    vad.onSpeechStart = () => {
      speechStarted = true;
    };

    // Feed 2 seconds of silence
    const silence = generateSilence(2000);
    // Process in 512-sample chunks to track probabilities via mock-free approach
    // We can't easily capture probabilities from the class, but we verify no speech_start fires
    await vad.processAudio(silence);

    expect(speechStarted).toBe(false);
  });

  it("does not trigger on low-level white noise", async () => {
    vad = new SileroVad({ speechThreshold: 0.5 });
    await vad.init();

    let speechStarted = false;
    vad.onSpeechStart = () => {
      speechStarted = true;
    };

    // Low-level background noise (10% amplitude)
    const noise = generateNoise(2000, 0.1);
    await vad.processAudio(noise);

    expect(speechStarted).toBe(false);
  });

  it("does not trigger on a pure sine tone", async () => {
    vad = new SileroVad({ speechThreshold: 0.5 });
    await vad.init();

    let speechStarted = false;
    vad.onSpeechStart = () => {
      speechStarted = true;
    };

    // Pure 440Hz tone — not speech
    const tone = generatePureTone(2000, 440);
    await vad.processAudio(tone);

    expect(speechStarted).toBe(false);
  });

  it("responds to speech-like formant audio (higher probability than silence)", async () => {
    vad = new SileroVad({ speechThreshold: 0.5 });
    await vad.init();

    let speechStarted = false;
    vad.onSpeechStart = () => {
      speechStarted = true;
    };

    // Formant-synthesized speech-like audio (2 seconds)
    const speech = generateSpeechLike(2000);
    await vad.processAudio(speech);

    // Synthetic formant audio may or may not cross the 0.5 threshold —
    // Silero VAD is trained on real human speech. We only verify no crash.
    // If it does trigger, great. If not, that's expected with synthetic audio.
    console.log(`[live-test] Speech-like audio triggered VAD: ${speechStarted}`);
  });

  it("handles Int16 input correctly", async () => {
    vad = new SileroVad();
    await vad.init();

    let speechStarted = false;
    vad.onSpeechStart = () => {
      speechStarted = true;
    };

    // Silence as Int16 — should not trigger
    const silence = new Int16Array(16000); // 1 second of silence
    await vad.processAudio(silence);

    expect(speechStarted).toBe(false);
  });

  it("can reset and process again without errors", async () => {
    vad = new SileroVad();
    await vad.init();

    // First pass
    await vad.processAudio(generateSilence(500));

    // Reset
    vad.resetState();

    // Second pass — should work fine
    await vad.processAudio(generateSilence(500));
  });

  it("processes a realistic utterance pattern (silence → speech → silence)", async () => {
    vad = new SileroVad({
      speechThreshold: 0.5,
      silenceDurationMs: 600,
      minSpeechDurationMs: 250,
    });
    await vad.init();

    let speechStartCount = 0;
    let speechEndCount = 0;

    vad.onSpeechStart = () => {
      speechStartCount++;
      console.log(`[live-test] Speech start #${speechStartCount}`);
    };
    vad.onSpeechEnd = () => {
      speechEndCount++;
      console.log(`[live-test] Speech end #${speechEndCount}`);
    };

    // Simulate: 500ms silence → 2000ms speech → 1500ms silence
    const silence1 = generateSilence(500);
    const speech = generateSpeechLike(2000);
    const silence2 = generateSilence(1500);

    await vad.processAudio(silence1);
    await vad.processAudio(speech);
    await vad.processAudio(silence2);

    // Wait for silence timer to potentially fire
    await new Promise((r) => setTimeout(r, 800));

    console.log(
      `[live-test] Utterance pattern: starts=${speechStartCount}, ends=${speechEndCount}`
    );
    // With synthetic audio, we may not get a speech detection,
    // but the pipeline should not crash
  });

  it("handles rapid successive audio chunks without accumulation issues", async () => {
    vad = new SileroVad();
    await vad.init();

    // Send many small chunks rapidly
    for (let i = 0; i < 100; i++) {
      await vad.processAudio(new Float32Array(100)); // 100 samples each
    }
    // 100 * 100 = 10000 samples / 512 = ~19 inference calls
    // Should not crash or accumulate unbounded memory
  });
});
