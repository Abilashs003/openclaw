# ESP32 Voice — Project Overview

**Product:** @cheeko-ai/esp32-voice | OpenClaw ESP32 Voice Channel Plugin
**Version:** 2026.2.23.5 (Pre-release)
**License:** MIT
**Date:** February 2026

---

## 1. Executive Summary

ESP32 Voice turns a $5-15 ESP32 microcontroller into a full AI voice assistant powered by OpenClaw. A user presses a button, speaks, and hears an AI-generated spoken response — all processed through a self-hosted pipeline with pluggable speech-to-text and text-to-speech providers.

What makes this unique: the ESP32 voice device shares the same AI agent as the user's WhatsApp, Telegram, Slack, Discord, and other messaging channels. One AI brain, every surface. No competitor in the market offers this multi-channel unification with hardware voice devices.

| Metric | Value |
|--------|-------|
| Lines of Code | ~4,090 |
| Source Files | 16 TypeScript + 1 JavaScript |
| Runtime Dependencies | 3 (opusscript, ws, zod) |
| Hardware Cost | $5-15 per device |
| Status | Feature-complete, beta-ready |

---

## 2. What We Built

### 2.1 Hardware Integration

The plugin supports ESP32-S3 boards running Cheeko/XiaoZhi firmware — an open-source ESP32 voice platform with 22,000+ GitHub stars and an active global developer community.

**Supported Hardware:**
- Jiuchuan S3 (Cheeko ESP32-S3 board) — recommended, $8-12 wholesale
- Any ESP32 board running XiaoZhi firmware

**How It Works:**

```
User presses button on ESP32
        |
        v
ESP32 captures audio (Opus, 24kHz mono)
        |
        v  WebSocket (port 8765)
        |
Voice Server (ESP32 Voice Plugin)
   |-- STT: Deepgram --> transcript text
   |-- LLM: OpenClaw AI Agent --> response text
   |-- TTS: ElevenLabs --> audio response
        |
        v  Opus audio frames
        |
ESP32 speaker plays response
```

**Zero-Touch Device Provisioning:**
An OTA (Over-the-Air) config server automatically provides ESP32 devices with connection URLs and authentication tokens on boot. No manual firmware flashing required after initial setup.

---

### 2.2 Plugin Architecture

```
+-----------------------------------------------------------+
|  ESP32 Device (XiaoZhi firmware)                          |
|  Push-to-talk, Opus audio capture, speaker playback       |
+---------------------------+-------------------------------+
                            |
                   WebSocket (port 8765)
                            |
+---------------------------v-------------------------------+
|  ESP32 Voice Plugin                                       |
|                                                           |
|  +-------------+  +-----------+  +------------------+    |
|  | STT Provider |  | AI Agent  |  | TTS Provider     |    |
|  | (Deepgram)   |->| (OpenClaw |->| (ElevenLabs)     |    |
|  | nova-2       |  |  Gateway) |  | turbo v2.5       |    |
|  +-------------+  +-----------+  +------------------+    |
|                                                           |
|  +-------------+  +-----------+  +------------------+    |
|  | Opus Codec   |  | Device    |  | Session Manager  |    |
|  | (WASM)       |  | Auth/OTP  |  | (State Machine)  |    |
|  +-------------+  +-----------+  +------------------+    |
+---------------------------+-------------------------------+
                            |
                   WebSocket (port 18789, internal)
                            |
+---------------------------v-------------------------------+
|  OpenClaw Gateway                                         |
|  AI Agent + Multi-Channel Router                          |
|  (WhatsApp, Telegram, Slack, Discord, Signal, iMessage)   |
+-----------------------------------------------------------+
```

**Voice Pipeline State Machine:**

```
IDLE --> LISTENING --> PROCESSING_STT --> QUERYING_LLM --> STREAMING_TTS --> IDLE
  ^                                                                          |
  +--------------------------------------------------------------------------+
```

Each state transition is managed with abort support, timeout handling, and error recovery.

---

### 2.3 Key Features

