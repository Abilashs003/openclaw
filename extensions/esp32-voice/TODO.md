# ESP32-Voice Plugin — Remaining Work TODO

> This document tracks everything that needs to be done before the plugin is production-ready
> and publishable to npm. Work through each section top-to-bottom. Each item is self-contained
> with enough context so a fresh contributor can pick it up without prior knowledge of the session.

---

## 🔴 SECTION 1 — Security (Do This Before Anything Else)

### 1.1 — Delete or sanitize `SETUP.md`

**Why:** `SETUP.md` contains real, live API keys committed to the repository. Anyone who clones
the repo has these keys.

**Steps:**
1. Open `extensions/esp32-voice/SETUP.md`
2. Replace every real credential with a placeholder:
   - `GEMINI_API_KEY=AIzaSy...` → `GEMINI_API_KEY=<YOUR_GEMINI_API_KEY>`
   - `ELEVENLABS_API_KEY=sk_...` → `ELEVENLABS_API_KEY=<YOUR_ELEVENLABS_API_KEY>`
   - Any token or secret string → `<YOUR_TOKEN_HERE>`
3. Add a note at the top: `> **Note:** Replace all `<PLACEHOLDER>` values with your own credentials.`
4. Immediately rotate the exposed keys:
   - Go to [ElevenLabs API keys](https://elevenlabs.io/app/settings/api-keys) → delete old key → create new
   - Go to [Google AI Studio](https://aistudio.google.com/apikey) → delete old key → create new
5. Commit: `"security: remove exposed credentials from SETUP.md"`

---

### 1.2 — Remove hardcoded fallback token from `ota-server.js`

**Why:** The gateway token in `ota-server.js` (line ~59) has a hardcoded default:
```js
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "YOUR_GATEWAY_TOKEN_HERE";
```
This token is now public. If the env var is not set, the server should exit with a clear error,
not fall back to a known value.

**Steps:**
1. Open `extensions/esp32-voice/ota-server.js`
2. Find the `GATEWAY_TOKEN` line
3. Replace with:
```js
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
if (!GATEWAY_TOKEN) {
  console.error("[ota-server] ERROR: GATEWAY_TOKEN env var is required. Set it in your .env file.");
  process.exit(1);
}
```
4. Update the README/QUICKSTART to mention this env var is required
5. Commit: `"security: require GATEWAY_TOKEN env var in ota-server, remove hardcoded fallback"`

---

## 🔴 SECTION 2 — Package.json Cleanup (Required for npm publish)

### 2.1 — Remove unused `@discordjs/opus` dependency

**Why:** During development, `@discordjs/opus` was replaced with `opusscript` because macOS
Gatekeeper rejects its prebuilt native binary. The `@discordjs/opus` package is still listed in
`package.json` but is never imported anywhere in the source code.

**Steps:**
1. Verify it's unused:
   ```bash
   grep -r "@discordjs/opus\|require.*opus\|import.*opus" extensions/esp32-voice/src/
   # Should only find opusscript references, not @discordjs/opus
   ```
2. Remove it:
   ```bash
   cd extensions/esp32-voice
   npm uninstall @discordjs/opus
   ```
3. Verify `opusscript` is still in `dependencies` in `package.json`
4. Commit: `"chore: remove unused @discordjs/opus dependency, use opusscript only"`

**Note on opusscript:** `opusscript` is pure JavaScript/WebAssembly — it needs NO native
compilation, NO node-gyp, NO system libraries. It installs cleanly on macOS, Linux and Windows.
No pre/post-install scripts are needed.

---

### 2.2 — Update version to CalVer format

**Why:** All OpenClaw extensions use CalVer (`YYYY.M.D` e.g. `2026.2.21`). This package
has `"version": "1.0.0"` which is inconsistent.

**Steps:**
1. Open `extensions/esp32-voice/package.json`
2. Change `"version": "1.0.0"` to today's date in CalVer format, e.g. `"version": "2026.2.21"`
3. Commit: `"chore: align version to CalVer format"`

---

### 2.3 — Add `ota-server.js` to the `files` array

**Why:** `ota-server.js` is not listed in the `files` array in `package.json`. When the package
is published to npm, this file will be excluded and users won't have the OTA server.

**Steps:**
1. Open `extensions/esp32-voice/package.json`
2. Find the `files` array (currently: `["index.ts", "src/", "openclaw.plugin.json", "README.md"]`)
3. Add `"ota-server.js"` and `"TODO.md"` to the array:
```json
"files": [
  "index.ts",
  "src/",
  "openclaw.plugin.json",
  "README.md",
  "ota-server.js",
  "TODO.md"
]
```
4. Commit: `"chore: add ota-server.js and TODO.md to npm files array"`

---

## 🟡 SECTION 3 — OTA Server Integration (High Priority UX)

### 3.1 — Fix hardcoded timezone (IST) in `ota-server.js`

**Why:** The OTA server response hardcodes the timezone offset to IST (UTC+5:30 = 330 minutes).
Users in other timezones will get wrong device time on their ESP32.

**Current code (in `ota-server.js`):**
```js
timezone_offset: 330  // hardcoded IST — wrong for everyone else
```

**Steps:**
1. Open `extensions/esp32-voice/ota-server.js`
2. Find the `timezone_offset` line
3. Replace with a dynamic calculation:
```js
// Get local UTC offset in minutes (negative for west, positive for east)
timezone_offset: -new Date().getTimezoneOffset(),
```
> `getTimezoneOffset()` returns minutes west of UTC (negative for east), so negate it to get
> the standard "minutes east of UTC" that XiaoZhi firmware expects.

4. Commit: `"fix: use system timezone instead of hardcoded IST in ota-server"`

---

### 3.2 — Integrate OTA endpoint into the plugin HTTP handler

**Why:** Currently users must run `node ota-server.js` as a completely separate process in a
separate terminal. This is confusing and adds friction. The plugin already registers an HTTP
handler (`src/http-handler.ts`). Adding the OTA route there means users just start OpenClaw
normally — no second process.

**Steps:**
1. Open `extensions/esp32-voice/src/http-handler.ts`
2. Identify where HTTP routes are registered (look for `app.get(...)` or similar)
3. Add a route for `/xiaozhi/ota/` or `/__openclaw__/esp32-voice/ota/` that returns the same
   JSON payload currently in `ota-server.js`:
   ```typescript
   // The payload the XiaoZhi firmware expects
   {
     "websocket": {
       "url": "ws://<LAN_IP>:<ESP32_VOICE_PORT>/"
     },
     "openclaw": {
       "url": "ws://127.0.0.1:18789",
       "token": "<GATEWAY_TOKEN>"
     },
     "timezone_offset": -new Date().getTimezoneOffset()
   }
   ```
4. Get the LAN IP using the same interface detection logic already in `ota-server.js`
   (prefer `en0`, `en1`, `eth0`, `wlan0`, `wlo1`)
5. Once integrated, update `README.md` to say "OTA is served automatically at
   `http://<your-ip>:18789/__openclaw__/esp32-voice/ota/`" — no separate server needed
6. Keep `ota-server.js` as a standalone fallback option for users who run the plugin without
   the full Gateway
7. Commit: `"feat: integrate OTA endpoint into plugin HTTP handler"`

---

## 🟡 SECTION 4 — Developer Experience

### 4.1 — Write proper `README.md` with 3-step quick setup

**Why:** The current `README.md` is detailed but scattered. A new user needs a clear "from zero
to voice in 10 minutes" path at the very top, with details below.

**Suggested structure:**

```
# @openclaw/esp32-voice

[One-line description]

## Quick Start (10 minutes)

### Step 1 — Get API Keys
- Deepgram (free): https://console.deepgram.com → API Keys → Create Key
- ElevenLabs (free tier): https://elevenlabs.io → Profile → API Keys

### Step 2 — Configure OpenClaw
[exact env vars and openclaw.json snippet]

### Step 3 — Flash your ESP32
[exact OTA URL to point firmware at]

## Configuration Reference
[full table of all options]

## How It Works
[architecture diagram]

## Troubleshooting
[common errors and fixes]
```

**Steps:**
1. Open `extensions/esp32-voice/README.md`
2. Add the "Quick Start" section as the very first content after the title
3. Link to the Deepgram free tier and ElevenLabs free tier pages explicitly
4. Show the minimum `~/.openclaw/openclaw.json` block (copy from QUICKSTART.md)
5. Commit: `"docs: rewrite README with 3-step quick start at top"`

---

### 4.2 — Add `.env.example` file

**Why:** Users need to know what env vars to set. A `.env.example` file is the standard way
to document this without committing real credentials.

**Create `extensions/esp32-voice/.env.example`:**
```bash
# Required — get free API key at https://console.deepgram.com
DEEPGRAM_API_KEY=<your-deepgram-api-key>

# Required — get free API key at https://elevenlabs.io
ELEVENLABS_API_KEY=<your-elevenlabs-api-key>

# Optional — find voice IDs at https://elevenlabs.io/voice-library
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM

# Optional — override default ElevenLabs model
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5

# Optional — override default Deepgram model
DEEPGRAM_MODEL=nova-2

# Optional — port for ESP32 voice WebSocket server (default: 8765)
ESP32_VOICE_PORT=8765

# Required for OTA server — copy from ~/.openclaw/openclaw.json or your gateway setup
GATEWAY_TOKEN=<your-openclaw-gateway-token>

# Optional — override OpenClaw gateway URL (default: ws://127.0.0.1:18789)
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
```

**Steps:**
1. Create the file at `extensions/esp32-voice/.env.example` with the content above
2. Make sure `.env.example` is in the `files` array in `package.json`
3. Add a note in README: "Copy `.env.example` to `~/.openclaw/.env` and fill in your keys"
4. Commit: `"docs: add .env.example with all required and optional env vars"`

---

## 🟡 SECTION 5 — Reliability Improvements

### 5.1 — Persist OTP pairing across restarts

**Why:** The OTP pairing system stores approved devices in memory only. If OpenClaw restarts,
all paired devices need to be re-paired. This is annoying for users with always-on ESP32 devices.

**Current code in `src/device/device-otp.ts`:**
```typescript
private pairedDevices: Map<string, PairedDevice> = new Map(); // in-memory only
```

**Steps:**
1. Open `extensions/esp32-voice/src/device/device-otp.ts`
2. Add persistence using a JSON file at `~/.openclaw/esp32-voice-devices.json`
3. On `DeviceOtpManager` construction, load the file if it exists
4. On successful pairing, write the updated map back to the file
5. On OpenClaw restart, previously paired devices are immediately trusted without re-pairing
6. Commit: `"feat: persist paired devices to disk so pairing survives gateway restarts"`

---

### 5.2 — Add rate limiting to OTP verification

**Why:** The OTP is 6 digits (100,000 possible values). Without rate limiting, an attacker
on the same network could brute-force the OTP in minutes. The OTA HTTP endpoint and the
voice WebSocket both need protection.

**Steps:**
1. Open `extensions/esp32-voice/src/device/device-otp.ts`
2. Add a failed-attempt counter per source IP
3. After 5 failed attempts from the same IP, block for 15 minutes
4. Log blocked attempts at `warn` level
5. Commit: `"security: add rate limiting to OTP verification (5 attempts then 15min block)"`

---

### 5.3 — Handle Gateway reconnection gracefully

**Why:** Currently if the OpenClaw Gateway drops the WebSocket connection (restart, timeout,
network hiccup), the plugin's `openclawConnected` flag goes false and stays false until the
ESP32 session is restarted. The Gateway reconnect should happen automatically in the background.

**Steps:**
1. Open `extensions/esp32-voice/src/voice/voice-session.ts`
2. In the `openclawWs.on("close", ...)` handler, instead of just setting `openclawConnected = false`,
   schedule a reconnect after 3 seconds:
   ```typescript
   this.openclawWs.on("close", () => {
     this.openclawConnected = false;
     this.log("info", "OpenClaw disconnected — reconnecting in 3s...");
     setTimeout(() => {
       this.connectToOpenClaw().catch((err) =>
         this.log("error", `Reconnect failed: ${err}`)
       );
     }, 3000);
   });
   ```
3. Add an exponential backoff: 3s → 6s → 12s → 30s (cap at 30s)
4. Stop retrying after session `cleanup()` is called
5. Commit: `"feat: auto-reconnect to OpenClaw Gateway on disconnect"`

---

## 🟢 SECTION 6 — Publishing to npm

### 6.1 — Final pre-publish checklist

Run through this checklist in order before running `npm publish`:

- [ ] All items in Section 1 (Security) are done
- [ ] All items in Section 2 (package.json) are done
- [ ] `SETUP.md` has no real credentials
- [ ] `ota-server.js` has no hardcoded tokens
- [ ] `@discordjs/opus` is removed from `package.json`
- [ ] Version is CalVer format (e.g. `2026.2.21`)
- [ ] `ota-server.js` is in the `files` array
- [ ] `.env.example` is in the `files` array
- [ ] `README.md` has a clear Quick Start section at the top
- [ ] Run `npm pack --dry-run` and check the file list — no `node_modules/`, no `.env`, no real credentials
- [ ] Test install in a clean directory: `mkdir /tmp/test-install && cd /tmp/test-install && npm install @openclaw/esp32-voice`

### 6.2 — Publish

```bash
cd extensions/esp32-voice
npm login   # login to npm with your account
npm publish --access public
```

After publishing, verify:
```bash
npm info @openclaw/esp32-voice
```

---

## 🟢 SECTION 7 — Future Enhancements (Post-Launch)

These are not blockers but would significantly improve the plugin:

| # | Enhancement | Effort | Impact |
|---|---|---|---|
| 7.1 | Add Google STT provider (`src/stt/google.ts`) | Medium | High — alternative to Deepgram |
| 7.2 | Add OpenAI Whisper STT provider | Medium | High — popular, good accuracy |
| 7.3 | Add Azure TTS provider | Medium | Medium — enterprise users |
| 7.4 | Add support for multiple simultaneous ESP32 devices per account | Medium | High |
| 7.5 | Add WebRTC transport option (lower latency than WebSocket+Opus) | High | Medium |
| 7.6 | Streaming TTS to ESP32 before full LLM response is ready | High | High — reduces perceived latency |
| 7.7 | Wake-word detection passthrough from ESP32 | Medium | Medium |
| 7.8 | Add unit tests for STT/TTS registry, frame pacing, JSON-in-binary detection | Medium | High |
| 7.9 | CI/CD pipeline for the extension (GitHub Actions) | Low | Medium |
| 7.10 | Support for Zalo/Line/Telegram as voice backends (not just OpenClaw main session) | High | Medium |

---

## Quick Reference — Architecture

```
ESP32 (XiaoZhi firmware)
  │
  │  WebSocket  ws://<your-ip>:8765/
  ▼
[esp32-voice plugin — port 8765]
  │  STT: Opus frames → Deepgram → transcript
  │  LLM: transcript → OpenClaw Gateway → response text
  │  TTS: response text → ElevenLabs → PCM → Opus frames
  │
  │  WebSocket  ws://127.0.0.1:18789
  ▼
[OpenClaw Gateway — port 18789]
  │
  ▼
[AI Model — Gemini / Claude / GPT]
```

**Key files:**
- `src/voice/voice-session.ts` — main pipeline orchestrator (STT → LLM → TTS)
- `src/voice/voice-endpoint.ts` — standalone WebSocket server on port 8765
- `src/stt/deepgram.ts` — Deepgram STT (VAD + streaming)
- `src/tts/elevenlabs.ts` — ElevenLabs TTS (serialized audio chain)
- `src/device/device-otp.ts` — OTP pairing system
- `ota-server.js` — standalone OTA config server for XiaoZhi firmware
- `index.ts` — OpenClaw plugin entry point

**Known quirks solved (do not revert):**
- XiaoZhi sends ALL WebSocket messages as binary frames — even JSON. Detection: check if binary frame starts with `0x7b` (`{`) before treating as audio.
- `@discordjs/opus` prebuilt binaries are rejected by macOS Gatekeeper. Use `opusscript` (pure WASM) instead.
- ElevenLabs `onAudio` callback must be chained (not fire-and-forget) so Opus frame pacing is respected and sentences play sequentially, not simultaneously.
- Frame pacing anchor: `nextFrameAt` must be set at the moment the **first** frame is sent, not at function entry — otherwise TTS connection time is counted as debt and early frames are sent with no delay.

---

*Last updated: 2026-02-21 | Plugin version: 1.0.0 (pre-release)*
