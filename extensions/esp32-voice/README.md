# 🎤 ESP32 Voice — OpenClaw Extension

Turn a Cheeko ESP32 board into a voice AI assistant powered by OpenClaw.
Push to talk → speak → get a spoken response.

---

## Quick Start

### Step 1 — Install the plugin

```bash
openclaw plugins install @cheeko-ai/esp32-voice
```

### Step 2 — Run the setup wizard

```bash
openclaw channels add
# Select "ESP32 Voice (plugin)" from the menu
```

The wizard guides you through:

| Step | What happens |
|------|-------------|
| **1. Connect to Cheeko** | Browser opens automatically → log in → Settings → Connect OpenClaw → paste the token |
| **2. STT setup** | Enter your Deepgram API key |
| **3. TTS setup** | Enter your ElevenLabs API key + voice ID |
| **4. Add device** | Browser opens automatically → add your ESP32 device |

All keys are saved to `~/.openclaw/.env` automatically — you only do this once.

> **Note:** Use Node.js 22. Run `nvm use 22` before any openclaw commands.

---

### Step 3 — Start the Gateway

```bash
openclaw gateway
```

The plugin starts the voice WebSocket server on port **8765** and auto-registers your machine's URL with the Cheeko dashboard.

---

### Step 4 — Start the OTA server

The OTA server tells your ESP32 where to connect on boot:

```bash
GATEWAY_TOKEN=<your-gateway-token> node $(openclaw plugins path @cheeko-ai/esp32-voice)/ota-server.js
```

It prints your URLs:

```
🦞 ESP32 OTA Mock Server
   Auto-detected MAC IP : 192.168.1.10
   OTA Server           : http://192.168.1.10:8080/cheeko/ota/
   Voice WebSocket      : ws://192.168.1.10:8765/
```

> **Gateway token** — found in `~/.openclaw/openclaw.json` under `gateway.auth.token`.

---

### Step 5 — Flash your ESP32

In your Cheeko firmware settings, set the OTA URL to what the server printed:

```
http://192.168.1.10:8080/cheeko/ota/
```

Reboot the device. It fetches its config, connects to the voice server, and is ready.
**Hold the button → speak → release → hear the response.**

---

## How It Works

```
ESP32 (Cheeko firmware)
  │  Opus audio frames  →  WebSocket port 8765
  ▼
[esp32-voice plugin]
  │  STT: Deepgram       →  transcript text
  │  LLM: OpenClaw Gateway (port 18789)  →  response text
  │  TTS: ElevenLabs     →  Opus audio frames
  ▼
ESP32 speaker
```

The plugin runs its own WebSocket server on port **8765** — completely separate from the OpenClaw Gateway port (18789). No changes to OpenClaw core are needed.

---

## Cheeko Dashboard Pairing

1. Log in to the Cheeko dashboard → **Settings → Connect OpenClaw**
2. The dashboard generates a short pairing token (e.g. `XK9-2M4`)
3. Paste it into the setup wizard (or set `CHEEKO_PAIR=XK9-2M4` in `~/.openclaw/.env`)
4. On next gateway start, the plugin POSTs your voice URL to the dashboard automatically
5. Your ESP32 devices now know where to connect

---

## Configuration

Keys can be set in `~/.openclaw/.env` (recommended) or in `~/.openclaw/openclaw.json` under `channels.esp32voice`.

```bash
# ~/.openclaw/.env
DEEPGRAM_API_KEY=your-deepgram-key
ELEVENLABS_API_KEY=your-elevenlabs-key
CHEEKO_PAIR=XK9-2M4
```

### All options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the channel |
| `sttApiKey` | string | — | Deepgram API key |
| `sttModel` | string | `"nova-2"` | Deepgram model |
| `ttsApiKey` | string | — | ElevenLabs API key |
| `ttsVoiceId` | string | Rachel | ElevenLabs voice ID |
| `ttsModel` | string | `"eleven_turbo_v2_5"` | ElevenLabs model |
| `language` | string | `"en"` | Language code (ISO 639-1) |
| `maxResponseLength` | number | `500` | Max response chars (keep short for voice) |
| `voiceOptimized` | boolean | `true` | Tells the AI to respond concisely without markdown |

### Environment variables

| Variable | Description |
|----------|-------------|
| `DEEPGRAM_API_KEY` | Deepgram STT API key |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS API key |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID (optional) |
| `ELEVENLABS_MODEL_ID` | ElevenLabs model (optional) |
| `CHEEKO_PAIR` | Pairing token from Cheeko dashboard |
| `GATEWAY_TOKEN` | Required for OTA server |
| `MAC_IP` | Override auto-detected LAN IP |
| `ESP32_VOICE_PORT` | Voice WebSocket port (default: `8765`) |

---

## Gateway HTTP Endpoints

The plugin registers these endpoints on the OpenClaw Gateway port (18789):

| Endpoint | Description |
|----------|-------------|
| `GET /__openclaw__/esp32-voice/health` | Health check — shows configured STT/TTS status |
| `GET /__openclaw__/esp32-voice/otp` | Generate a one-time device pairing code |
| `GET /__openclaw__/esp32-voice/devices` | List currently paired devices |

---

## Troubleshooting

**ESP32 shows "connecting" but never "listening"**
- Check the OTA server is running and the ESP32 fetched its config (watch OTA server logs)
- Make sure firewall allows port 8765 inbound
- Confirm `GATEWAY_TOKEN` matches `gateway.auth.token` in `~/.openclaw/openclaw.json`

**Dashboard pairing fails**
- Paste only the short token (e.g. `XK9-2M4`), not the full command string
- Token expires after 10 minutes — generate a new one from the dashboard if needed

**No audio from ESP32 speaker**
- Check ElevenLabs key is valid and has quota remaining
- Plugin outputs 24kHz mono Opus at 60ms frames — confirm firmware matches

**STT timeout / empty transcript**
- Validate Deepgram key: `curl https://api.deepgram.com/v1/auth -H "Authorization: Token YOUR_KEY"`
- Check the ESP32 is actually sending audio (hold button while speaking)

---

## Supported Hardware

Tested with:
- **Jiuchuan S3** (Cheeko ESP32-S3 board) — recommended
- Any ESP32 board running [Cheeko ESP32 firmware](https://github.com/78/xiaozhi-esp32)

---

## Plugin Management

```bash
# Update to latest version
openclaw plugins update @cheeko-ai/esp32-voice

# Remove the plugin
openclaw plugins uninstall @cheeko-ai/esp32-voice

# List all installed plugins
openclaw plugins list

# Enable / disable without removing
openclaw plugins enable @cheeko-ai/esp32-voice
openclaw plugins disable @cheeko-ai/esp32-voice
```

---

## License

MIT — Published under [@cheeko-ai](https://www.npmjs.com/org/cheeko-ai) on npm.
