# Multi-Provider STT — Design Document

**Date:** 2026-02-26
**Status:** Approved
**Branch:** multiple_tts_Provider

## Problem

The ESP32 voice extension only supports Deepgram for speech-to-text. Users need provider flexibility for cost, latency, language coverage, and redundancy — the same reasons we added multi-provider TTS.

## Chosen Approach: Per-Provider Internal Decode (Approach A)

Each provider is a self-contained unit. The `SttProvider` interface stays unchanged — `sendAudio(Buffer)` receives raw Opus frames. Providers that don't support Opus natively decode internally using their own `opusscript` decoder instance.

**Why this approach:**
- Zero interface changes — Deepgram/Gladia keep their native Opus advantage
- Each provider is fully self-contained and independently testable
- Decoder memory cost is trivial (~50KB per instance)
- Mirrors the existing TTS pattern exactly

**Alternatives rejected:**
- *Shared decoder helper* — the 3-line import pattern is too simple to warrant extraction
- *Decode in voice-session* — breaks `sendAudio()` contract, forces Deepgram/Gladia off native Opus

## Providers

| Provider | ID | Opus Native | Latency | Price/hr | Env Var |
|---|---|---|---|---|---|
| Deepgram (existing) | `deepgram` | Yes | ~150ms | $0.46 | `DEEPGRAM_API_KEY` |
| Soniox v4 | `soniox` | No (PCM) | <200ms | $0.12 | `SONIOX_API_KEY` |
| ElevenLabs Scribe v2 | `elevenlabs-stt` | No (PCM) | ~150ms | $0.28-0.48 | `ELEVENLABS_STT_API_KEY` |
| AssemblyAI Universal | `assemblyai` | No (PCM) | 307ms P50 | $0.15 | `ASSEMBLYAI_API_KEY` |
| Gladia Solaria | `gladia` | Yes | 270ms | $0.75 | `GLADIA_API_KEY` |

## Architecture

```
ESP32 (Opus 16kHz mono, 20ms frames = 320 samples)
  │
  ▼ sendAudio(opusFrame: Buffer)
  │
  ├── Deepgram:   ws.send(opusFrame)              ← Opus native
  ├── Gladia:     ws.send(opusFrame)              ← Opus native
  ├── Soniox:     decode → ws.send(pcm16)         ← internal opusscript
  ├── ElevenLabs: decode → base64 → ws.send(json) ← internal opusscript
  └── AssemblyAI: decode → ws.send(pcm16)         ← internal opusscript
```

No shared state between providers. Each non-Opus provider creates its own decoder:
```typescript
const OpusScript = await import("opusscript");
const Ctor = OpusScript.default ?? OpusScript;
this.decoder = new Ctor(16000, 1, Ctor.Application.VOIP);
// sendAudio(): this.decoder.decode(opusFrame, 320) → PCM16 Buffer
```

Frame duration is fixed at 20ms (320 samples at 16kHz) — the device always sends 20ms frames.

## Provider Protocol Details

### Soniox (`soniox.ts`)
- **WS URL:** `wss://stt-rt.soniox.com/transcribe-websocket`
- **Auth:** API key in initial JSON config message
- **Connect:** Send JSON `{api_key, model: "stt-rt-v4", audio_format: "pcm_s16le", sample_rate: 16000, num_audio_channels: 1}`
- **Audio:** Decode Opus→PCM16, send as binary frames
- **Messages:** JSON tokens with transcript text, partial vs final tracking
- **Finalize:** Send empty binary frame, wait for final (6s timeout)

### ElevenLabs STT (`elevenlabs-stt.ts`)
- **WS URL:** `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime`
- **Auth:** `xi-api-key` header on WebSocket
- **Audio:** Decode Opus→PCM16 → base64 → JSON `{type: "input_audio_chunk", audio_chunk: base64}`
- **Messages:** `partial_transcript` (interim), `committed_transcript` (final)
- **Finalize:** Wait for committed_transcript or timeout (6s)

### AssemblyAI (`assemblyai.ts`)
- **Connect:** Two-step — POST to `/v3/streaming/token` (Bearer key) → get temp token → WS `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&token=<TOKEN>`
- **Audio:** Decode Opus→PCM16, send as binary frames
- **Messages:** `receiveTurn` with words array, build transcript
- **Finalize:** Send `{type: "sendSessionTermination"}`, wait for final (6s timeout)

### Gladia (`gladia.ts`)
- **Connect:** Two-step — POST to `https://api.gladia.io/v2/live` (x-gladia-key header, body: `{encoding: "opus", sample_rate: 16000, channels: 1}`) → get WS URL → connect
- **Audio:** Raw Opus frames as binary (no conversion)
- **Messages:** `partial_transcript` and `final_transcript` events
- **Finalize:** Signal end, wait for final (6s timeout)

### Common Patterns
- Audio buffering before WS is `OPEN` (flush on open, same as Deepgram)
- `finalizeResolve` promise pattern with 6s timeout, fallback to last partial
- `onTranscript` callback fires for both interim and final results
- `onSpeechEnd` fires on end-of-speech detection (if supported by provider)

## Integration Changes

### config-schema.ts
Change `sttProvider` from `z.string()` to validated enum:
```typescript
sttProvider: z.enum(["deepgram", "soniox", "elevenlabs-stt", "assemblyai", "gladia"])
  .optional().default("deepgram"),
```

### voice-endpoint.ts
Add 4 import lines for auto-registration + update health check to report STT provider status.

### voice-session.ts
Update auto-hello path (line 306) to resolve STT provider + key from env vars dynamically (currently hardcoded to `"deepgram"` + `DEEPGRAM_API_KEY`). Rest of `startListening()` already uses `sttRegistry.create()`.

## Testing Strategy

### Unit Tests (`stt-providers.test.ts`)
- Mirror TTS test pattern: `vi.hoisted()` + `vi.mock("ws")` + `vi.mock("opusscript")`
- Mock `fetch` globally for AssemblyAI (temp token) and Gladia (session init)
- ~15 tests per provider: connect, sendAudio, handleMessage, finalize, close, onSpeechEnd, errors
- Target: ~60 tests across 4 providers

### Live Tests (`stt-providers.live.test.ts`)
- `describe.skipIf(!process.env.XXX)` pattern
- Send pre-recorded Opus frames → verify non-empty transcript
- Run via `npx vitest run --config vitest.live.config.ts`

## Files To Create/Modify

**New files:**
- `extensions/esp32-voice/src/stt/soniox.ts`
- `extensions/esp32-voice/src/stt/elevenlabs-stt.ts`
- `extensions/esp32-voice/src/stt/assemblyai.ts`
- `extensions/esp32-voice/src/stt/gladia.ts`
- `extensions/esp32-voice/src/stt/stt-providers.test.ts`
- `extensions/esp32-voice/src/stt/stt-providers.live.test.ts`

**Modified files:**
- `extensions/esp32-voice/src/config-schema.ts` — sttProvider enum
- `extensions/esp32-voice/src/voice/voice-endpoint.ts` — imports + health check
- `extensions/esp32-voice/src/voice/voice-session.ts` — auto-hello STT resolution

## Success Criteria

- All unit tests pass (~60 new + 77 existing TTS tests)
- Live tests pass for providers with available API keys
- `npx tsc --noEmit` passes
- Config schema validates all 5 provider IDs
- No regressions to Deepgram or TTS functionality
