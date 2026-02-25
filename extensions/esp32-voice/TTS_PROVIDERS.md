# TTS Providers — ESP32 Voice Plugin

This document covers the TTS provider system architecture, all implemented providers,
and how to add new providers to the ESP32 voice pipeline.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Audio Pipeline Requirements](#2-audio-pipeline-requirements)
3. [Provider Interface](#3-provider-interface)
4. [Current Providers](#4-current-providers)
5. [Provider Details](#5-provider-details)
6. [How to Add a New Provider](#6-how-to-add-a-new-provider)

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
| [src/tts/elevenlabs.ts](src/tts/elevenlabs.ts) | ElevenLabs implementation (reference) |
| [src/tts/rime.ts](src/tts/rime.ts) | Rime implementation |
| [src/tts/inworld.ts](src/tts/inworld.ts) | Inworld implementation |
| [src/tts/cartesia.ts](src/tts/cartesia.ts) | Cartesia implementation |
| [src/tts/smallest-ai.ts](src/tts/smallest-ai.ts) | Smallest.ai implementation |
| [src/tts/groq-playai.ts](src/tts/groq-playai.ts) | Groq PlayAI implementation |
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

## 4. Current Providers

All 6 providers are implemented and available. Select via `TTS_PROVIDER` in `~/.openclaw/.env`.

| Provider | ID | Env Var | Transport | Latency | Status |
|----------|----|---------|-----------|---------|--------|
| ElevenLabs | `elevenlabs` | `ELEVENLABS_API_KEY` | WebSocket | ~300ms | ✅ Implemented |
| Rime | `rime` | `RIME_API_KEY` | WebSocket | Low | ✅ Implemented |
| Inworld | `inworld` | `INWORLD_API_KEY` | WebSocket | <120ms | ✅ Implemented |
| Cartesia | `cartesia` | `CARTESIA_API_KEY` | WebSocket | ~80ms | ✅ Implemented |
| Smallest.ai | `smallest-ai` | `SMALLEST_AI_API_KEY` | WebSocket | Low | ✅ Implemented |
| Groq PlayAI | `groq-playai` | `GROQ_API_KEY` | HTTP batch | Batch | ✅ Implemented |

**Quick setup:**

```bash
# In ~/.openclaw/.env — choose any provider:
TTS_PROVIDER=cartesia
CARTESIA_API_KEY=sk_car_...

# Or interactively during onboarding:
openclaw channels add --channel esp32voice
```

---

## 5. Provider Details

### 5.1 ElevenLabs

**File:** [src/tts/elevenlabs.ts](src/tts/elevenlabs.ts) ✅ Implemented

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

### 5.2 Rime

**File:** [src/tts/rime.ts](src/tts/rime.ts) ✅ Implemented

| Property | Value |
|----------|-------|
| Provider ID | `rime` |
| Env var | `RIME_API_KEY` |
| Website | https://rime.ai |
| Transport | WebSocket (`wss://users.rime.ai/v1/rime-tts`) |
| Output | Binary PCM native (no base64 decode step) |
| Sample rate | 24000 Hz |
| Streaming | Yes — `reduce_latency` mode enabled |
| Default voice | `arcas` |
| Default model | `mist` |

```bash
RIME_API_KEY=...
RIME_VOICE_ID=arcas   # optional
```

---

### 5.3 Inworld

**File:** [src/tts/inworld.ts](src/tts/inworld.ts) ✅ Implemented

| Property | Value |
|----------|-------|
| Provider ID | `inworld` |
| Env var | `INWORLD_API_KEY` |
| Website | https://inworld.ai/tts-api |
| Transport | WebSocket (`wss://studio.inworld.ai/v1/tts`) |
| Output | LINEAR16 PCM (16-bit LE, 24kHz) |
| Streaming | Yes — persistent connection |
| Latency | **<120ms P90** (best of all providers) |
| Default voice | `inworld.neutral` |
| Default model | `tts-1.5-mini` |

```bash
INWORLD_API_KEY=...
INWORLD_VOICE_ID=inworld.neutral   # optional
```

---

### 5.4 Cartesia

**File:** [src/tts/cartesia.ts](src/tts/cartesia.ts) ✅ Implemented

| Property | Value |
|----------|-------|
| Provider ID | `cartesia` |
| Env var | `CARTESIA_API_KEY` |
| Website | https://cartesia.ai |
| Transport | WebSocket (`wss://api.cartesia.ai/tts/websocket`) |
| Output | PCM (raw bytes, 24kHz) |
| Streaming | Yes |
| Latency | **~80ms** — production-grade |
| Default voice | `a0e99841-438c-4a64-b679-ae501e7d6091` (Barbershop Man) |
| Default model | `sonic-english` |

```bash
CARTESIA_API_KEY=sk_car_...
CARTESIA_VOICE_ID=a0e99841-438c-4a64-b679-ae501e7d6091   # optional
```

---

### 5.5 Smallest.ai

**File:** [src/tts/smallest-ai.ts](src/tts/smallest-ai.ts) ✅ Implemented

| Property | Value |
|----------|-------|
| Provider ID | `smallest-ai` |
| Env var | `SMALLEST_AI_API_KEY` |
| Website | https://smallest.ai |
| Docs | https://waves-docs.smallest.ai |
| Transport | WebSocket (`wss://waves-api.smallest.ai/api/v1/lightning/get_speech`) |
| Output | base64-encoded raw PCM chunks (24kHz, no WAV header) |
| Streaming | Yes — chunk + `{ status: "complete" }` pattern |
| Default voice | `emily` |
| Default model | `lightning` |

```bash
SMALLEST_AI_API_KEY=...
SMALLEST_AI_VOICE_ID=emily   # optional
```

**Note:** Audio is confirmed raw PCM (not MP3). Uses `add_wav_header: false` and
`sample_rate: 24000` in request payload. 20-second server-side inactivity timeout applies.

---

### 5.6 Groq PlayAI

**File:** [src/tts/groq-playai.ts](src/tts/groq-playai.ts) ✅ Implemented

| Property | Value |
|----------|-------|
| Provider ID | `groq-playai` |
| Env var | `GROQ_API_KEY` |
| Website | https://console.groq.com |
| Transport | HTTP POST (`https://api.groq.com/openai/v1/audio/speech`) |
| Output | WAV binary → strip 44-byte header → raw PCM (24kHz) |
| Streaming | **No** (batch) |
| Default voice | `Fritz-PlayAI` |
| Default model | `playai-tts` |

```bash
GROQ_API_KEY=gsk_...
GROQ_VOICE_ID=Fritz-PlayAI   # optional
```

**Note:** Batch-only — full synthesis must complete before ESP32 playback begins.
Cheapest option; reuses `GROQ_API_KEY` if already set for STT.

---

## 6. How to Add a New Provider

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

### Step 6 — Add to onboarding

Add an entry to `TTS_PROVIDERS_INFO` in `src/onboarding.ts` with `value`, `label`,
`hint`, `envVar`, `docsUrl`, `defaultVoice`, and `voiceHint`.

### Step 7 — Test

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