| Feature | Description |
|---------|-------------|
| End-to-end voice pipeline | Audio in, speech recognized, AI responds, audio out |
| Pluggable STT providers | Deepgram (implemented), extensible registry for Google, Whisper, Azure |
| Pluggable TTS providers | ElevenLabs (implemented), extensible registry for Edge TTS, Google, Azure |
| Device pairing (OTP) | 6-digit codes with 5-minute expiry, cryptographically secure |
| Bearer token auth | Per-device 64-character hex tokens for ongoing authentication |
| Cheeko dashboard integration | Browser-based device management and pairing |
| Multi-device accounts | Multiple ESP32 devices per user, independent configs |
| Voice-optimized responses | AI instructed to respond concisely without markdown |
| Onboarding wizard | 4-step interactive setup: dashboard login, STT, TTS, device add |
| Health/diagnostics endpoints | HTTP endpoints for monitoring STT/TTS status |
| Real-time frame pacing | 60ms audio frames paced to match playback speed |
| Opus codec (pure WASM) | No native compilation required, works on any OS |

---

### 2.4 Deployment Options

| Deployment | How It Works | Best For |
|------------|-------------|----------|
| Local LAN | ESP32 + Mac/PC on same WiFi network | Home use, simplest setup |
| VPS Relay (Tailscale) | ESP32 connects to cloud VPS, VPS relays to home machine via Tailscale VPN | Remote access, devices anywhere |
| Full Cloud | Everything runs on a cloud server | Always-on, no home hardware |

**VPS Relay Architecture (Recommended for Production):**

```
ESP32 (anywhere with internet)
  |  ws://<vps-public-ip>:8765/
  v
VPS (nginx WebSocket proxy + Tailscale)
  |  proxy to Mac Mini Tailscale IP
  v
Mac Mini (home, Tailscale)
  |-- Voice Server (port 8765)
  |-- Gateway + AI Agent (port 18789)
```

---

## 3. Multi-Channel Advantage

This is the product's defining differentiator. No competitor offers it.

The ESP32 Voice device connects to the same OpenClaw AI agent that handles:

| Channel | Type | Status |
|---------|------|--------|
| WhatsApp | Text messaging | Built-in |
| Telegram | Text messaging | Built-in |
| Slack | Workspace messaging | Built-in |
| Discord | Community messaging | Built-in |
| Signal | Encrypted messaging | Built-in |
| iMessage | Apple messaging | Built-in |
| Microsoft Teams | Enterprise messaging | Extension |
| Google Chat | Workspace messaging | Extension |
| Matrix | Open protocol | Extension |
| **ESP32 Voice** | **Hardware voice** | **This plugin** |

**What this means for users:**
- One AI personality across all devices and channels
- Shared conversation history and memory
- Start a conversation on ESP32 voice, continue it on WhatsApp
- The AI knows the user's context regardless of how they communicate

---

## 4. Market Opportunity

### 4.1 Market Size

| Market Segment | 2024 Value | Projected Value | CAGR |
|---------------|-----------|-----------------|------|
| Voice AI Assistants | $7.35B | $33.7B by 2030 | 26.5% |
| Voice AI Agents | $2.4B | $47.5B by 2034 | 34.8% |
| Voice AI in Smart Homes | $13.56B | $20.1B by 2025 | 48.2% |
| Smart Speakers | $13.71B | $29.1B by 2032 | 9.8% |
| ESP32 Module Market | $567M-$1.5B | $1-4.6B by 2032 | 8.5-14.5% |
| Assistive Technology | $30.4B | $65.2B by 2034 | — |
| AI Voice in Healthcare | $472M | $11.7B by 2035 | 37.85% |

*Sources: NextMSC, Market.us, Fortune Business Insights, Semiconductor Insight, Astute Analytica, Custom Market Insights*

**Key Stat:** Over 200 voice AI startups raised $1.5B+ in 2025. ElevenLabs (TTS provider used in this plugin) reached a $3.3B valuation.

### 4.2 User Adoption

- **153.5 million** US voice assistant users (46% of population)
- **8.4 billion** voice-enabled devices worldwide
- **75%** of US households projected to have smart speakers
- Adults **65+** are one of the fastest-growing segments

