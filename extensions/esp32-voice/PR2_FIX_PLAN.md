# PR #2 Fix Plan — Silero VAD Performance & Correctness

**PR:** [#2 — raised pr](https://github.com/Abilashs003/openclaw/pull/2)  
**Author:** @rahulpscraftech360  
**Goal:** Merge the Silero VAD feature while fixing all blockers and maintaining performance.

---

## Fix 1: Do NOT Delete `AGENTS.md`

**Problem:** The PR accidentally deletes the root `AGENTS.md` (933 lines).

**Fix:** Remove from the PR by reverting that specific file:

```bash
# On rahul's branch
git checkout feat/esp32-voice-plugin -- "AGENTS.md"
git add "AGENTS.md"
git commit -m "fix: restore AGENTS.md (accidentally deleted)"
```

---

## Fix 2: Make `onnxruntime-node` an Optional Dependency

**Problem:** `onnxruntime-node` adds ~50MB to install and is only needed if the user wants local VAD.

**Fix in `package.json`:**

```jsonc
{
  "dependencies": {
    "opusscript": "^0.0.8",
    "ws": "^8.18.0",
    "zod": "^4.3.6"
    // ❌ Remove onnxruntime-node from here
  },
  "optionalDependencies": {
    "onnxruntime-node": "^1.21.0"   // ✅ Move here — install won't fail if it can't build
  }
}
```

**Fix in `silero-vad.ts` — already handled:**
The existing dynamic `import("onnxruntime-node")` pattern with try/catch already handles this. If the package isn't installed, `init()` will throw, and the `VoiceSession` constructor already catches that and falls back to Deepgram VAD. **No code change needed here — just move the dependency.**

---

## Fix 3: Per-Session Opus Decoder (Fix Thread Safety)

**Problem:** Global singleton `opusDecoderInstance` is shared across all sessions. Two ESP32 devices connecting simultaneously will corrupt each other's audio.

**Fix in `voice-session.ts` — give each session its own decoder:**

```typescript
export class VoiceSession {
  // ... existing fields ...

  // ✅ Per-session decoder instead of global singleton
  private opusDecoder: any = null;

  private async getSessionDecoder(): Promise<any> {
    if (this.opusDecoder) return this.opusDecoder;

    const OpusScript = (await import("opusscript")) as any;
    const Ctor = OpusScript.default ?? OpusScript;
    this.opusDecoder = new Ctor(INPUT_SAMPLE_RATE, 1, Ctor.Application.VOIP);
    this.log("info", `Opus decoder initialized: ${INPUT_SAMPLE_RATE}Hz mono`);
    return this.opusDecoder;
  }

  // In handleAudioFrame(), replace:
  //   const decoder = await getOpusDecoder();    ❌ global
  // with:
  //   const decoder = await this.getSessionDecoder();  ✅ per-session

  // In destroy(), add cleanup:
  async destroy(): Promise<void> {
    this.opusDecoder = null;  // ✅ Release per-session decoder
    // ... rest of existing cleanup ...
  }
}
```

**Also delete the global `getOpusDecoder()` function and `opusDecoderInstance` variable** at the top of the file.

> **Note:** The global `opusEncoderInstance` (for TTS output) has the same issue but was pre-existing. Consider fixing that too in a follow-up.

---

## Fix 4: Add VAD Config Toggle

**Problem:** VAD is always-on with no way to disable it. Some deployments may not want the CPU overhead.

**Fix — add to config-schema.ts:**

```typescript
// Add to the existing config schema
enableLocalVad: z.boolean().default(true).describe(
  "Enable Silero VAD for local speech-end detection. " +
  "Faster than cloud VAD but uses more CPU. " +
  "Falls back to Deepgram VAD if disabled or if onnxruntime-node is not installed."
),
```

**Fix — in `voice-session.ts` constructor:**

```typescript
constructor(ws: WebSocket, sessionId: string) {
  this.ws = ws;
  this.sessionId = sessionId;

  // ✅ Only init VAD if enabled in config
  if (this.cfg?.enableLocalVad !== false) {
    this.initVad();
  }
}
```

---

## Fix 5: Start/Stop Silence Timer on Demand

**Problem:** The 100ms `setInterval` runs continuously from init, even when nobody is speaking.

**Fix in `silero-vad.ts`:**

```typescript
// ❌ REMOVE from init():
// this.silenceCheckTimer = setInterval(() => { ... }, 100);

// ✅ Start timer only when speech starts:
private updateState(probability: number): void {
  const now = Date.now();

  if (probability >= this.config.speechThreshold) {
    this.lastSpeechAt = now;

    if (!this.isSpeaking) {
      this.isSpeaking = true;
      this.speechStartedAt = now;

      // ✅ Start silence checker only when speech begins
      if (!this.silenceCheckTimer) {
        this.silenceCheckTimer = setInterval(() => {
          this.checkSilenceTimeout();
        }, 100);
      }

      if (this.onSpeechStart) { /* ... existing callback ... */ }
    }
  }
}

// ✅ Stop timer when speech ends:
private checkSilenceTimeout(): void {
  // ... existing logic ...

  if (silenceDuration >= this.config.silenceDurationMs) {
    this.isSpeaking = false;

    // ✅ Stop the timer — no need to poll during silence
    if (this.silenceCheckTimer) {
      clearInterval(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }

    if (speechDuration >= this.config.minSpeechDurationMs) {
      if (this.onSpeechEnd) { /* ... existing callback ... */ }
    }
  }
}
```

**Impact:** Eliminates ~10 timer callbacks/second during idle periods. With 10 devices idle, that's 100 fewer callbacks/second.

---

## Fix 6: Avoid Float32Array Allocation on Every Frame

**Problem:** Every audio frame creates new `Float32Array` objects:

```typescript
// ❌ Current — allocates a new array every call
const newBuffer = new Float32Array(this.pcmBuffer.length + floatPcm.length);
newBuffer.set(this.pcmBuffer);
newBuffer.set(floatPcm, this.pcmBuffer.length);
this.pcmBuffer = newBuffer;
```

At 16.6 frames/second (60ms intervals), this creates ~17 short-lived arrays/second per device → GC pressure.

**Fix — use a pre-allocated ring buffer:**

```typescript
export class SileroVad {
  // ✅ Pre-allocate a large enough buffer (2 seconds of audio at 16kHz)
  private readonly pcmRing = new Float32Array(SAMPLE_RATE * 2);
  private pcmWritePos = 0;
  private pcmReadPos = 0;

  private get pcmAvailable(): number {
    return this.pcmWritePos - this.pcmReadPos;
  }

  async processAudio(pcm: Int16Array | Float32Array): Promise<void> {
    if (!this.session) throw new Error("SileroVad not initialized.");

    // Convert Int16 → Float32 in-place to the ring buffer
    if (pcm instanceof Int16Array) {
      const writeStart = this.pcmWritePos % this.pcmRing.length;
      for (let i = 0; i < pcm.length; i++) {
        this.pcmRing[(writeStart + i) % this.pcmRing.length] = pcm[i] / 32768.0;
      }
    } else {
      const writeStart = this.pcmWritePos % this.pcmRing.length;
      for (let i = 0; i < pcm.length; i++) {
        this.pcmRing[(writeStart + i) % this.pcmRing.length] = pcm[i];
      }
    }
    this.pcmWritePos += pcm.length;

    // Process complete 512-sample windows without allocating
    const window = new Float32Array(WINDOW_SIZE); // ← reuse across calls (move to class field)
    while (this.pcmAvailable >= WINDOW_SIZE) {
      const readStart = this.pcmReadPos % this.pcmRing.length;
      for (let i = 0; i < WINDOW_SIZE; i++) {
        window[i] = this.pcmRing[(readStart + i) % this.pcmRing.length];
      }
      this.pcmReadPos += WINDOW_SIZE;

      const probability = await this.infer(window);
      this.updateState(probability);
    }
  }

  resetState(): void {
    // ... existing resets ...
    this.pcmWritePos = 0;
    this.pcmReadPos = 0;
  }
}
```

**Impact:** Eliminates ~17 array allocations/second per device. Reduces GC pauses.

---

## Fix 7: `test-full-client.mjs` Cross-Platform Mic

**Problem:** Hardcoded Windows `dshow` audio format. Won't work on macOS.

**Fix:**

```javascript
function startMicCapture() {
  const platform = process.platform;
  let args;

  if (platform === "darwin") {
    // macOS — use avfoundation
    args = ["-f", "avfoundation", "-i", ":default",
            "-ar", String(INPUT_SAMPLE_RATE), "-ac", String(INPUT_CHANNELS),
            "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"];
  } else if (platform === "win32") {
    // Windows — use dshow
    const mic = process.env.MIC_DEVICE || "External Microphone (Realtek(R) Audio)";
    args = ["-f", "dshow", "-i", `audio=${mic}`,
            "-ar", String(INPUT_SAMPLE_RATE), "-ac", String(INPUT_CHANNELS),
            "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"];
  } else {
    // Linux — use pulseaudio or alsa
    args = ["-f", "pulse", "-i", "default",
            "-ar", String(INPUT_SAMPLE_RATE), "-ac", String(INPUT_CHANNELS),
            "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"];
  }

  micProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
}
```

---

## Fix 8: Download ONNX Model At Runtime (Optional — Can Be Follow-Up)

**Problem:** Binary `.onnx` file (~2MB) committed to git.

**Fix — lazy download in `silero-vad.ts`:**

```typescript
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const MODEL_URL = "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx";

async function ensureModel(modelPath: string): Promise<string> {
  if (existsSync(modelPath)) return modelPath;

  console.log("[silero-vad] Downloading model on first use...");
  const dir = dirname(modelPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Failed to download model: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(modelPath, buffer);
  console.log(`[silero-vad] Model saved to ${modelPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
  return modelPath;
}
```

Then in `init()`, call `modelPath = await ensureModel(modelPath);` before `InferenceSession.create()`.

**Impact:** Removes binary from git. Model downloads once and is cached locally.

> This can be a follow-up PR — not blocking.

---

## Fix 9: Proper PR Title & Description

**Current:**
```
Title: "raised pr"
Body: (empty)
```

**Should be:**
```
Title: feat(esp32-voice): add Silero VAD for local speech-end detection

Body:
## Summary
- Adds server-side Voice Activity Detection using Silero VAD (ONNX)
- Decodes incoming Opus → PCM to feed the VAD neural network
- Triggers processUtterance() on speech_end ~5x faster than Deepgram cloud VAD
- Falls back gracefully to Deepgram VAD if onnxruntime-node is unavailable
- Adds standalone voice server runner and 3 test harnesses

## Performance
- Speech-end latency: ~500-1000ms → ~100-200ms (5x improvement)
- CPU overhead: ~1-3ms per 60ms audio frame per device
- onnxruntime-node is optional — plugin works without it
```

---

## Summary — Priority Order

| # | Fix | Priority | Effort | Impact |
|---|-----|----------|--------|--------|
| 1 | Restore `AGENTS.md` | 🔴 Blocker | 1 min | Prevents data loss |
| 2 | Move `onnxruntime-node` to optionalDependencies | 🔴 Blocker | 2 min | -50MB install for users who don't need VAD |
| 3 | Per-session Opus decoder | 🔴 Blocker | 15 min | Fixes multi-device audio corruption |
| 4 | Add VAD config toggle | 🟡 Important | 10 min | Users can disable VAD CPU overhead |
| 5 | On-demand silence timer | 🟡 Important | 10 min | -100 callbacks/sec when idle |
| 6 | Ring buffer (avoid allocs) | 🟡 Important | 20 min | Reduces GC pressure |
| 7 | Cross-platform test client | 🟡 Nice | 10 min | Tests work on macOS |
| 8 | Runtime model download | 💡 Follow-up | 30 min | Removes binary from git |
| 9 | PR title/description | 🟡 Hygiene | 5 min | Code review standards |

**Fixes 1-3 are blockers.** They must be done before merge.  
**Fixes 4-6 maintain performance** at scale (multiple devices).  
**Fixes 7-9 are quality improvements** that can be done now or in follow-ups.

---

## After Fixes — Expected Performance Profile

| Metric | Current PR | After Fixes | Notes |
|--------|-----------|-------------|-------|
| `npm install` size (without VAD) | +50MB forced | +0MB | onnxruntime is optional |
| `npm install` size (with VAD) | +50MB | +50MB | Same, but opt-in |
| Idle CPU (no speech) | Timer polling constantly | Zero overhead | Timer starts on speech only |
| Per-frame allocation | ~17 arrays/sec/device | 0 arrays/sec | Ring buffer reuse |
| Multi-device safety | ❌ Broken (shared decoder) | ✅ Safe | Per-session decoder |
| Speech-end latency | ~100-200ms | ~100-200ms | Same — this is the win ✅ |
