# Multi-Provider STT — Product Requirements Document

## Overview

Add 4 new Speech-to-Text providers to the ESP32 voice extension (`extensions/esp32-voice/src/stt/`), mirroring the existing multi-provider TTS architecture. Currently only Deepgram is implemented. We will add **Soniox**, **ElevenLabs**, **AssemblyAI**, and **Gladia** — chosen for low latency, WebSocket streaming, and cost-effectiveness.

**Problem:** Users are locked into Deepgram for STT. Different use cases need different tradeoffs (cost vs latency vs language support). Providers go down. Users need options.

## Target Audience

- ESP32 voice assistant developers using the OpenClaw plugin
- Users who need low-latency, real-time speech transcription
- Users who want provider flexibility (cost, accuracy, language coverage)

## Core Features

1. **4 new STT provider implementations** (Soniox, ElevenLabs, AssemblyAI, Gladia) — all WebSocket streaming
2. **Per-provider Opus→PCM conversion** for providers that don't accept Opus natively (Soniox, ElevenLabs, AssemblyAI use existing `opusscript` decoder)
3. **Full test suite** — unit tests with mocked WebSockets + live integration tests (mirroring TTS test pattern)
4. **Config/onboarding updates** — config-schema.ts enum, voice-endpoint.ts imports, health check updates
5. **Runtime wiring** — voice-session.ts updated to use `sttRegistry.create()` with the configured provider

## Tech Stack

- **Language:** TypeScript (ESM)
- **Runtime:** Node.js (runs on OpenClaw Gateway)
- **WebSocket:** `ws` package (already a dependency)
- **Opus decode:** `opusscript` package (already a dependency — used for VAD)
- **Testing:** Vitest (unit + live integration)
- **Schema:** Zod (config validation)

## Architecture

Mirrors the existing TTS multi-provider pattern exactly:

```
SttProvider (interface)  ←  stt-provider.ts
     ↑
SttRegistry (singleton)  ←  stt-registry.ts
     ↑
┌────┴─────────────────────────────────────────┐
│  deepgram.ts  (existing, Opus native)        │
│  soniox.ts    (new, Opus→PCM via opusscript) │
│  elevenlabs.ts(new, Opus→PCM via opusscript) │
│  assemblyai.ts(new, Opus→PCM via opusscript) │
│  gladia.ts    (new, Opus native)             │
└──────────────────────────────────────────────┘
```

Each provider file:
1. Implements `SttProvider` interface
2. Exports metadata (`SttProviderMeta`) and factory function
3. Auto-registers with `sttRegistry` at module import time
4. Is imported in `voice-endpoint.ts` to trigger registration

### Audio Flow

```
ESP32 (Opus 16kHz mono)
  ↓ sendAudio(opusFrame)
  ├─ Deepgram/Gladia: send raw Opus directly (native support)
  └─ Soniox/ElevenLabs/AssemblyAI: decode Opus→PCM16 internally, send PCM
```

## Provider Specifications

### 1. Soniox v4 (NEW)

| Field | Value |
|---|---|
| ID | `soniox` |
| WS URL | `wss://stt-rt.soniox.com/transcribe-websocket` |
| Auth | API key in initial JSON config message |
| Input | PCM s16le (Opus→PCM conversion needed) |
| Sample Rate | 16000 Hz |
| Protocol | 1) Send JSON config `{api_key, model, audio_format, sample_rate}` 2) Send binary PCM frames 3) Receive JSON tokens 4) Send empty frame to close |
| Default Model | `stt-rt-v4` |
| Latency | <200ms |
| Price | $0.12/hr |
| Env Var | `SONIOX_API_KEY` |

### 2. ElevenLabs Scribe v2 (NEW)

| Field | Value |
|---|---|
| ID | `elevenlabs-stt` |
| WS URL | `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime` |
| Auth | `xi-api-key` header |
| Input | PCM 16-bit (Opus→PCM conversion needed) |
| Sample Rate | 16000 Hz |
| Protocol | Send `input_audio_chunk` JSON messages with base64 audio. Receive `partial_transcript` and `committed_transcript` events. VAD auto-commit mode |
| Default Model | `scribe_v2_realtime` |
| Latency | ~150ms |
| Price | $0.28–0.48/hr |
| Env Var | `ELEVENLABS_STT_API_KEY` (separate from TTS key, or fallback to `ELEVENLABS_API_KEY`) |

### 3. AssemblyAI Universal Streaming (NEW)

