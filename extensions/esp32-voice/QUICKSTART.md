# ESP32 Voice Plugin — Quick Start Guide

## Prerequisites

| Requirement | How to Get |
|-------------|-----------|
| **Node.js 22+** | `nvm install 22 && nvm use 22` |
| **pnpm** | `npm install -g pnpm` |
| **Deepgram API Key** | Free at https://console.deepgram.com → "Create API Key" |
| **ElevenLabs API Key** | Free at https://elevenlabs.io → Profile → "API Keys" |
| **Anthropic API Key** | https://console.anthropic.com → "API Keys" (for OpenClaw's AI brain) |

---

## Step-by-Step: Full Setup

### 1. Build OpenClaw

```bash
cd /Users/abilashs/development/openclaw/openclaw

# Use Node 22
nvm use 22

# Install all dependencies
pnpm install

# Build the gateway (skip the UI — not needed for voice)
pnpm exec tsdown --no-clean

# Generate plugin SDK types
pnpm build:plugin-sdk:dts
```

### 2. Set Your API Keys

Create/edit `~/.openclaw/.env`:

```bash
cat >> ~/.openclaw/.env << 'EOF'
# OpenClaw AI Agent (pick one)
ANTHROPIC_API_KEY=sk-ant-xxxxx

# ESP32 Voice — STT
DEEPGRAM_API_KEY=dg_xxxxx

# ESP32 Voice — TTS
ELEVENLABS_API_KEY=xi_xxxxx
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
EOF
```

### 3. Configure OpenClaw

Edit `~/.openclaw/openclaw.json`:

```json
{
  "agent": {
    "model": "anthropic/claude-sonnet-4-20250514"
  },
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "your-gateway-token-here"
    }
  },
  "plugins": {
    "entries": {
      "esp32-voice": {
        "enabled": true
      }
    }
  }
}
```

### 4. Start the Gateway

```bash
nvm use 22
node dist/entry.js gateway --allow-unconfigured --verbose
```

You should see:

```
🦞 OpenClaw 2026.2.20

[stt-registry] Registered STT provider: Deepgram (deepgram)
[tts-registry] Registered TTS provider: ElevenLabs (elevenlabs)
[esp32voice] Voice WebSocket server created
[esp32voice] Plugin registered successfully
[esp32voice] Voice WebSocket: ws://<gateway>/__openclaw__/esp32-voice/stream
[esp32voice] Health check: http://<gateway>/__openclaw__/esp32-voice/health

[gateway] listening on ws://127.0.0.1:18789
```

### 5. Verify Everything is Working

```bash
# Check health
curl http://127.0.0.1:18789/__openclaw__/esp32-voice/health
# → {"ok":true,"service":"esp32-voice","sttConfigured":true,"ttsConfigured":true}

# Generate OTP for device pairing
curl http://127.0.0.1:18789/__openclaw__/esp32-voice/otp
# → {"code":"502913","expiresInSeconds":300}

# List paired devices
curl http://127.0.0.1:18789/__openclaw__/esp32-voice/devices
# → {"devices":[]}
```

### 6. Connect Your ESP32 Device

Your ESP32 firmware connects via WebSocket:

```
ws://YOUR_MAC_IP:18789/__openclaw__/esp32-voice/stream
```

**Hello message from ESP32:**

```json
{
  "type": "hello",
  "deviceId": "esp32-office",
  "transport": "websocket",
  "version": 1,
  "audio_params": {
    "format": "opus",
    "sample_rate": 16000,
    "channels": 1
  },
  "otp": "502913",
  "openclaw": {
    "url": "ws://YOUR_MAC_IP:18789",
    "token": "your-gateway-token-here"
  }
}
```

---

## End-to-End Voice Flow

```
ESP32 🎤                         OpenClaw Gateway (your Mac)
─────────                       ──────────────────────────────
1. WS connect to                 ws://192.168.1.x:18789/
   /__openclaw__/                   __openclaw__/esp32-voice/stream
   esp32-voice/stream

2. Send hello JSON ──────────────→ Verify OTP → Pair device
                                   Connect to AI agent

3. Send { listen: "start" } ─────→ STT session starts (Deepgram)

4. Send Opus audio frames ───────→ Deepgram transcribes in real time
   (16kHz mono, binary WS)        ← { transcript, partial: true }

5. Send { listen: "stop" } ──────→ Deepgram finalizes transcript
   or { speech_end }               "Hey, what's the weather?"

                                   → Send to Claude AI agent
                                   ← AI responds: "It's sunny, 25°C"

                                   → ElevenLabs synthesizes speech
6. ←──── PCM audio frames ──────── TTS audio streamed back
   (24kHz mono, paced at            sentence by sentence
    real-time rate)

7. Play on speaker 🔊
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `sttConfigured: false` | Set `DEEPGRAM_API_KEY` in `~/.openclaw/.env` |
| `ttsConfigured: false` | Set `ELEVENLABS_API_KEY` in `~/.openclaw/.env` |
| Plugin not loading | Add `"esp32-voice": {"enabled": true}` to `plugins.entries` in config |
| Port already in use | `kill $(lsof -ti:18789)` then restart |
| Node version error | `nvm use 22` before running |
| UI build fails | Ignore — UI is optional for voice |
