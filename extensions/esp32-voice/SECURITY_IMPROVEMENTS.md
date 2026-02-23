# ESP32 Voice Plugin — Security Improvements (Next Version)

> These are identified security improvements to be addressed in the next release.
> Current version is functional and safe for trusted LAN use. These improvements
> harden the plugin for broader / production deployment.

---

## 🔴 Critical

### 1. WebSocket Server Binds to `0.0.0.0` by Default
**Risk:** Anyone on the LAN (or internet if port-forwarded) can connect to port 8765 without credentials. Violates OpenClaw's principle of binding to loopback by default.

**Fix:**
- Change default bind from `0.0.0.0` to `127.0.0.1`
- Add `ESP32_VOICE_BIND=0.0.0.0` env var to opt-in explicitly
- Print a loud warning when binding to `0.0.0.0`

---

### 2. No Authentication on WebSocket Upgrade
**Risk:** Any device on the LAN can connect and start consuming Deepgram/ElevenLabs API quota. Authentication only happens after the WebSocket is already open (inside the `hello` message).

**Fix:**
- Check `Authorization: Bearer <token>` header at the HTTP upgrade step
- Reject with HTTP 401 before `wss.handleUpgrade()` is called if token is missing/invalid

---

### 3. OTP Validation is a No-Op
**Risk:** An invalid OTP logs a warning but the session proceeds normally. OTP pairing provides no actual security enforcement.

**Fix:**
- Add config flag `requireOtp: true/false` (default: `false` for backward compat)
- When `true`, reject the session if OTP is missing or invalid
- Document the flag clearly for production deployments

---

## 🟠 High

### 4. OTP Code Logged to Console
**File:** `src/device/device-otp.ts`

**Risk:** Raw OTP code is printed to stdout — visible in Docker logs, systemd logs, any log aggregator. Could allow an attacker with log access to intercept pairings.

**Fix:** Remove `console.log` of OTP code. Return it only in the HTTP response, never log it.

---

### 5. No Rate Limiting on WebSocket Connections or OTA Server
**Risk:** Unlimited connections can burn Deepgram/ElevenLabs API quota or exhaust server memory. OTA server has no throttle.

**Fix:**
- Per-IP connection limit on port 8765 (e.g., max 3 concurrent connections per IP)
- Rate limit audio frame processing per session
- Request throttle on OTA server (e.g., 10 req/min per IP)

---

### 6. `~/.openclaw/.env` Written with Default Permissions (0644)
**File:** `src/voice/voice-endpoint.ts` → `savePairTokenToEnv()`

**Risk:** `.env` file containing `CHEEKO_PAIR` and API keys is readable by any local user on the machine.

**Fix:** Write with mode `0600` (owner-read/write only):
```typescript
writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
```

---

## 🟡 Medium

### 7. No JSON Message Size Limit on WebSocket Frames
**File:** `src/voice/voice-session.ts` → `handleMessage()`

**Risk:** A malicious device can send multi-MB JSON blobs causing memory exhaustion. The HTTP handler already has a 64KB limit but WebSocket messages are unlimited.

**Fix:**
```typescript
const MAX_JSON_BYTES = 64 * 1024; // 64 KB
if (Buffer.isBuffer(data) && data.length > MAX_JSON_BYTES) {
  this.log("warn", `Oversized message dropped: ${data.length} bytes`);
  return;
}
```

---

### 8. Client Hello Can Override STT/TTS API Keys
**File:** `src/voice/voice-session.ts` → `handleHello()`

**Risk:** Device can send its own `stt.apiKey` / `tts.apiKey` in the hello message which gets used instead of the server's keys. Allows key exfiltration or credential hijacking.

**Fix:** Ignore API keys from client hello entirely — always use server-side env vars:
```typescript
sttApiKey: process.env.DEEPGRAM_API_KEY ?? "",
ttsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
```

---

## 🔵 Low

### 9. OTA Server Logs Unsanitized Device Headers
**File:** `ota-server.js`

**Risk:** `device-id` and `user-agent` headers are logged directly — ANSI escape code injection possible in terminal/log outputs.

**Fix:** Strip non-printable characters before logging:
```javascript
const sanitize = (s) => String(s).replace(/[^\x20-\x7E]/g, '?').slice(0, 100);
console.log(`device=${sanitize(deviceId)} ua=${sanitize(userAgent)}`);
```

---

### 10. No WSS/TLS Support
**Risk:** Audio and tokens travel unencrypted over the LAN. Not suitable for untrusted networks (open WiFi, corporate networks).

**Fix:** Optional TLS via env vars:
- `ESP32_VOICE_TLS_CERT` — path to TLS certificate
- `ESP32_VOICE_TLS_KEY` — path to TLS private key
- When set, start `https.createServer()` instead of `http.createServer()`

---

## ✅ Already Secure (No Action Needed)

| Feature | Status |
|---|---|
| Ed25519 device identity signatures for Gateway auth | ✅ Solid |
| Per-session isolation and resource cleanup | ✅ Done |
| HTTP handler 64KB body limit + Bearer token auth | ✅ Done |
| Default `dmPolicy: "pairing"` on channel | ✅ Done |
| No database / no SQL injection risk | ✅ N/A |
| Env vars always preferred over hardcoded values | ✅ Done |
| CHEEKO_PAIR registration non-blocking (won't crash startup) | ✅ Done |

---

## Priority for Next Version

| Priority | Item | Effort |
|---|---|---|
| P0 | Fix `.env` file permissions to `0600` | 1 line |
| P0 | Remove OTP from console log | 1 line |
| P0 | Add JSON message size limit | 5 lines |
| P1 | Warn loudly when binding to `0.0.0.0` | 3 lines |
| P1 | Ignore client-supplied API keys in hello | 2 lines |
| P2 | Rate limiting on WS connections + OTA | Medium |
| P2 | Auth on WebSocket upgrade (pre-connection) | Medium |
| P2 | OTP enforcement toggle (`requireOtp` flag) | Small |
| P3 | Sanitize OTA server logs | 2 lines |
| P3 | WSS/TLS support | Large |
