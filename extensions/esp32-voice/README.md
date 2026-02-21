# 🎤 ESP32 Voice Channel — OpenClaw Extension

An OpenClaw channel plugin that turns an ESP32 microcontroller into a voice-controlled AI assistant. The ESP32 captures audio, converts speech to text (STT), sends it to OpenClaw via HTTP, and receives a text response to convert back to speech (TTS).

## Architecture

```
┌──────────────────────────────┐
│         ESP32 Device         │
│                              │
│  🎤 Microphone               │
│       ↓                      │
│  [Speech-to-Text (STT)]     │
│       ↓                      │
│  HTTP POST (JSON text)  ────────────┐
│                              │      │
│  [Text-to-Speech (TTS)]     │      │
│       ↑                      │      │
│  HTTP Response (JSON text) ◄────────┤
│       ↓                      │      │
│  🔊 Speaker                  │      │
└──────────────────────────────┘      │
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   OpenClaw Gateway     │
                          │                       │
                          │  POST /__openclaw__/  │
                          │   esp32-voice/message │
                          │       ↓               │
                          │  [Auth + Route]       │
                          │       ↓               │
                          │  [AI Agent (Pi)]      │
                          │       ↓               │
                          │  [Response Text]      │
                          └───────────────────────┘
```

## Setup

### 1. Enable the Extension

```bash
# From the openclaw repo root
openclaw plugins install @openclaw/esp32-voice
```

Or if developing locally, it's already available as a workspace extension.

### 2. Configure in `~/.openclaw/openclaw.json`

#### Single Device

```json5
{
  channels: {
    esp32voice: {
      enabled: true,
      deviceToken: "your-secret-device-token-here", // openssl rand -hex 16
      deviceId: "esp32-office",
      maxResponseLength: 500,
      voiceOptimized: true,
      language: "en",
    },
  },
}
```

#### Multiple Devices

```json5
{
  channels: {
    esp32voice: {
      enabled: true,
      voiceOptimized: true,
      accounts: {
        office: {
          name: "Office Assistant",
          deviceToken: "token-for-office-device",
          deviceId: "esp32-office",
          language: "en",
        },
        bedroom: {
          name: "Bedroom Assistant",
          deviceToken: "token-for-bedroom-device",
          deviceId: "esp32-bedroom",
          language: "en",
          maxResponseLength: 300,
        },
      },
    },
  },
}
```

### 3. Environment Variable (Alternative)

```bash
export ESP32_VOICE_DEVICE_TOKEN="your-secret-device-token"
```

## HTTP API

### Endpoint

```
POST http://<gateway-host>:18789/__openclaw__/esp32-voice/message
```

### Request

```http
POST /__openclaw__/esp32-voice/message HTTP/1.1
Host: 192.168.1.100:18789
Content-Type: application/json
Authorization: Bearer your-secret-device-token-here

{
  "text": "What's the weather like today?",
  "deviceId": "esp32-office",
  "language": "en",
  "sessionId": "optional-session-id-for-continuity"
}
```

### Response (Success)

```json
{
  "ok": true,
  "text": "I'd need to check the weather service for your location. Could you tell me your city?",
  "sessionId": "session-abc123"
}
```

### Response (Error)

```json
{
  "ok": false,
  "error": "Authentication failed"
}
```

## ESP32 Firmware Example (Arduino)

Below is a complete Arduino sketch for an ESP32 with an I2S microphone and speaker. This example uses:

- **ESP32-S3** or any ESP32 with PSRAM
- **INMP441** (I2S MEMS microphone) for audio input
- **MAX98357A** (I2S amplifier) for audio output
- **WiFi** for HTTP communication

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ── Configuration ─────────────────────────────────────────────
const char* WIFI_SSID     = "YourWiFiSSID";
const char* WIFI_PASSWORD = "YourWiFiPassword";

// OpenClaw Gateway address (run `openclaw gateway` on your machine)
const char* OPENCLAW_HOST  = "http://192.168.1.100:18789";
const char* OPENCLAW_PATH  = "/__openclaw__/esp32-voice/message";
const char* DEVICE_TOKEN   = "your-secret-device-token-here";
const char* DEVICE_ID      = "esp32-office";

// ── Button pin for push-to-talk ───────────────────────────────
const int BUTTON_PIN = 0; // GPIO0 (BOOT button on most ESP32 boards)

// ── State ─────────────────────────────────────────────────────
String sessionId = "";

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  // Connect to WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConnected! IP: " + WiFi.localIP().toString());

  // TODO: Initialize I2S microphone (INMP441)
  // TODO: Initialize I2S speaker (MAX98357A)
  // TODO: Initialize STT engine (e.g., ESP-SR or cloud API)
  // TODO: Initialize TTS engine (e.g., edge-tts or cloud API)
}

