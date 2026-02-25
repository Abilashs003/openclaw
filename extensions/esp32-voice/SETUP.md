# OpenClaw + ESP32 Voice Setup Guide

Here is your complete, step-by-step guide to running OpenClaw with your specific Deepgram, ElevenLabs, and Gemini keys, plus your ESP32 Voice plugin.

## 1. Configure Your API Keys

We need to add your API keys to OpenClaw's environment file.

Run this command in your terminal to save your keys safely:

```bash
cat >> ~/.openclaw/.env << 'EOF'

# OpenClaw AI Agent -- Google Gemini
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE

# ESP32 Voice -- STT (Deepgram)
DEEPGRAM_API_KEY=<YOUR_DEEPGRAM_API_KEY>
DEEPGRAM_MODEL=nova-2

# ESP32 Voice -- TTS (ElevenLabs)
ELEVENLABS_API_KEY=YOUR_ELEVENLABS_API_KEY_HERE
ELEVENLABS_VOICE_ID=uMM5TEnpKKgD758knVJO
ELEVENLABS_MODEL_ID=eleven_turbo_v2
EOF
```

## 2. Configure OpenClaw Settings

Next, tell OpenClaw to use Gemini as the main AI model, and enable your `esp32-voice` plugin. 

Open `~/.openclaw/openclaw.json` and make sure it looks like this:

```json
{
  "agent": {
    "model": "google/gemini-2.0-flash"
  },
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "YOUR_GATEWAY_TOKEN_HERE"
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

## 3. Configure Agent Authentication Profile

OpenClaw requires an auth profile for its agents. Run this command to create the necessary auth profile for Gemini:

```bash
mkdir -p ~/.openclaw/agents/main/agent

cat > ~/.openclaw/agents/main/agent/auth-profiles.json << 'EOF'
{
  "google-gemini-cli": {
    "providerId": "google",
    "type": "google-gemini-cli",
    "id": "google-gemini-cli",
    "enabled": true,
    "apiKey": "YOUR_GEMINI_API_KEY_HERE"
  }
}
EOF
```

## 4. Build and Run the Gateway

Navigate to your OpenClaw repository, build the project with Node 22, and start the gateway:

```bash
# Navigate to your repo
cd /Users/abilashs/development/openclaw/openclaw

# Make sure you are using Node 22
nvm use 22

# Build the project (skip UI)
pnpm exec tsdown --no-clean

# Start the gateway
node dist/entry.js gateway --allow-unconfigured --verbose
```

When it successfully starts, you will see output like:
```text
[stt-registry] Registered STT provider: Deepgram (deepgram)
[tts-registry] Registered TTS provider: ElevenLabs (elevenlabs)
[esp32voice] Voice WebSocket server created
[esp32voice] Plugin registered successfully
[gateway] listening on ws://127.0.0.1:18789
```

## 5. Verify the Gateway Endpoints

Open a **new terminal tab** and run these commands to verify the plugin is active:

**Check Health:**
```bash
curl http://127.0.0.1:18789/__openclaw__/esp32-voice/health
```
*(Should return `{"ok":true,"service":"esp32-voice","sttConfigured":true,"ttsConfigured":true}`)*

**Generate OTP for your ESP32:**
```bash
curl http://127.0.0.1:18789/__openclaw__/esp32-voice/otp
```
*(Will return a 6-digit code like `{"code":"123456","expiresInSeconds":300}`)*

## 6. Connect your ESP32

Program your ESP32 firmware to connect to your Mac's IP address (find using `ifconfig` or network settings) over WebSocket:

**WebSocket URL:**
`ws://<YOUR_MAC_IP_ADDRESS>:18789/__openclaw__/esp32-voice/stream`

**First Message (Hello Message) Example:**
Send this JSON immediately upon connecting. Use the OTP code you generated in Step 5:

```json
{
  "type": "hello",
  "deviceId": "esp32-speaker-1",
  "transport": "websocket",
  "version": 1,
  "audio_params": {
    "format": "opus",
    "sample_rate": 16000,
    "channels": 1
  },
  "otp": "<YOUR_OTP_CODE>",
  "openclaw": {
    "url": "ws://<YOUR_MAC_IP_ADDRESS>:18789",
    "token": "YOUR_GATEWAY_TOKEN_HERE"
  }
}
```

Once paired, your ESP32 will transition to the `IDLE` state and is ready to stream voice!