| Field | Value |
|---|---|
| ID | `assemblyai` |
| WS URL | `wss://streaming.assemblyai.com/v3/ws` |
| Auth | Temporary token via REST, then `token` query param on WS |
| Input | PCM s16le (Opus→PCM conversion needed) |
| Sample Rate | 16000 Hz |
| Protocol | 1) Get temp token via `POST /v3/streaming/token` 2) Connect WS with `?sample_rate=16000&encoding=pcm_s16le&token=<TOKEN>` 3) Send binary PCM chunks 4) Receive `receiveTurn` JSON 5) Send `sendSessionTermination` |
| Default Model | `universal` |
| Latency | 307ms P50 |
| Price | $0.15/hr |
| Env Var | `ASSEMBLYAI_API_KEY` |

### 4. Gladia Solaria (NEW)

| Field | Value |
|---|---|
| ID | `gladia` |
| WS URL | Two-step: POST init → get WS session URL |
| Auth | `x-gladia-key` header on init REST call |
| Input | Opus native (no conversion needed) |
| Sample Rate | 16000 Hz |
| Protocol | 1) POST to init endpoint with config, get session WS URL 2) Connect WS 3) Send binary Opus frames 4) Receive partial/final transcript JSON |
| Default Model | `solaria` |
| Latency | 270ms |
| Price | $0.75/hr |
| Env Var | `GLADIA_API_KEY` |

## Data Model

No database changes. Provider selection stored in existing config schema:

```typescript
// config-schema.ts — sttProvider enum expanded:
sttProvider: z.enum([
  "deepgram",
  "soniox",
  "elevenlabs-stt",
  "assemblyai",
  "gladia",
]).optional().default("deepgram"),
```

## Opus→PCM Conversion Strategy

For Soniox, ElevenLabs, and AssemblyAI (no native Opus):

```typescript
// Inside each provider's constructor or connect():
import OpusScript from "opusscript";

// Decode Opus→PCM16 at 16kHz mono (same as VAD decoder in voice-session.ts)
const decoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);

// In sendAudio():
const pcmSamples = decoder.decode(opusFrame, samplesPerFrame);
// samplesPerFrame = (16000 * frameMs) / 1000
// frameMs is detected from Opus frame or defaults to 60
```

Each provider manages its own decoder instance. No shared state.

## Security Considerations

- API keys stored in environment variables (never in code or config files)
- WebSocket connections use `wss://` (TLS)
- AssemblyAI temp tokens are short-lived (10-minute expiry)
- No credentials logged (mask in debug output)

## Constraints & Assumptions

- ESP32 always sends Opus at 16kHz mono
- `opusscript` is already a dependency — no new deps needed for Opus decode
- All providers use WebSocket (no gRPC/SDK dependencies)
- Each provider instance is single-use (one per utterance, same as Deepgram)
- Tests follow the existing `vi.hoisted()` + `vi.mock()` pattern for ESM-safe mocking

## Success Criteria

- All unit tests pass (target: ~60+ new tests across 4 providers)
- Live integration tests pass for providers where API keys are available
- Existing Deepgram tests remain green
- Config schema accepts all 5 provider IDs
- `voice-endpoint.ts` imports all 5 providers
- Health check reports STT provider status

---

## Task List