void loop() {
  // Push-to-talk: record while button is pressed
  if (digitalRead(BUTTON_PIN) == LOW) {
    Serial.println("Recording...");

    // ── Step 1: Capture audio from microphone ─────────────────
    // TODO: Record audio via I2S into a buffer
    // uint8_t* audioBuffer = recordAudio(&audioLength);

    // ── Step 2: Speech-to-Text ────────────────────────────────
    // Convert recorded audio to text using STT
    // Options:
    //   a) On-device: ESP-SR (Espressif's speech recognition)
    //   b) Cloud: Google STT, Whisper API, Deepgram
    String transcribedText = performSTT(/* audioBuffer, audioLength */);

    if (transcribedText.length() > 0) {
      Serial.println("You said: " + transcribedText);

      // ── Step 3: Send to OpenClaw ────────────────────────────
      String responseText = sendToOpenClaw(transcribedText);

      if (responseText.length() > 0) {
        Serial.println("OpenClaw says: " + responseText);

        // ── Step 4: Text-to-Speech ────────────────────────────
        // Convert response text to audio and play via speaker
        // Options:
        //   a) On-device: ESP-TTS (Espressif's text-to-speech)
        //   b) Cloud: ElevenLabs, Google TTS, edge-tts
        performTTS(responseText);
      }
    }

    // Debounce
    delay(500);
  }

  delay(50);
}

// ── Send transcribed text to OpenClaw Gateway ─────────────────
String sendToOpenClaw(String text) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected!");
    return "";
  }

  HTTPClient http;
  String url = String(OPENCLAW_HOST) + String(OPENCLAW_PATH);

  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + String(DEVICE_TOKEN));
  http.setTimeout(30000); // 30s timeout for AI processing

  // Build JSON request
  JsonDocument doc;
  doc["text"] = text;
  doc["deviceId"] = DEVICE_ID;
  doc["language"] = "en";
  if (sessionId.length() > 0) {
    doc["sessionId"] = sessionId;
  }

  String requestBody;
  serializeJson(doc, requestBody);

  Serial.println("Sending to OpenClaw: " + requestBody);

  int httpCode = http.POST(requestBody);

  if (httpCode == 200) {
    String response = http.getString();
    Serial.println("Response: " + response);

    // Parse JSON response
    JsonDocument resDoc;
    DeserializationError error = deserializeJson(resDoc, response);
    if (!error && resDoc["ok"] == true) {
      // Save session ID for conversation continuity
      if (resDoc.containsKey("sessionId")) {
        sessionId = resDoc["sessionId"].as<String>();
      }
      return resDoc["text"].as<String>();
    } else {
      String errMsg = resDoc["error"].as<String>();
      Serial.println("Error from OpenClaw: " + errMsg);
    }
  } else {
    Serial.println("HTTP Error: " + String(httpCode));
  }

  http.end();
  return "";
}

// ── Placeholder: Speech-to-Text ───────────────────────────────
String performSTT(/* audio params */) {
  // TODO: Implement your STT solution:
  //
  // Option A — Cloud STT (recommended for accuracy):
  //   - Send audio buffer to Google Cloud Speech-to-Text API
  //   - Or Whisper API (OpenAI)
  //   - Or Deepgram API
  //
  // Option B — On-device STT (offline, lower accuracy):
  //   - Use ESP-SR (Espressif Speech Recognition)
  //   - Limited to predefined command sets
  //
  // Return the transcribed text string.
  return "Hello, what can you help me with?"; // Placeholder
}

// ── Placeholder: Text-to-Speech ───────────────────────────────
void performTTS(String text) {
  // TODO: Implement your TTS solution:
  //
  // Option A — Cloud TTS (recommended for natural voice):
  //   - Send text to Google Cloud TTS
  //   - Or ElevenLabs API
  //   - Or edge-tts via a local proxy
  //   - Receive audio data (MP3/WAV)
  //   - Play via I2S speaker (MAX98357A)
  //
  // Option B — On-device TTS (offline, robotic voice):
  //   - Use ESP-TTS from Espressif
  //   - Flite TTS
  //
  Serial.println("[TTS] Would play: " + text);
}
```

## Configuration Reference

| Key                  | Type    | Default     | Description                                         |
| -------------------- | ------- | ----------- | --------------------------------------------------- |
| `enabled`            | boolean | `true`      | Enable/disable the device                           |
| `deviceToken`        | string  | —           | Bearer token for authentication                     |
| `deviceId`           | string  | account ID  | Unique identifier for the device                    |
| `dmPolicy`           | string  | `"pairing"` | DM security policy                                  |
| `allowFrom`          | array   | `[]`        | Allowlist of device IDs                             |
| `maxResponseLength`  | number  | `500`       | Max chars in response (optimized for TTS)           |
| `voiceOptimized`     | boolean | `true`      | Prompt AI for concise spoken responses              |
| `language`           | string  | `"en"`      | Language code (ISO 639-1)                           |

## Environment Variables

| Variable                       | Description                |
| ------------------------------ | -------------------------- |
| `ESP32_VOICE_DEVICE_TOKEN`     | Default device auth token  |

## Security Notes

- Always use a strong, unique `deviceToken` per device
- The Gateway should only be accessible on your local network (loopback or LAN)
- Never expose the Gateway to the public internet without proper auth
- Use Tailscale or SSH tunnels for remote access

## Troubleshooting

```bash
# Check channel status
openclaw channels status --probe

# Test with curl
curl -X POST http://localhost:18789/__openclaw__/esp32-voice/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-device-token" \
  -d '{"text": "Hello, what time is it?", "deviceId": "test"}'

# Enable verbose logging
openclaw gateway --verbose
```
