# TTS Providers — ESP32 Voice Plugin

This document covers the TTS provider system architecture, the current ElevenLabs integration,
and a full evaluation of alternative providers for the ESP32 voice pipeline.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Audio Pipeline Requirements](#2-audio-pipeline-requirements)
3. [Provider Interface](#3-provider-interface)
4. [Current Provider — ElevenLabs](#4-current-provider--elevenlabs)
5. [Alternative Providers — Evaluation](#5-alternative-providers--evaluation)
6. [Recommendation](#6-recommendation)
7. [How to Add a New Provider](#7-how-to-add-a-new-provider)

---

## 1. Architecture Overview

The TTS system uses a **registry pattern**. Providers register themselves at module load
time. The voice session picks a provider by ID from config and calls a standard 4-step
lifecycle:

```
voice-session.ts
    │
    ├─ ttsRegistry.create("elevenlabs", config)
    │
    ▼
TtsProvider instance
    │
    ├─ connect()      → open WebSocket / HTTP connection
    ├─ synthesize()   → send text
    ├─ flush()        → wait for all audio delivery
    └─ close()        → cleanup
         │
         ▼ onAudio(pcmChunk: Buffer)   ← called per chunk
              │
              ▼ Opus encoder (24kHz PCM → Opus frame)
                   │
                   ▼ Binary WebSocket frame → ESP32 speaker
```

**Key files:**

| File | Purpose |
|------|---------|
| [src/tts/tts-provider.ts](src/tts/tts-provider.ts) | Interface + types |
| [src/tts/tts-registry.ts](src/tts/tts-registry.ts) | Global registry singleton |
| [src/tts/elevenlabs.ts](src/tts/elevenlabs.ts) | ElevenLabs implementation |
| [src/voice/voice-session.ts](src/voice/voice-session.ts) | TTS consumer |

---

## 2. Audio Pipeline Requirements

Any TTS provider added to this plugin **must** satisfy these requirements:

| Requirement | Value | Notes |
|-------------|-------|-------|
| Output format | **16-bit signed LE PCM** | Fed into opusscript encoder |
| Sample rate | **24000 Hz** | Matches ESP32 Opus decoder config |
| Channels | **Mono (1ch)** | |
| Frame size | 2880 bytes | 1440 samples × 2 bytes (60ms @ 24kHz) |
| Delivery | `onAudio(chunk: Buffer)` callback | Chunks don't need to be frame-aligned |
| Completion | `onDone()` callback | After all audio is delivered |

The voice session handles framing, Opus encoding, and real-time pacing — the provider
only needs to deliver raw PCM bytes.

---

## 3. Provider Interface

```typescript
// tts-provider.ts

export interface TtsProvider {
  readonly id: string;           // e.g. "elevenlabs", "rime", "cartesia"
  readonly name: string;         // Human-readable
  readonly streaming: boolean;   // true = WebSocket, false = HTTP batch
  readonly outputSampleRate: number; // Must be 24000

  onAudio: TtsAudioCallback | null;  // Set by voice-session before connect()
  onDone: TtsDoneCallback | null;    // Set by voice-session before connect()

  connect(): Promise<void>;
  synthesize(text: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

**Streaming vs Batch:**

- **Streaming** (`streaming: true`) — WebSocket, audio starts flowing ~300ms after
  first text chunk. Best user experience — ESP32 starts playing before synthesis is done.
- **Batch** (`streaming: false`) — HTTP POST, wait for full audio file, then stream
  to ESP32. Simple to implement but adds full synthesis time as latency.

---

## 4. Current Provider — ElevenLabs

**File:** [src/tts/elevenlabs.ts](src/tts/elevenlabs.ts)

| Property | Value |
|----------|-------|
| Provider ID | `elevenlabs` |
| Env var | `ELEVENLABS_API_KEY` |
| Transport | WebSocket (`wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`) |
| Output | base64-encoded 24kHz PCM, decoded on receipt |
| Streaming | Yes |
| Default voice | Rachel (`21m00Tcm4TlvDq8ikWAM`) |
| Default model | `eleven_turbo_v2_5` |
| Latency | ~300ms to first audio |

**Configuration env vars:**

```bash
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM   # optional
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5       # optional
```

**Protocol summary:**

1. Open WebSocket with `?model_id=...&output_format=pcm_24000`
2. Send BOS: `{ text: " ", voice_settings: {...}, generation_config: { flush: true } }`
3. Send text chunks: `{ text: "...", generation_config: { flush: true } }`
4. Send EOS: `{ text: "" }`
5. Receive messages: `{ audio: "<base64-pcm>", isFinal: true/false }`

---

## 5. Alternative Providers — Evaluation

### Implemented Providers

All 5 providers below are implemented. Set `TTS_PROVIDER=<id>` in `~/.openclaw/.env` to activate.

| Provider | ID | Env Var | Streaming | Latency | File |
|----------|----|---------|-----------|---------|------|
| Rime | `rime` | `RIME_API_KEY` | Yes (WS) | Low | `src/tts/rime.ts` |
| Inworld | `inworld` | `INWORLD_API_KEY` | Yes (WS) | <120ms | `src/tts/inworld.ts` |
| Cartesia | `cartesia` | `CARTESIA_API_KEY` | Yes (WS) | ~80ms | `src/tts/cartesia.ts` |
| Smallest.ai | `smallest-ai` | `SMALLEST_AI_API_KEY` | Yes (WS) | Low | `src/tts/smallest-ai.ts` |
| Groq PlayAI | `groq-playai` | `GROQ_API_KEY` | No (batch) | High | `src/tts/groq-playai.ts` |

---

Evaluated against the ESP32 voice pipeline requirements (24kHz PCM, streaming preferred).

---

### 5.1 Rime

| Property | Value |
|----------|-------|
| Website | https://rime.ai |
| API endpoint | `wss://users.rime.ai/v1/rime-tts` |
| Transport | **WebSocket** (preferred) or HTTP |
| Output | **PCM native** (no base64 needed in non-JSON mode) |
| Sample rate | Configurable: 8k / 16k / 22050 / **24k** / 32k / 44.1k / 48k |
| Streaming | **Yes** — `reduce_latency` flag available |
| Env var | `RIME_API_KEY` |
| LiveKit support | Yes (managed inference) |

**Verdict: Best fit for this plugin.**
- Nearly identical WebSocket pattern to ElevenLabs
- Native PCM output — no base64 decode step
- `reduce_latency` mode for voice assistant use cases
- Clean implementation — least code to write

---

### 5.2 Inworld TTS

| Property | Value |
|----------|-------|
| Website | https://inworld.ai/tts |
| Transport | **WebSocket** |
| Output | **LINEAR16 PCM** (default), also MP3, Opus |
| Sample rate | 16000 / **24000** / 48000 Hz |
| Streaming | **Yes** — persistent connection, interruption support |
| Latency | **<120ms P90** (Mini model) |
| Env var | `INWORLD_API_KEY` |
| LiveKit support | Yes (managed inference) |

**Verdict: Best latency.**
- Fastest of all evaluated providers (<120ms)
- WebSocket with direct PCM LINEAR16 — perfect match
- Designed specifically for voice agents
- Marketed as ElevenLabs alternative with better latency

---

### 5.3 Cartesia

| Property | Value |
|----------|-------|
| Website | https://cartesia.ai |
| Transport | **WebSocket** |
| Output | PCM (raw bytes) |
| Sample rate | **24000** Hz (and others) |
| Streaming | **Yes** |
| Latency | **~80ms** — fastest of all options |
| Env var | `CARTESIA_API_KEY` |
| LiveKit support | Yes (managed inference) |

**Verdict: Best for production / lowest latency.**
- ~80ms latency — industry leading
- WebSocket streaming with PCM
- Widely used in voice agent frameworks (Pipecat, LiveKit)
- Highly stable API

---

### 5.4 Smallest.ai (Waves)

| Property | Value |
|----------|-------|
| Website | https://smallest.ai |
| Docs | https://waves-docs.smallest.ai |
| Transport | **WebSocket** |
| Output | base64-encoded audio chunks |
| Sample rate | **24000** Hz supported |
| Streaming | **Yes** — chunk + complete pattern |
| Env var | `SMALLEST_API_KEY` |

**Verdict: Good option, needs audio format verification.**
- WebSocket streaming confirmed
- Audio comes as base64 chunks (same pattern as ElevenLabs)
- Need to verify output is raw PCM vs MP3 (docs are not explicit)
- 20-second inactivity timeout (manageable)

---

### 5.5 Groq PlayAI

| Property | Value |
|----------|-------|
| Model | `playai-tts` / `playai-tts-arabic` |
| API endpoint | `POST https://api.groq.com/openai/v1/audio/speech` |
| Transport | **HTTP batch only** (no WebSocket) |
| Output | WAV / MP3 / FLAC (need to strip WAV header for PCM) |
| Sample rate | **24000** Hz (default) |
| Streaming | **No** — full file returned at once |
| Env var | `GROQ_API_KEY` |
| Speed | ~140 chars/sec on GroqCloud |

**Verdict: Feasible but adds latency.**
- No streaming = entire synthesis must complete before ESP32 hears anything
- Good as a cost-effective fallback (Groq is cheap)
- WAV format: strip 44-byte header → raw PCM
- Useful for non-realtime use cases or development/testing

---

### 5.6 Deepgram Aura TTS

| Property | Value |
|----------|-------|
| Transport | **WebSocket** |
| Output | PCM |
| Sample rate | **24000** Hz |
| Streaming | **Yes** |
| Env var | `DEEPGRAM_API_KEY` (same key as STT!) |
| Note | Same API key as Deepgram STT already required |

**Verdict: Convenient if already using Deepgram STT.**
- No extra API key needed — already have `DEEPGRAM_API_KEY`
- WebSocket streaming, PCM output
- Quality not as high as ElevenLabs/Cartesia/Rime for voice assistants

---

## 6. Recommendation

| Priority | Provider | Reason |
|----------|----------|--------|
| **1st — Next to implement** | **Rime** | Closest API shape to ElevenLabs, native PCM, streaming, `reduce_latency` mode |
| **2nd** | **Inworld** | Best latency (<120ms), WebSocket + LINEAR16 PCM |
| **3rd** | **Cartesia** | ~80ms latency, production-grade stability |
| **4th** | **Deepgram Aura** | Zero new API key needed (already have Deepgram) |
| **Fallback** | **Groq PlayAI** | Batch only, but cheap and simple for non-realtime |

---

## 7. How to Add a New Provider

### Step 1 — Create the provider file

```
extensions/esp32-voice/src/tts/<provider-name>.ts
```

### Step 2 — Implement the interface

```typescript
import type { TtsProvider, TtsProviderConfig, TtsProviderMeta } from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

export class MyProviderTts implements TtsProvider {
  readonly id = "myprovider";
  readonly name = "My Provider";
  readonly streaming = true;          // true if WebSocket, false if HTTP batch
  readonly outputSampleRate = 24000;  // MUST be 24000 for ESP32 Opus encoder

  onAudio: TtsAudioCallback | null = null;
  onDone: TtsDoneCallback | null = null;

  constructor(private config: TtsProviderConfig) {}

  async connect(): Promise<void> {
    // Open WebSocket or prepare HTTP client
  }

  async synthesize(text: string): Promise<void> {
    // Send text to provider
    // For streaming: send chunk, audio flows via onAudio callback
    // For batch: buffer text (send all in flush)
  }

  async flush(): Promise<void> {
    // Signal end of input
    // Wait until all onAudio callbacks have fired, then call onDone
  }

  async close(): Promise<void> {
    // Close WebSocket / cleanup
  }
}

export const myProviderMeta: TtsProviderMeta = {
  id: "myprovider",
  name: "My Provider",
  description: "Short description",
  streaming: true,
  envVar: "MYPROVIDER_API_KEY",
  defaultVoiceId: "default-voice-id",
  defaultModel: "default-model",
  outputSampleRate: 24000,
  docsUrl: "https://myprovider.com/docs/tts",
};

// Auto-register on import
ttsRegistry.register(myProviderMeta, (config) => new MyProviderTts(config));
```

### Step 3 — Register in index.ts

```typescript
// extensions/esp32-voice/index.ts
import "./src/tts/myprovider.js";
```

### Step 4 — Add env var to .env.example

```bash
# Optional — My Provider TTS
MYPROVIDER_API_KEY=<your-myprovider-api-key>
```

### Step 5 — Wire config in config-schema.ts

Add `"myprovider"` to the `ttsProvider` enum in the Zod schema.

### Step 6 — Test

Set `TTS_PROVIDER=myprovider` and `MYPROVIDER_API_KEY=...` in your `.env`, start the
gateway, connect an ESP32 (or the test client), and verify audio plays back correctly.

---

## Audio Format Quick Reference

```
TTS Provider output:
  Format:     16-bit signed little-endian PCM
  Rate:       24000 Hz
  Channels:   1 (mono)
  Chunk size: variable (any size — session handles framing)

voice-session.ts buffers PCM and sends in fixed frames:
  Frame:      2880 bytes = 1440 samples = 60ms @ 24kHz
  Encoding:   opusscript (24kHz, 1ch, VOIP application)
  Transport:  Binary WebSocket frame → ESP32
```
