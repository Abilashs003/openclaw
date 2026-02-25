# TTS Providers — Test Suite Design

**Date:** 2026-02-25
**Branch:** multiple_tts_Provider

## Goal

Write thorough unit tests + standard live integration tests for all 5 new TTS providers:
Rime, Inworld, Cartesia, Smallest.ai, Groq PlayAI.

---

## Test Files

| File | Type | Runs |
|------|------|------|
| `extensions/esp32-voice/src/tts/tts-providers.test.ts` | Unit (mocked) | Every `vitest` run |
| `extensions/esp32-voice/src/tts/tts-providers.live.test.ts` | Live (real API) | Excluded from normal CI; run manually with keys |

**Why two files, not one per provider:**
- Unit tests use `describe.each` — the same thorough suite runs against each provider with a mocked WebSocket/HTTPS
- Live tests skip individual providers when their env key is absent — one file, selective execution

---

## Test Runner

**Vitest** — already used project-wide (`vitest.config.ts`).
- Unit tests: `extensions/**/*.test.ts` → picked up automatically
- Live tests: `**/*.live.test.ts` → excluded from normal runs (already in vitest exclude list)

---

## Unit Test Coverage (thorough, all mocked)

### WebSocket Providers: Rime, Inworld, Cartesia, Smallest.ai

For each provider:

1. **Registry** — `ttsRegistry.get(id)` returns the provider factory; meta has correct id, name, envVar, `streaming: true`
2. **Constructor defaults** — voiceId and model fall back to defaults when not in config
3. **connect()** — WebSocket opened with correct URL and auth header (`Authorization: Bearer` or `xi-api-key`)
4. **synthesize()** — sends correct JSON payload
5. **flush()** — sends EOS signal (provider-specific), resolves after done signal received
6. **flush() timeout** — resolves after 30s if server never signals done
7. **close()** — closes the WebSocket
8. **Binary PCM message** → `onAudio` callback fires with the buffer
9. **JSON done signal** → `onDone` fires and `donePromise` resolves
10. **Audio chain ordering** — second chunk waits for first to finish (serialised chain)
11. **Unexpected socket close** → `fireDone` called even without explicit done message
12. **WebSocket error** → `connect()` rejects
13. **synthesize() when not connected** → throws

### Groq PlayAI (HTTP batch)

1. **Registry** — correct meta, `streaming: false`
2. **connect()** — no-op (just logs)
3. **synthesize()** — buffers text (no HTTP call yet)
4. **flush() with text** → POST to `api.groq.com`, strips 44-byte WAV header, delivers chunks via `onAudio`
5. **flush() with empty text** → calls `onDone` immediately, no HTTP call
6. **Chunk delivery** — 4096-byte chunks, last chunk may be smaller
7. **HTTP non-200 response** → rejects with error message

---

## Live Test Coverage (standard, real API calls)

For each provider — **skipped** when env key is not set:

| Provider | Skip condition |
|----------|---------------|
| Rime | `!process.env.RIME_API_KEY` |
| Inworld | `!process.env.INWORLD_API_KEY` |
| Cartesia | `!process.env.CARTESIA_API_KEY` |
| Smallest.ai | `!process.env.SMALLEST_AI_API_KEY` |
| Groq PlayAI | `!process.env.GROQ_API_KEY` |

For each provider with a key:

1. `connect()` resolves without error
2. `synthesize("Hello, this is a test.")` + `flush()` completes within 30s
3. `onAudio` called at least once with a non-empty Buffer
4. `onDone` called exactly once
5. Total audio received > 1,000 bytes

---

## Mocking Strategy

### WebSocket mock (`vi.mock('ws')`)

A fake WS class with:
- `on(event, handler)` — stores handlers
- `send(data)` — stores sent messages for assertions
- `close()` — triggers close handler
- Helper: `emit(event, data)` — calls stored handler directly in tests

### HTTPS mock (`vi.mock('https')`)

A fake `https.request` that returns a mock IncomingMessage with:
- `statusCode: 200`
- Emits `data` with a 44-byte WAV header + synthetic PCM bytes
- Emits `end`

---

## File Locations

```
extensions/esp32-voice/src/tts/
  tts-providers.test.ts       ← unit tests (new)
  tts-providers.live.test.ts  ← live integration tests (new)
```
