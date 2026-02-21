# ESP32-Voice Plugin — npm Publishing Readiness Report

> Full analysis of what needs to change before this plugin can be published to npm
> and work out-of-the-box for other OpenClaw users.

---

## Current Status: NOT READY for npm publish

---

## 🔴 Section 1 — Security (Fix Before Anything Else)

### 1.1 Real API keys exposed in `SETUP.md`

`SETUP.md` contains live, active credentials committed to the repository:

```
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
ELEVENLABS_API_KEY=YOUR_ELEVENLABS_API_KEY_HERE
```

**Action required:**
1. Rotate both keys immediately (they are now public):
   - ElevenLabs: https://elevenlabs.io/app/settings/api-keys → delete → create new
   - Google AI Studio: https://aistudio.google.com/apikey → delete → create new
2. Replace all real values in `SETUP.md` with placeholders like `<YOUR_ELEVENLABS_API_KEY>`

---

### 1.2 Hardcoded fallback gateway token in `ota-server.js`

```js
// Line ~59 in ota-server.js
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "YOUR_GATEWAY_TOKEN_HERE";
```

This token is now public. Any user who forgets to set the env var silently uses this known token.

**Action required:**
Replace with a hard exit if the env var is not set:
```js
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
if (!GATEWAY_TOKEN) {
  console.error("[ota-server] ERROR: GATEWAY_TOKEN env var is required.");
  process.exit(1);
}
```

---

## 🔴 Section 2 — package.json Fixes (Required for npm publish)

### 2.1 Remove unused `@discordjs/opus` dependency

`@discordjs/opus` is listed in `dependencies` but is **never imported anywhere** in the source.
It was replaced by `opusscript` after macOS Gatekeeper rejected its prebuilt native binary.
Leaving it in `dependencies` means every user downloads and tries to install a native binary
they don't need — and it will fail on many systems.

```bash
cd extensions/esp32-voice
npm uninstall @discordjs/opus
```

**Why opusscript needs no install script:**
`opusscript` is pure JavaScript/WebAssembly. It requires:
- No native compilation
- No `node-gyp`
- No system libraries (no `libopus` to install)
- No pre/post-install scripts

It installs cleanly on macOS, Linux, and Windows via a plain `npm install`. No extra steps for users.

---

### 2.2 Update version to CalVer

All OpenClaw extensions use CalVer format (`YYYY.M.D`). This package has `"version": "1.0.0"`.

Change to: `"version": "2026.2.21"` (or the date of first publish)

---

### 2.3 Add `ota-server.js` to the `files` array

`ota-server.js` is not in the `files` array so it will be excluded from the npm package.
Users will install the plugin but have no OTA server.

Current `files` array:
```json
"files": ["index.ts", "src/", "openclaw.plugin.json", "README.md"]
```

Should be:
```json
"files": ["index.ts", "src/", "openclaw.plugin.json", "README.md", "ota-server.js", ".env.example"]
```

---

### 2.4 Add `.env.example` file (new file to create)

Users need to know what env vars to set. Create `extensions/esp32-voice/.env.example`:

```bash
# Required — get free key at https://console.deepgram.com
DEEPGRAM_API_KEY=<your-deepgram-api-key>

# Required — get free key at https://elevenlabs.io
ELEVENLABS_API_KEY=<your-elevenlabs-api-key>

# Optional — find voice IDs at https://elevenlabs.io/voice-library
# Default: Rachel (21m00Tcm4TlvDq8ikWAM)
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM

# Optional — default: eleven_turbo_v2_5
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5

# Optional — default: nova-2
DEEPGRAM_MODEL=nova-2

# Optional — port for ESP32 WebSocket server (default: 8765)
ESP32_VOICE_PORT=8765

# Required for OTA server — copy from your openclaw.json or gateway setup
GATEWAY_TOKEN=<your-openclaw-gateway-token>

# Optional — default: ws://127.0.0.1:18789
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
```

---

## 🟡 Section 3 — Setup Experience for New Users

### What a new user has to do today (too many steps)

1. Install OpenClaw and the plugin
2. Sign up for Deepgram (STT) — get API key
3. Sign up for ElevenLabs (TTS) — get API key
4. Add keys to `~/.openclaw/.env`
5. Edit `~/.openclaw/openclaw.json` with a device token (generate manually)
6. Start OpenClaw Gateway in one terminal
7. Start `ota-server.js` in a **second terminal**
8. Find their machine's LAN IP address
9. Flash ESP32 with the OTA URL
10. Reboot ESP32 and hope auto-detect worked

**Pain point:** Two separate processes, manual IP lookup, unclear token generation.

---

### 3.1 Fix hardcoded timezone in `ota-server.js`

The OTA server hardcodes IST (UTC+5:30 = 330 minutes). Users in other timezones get wrong device time on their ESP32.

Current:
```js
timezone_offset: 330  // hardcoded IST
```

Fix:
```js
timezone_offset: -new Date().getTimezoneOffset()  // reads system timezone
```

