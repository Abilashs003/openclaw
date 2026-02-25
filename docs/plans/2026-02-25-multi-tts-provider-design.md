# Multi-Provider TTS Expansion — Design Document

**Date:** 2026-02-25
**Branch:** feat/esp32-plugin-vad
**Status:** Approved — ready for implementation

---

## Problem

The ESP32 voice plugin is locked to ElevenLabs for TTS. Users have no choice of provider,
and ElevenLabs has ~300ms latency, a subscription cost, and a single voice catalogue.

## Goal

Add 5 new TTS providers — Rime, Inworld, Cartesia, Smallest.ai, Groq PlayAI — as
fully equivalent first-class options. Any provider can be selected in onboarding and
the ESP32 experience is identical.

---

## Decisions Made

| Question | Decision | Reason |
|----------|----------|--------|
| Provider parity | Fully equivalent | Any provider selected = same UX |
| Onboarding | Full picker (all 6 shown) | Most user-friendly |
| Structure | Approach A — flat, one file per provider | Follows ElevenLabs pattern exactly |
| Smallest.ai audio | Raw PCM (confirmed via docs) | No decode step needed |
| Groq PlayAI audio | WAV → strip 44-byte header | Batch HTTP, same as pattern used elsewhere |

---

## Architecture

### File Structure

```
extensions/esp32-voice/
  index.ts                      ← add 5 import lines
  src/
    tts/
      tts-provider.ts           ← interface (no changes)
      tts-registry.ts           ← registry (no changes)
      elevenlabs.ts             ← reference (no changes)
      rime.ts                   ← NEW
      inworld.ts                ← NEW
      cartesia.ts               ← NEW
      smallest-ai.ts            ← NEW
      groq-playai.ts            ← NEW
    config-schema.ts            ← update ttsProvider enum
    onboarding.ts               ← refactor stepTtsSetup()
  .env.example                  ← add new env var section
  TTS_PROVIDERS.md              ← mark all 5 as implemented
  docs/plans/
    this file
```

### Provider Template (all WebSocket providers follow this)

```typescript
class <Provider>TtsProvider implements TtsProvider {
  readonly id = "<id>"
  readonly name = "<Name>"
  readonly streaming = true          // false for Groq PlayAI
  readonly outputSampleRate = 24000  // always 24000

  onAudio: TtsAudioCallback | null = null
  onDone: TtsDoneCallback | null = null

  // serializes onAudio so pacing sleeps in voice-session are respected
  private audioChain: Promise<void> = Promise.resolve()
  private doneResolve: (() => void) | null = null
  private donePromise: Promise<void> | null = null
  private isFinalReceived = false

  async connect(): Promise<void>    // open WebSocket, set up handlers
  async synthesize(text): Promise<void>  // send text chunk
  async flush(): Promise<void>      // send EOS, await donePromise (30s timeout)
  async close(): Promise<void>      // ws.close()

  private handleMessage(data)       // parse chunk → audioChain → fireDone on final
  private fireDone()                // drain audioChain → onDone() → resolve donePromise
}
```

### Provider Specifications

| Provider | ID | Env Var | Transport | WS Endpoint | Audio |
|----------|----|---------|-----------|-------------|-------|
| Rime | `rime` | `RIME_API_KEY` | WebSocket | `wss://users.rime.ai/v1/rime-tts` | Binary PCM |
| Inworld | `inworld` | `INWORLD_API_KEY` | WebSocket | `wss://studio.inworld.ai/v1/tts` | Binary LINEAR16 PCM |
| Cartesia | `cartesia` | `CARTESIA_API_KEY` | WebSocket | `wss://api.cartesia.ai/tts/websocket` | Binary PCM |
| Smallest.ai | `smallest-ai` | `SMALLEST_AI_API_KEY` | WebSocket | `wss://waves-api.smallest.ai/api/v1/lightning/get_speech` | Raw PCM bytes |
| Groq PlayAI | `groq-playai` | `GROQ_API_KEY` | HTTPS POST | `https://api.groq.com/openai/v1/audio/speech` | WAV → strip header |

### Config Schema Change

```typescript
// config-schema.ts
ttsProvider: z.enum([
  "elevenlabs",
  "rime",
  "inworld",
  "cartesia",
  "smallest-ai",
  "groq-playai"
]).optional().default("elevenlabs")
```

### Onboarding Wizard — stepTtsSetup() Refactor

```
Step 3 — TTS Setup
  ┌─ select() ─────────────────────────────────────────────────────────┐
  │  Which TTS provider?                                               │
  │  ❯ ElevenLabs   — streaming, high quality, ~300ms                  │
  │    Rime         — streaming, native PCM, low latency               │
  │    Inworld      — streaming, <120ms, best latency                  │
  │    Cartesia     — streaming, ~80ms, production-grade               │
  │    Smallest.ai  — streaming, raw PCM, 24kHz                        │
  │    Groq PlayAI  — batch, cheapest, reuses GROQ_API_KEY             │
  └────────────────────────────────────────────────────────────────────┘
  ┌─ text() ───────────────────────────────────────────────────────────┐
  │  Enter your <ProviderName> API key                                 │
  │  [link to that provider's API key page]                            │
  └────────────────────────────────────────────────────────────────────┘
  ┌─ text() (optional) ────────────────────────────────────────────────┐
  │  Voice ID? (press Enter for default: <default-voice-id>)           │
  └────────────────────────────────────────────────────────────────────┘
  Saves:
    TTS_PROVIDER=<chosen>
    <PROVIDER>_API_KEY=<key>
    <PROVIDER>_VOICE_ID=<voice>  (if provided)
```

**Status check update:**
- `getStatus()` reads `TTS_PROVIDER` env var → checks the correct API key
- Summary line: `TTS : Cartesia (default voice)` instead of hard-coded ElevenLabs

### .env.example Addition

```bash
# TTS Provider selection (default: elevenlabs)
# Options: elevenlabs | rime | inworld | cartesia | smallest-ai | groq-playai
TTS_PROVIDER=elevenlabs

# --- Alternative TTS Providers (set TTS_PROVIDER above to activate) ---

# Rime — https://rime.ai
RIME_API_KEY=<your-rime-api-key>

# Inworld — https://inworld.ai/tts-api
INWORLD_API_KEY=<your-inworld-api-key>

# Cartesia — https://docs.cartesia.ai
CARTESIA_API_KEY=<your-cartesia-api-key>

# Smallest.ai — https://waves-docs.smallest.ai
SMALLEST_AI_API_KEY=<your-smallest-ai-api-key>

# Groq PlayAI — https://console.groq.com (same key as Groq STT if applicable)
GROQ_API_KEY=<your-groq-api-key>
```

---

## What Does NOT Change

- `tts-provider.ts` — interface is already correct
- `tts-registry.ts` — registry handles any number of providers
- `voice-session.ts` — consumes `onAudio` / `onDone` regardless of provider
- `elevenlabs.ts` — reference implementation, untouched

---

## Out of Scope

- Audio resampling (all providers must output 24kHz)
- MP3 decode (not needed — Smallest.ai confirmed raw PCM)
- Dynamic provider discovery
- Provider benchmarking / latency measurement tooling

---

## Implementation Order

1. `rime.ts`
2. `inworld.ts`
3. `cartesia.ts`
4. `smallest-ai.ts`
5. `groq-playai.ts`
6. `index.ts` — add 5 import lines
7. `config-schema.ts` — enum update
8. `onboarding.ts` — stepTtsSetup() refactor
9. `.env.example` — new section
10. `TTS_PROVIDERS.md` — mark as implemented