### 4.3 Competitive Landscape

| Dimension | OpenClaw ESP32 | Xiaozhi | Willow | Home Assistant | Amazon Alexa |
|-----------|---------------|---------|--------|----------------|-------------|
| Hardware Cost | $5-15 | $5-15 | $40-50 | $59 | $50-250 |
| Self-Hosted | Yes | Partial | Yes | Yes | No |
| Multi-Channel | **Yes** | No | No | Limited | No |
| Open Source | MIT | MIT | MIT | Apache 2.0 | No |
| Pluggable STT/TTS | Yes | Yes | Yes | Yes | No |
| LLM Flexibility | Any provider | Qwen/DeepSeek | N/A | Limited | Amazon only |
| Community Size | Growing | 22.3K stars | ~3K stars | Very large | Massive |

**Competitive advantages:**
1. **Multi-channel unification** — only product combining voice hardware + messaging channels under one AI
2. **3-20x cheaper hardware** than commercial alternatives
3. **Self-hosted with privacy** — user data stays on their devices
4. **Provider freedom** — not locked to any single STT, TTS, or LLM vendor

### 4.4 Privacy Tailwind

Consumer concerns about cloud-dependent voice assistants are a documented market restraint. Amazon had to enhance on-device processing in 2024 specifically to address privacy backlash. OpenClaw's self-hosted architecture turns this industry weakness into a product strength.

---

## 5. Target Applications

### 5.1 Home Automation
- Voice control for smart home devices
- Integration with Home Assistant ecosystem
- Market: $20B+ Voice AI in Smart Homes, growing at 48.2%

### 5.2 Elderly Care and Accessibility
- Low-cost voice interface for users who cannot operate smartphones/tablets
- Medication reminders, emergency assistance, AI companionship
- Adults 65+ are the fastest-growing voice assistant user segment
- Market: $30.4B assistive technology, $472M AI voice in healthcare (37.85% CAGR)

### 5.3 Education and STEM
- Students build their own AI voice device ($10 bill of materials)
- Language learning with multilingual AI conversations
- XiaoZhi already positions itself as a learning platform for students

### 5.4 Small Business
- Low-cost AI voice kiosk for reception/customer service
- Voice-based inventory queries, order status, appointment booking
- Deployed at $15 hardware + $10-20/month API costs

### 5.5 Industrial IoT
- Hands-free voice commands in manufacturing/warehouse environments
- ESP32's industrial temperature range and low power suit harsh environments
- Status queries, machinery control, safety alerts

### 5.6 Developing Markets
- $5-15 hardware cost removes the primary adoption barrier
- Multilingual support covers non-English markets
- Voice interface bridges the digital literacy gap

---

## 6. Revenue Model Options

### 6.1 Hardware Sales

| Product Tier | Description | Price | Margin |
|-------------|-------------|-------|--------|
| DIY Kit | ESP32 board + mic + speaker + case | $15-25 | 40-60% |
| Ready-to-Use | Pre-assembled, pre-flashed device | $30-50 | 50-65% |
| Premium | Better speaker, display, enclosure | $50-80 | 55-70% |

Cheeko/Jiuchuan S3 boards are available at $8-12 wholesale from Chinese manufacturers.

### 6.2 SaaS (Hosted Voice Processing)

- **Managed gateway hosting:** Users who don't want to self-host pay $10-30/month per device
- **Usage-based billing:** Charge per minute of voice interaction
- **Aggregated API pricing:** Bundle STT/TTS API costs with markup (60-75% margins typical in voice AI agencies)

### 6.3 Enterprise Licensing

- On-premises deployment for organizations requiring data sovereignty
- Volume licensing for care facilities, schools, hotels
- Custom model fine-tuning and voice cloning
- SLA-backed support tiers

### 6.4 Plugin Marketplace (ClawHub)

- Revenue share on paid skills/plugins (industry standard: 70/30 split)
- Premium plugin certification
- Vertical-specific bundles (healthcare, hospitality, education)

