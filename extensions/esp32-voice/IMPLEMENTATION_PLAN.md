# ESP32 Voice Channel — Implementation Plan

## Overview

Port the `cheekoclaw_bridge` (Python FastAPI + Deepgram + ElevenLabs) into an OpenClaw
TypeScript plugin extension with a **pluggable STT/TTS provider system** modeled after
OpenClaw's own multi-provider architecture.

## Architecture

```
ESP32 Device                                 OpenClaw Gateway
─────────────                               ─────────────────
🎤 Microphone                                Plugin: esp32-voice
    ↓                                        ┌─────────────────────────┐
[Opus 16kHz mono]                            │   WebSocket Endpoint    │
    ↓                                        │ /voice/stream           │
    ├── WS connect ──────────────────────────▶│                         │
    │    hello { openclaw, deviceId }         │   Voice Session         │
    │                                        │   (state machine)       │
    │    binary Opus frames ─────────────────▶│       ↓                 │
    │                                        │   STT Provider          │
    │    { type: "speech_end" } ─────────────▶│   ┌─────────────────┐   │
    │                                        │   │ • Deepgram       │   │
    │                                        │   │ • Google STT     │   │
    │                                        │   │ • Whisper        │   │
    │                                        │   │ • Azure STT      │   │
    │                                        │   └────────┬────────┘   │
    │                                        │            ↓            │
    │                                        │   OpenClaw Agent        │
    │                                        │   (chat.send via WS)    │
    │                                        │            ↓            │
    │                                        │   TTS Provider          │
    │                                        │   ┌─────────────────┐   │
    │    ◀──── Opus 24kHz frames ────────────│   │ • ElevenLabs    │   │
    │    ◀──── { type: "tts", state } ───────│   │ • Google TTS    │   │
    │                                        │   │ • Azure TTS     │   │
    │                                        │   │ • edge-tts      │   │
    ↓                                        │   └─────────────────┘   │
🔊 Speaker                                  └─────────────────────────┘
```

## Onboarding Flow

```
$ openclaw channels setup esp32voice

1. Select STT provider:
   > Deepgram (recommended)
     Google Cloud STT
     OpenAI Whisper
     Azure Speech

2. Enter Deepgram API Key: dg_xxxxx

3. Select TTS provider:
   > ElevenLabs (recommended)
     Google Cloud TTS
     Azure Speech
     edge-tts (free, local)

4. Enter ElevenLabs API Key: xi_xxxxx
5. Select voice: Rachel (default)

6. Device OTP: 847291
   → Enter this code on your ESP32 device to pair it.
   → Waiting for device activation...

✓ Device "esp32-office" paired successfully!
✓ Channel esp32voice is ready.
```

## File Structure

```
extensions/esp32-voice/
├── package.json
├── openclaw.plugin.json
├── index.ts                    # Plugin entry point
├── README.md
├── IMPLEMENTATION_PLAN.md      # This file
├── src/
│   ├── runtime.ts              # Plugin runtime singleton
│   ├── types.ts                # Core types + config types
│   ├── config-schema.ts        # Zod validation schema
│   ├── accounts.ts             # Account resolution
│   ├── channel.ts              # ChannelPlugin implementation
│   ├── monitor.ts              # Gateway lifecycle
│   │
│   ├── voice/                  # Voice pipeline
│   │   ├── voice-endpoint.ts   # WebSocket endpoint handler
│   │   ├── voice-session.ts    # Per-client session state machine
│   │   ├── audio-codec.ts      # Opus encode/decode (via @discordjs/opus)
│   │   └── openclaw-bridge.ts  # WS client to Gateway (chat.send)
│   │
│   ├── stt/                    # Speech-to-Text provider system
│   │   ├── stt-provider.ts     # STT provider interface
│   │   ├── stt-registry.ts     # STT provider registry
│   │   ├── deepgram.ts         # Deepgram streaming STT
│   │   ├── google-stt.ts       # Google Cloud STT (future)
│   │   ├── whisper.ts          # OpenAI Whisper (future)
│   │   └── azure-stt.ts        # Azure Speech (future)
│   │
│   ├── tts/                    # Text-to-Speech provider system
│   │   ├── tts-provider.ts     # TTS provider interface
│   │   ├── tts-registry.ts     # TTS provider registry
│   │   ├── elevenlabs.ts       # ElevenLabs streaming TTS
│   │   ├── google-tts.ts       # Google Cloud TTS (future)
│   │   ├── edge-tts.ts         # edge-tts free TTS (future)
│   │   └── azure-tts.ts        # Azure Speech (future)
│   │
│   └── device/                 # Device management
│       ├── device-otp.ts       # OTP generation + verification
│       └── device-registry.ts  # Connected device tracking
│
└── test/
    ├── stt-provider.test.ts
    ├── tts-provider.test.ts
    ├── voice-session.test.ts
    └── device-otp.test.ts
```

## STT/TTS Provider Interface Design

### STT Provider Interface
```typescript
interface SttProvider {
  id: string;
  name: string;
  streaming: boolean;           // true = WS streaming, false = batch
  connect(): Promise<void>;
  sendAudio(opusFrame: Buffer): Promise<void>;
  finalize(): Promise<string>;  // returns final transcript
  close(): Promise<void>;
  onTranscript?: (text: string, isFinal: boolean) => void;
}
```

### TTS Provider Interface
```typescript
interface TtsProvider {
  id: string;
  name: string;
  streaming: boolean;
  connect(): Promise<void>;
  synthesize(text: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  onAudio?: (pcmChunk: Buffer) => void;
  onDone?: () => void;
}
```

### Provider Registry
```typescript
// STT providers register themselves
sttRegistry.register("deepgram", DeepgramSttProvider);
sttRegistry.register("google", GoogleSttProvider);
sttRegistry.register("whisper", WhisperSttProvider);

// TTS providers register themselves
ttsRegistry.register("elevenlabs", ElevenLabsTtsProvider);
ttsRegistry.register("google", GoogleTtsProvider);
ttsRegistry.register("edge-tts", EdgeTtsProvider);
```

## Key Differences from cheekoclaw_bridge

| Aspect          | cheekoclaw_bridge (Python)     | esp32-voice plugin (TypeScript)    |
|-----------------|-------------------------------|------------------------------------|
| Language        | Python (FastAPI + uvicorn)    | TypeScript (ESM, Node.js)          |
| HTTP framework  | FastAPI                       | Express 5 (via Gateway)            |
| STT             | Deepgram only (hardcoded)     | Pluggable provider system          |
| TTS             | ElevenLabs only (hardcoded)   | Pluggable provider system          |
| Opus            | opuslib (Python)              | @discordjs/opus (native Node)      |
| Config          | .env only                     | openclaw.json + env + onboarding   |
| Auth            | X-Omi-Token header            | Device OTP pairing + WS hello      |
| Deployment      | Separate process + ngrok      | Built into OpenClaw Gateway        |

## Priority Order

1. **Phase 1** ✅ — Provider interfaces, types, config schema
2. **Phase 2** — Deepgram STT + ElevenLabs TTS (port from Python)
3. **Phase 3** — Voice session state machine + Opus codec
4. **Phase 4** — WebSocket endpoint + OpenClaw bridge client
5. **Phase 5** — Device OTP pairing + onboarding wizard
6. **Phase 6** — Additional providers (Google, Azure, Whisper, edge-tts)