```json
[
  {
    "category": "feature",
    "description": "Implement Soniox STT provider (soniox.ts)",
    "steps": [
      "Create extensions/esp32-voice/src/stt/soniox.ts implementing SttProvider interface",
      "WebSocket URL: wss://stt-rt.soniox.com/transcribe-websocket",
      "Auth: send JSON config with api_key field on connection open",
      "On connect: send JSON {api_key, model: 'stt-rt-v4', audio_format: 'pcm_s16le', sample_rate: 16000, num_audio_channels: 1}",
      "Implement Opus→PCM decode in sendAudio() using opusscript (16kHz, mono, VOIP app)",
      "Auto-detect Opus frame duration (default 60ms = 960 samples at 16kHz)",
      "Send decoded PCM16 as binary frames over WebSocket",
      "Handle incoming JSON messages: extract transcript tokens, track partial vs final",
      "Implement finalize(): send empty binary frame to signal end, wait for final transcript with timeout",
      "Export metadata (id: 'soniox', envVar: 'SONIOX_API_KEY', defaultModel: 'stt-rt-v4')",
      "Auto-register with sttRegistry at module level"
    ],
    "passes": false
  },
  {
    "category": "feature",
    "description": "Implement ElevenLabs STT provider (elevenlabs-stt.ts)",
    "steps": [
      "Create extensions/esp32-voice/src/stt/elevenlabs-stt.ts implementing SttProvider interface",
      "WebSocket URL: wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime",
      "Auth: xi-api-key header on WebSocket connection",
      "Implement Opus→PCM decode in sendAudio() using opusscript (16kHz, mono)",
      "Send audio as JSON messages: {type: 'input_audio_chunk', audio_chunk: base64(pcm)} ",
      "Handle partial_transcript and committed_transcript response events",
      "Support VAD-based auto-commit mode for speech-end detection",
      "Implement finalize(): send flush/end signal, wait for committed_transcript with timeout",
      "Export metadata (id: 'elevenlabs-stt', envVar: 'ELEVENLABS_STT_API_KEY', defaultModel: 'scribe_v2_realtime')",
      "Fallback: also check ELEVENLABS_API_KEY env var if ELEVENLABS_STT_API_KEY not set",
      "Auto-register with sttRegistry at module level"
    ],
    "passes": false
  },
  {
    "category": "feature",
    "description": "Implement AssemblyAI STT provider (assemblyai.ts)",
    "steps": [
      "Create extensions/esp32-voice/src/stt/assemblyai.ts implementing SttProvider interface",
      "In connect(): first POST to https://api.assemblyai.com/v3/streaming/token to get temp token",
      "Auth for token request: Authorization: Bearer <API_KEY> header",
      "Connect WebSocket: wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&token=<TEMP_TOKEN>",
      "Implement Opus→PCM decode in sendAudio() using opusscript (16kHz, mono)",
      "Send decoded PCM16 as binary frames over WebSocket",
      "Handle receiveTurn JSON messages: extract words array, build transcript, track is_final equivalent",
      "Support immutable transcripts (no retraction) — can trigger LLM early",
      "Implement finalize(): send sendSessionTermination message, wait for final transcript with timeout",
      "Handle sendForceEndpoint for manual endpoint triggering",
      "Export metadata (id: 'assemblyai', envVar: 'ASSEMBLYAI_API_KEY', defaultModel: 'universal')",
      "Auto-register with sttRegistry at module level"
    ],
    "passes": false
  },
  {
    "category": "feature",
    "description": "Implement Gladia STT provider (gladia.ts)",
    "steps": [
      "Create extensions/esp32-voice/src/stt/gladia.ts implementing SttProvider interface",
      "In connect(): POST to https://api.gladia.io/v2/live to init session (x-gladia-key header)",
      "POST body: {encoding: 'opus', sample_rate: 16000, channels: 1, model: 'solaria'}",
      "Extract WebSocket URL from init response",
      "Connect to the returned session WebSocket URL",
      "sendAudio(): send raw Opus frames directly as binary (Gladia supports Opus natively)",
      "Handle incoming JSON: partial_transcript and final_transcript events",
      "Implement finalize(): signal end of audio, wait for final transcript with timeout",
      "Export metadata (id: 'gladia', envVar: 'GLADIA_API_KEY', defaultModel: 'solaria')",
      "Auto-register with sttRegistry at module level"
    ],
    "passes": false
  },
  {
    "category": "integration",
    "description": "Update config-schema.ts with all 5 STT provider IDs",
    "steps": [
      "Change sttProvider from z.string() to z.enum(['deepgram', 'soniox', 'elevenlabs-stt', 'assemblyai', 'gladia'])",
      "Keep default as 'deepgram'",
      "Verify schema validates correctly for all 5 values"
    ],
    "passes": false
  },
  {
    "category": "integration",
    "description": "Update voice-endpoint.ts to import and register all STT providers",
    "steps": [
      "Add import statements for all 4 new STT provider modules (triggers auto-registration)",
      "Update health check JSON to report sttProvider name and configured status for all providers",
      "Verify all 5 providers appear in sttRegistry.list() after imports"
    ],
    "passes": false
  },
  {
    "category": "integration",
    "description": "Update voice-session.ts to use sttRegistry for provider creation",
    "steps": [
      "In the STT initialization section, use sttRegistry.create(config.sttProvider, {apiKey, model}) instead of hardcoded Deepgram",
      "Resolve API key from the correct env var based on selected provider (use sttRegistry.getMeta(id).envVar)",
      "Handle Opus frame duration detection for providers that need it (pass via config.options)",
      "Ensure sendAudio() still sends raw Opus frames — each provider handles conversion internally",
      "Verify Silero VAD still receives decoded PCM independently (no change to VAD path)"
    ],
    "passes": false
  },
  {
    "category": "integration",
    "description": "Update onboarding wizard with multi-provider STT selection",
    "steps": [
      "Add STT_PROVIDERS_INFO array to onboarding.ts (mirroring TTS_PROVIDERS_INFO) with all 5 providers",
      "Rewrite stepSttSetup() to use prompter.select() for provider choice (mirroring stepTtsSetup())",
      "Prompt for API key using the selected provider's envVar and docsUrl",
      "Prompt for optional model override",
      "Save STT_PROVIDER + provider API key + optional STT_MODEL to ~/.openclaw/.env",
      "Update getStatus() to show dynamic STT provider name instead of hardcoded 'Deepgram'",
      "Update the final summary note to show chosen STT provider",
      "Update intro note: 'Set up Speech-to-Text (STT provider)' instead of '(Deepgram)'"
    ],
    "passes": false
  },
  {
    "category": "testing",
    "description": "Write unit tests for all 4 new STT providers (stt-providers.test.ts)",
    "steps": [
      "Create extensions/esp32-voice/src/stt/stt-providers.test.ts mirroring TTS test pattern",
      "Use vi.hoisted() + vi.mock('ws') for ESM-safe WebSocket mocking",
      "For each provider test: connect(), sendAudio(), handleMessage(), finalize(), close()",
      "Test Opus→PCM conversion path for Soniox, ElevenLabs, AssemblyAI (mock opusscript)",
      "Test Gladia two-step connection (mock fetch for session init + mock WS)",
      "Test AssemblyAI token acquisition (mock fetch for temp token + mock WS)",
      "Test error handling: connection failures, timeouts, malformed messages",
      "Test audio buffering before WS is open",
      "Test finalize timeout fallback to last partial transcript",
      "Test onTranscript and onSpeechEnd callbacks fire correctly",
      "Target: ~60+ test cases across all 4 providers"
    ],
    "passes": false
  },
  {
    "category": "testing",
    "description": "Write live integration tests for STT providers (stt-providers.live.test.ts)",
    "steps": [
      "Create extensions/esp32-voice/src/stt/stt-providers.live.test.ts",
      "Use describe.skipIf(!process.env.XXX) pattern for conditional execution",
      "For each provider: connect, send real Opus audio frames, verify transcript returned",
      "Generate test Opus frames: encode a known PCM audio sample (e.g., 'hello world' TTS output) to Opus",
      "Or use a pre-recorded Opus test fixture file",
      "Verify live tests run with: npx vitest run --config vitest.live.config.ts",
      "Add env var names: SONIOX_API_KEY, ELEVENLABS_STT_API_KEY, ASSEMBLYAI_API_KEY, GLADIA_API_KEY"
    ],
    "passes": false
  },
  {
    "category": "testing",
    "description": "Run full test suite and verify all tests pass",
    "steps": [
      "Run unit tests: npx vitest run (should include both TTS and STT test suites)",
      "Verify all existing TTS tests (77) still pass (no regressions)",
      "Verify all new STT unit tests pass",
      "Run live tests if API keys available: npx vitest run --config vitest.live.config.ts",
      "Run TypeScript type check: npx tsc --noEmit",
      "Fix any failures before marking complete"
    ],
    "passes": false
  }
]
```

---

## Agent Instructions

1. Read `activity.md` first to understand current state
2. Find next task with `"passes": false`
3. Complete all steps for that task
4. Verify by running `npx vitest run` (for test tasks) or `npx tsc --noEmit` (for implementation tasks)
5. Update task to `"passes": true`
6. Log completion in `activity.md`
7. Repeat until all tasks pass

**Important:** Only modify the `passes` field. Do not remove or rewrite tasks.

**Key reference files:**
- Interface: `extensions/esp32-voice/src/stt/stt-provider.ts`
- Registry: `extensions/esp32-voice/src/stt/stt-registry.ts`
- Example provider: `extensions/esp32-voice/src/stt/deepgram.ts` (follow this pattern exactly)
- Example TTS tests: `extensions/esp32-voice/src/tts/tts-providers.test.ts` (mirror for STT)
- Config: `extensions/esp32-voice/src/config-schema.ts`
- Endpoint: `extensions/esp32-voice/src/voice/voice-endpoint.ts`
- Session: `extensions/esp32-voice/src/voice/voice-session.ts`

---

## Completion Criteria
All tasks marked with `"passes": true`