### 6.5 White-Label Solutions

- Branded voice assistants for companies wanting their own AI voice product
- Per-client revenue: $100-300/month recurring
- Distribution through telecom providers, agencies, web hosting companies

---

## 7. Roadmap

### Immediate (This Week)
- [ ] Fix 5 npm publishing blockers (~15 minutes total)
- [ ] Rotate exposed API keys in git history
- [ ] Remove hardcoded fallback token
- [ ] Publish v1.0.0 to npm

### Short-Term (1-2 Months)
- [ ] Add Google Cloud STT provider
- [ ] Add OpenAI Whisper STT provider
- [ ] Add Azure TTS provider
- [ ] Write unit tests for STT/TTS/pacing
- [ ] Integrate OTA server into plugin (eliminate separate process)
- [ ] Rate-limit OTP brute-force attempts
- [ ] Persist paired devices to disk

### Medium-Term (3-6 Months)
- [ ] Wake-word detection pass-through
- [ ] WebRTC transport (lower latency than WebSocket)
- [ ] Multiple simultaneous ESP32 device sessions
- [ ] Auto-reconnect to gateway on disconnect
- [ ] Tailscale-aware IP detection and health endpoint
- [ ] GitHub Actions CI/CD pipeline

### Long-Term (6-12 Months)
- [ ] Early TTS streaming (start speaking before full LLM response)
- [ ] Voice cloning integration
- [ ] Continuous conversation mode (no button press)
- [ ] Cross-channel voice (Telegram voice, Discord voice, ESP32)
- [ ] Hardware reference design for custom PCB

---

## 8. Current Status

### What's Working
- Full voice pipeline: audio in, STT, LLM query, TTS, audio out
- Deepgram streaming STT with server-side VAD
- ElevenLabs streaming TTS with real-time frame pacing
- Opus encoding/decoding (pure WASM)
- Device OTP pairing and Bearer token auth
- Cheeko dashboard integration
- OTA server for device provisioning
- 4-step onboarding wizard
- Multi-device account support

### What Needs Work
- Rate limiting on OTP attempts (security)
- Disk persistence for paired devices (reliability)
- Auto-reconnect to gateway on disconnect (reliability)
- Multiple STT/TTS provider options (extensibility)

### Publishing Readiness: ~80%

| Blocker | Severity | Fix Time |
|---------|----------|----------|
| Real API keys in SETUP.md (git history) | Critical | 5 min |
| Hardcoded fallback token in OTA server | Critical | 5 min |
| Unused @discordjs/opus dependency | Blocker | 2 min |
| Version format (needs CalVer) | Blocker | 1 min |
| OTA server not in npm files array | Blocker | 2 min |

**Total time to publish-ready: ~15 minutes of fixes.**

---

## Appendix A: Technical Specifications

### Audio Pipeline

| Parameter | Value |
|-----------|-------|
| Input format | Opus, 16kHz, 1-channel (from ESP32) |
| Output format | Opus, 24kHz, 1-channel (to ESP32) |
| Frame duration | 60ms (1,440 samples per frame) |
| PCM frame size | 2,880 bytes (16-bit mono) |
| Opus bitrate | 32 kbps (VOIP mode) |
| Sentence pause | 300ms silence between sentences |
| Max response length | 500 characters (configurable) |

### WebSocket Protocol (ESP32 to Voice Server)

**Control Messages (JSON):**

| Message | Direction | Purpose |
|---------|-----------|---------|
| `hello` | ESP32 -> Server | Connection setup, device auth, config |
| `hello` | Server -> ESP32 | Session ID, audio parameters |
| `listen` | ESP32 -> Server | Start/stop audio capture |
| `speech_end` | ESP32 -> Server | Manual end-of-speech signal |
| `abort` | ESP32 -> Server | Cancel current processing |
| `transcript` | Server -> ESP32 | Partial/final STT results |
| `stt` | Server -> ESP32 | Final STT transcript |
| `status` | Server -> ESP32 | Processing stage (thinking/speaking) |
| `tts` | Server -> ESP32 | TTS state (start/stop) |
| `error` | Server -> ESP32 | Error message |