> `getTimezoneOffset()` returns minutes west of UTC (negative for east of UTC),
> so negating it gives the standard "minutes east of UTC" that XiaoZhi expects.

---

### 3.2 Integrate OTA endpoint into the plugin HTTP handler (removes second terminal)

Currently `ota-server.js` must be run as a separate process. The plugin already has an
HTTP handler (`src/http-handler.ts`). Adding the OTA route there means users only run
one command — `openclaw gateway` — and everything works.

The OTA route should be served at:
```
http://<your-lan-ip>:18789/__openclaw__/esp32-voice/ota/
```

Payload returned (same as ota-server.js currently returns):
```json
{
  "websocket": {
    "url": "ws://<LAN_IP>:8765/"
  },
  "openclaw": {
    "url": "ws://127.0.0.1:18789",
    "token": "<GATEWAY_TOKEN>"
  },
  "timezone_offset": -330
}
```

Once integrated, update `README.md` to say "OTA is automatically available — no second server needed."

---

### 3.3 Rewrite `README.md` top section as a 3-step Quick Start

The current README has good detail but buries the getting-started path. New users need:

```
## Quick Start

### Step 1 — Get API keys (both have free tiers)
- Deepgram: https://console.deepgram.com → API Keys → Create
- ElevenLabs: https://elevenlabs.io → Profile → API Keys

### Step 2 — Configure
cp .env.example ~/.openclaw/.env
# Edit ~/.openclaw/.env with your keys

### Step 3 — Flash your ESP32
Point your XiaoZhi firmware OTA URL to:
  http://<your-machine-lan-ip>:18789/__openclaw__/esp32-voice/ota/
Reboot the device. Done.
```

---

## 🟡 Section 4 — Reliability Improvements

### 4.1 Persist OTP pairing across Gateway restarts

Currently paired devices are stored in memory only. If the Gateway restarts, all ESP32
devices need to be re-paired with a new OTP. This is very annoying for always-on devices.

Fix: persist the paired device map to `~/.openclaw/esp32-voice-devices.json` on each
successful pairing and reload it on startup.

---

### 4.2 Add rate limiting to OTP verification

The OTP is 6 digits (100,000 possible values). Without rate limiting, someone on the
same LAN could brute-force it in minutes. Add a per-IP attempt counter: lock out for
15 minutes after 5 failed attempts.

---

### 4.3 Auto-reconnect to Gateway on disconnect

If the OpenClaw Gateway drops the connection (restart, timeout, network blip),
`openclawConnected` goes false and stays false until the ESP32 session is restarted.
Should reconnect automatically with exponential backoff (3s → 6s → 12s → 30s cap).

---

## 🟢 Section 5 — Pre-publish Checklist

Run through this before `npm publish`:

- [ ] Rotated the exposed API keys (ElevenLabs + Gemini)
- [ ] `SETUP.md` has no real credentials — only `<PLACEHOLDER>` values
- [ ] Hardcoded fallback token removed from `ota-server.js`
- [ ] `@discordjs/opus` removed from `package.json` dependencies
- [ ] Version updated to CalVer (e.g. `2026.2.21`)
- [ ] `ota-server.js` added to `files` array in `package.json`
- [ ] `.env.example` created and added to `files` array
- [ ] Timezone fix applied in `ota-server.js`
- [ ] README has a 3-step Quick Start at the very top
- [ ] Ran `npm pack --dry-run` and verified:
  - No `node_modules/` in the package
  - No `.env` file in the package
  - No real credentials in any file
- [ ] Test clean install: `mkdir /tmp/test && cd /tmp/test && npm install @openclaw/esp32-voice`

Then publish:
```bash
cd extensions/esp32-voice
npm login
npm publish --access public
```

---

## Summary Table

| # | Issue | Severity | Effort |
|---|---|---|---|
| 1.1 | Real API keys in SETUP.md | 🔴 Critical | 5 min |
| 1.2 | Hardcoded fallback token in ota-server.js | 🔴 Critical | 5 min |
| 2.1 | Remove unused @discordjs/opus | 🔴 Blocker | 2 min |
| 2.2 | Version to CalVer | 🔴 Blocker | 1 min |
| 2.3 | Add ota-server.js to files array | 🔴 Blocker | 2 min |
| 2.4 | Create .env.example | 🟡 Important | 10 min |
| 3.1 | Fix hardcoded IST timezone | 🟡 Important | 5 min |
| 3.2 | Integrate OTA into plugin HTTP handler | 🟡 Important | 2–3 hours |
| 3.3 | Rewrite README Quick Start | 🟡 Important | 30 min |
| 4.1 | Persist OTP pairing to disk | 🟡 Nice to have | 1 hour |
| 4.2 | Rate limit OTP attempts | 🟡 Nice to have | 1 hour |
| 4.3 | Auto-reconnect to Gateway | 🟡 Nice to have | 1 hour |

**Minimum to publish safely: items 1.1, 1.2, 2.1, 2.2, 2.3**
**Minimum for a good user experience: all of Section 2 + Section 3**
