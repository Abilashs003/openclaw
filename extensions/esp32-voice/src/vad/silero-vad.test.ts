/**
 * Unit tests for Silero VAD (Voice Activity Detection).
 *
 * Uses mocked onnxruntime-node to test all logic paths without
 * requiring the actual ONNX model file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock onnxruntime-node ─────────────────────────────────────

const mockRun = vi.fn();
const mockRelease = vi.fn();
const mockCreate = vi.fn();

// Tensor stub: just stores args for assertion
class MockTensor {
  type: string;
  data: unknown;
  dims: number[];
  constructor(type: string, data: unknown, dims: number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

vi.mock("onnxruntime-node", () => ({
  InferenceSession: {
    create: mockCreate,
  },
  Tensor: MockTensor,
}));

// ── Import after mock ─────────────────────────────────────────

const { SileroVad } = await import("./silero-vad.js");

// ── Helpers ───────────────────────────────────────────────────

/** Create a mock ONNX inference result with the given speech probability. */
function mockInferenceResult(probability: number) {
  return {
    output: { data: [probability] },
    stateN: { data: new Float32Array(2 * 1 * 128) },
  };
}

/** Generate silent PCM (all zeros). */
function silentPcmFloat(samples: number): Float32Array {
  return new Float32Array(samples);
}

/** Generate "speech" PCM (non-zero values). */
function speechPcmFloat(samples: number): Float32Array {
  const pcm = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  }
  return pcm;
}

// ── Tests ─────────────────────────────────────────────────────