**Binary Frames:** Raw Opus audio data in both directions.

### Gateway Communication (Voice Server to AI)

| Parameter | Value |
|-----------|-------|
| Protocol | WebSocket JSON RPC |
| Default URL | ws://127.0.0.1:18789 |
| Auth | Bearer token + optional Ed25519 device signature |
| Method | `chat.send` with session key `agent:main:main` |
| Response | Streaming events (`agent`, `chat`) |
| Timeout | 120 seconds |

### Security Layers

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| Device Token | 64-char hex Bearer token | Per-device WebSocket auth |
| OTP Pairing | 6-digit code, 5-min expiry | Initial device onboarding |
| DM Policy | "pairing" (default) or "open" | Access control per account |
| Gateway Token | Shared secret | Plugin-to-gateway internal auth |

### External API Integrations

| Service | Protocol | Model | Purpose |
|---------|----------|-------|---------|
| Deepgram | WebSocket streaming | nova-2 | Speech-to-text |
| ElevenLabs | WebSocket streaming | eleven_turbo_v2_5 | Text-to-speech |
| Cheeko Dashboard | HTTP REST | — | Device registration |
| OpenClaw Gateway | WebSocket RPC | Claude/GPT/etc. | AI agent processing |

### Plugin HTTP Endpoints (on Gateway port 18789)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/__openclaw__/esp32-voice/health` | GET | STT/TTS status check |
| `/__openclaw__/esp32-voice/stream` | GET | Voice server connection info |
| `/__openclaw__/esp32-voice/otp` | GET | Generate device pairing code |
| `/__openclaw__/esp32-voice/devices` | GET | List paired devices |

### State Machine Detail

```
IDLE
  |-- [user presses button, "listen start" received]
  v
LISTENING
  |-- [binary Opus frames forwarded to STT provider]
  |-- [partial transcripts sent back to ESP32]
  |-- [speech_final detected by Deepgram VAD OR "listen stop" received]
  v
PROCESSING_STT
  |-- [finalize STT, get complete transcript]
  |-- [send "stt" message to ESP32 with final text]
  v
QUERYING_LLM
  |-- [send transcript to OpenClaw Gateway via chat.send]
  |-- [stream agent response events]
  |-- [filter heartbeat/tool_use messages]
  |-- [accumulate response text]
  v
STREAMING_TTS
  |-- [split response into sentences]
  |-- [for each sentence: synthesize via ElevenLabs]
  |-- [encode PCM to Opus frames (60ms each)]
  |-- [pace frames at real-time intervals]
  |-- [insert 300ms silence between sentences]
  |-- [send "tts stop" when complete]
  v
IDLE (ready for next interaction)
```

### Provider Extensibility

Adding a new STT or TTS provider requires implementing a single interface and registering it:

```
Provider Interface (STT):
  connect() -> open connection to service
  sendAudio(buffer) -> stream audio data
  finalize() -> get final transcript
  close() -> cleanup

Provider Interface (TTS):
  connect() -> open connection to service
  synthesize(text) -> send text for synthesis
  flush() -> wait for all audio
  close() -> cleanup

Registration:
  registry.register(metadata, factoryFunction)
```

Both registries support runtime discovery, so third-party providers can be added as separate npm packages.

---

## Appendix B: Market Data Sources

- NextMSC — Voice Assistant Market Report
- Market.us — Voice AI Agents Market, Voice AI in Smart Homes Market
- Astute Analytica via GlobeNewsWire — Voice Assistant Market 2033 projections
- AgentVoice — AI Voice 2025 Market Analysis
- Fortune Business Insights — Smart Speaker Market
- Semiconductor Insight — ESP32 Module Market
- Markwide Research — ESP32 Module Market
- Custom Market Insights — Assistive Technology Market
- Towards Healthcare — AI Voice Agents in Healthcare
- SQ Magazine — Voice Assistant Usage Statistics

---

*Document prepared February 2026. Market data reflects latest available figures.*
