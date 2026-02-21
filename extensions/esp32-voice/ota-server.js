#!/usr/bin/env node
/**
 * Local OTA mock server for XiaoZhi ESP32 firmware.
 *
 * The ESP32 firmware calls this on boot (Ota::CheckVersion) to get
 * the WebSocket server URL and auth token. We return config pointing
 * to the local OpenClaw Gateway's esp32-voice plugin.
 *
 * Usage:
 *   node extensions/esp32-voice/ota-server.js
 *
 * The server listens on port 8080 and responds to any POST/GET with
 * the WebSocket + OpenClaw configuration.
 *
 * MAC_IP is auto-detected from your active LAN interface (en0 / en1 / eth0).
 * Override with: MAC_IP=x.x.x.x node ota-server.js
 */

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

// ── Auto-detect local LAN IP ───────────────────────────────────
function detectLocalIp() {
  // Allow manual override via env var
  if (process.env.MAC_IP) return process.env.MAC_IP;

  const nets = networkInterfaces();
  // Prefer these interfaces in order (macOS WiFi, macOS Ethernet, Linux eth, Linux wlan)
  const preferred = ["en0", "en1", "eth0", "wlan0", "wlo1"];

  for (const iface of preferred) {
    const addrs = nets[iface];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }

  // Fallback: first non-internal IPv4
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }

  console.warn("[ota-server] ⚠️  Could not detect local IP, falling back to 127.0.0.1");
  return "127.0.0.1";
}

// ── Configuration ──────────────────────────────────────────────
const MAC_IP        = detectLocalIp();
const VOICE_PORT    = process.env.VOICE_PORT    || "8765";     // standalone voice WS server port
const GATEWAY_PORT  = process.env.GATEWAY_PORT  || "18789";    // OpenClaw Gateway port
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "YOUR_GATEWAY_TOKEN_HERE";
const OTA_PORT      = parseInt(process.env.OTA_PORT || "8080", 10);

// IST = UTC+5:30 = 330 minutes
const TIMEZONE_OFFSET = parseInt(process.env.TZ_OFFSET || "330", 10);

// ── OTA Response ───────────────────────────────────────────────
function buildOtaResponse() {
  return {
    firmware: {
      version: "1.0.0",
      url: "",
    },
    websocket: {
      // The ESP32 connects to the STANDALONE voice server (port 8765),
      // NOT the Gateway port (18789) — this bypasses the Gateway's WS handler.
      url: `ws://${MAC_IP}:${VOICE_PORT}/`,
      token: GATEWAY_TOKEN,
      version: 1,
    },
    openclaw: {
      // The voice SESSION (running on the Mac) uses this to talk to the Gateway.
      // Must be 127.0.0.1 — the Gateway only binds to loopback, not the LAN IP.
      url: `ws://127.0.0.1:${GATEWAY_PORT}`,
      token: GATEWAY_TOKEN,
    },
    server_time: {
      timestamp: Date.now(),
      timezone_offset: TIMEZONE_OFFSET,
    },
  };
}

// ── HTTP Server ────────────────────────────────────────────────
const server = createServer((req, res) => {
  // Read body (ESP32 POSTs device info, but we don't need it)
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const deviceId  = req.headers["device-id"]  || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";
    console.log(`[ota-server] ${req.method} ${req.url} — device=${deviceId} ua=${userAgent}`);

    if (body) {
      try {
        const info = JSON.parse(body);
        console.log(`[ota-server] Device info: ${JSON.stringify(info).slice(0, 200)}`);
      } catch {
        // Not JSON, that's fine
      }
    }

    const response = buildOtaResponse();
    const json     = JSON.stringify(response, null, 2);

    console.log(`[ota-server] → Voice WS: ${response.websocket.url}`);
    console.log(`[ota-server] → Gateway:  ${response.openclaw.url} (loopback — server-side only)`);

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  });
});

server.listen(OTA_PORT, "0.0.0.0", () => {
  console.log(`\n🦞 ESP32 OTA Mock Server`);
  console.log(`   Auto-detected MAC IP : ${MAC_IP}`);
  console.log(`   OTA Server           : http://${MAC_IP}:${OTA_PORT}/xiaozhi/ota/`);
  console.log(`   Voice WebSocket      : ws://${MAC_IP}:${VOICE_PORT}/`);
  console.log(`   Gateway (AI agent)   : ws://${MAC_IP}:${GATEWAY_PORT}`);
  console.log(`   Gateway Token        : ${GATEWAY_TOKEN.slice(0, 8)}...`);
  console.log(`\n   Set on your ESP32:`);
  console.log(`     OTA URL  → http://${MAC_IP}:${OTA_PORT}/xiaozhi/ota/`);
  console.log(`\n   Waiting for ESP32 to connect...\n`);
});