describe("SileroVad", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({
      run: mockRun,
      release: mockRelease,
    });
    // Default: return low probability (silence)
    mockRun.mockResolvedValue(mockInferenceResult(0.1));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("uses default config when no options provided", () => {
      const vad = new SileroVad();
      // Access config via the init path — we verify defaults indirectly
      expect(vad).toBeDefined();
      expect(vad.onSpeechStart).toBeNull();
      expect(vad.onSpeechEnd).toBeNull();
    });

    it("accepts custom config", () => {
      const vad = new SileroVad({
        speechThreshold: 0.7,
        silenceDurationMs: 1000,
        minSpeechDurationMs: 500,
      });
      expect(vad).toBeDefined();
    });
  });

  describe("init()", () => {
    it("loads the ONNX model and starts silence check timer", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      expect(mockCreate).toHaveBeenCalledWith("/fake/model.onnx", {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });

      // Cleanup timer
      await vad.destroy();
    });

    it("resolves model path from __dirname when not provided", async () => {
      const vad = new SileroVad();
      await vad.init();

      // Should have called create with some path ending in silero_vad.onnx
      const calledPath = mockCreate.mock.calls[0][0] as string;
      expect(calledPath).toContain("silero_vad.onnx");

      await vad.destroy();
    });
  });

  describe("processAudio()", () => {
    it("throws if not initialized", async () => {
      const vad = new SileroVad();
      await expect(vad.processAudio(new Float32Array(512))).rejects.toThrow(
        "SileroVad not initialized"
      );
    });

    it("converts Int16Array to Float32 and processes", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      // 512 samples = one full window → one inference call
      const int16Pcm = new Int16Array(512);
      int16Pcm[0] = 16384; // 0.5 in float
      int16Pcm[1] = -16384; // -0.5 in float

      await vad.processAudio(int16Pcm);

      expect(mockRun).toHaveBeenCalledTimes(1);
      // Verify the input tensor was float32
      const feeds = mockRun.mock.calls[0][0];
      expect(feeds.input).toBeInstanceOf(MockTensor);
      expect(feeds.input.type).toBe("float32");

      await vad.destroy();
    });

    it("accepts Float32Array directly", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      await vad.processAudio(new Float32Array(512));
      expect(mockRun).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("buffers audio until a full 512-sample window is available", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      // Send 256 samples — not enough for a window
      await vad.processAudio(new Float32Array(256));
      expect(mockRun).not.toHaveBeenCalled();

      // Send another 256 → total 512 → one inference
      await vad.processAudio(new Float32Array(256));
      expect(mockRun).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("processes multiple windows from a large chunk", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      // 1024 samples = 2 windows of 512
      await vad.processAudio(new Float32Array(1024));
      expect(mockRun).toHaveBeenCalledTimes(2);

      await vad.destroy();
    });

    it("preserves leftover samples across calls", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      // 600 samples → 1 window (512) + 88 leftover
      await vad.processAudio(new Float32Array(600));
      expect(mockRun).toHaveBeenCalledTimes(1);

      // 424 more → 88 + 424 = 512 → another window
      await vad.processAudio(new Float32Array(424));
      expect(mockRun).toHaveBeenCalledTimes(2);

      await vad.destroy();
    });
  });

  describe("speech detection", () => {
    it("fires onSpeechStart when probability crosses threshold", async () => {
      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
      });
      await vad.init();

      const onStart = vi.fn();
      vad.onSpeechStart = onStart;

      // Return high probability
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));

      await vad.processAudio(speechPcmFloat(512));

      expect(onStart).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("does NOT fire onSpeechStart when probability is below threshold", async () => {
      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
      });
      await vad.init();

      const onStart = vi.fn();
      vad.onSpeechStart = onStart;

      mockRun.mockResolvedValueOnce(mockInferenceResult(0.3));

      await vad.processAudio(speechPcmFloat(512));

      expect(onStart).not.toHaveBeenCalled();

      await vad.destroy();
    });

    it("fires onSpeechStart only once per speech segment", async () => {
      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
      });
      await vad.init();

      const onStart = vi.fn();
      vad.onSpeechStart = onStart;

      // Multiple high-probability windows
      mockRun
        .mockResolvedValueOnce(mockInferenceResult(0.8))
        .mockResolvedValueOnce(mockInferenceResult(0.9))
        .mockResolvedValueOnce(mockInferenceResult(0.7));

      await vad.processAudio(speechPcmFloat(512 * 3));

      expect(onStart).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("handles async onSpeechStart callback", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      const onStart = vi.fn().mockResolvedValue(undefined);
      vad.onSpeechStart = onStart;

      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));

      await vad.processAudio(speechPcmFloat(512));

      expect(onStart).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("catches errors in async onSpeechStart callback", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vad.onSpeechStart = vi.fn().mockRejectedValue(new Error("callback error"));

      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));

      await vad.processAudio(speechPcmFloat(512));

      // Wait for promise rejection to be caught
      await new Promise((r) => setTimeout(r, 10));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("onSpeechStart error"),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
      await vad.destroy();
    });
  });

  describe("silence timeout (speech end)", () => {
    it("fires onSpeechEnd after silence exceeds silenceDurationMs", async () => {
      vi.useFakeTimers();

      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
        silenceDurationMs: 600,
        minSpeechDurationMs: 250,
      });
      await vad.init();

      const onEnd = vi.fn();
      vad.onSpeechEnd = onEnd;

      // First speech frame → speechStartedAt = 0, lastSpeechAt = 0
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));

      // Advance time 300ms, then send another speech frame so
      // lastSpeechAt = 300 and speechDuration = 300ms > minSpeechDurationMs
      vi.advanceTimersByTime(300);
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));

      // Now silence frames
      mockRun.mockResolvedValue(mockInferenceResult(0.1));
      await vad.processAudio(silentPcmFloat(512));

      // Advance past silence threshold (600ms)
      vi.advanceTimersByTime(700);

      expect(onEnd).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("does NOT fire onSpeechEnd if speech was too short", async () => {
      vi.useFakeTimers();

      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
        silenceDurationMs: 600,
        minSpeechDurationMs: 250,
      });
      await vad.init();

      const onEnd = vi.fn();
      vad.onSpeechEnd = onEnd;

      // Very brief speech (one frame) — speechStartedAt and lastSpeechAt
      // will be nearly identical → speechDuration < minSpeechDurationMs
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));

      // Immediate silence (no time advance for speech duration)
      mockRun.mockResolvedValue(mockInferenceResult(0.1));
      await vad.processAudio(silentPcmFloat(512));

      // Advance past silence threshold
      vi.advanceTimersByTime(700);

      // Should NOT fire because speech was too short (< 250ms)
      expect(onEnd).not.toHaveBeenCalled();

      await vad.destroy();
    });

    it("does NOT fire onSpeechEnd during ongoing speech", async () => {
      vi.useFakeTimers();

      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
        silenceDurationMs: 600,
      });
      await vad.init();

      const onEnd = vi.fn();
      vad.onSpeechEnd = onEnd;

      // Continuous speech — high probability on each window
      mockRun.mockResolvedValue(mockInferenceResult(0.8));

      for (let i = 0; i < 10; i++) {
        await vad.processAudio(speechPcmFloat(512));
        vi.advanceTimersByTime(32); // 32ms per window
      }

      expect(onEnd).not.toHaveBeenCalled();

      await vad.destroy();
    });

    it("handles async onSpeechEnd callback errors gracefully", async () => {
      vi.useFakeTimers();

      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        silenceDurationMs: 600,
        minSpeechDurationMs: 0, // disable min speech check for simplicity
      });
      await vad.init();

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vad.onSpeechEnd = vi.fn().mockRejectedValue(new Error("end error"));

      // Speech start
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));

      // Mark some speech time
      vi.advanceTimersByTime(300);

      // Silence
      mockRun.mockResolvedValue(mockInferenceResult(0.1));
      await vad.processAudio(silentPcmFloat(512));

      // Advance past silence threshold
      vi.advanceTimersByTime(700);

      // Wait for async error handling
      await vi.advanceTimersByTimeAsync(10);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("onSpeechEnd error"),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
      await vad.destroy();
    });
  });

  describe("resetState()", () => {
    it("resets all internal state", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      const onStart = vi.fn();
      vad.onSpeechStart = onStart;

      // Trigger speech
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));
      expect(onStart).toHaveBeenCalledTimes(1);

      // Reset
      vad.resetState();

      // Speech should trigger onSpeechStart again (state was reset)
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));
      expect(onStart).toHaveBeenCalledTimes(2);

      await vad.destroy();
    });

    it("clears the PCM buffer", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      // Add partial buffer (not enough for a window)
      await vad.processAudio(new Float32Array(256));
      expect(mockRun).not.toHaveBeenCalled();

      // Reset clears the buffer
      vad.resetState();

      // Now 256 samples again — still not enough (buffer was cleared)
      await vad.processAudio(new Float32Array(256));
      expect(mockRun).not.toHaveBeenCalled();

      await vad.destroy();
    });
  });

  describe("destroy()", () => {
    it("releases the ONNX session", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();
      await vad.destroy();

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it("clears the silence check timer", async () => {
      const clearSpy = vi.spyOn(global, "clearInterval");

      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();
      await vad.destroy();

      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });

    it("is safe to call multiple times", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();
      await vad.destroy();
      await vad.destroy(); // should not throw
    });

    it("resets state on destroy", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      // Process some audio
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));

      await vad.destroy();

      // After destroy, processAudio should throw (session is null)
      await expect(vad.processAudio(new Float32Array(512))).rejects.toThrow(
        "SileroVad not initialized"
      );
    });
  });

  describe("ONNX inference", () => {
    it("passes correct tensor shapes to the model", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      await vad.processAudio(new Float32Array(512));

      const feeds = mockRun.mock.calls[0][0];
      // input: [1, 576] (512 window + 64 context prepended)
      expect(feeds.input.dims).toEqual([1, 576]);
      // state: [2, 1, 128]
      expect(feeds.state.dims).toEqual([2, 1, 128]);
      // sr: scalar
      expect(feeds.sr.type).toBe("int64");

      await vad.destroy();
    });

    it("persists LSTM state across inference calls", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      // First call returns custom state
      const customState = new Float32Array(256).fill(0.42);
      mockRun.mockResolvedValueOnce({
        output: { data: [0.1] },
        stateN: { data: customState },
      });

      await vad.processAudio(new Float32Array(512));

      // Second call should use the state from first call
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.1));
      await vad.processAudio(new Float32Array(512));

      const secondCallState = mockRun.mock.calls[1][0].state.data;
      expect(secondCallState).toEqual(new Float32Array(customState));

      await vad.destroy();
    });
  });

  describe("edge cases", () => {
    it("handles empty audio input gracefully", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      await vad.processAudio(new Float32Array(0));
      expect(mockRun).not.toHaveBeenCalled();

      await vad.destroy();
    });

    it("handles exactly one window of audio", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      await vad.processAudio(new Float32Array(512));
      expect(mockRun).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("handles speech at exact threshold value", async () => {
      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
      });
      await vad.init();

      const onStart = vi.fn();
      vad.onSpeechStart = onStart;

      // Exactly at threshold — should trigger
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.5));
      await vad.processAudio(speechPcmFloat(512));

      expect(onStart).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("handles speech just below threshold", async () => {
      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
      });
      await vad.init();

      const onStart = vi.fn();
      vad.onSpeechStart = onStart;

      mockRun.mockResolvedValueOnce(mockInferenceResult(0.499));
      await vad.processAudio(speechPcmFloat(512));

      expect(onStart).not.toHaveBeenCalled();

      await vad.destroy();
    });

    it("works with custom high threshold", async () => {
      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.9,
      });
      await vad.init();

      const onStart = vi.fn();
      vad.onSpeechStart = onStart;

      // 0.8 is below the 0.9 threshold
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));
      expect(onStart).not.toHaveBeenCalled();

      // 0.95 is above
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.95));
      await vad.processAudio(speechPcmFloat(512));
      expect(onStart).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("handles null stateN in model output", async () => {
      const vad = new SileroVad({ modelPath: "/fake/model.onnx" });
      await vad.init();

      // stateN with no data
      mockRun.mockResolvedValueOnce({
        output: { data: [0.1] },
        stateN: {},
      });

      // Should not throw
      await vad.processAudio(new Float32Array(512));
      expect(mockRun).toHaveBeenCalledTimes(1);

      await vad.destroy();
    });

    it("speech → silence → speech triggers two onSpeechStart events", async () => {
      vi.useFakeTimers();

      const vad = new SileroVad({
        modelPath: "/fake/model.onnx",
        speechThreshold: 0.5,
        silenceDurationMs: 600,
        minSpeechDurationMs: 0, // disable min check
      });
      await vad.init();

      const onStart = vi.fn();
      const onEnd = vi.fn();
      vad.onSpeechStart = onStart;
      vad.onSpeechEnd = onEnd;

      // First speech
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));
      expect(onStart).toHaveBeenCalledTimes(1);

      // Some speech time
      vi.advanceTimersByTime(300);

      // Silence
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.1));
      await vad.processAudio(silentPcmFloat(512));

      // Advance past silence timeout
      vi.advanceTimersByTime(700);
      expect(onEnd).toHaveBeenCalledTimes(1);

      // Second speech — should trigger onSpeechStart again
      mockRun.mockResolvedValueOnce(mockInferenceResult(0.8));
      await vad.processAudio(speechPcmFloat(512));
      expect(onStart).toHaveBeenCalledTimes(2);

      await vad.destroy();
    });
  });
});
