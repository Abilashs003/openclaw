/**
 * WebSocket endpoint for voice streaming.
 *
 * Ported from cheekoclaw_bridge/voice_endpoint.py
 *
 * Runs a **standalone** HTTP + WebSocket server on its own port (default 8765)
 * because the OpenClaw Gateway plugin API does not support WebSocket upgrade
 * registration. The ESP32 connects directly to this server.
 *
 * Routes any WebSocket connection to a VoiceSession per client.
 */

import crypto from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { VoiceSession } from "./voice-session.js";

// Import providers to trigger auto-registration
import "../stt/deepgram.js";
import "../tts/elevenlabs.js";

/** Default port for the standalone voice WebSocket server. */
const DEFAULT_VOICE_PORT = parseInt(process.env.ESP32_VOICE_PORT || "8765", 10);

/**
 * Create the voice WebSocket server (noServer mode — for manual upgrade).
 */
export function createVoiceWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    const sessionId = crypto.randomUUID().replace(/-/g, "");
    const session = new VoiceSession(ws, sessionId);
    console.log(`[esp32voice] Voice client connected [${sessionId.slice(0, 8)}]`);

    ws.on("message", async (data: Buffer | string, isBinary: boolean) => {
      // ── Raw message debug logging ─────────────────────────────
      if (isBinary || Buffer.isBuffer(data)) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        console.log(`[esp32voice] [${sessionId.slice(0, 8)}] ← BINARY frame: ${buf.length} bytes`);
        await session.handleMessage(buf);
      } else {
        const text = typeof data === "string" ? data : data.toString();
        console.log(`[esp32voice] [${sessionId.slice(0, 8)}] ← TEXT message: ${text.slice(0, 300)}`);
        try {
          await session.handleMessage(text);
        } catch (err) {
          console.error(`[esp32voice] [${sessionId.slice(0, 8)}] Message error: ${err}`);
        }
      }
    });

    ws.on("close", async () => {
      console.log(`[esp32voice] [${sessionId.slice(0, 8)}] Voice client disconnected`);
      await session.cleanup();
    });

    ws.on("error", async (err) => {
      console.error(`[esp32voice] [${sessionId.slice(0, 8)}] WebSocket error: ${err.message}`);
      await session.cleanup();
    });
  });

  console.log("[esp32voice] Voice WebSocket server created");
  return wss;
}

/**
 * Handle an HTTP upgrade request for the voice WebSocket.
 */
export function handleVoiceUpgrade(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  // Accept any upgrade on this server — it's dedicated to voice
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
}

/**
 * Start a standalone HTTP + WebSocket server for ESP32 voice streaming.
 *
 * This server runs on its own port (separate from the Gateway) so that
 * WebSocket upgrades are handled directly by the esp32-voice plugin
 * without needing core Gateway changes.
 *
 * @returns The HTTP server instance (for cleanup).
 */
export function startStandaloneVoiceServer(port?: number): {
  httpServer: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  port: number;
} {
  const listenPort = port ?? DEFAULT_VOICE_PORT;
  const wss = createVoiceWebSocketServer();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    // Health check endpoint
    if (url === "/" || url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "esp32-voice",
          type: "websocket",
          hint: "Connect via WebSocket to this server for voice streaming",
          sttConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
          ttsConfigured: Boolean(process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY),
        }),
      );
      return;
    }

    // Fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Connect via WebSocket for voice streaming." }));
  });

  // Handle WebSocket upgrades on ANY path on this server
  httpServer.on("upgrade", (request, socket, head) => {
    handleVoiceUpgrade(wss, request, socket as Duplex, head);
  });

  httpServer.listen(listenPort, "0.0.0.0", () => {
    console.log(`[esp32voice] Standalone voice server listening on ws://0.0.0.0:${listenPort}`);
    console.log(`[esp32voice] ESP32 should connect to ws://<your-ip>:${listenPort}/`);
  });

  return { httpServer, wss, port: listenPort };
}
