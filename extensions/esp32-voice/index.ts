import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { esp32VoicePlugin } from "./src/channel.js";
import { setEsp32VoiceRuntime } from "./src/runtime.js";
import { startStandaloneVoiceServer } from "./src/voice/voice-endpoint.js";

// Import STT/TTS providers to trigger auto-registration with the registries
import "./src/stt/deepgram.js";
import "./src/tts/elevenlabs.js";

const VOICE_PORT = parseInt(process.env.ESP32_VOICE_PORT ?? "8765", 10);

const plugin = {
  id: "esp32-voice",
  name: "ESP32 Voice",
  description:
    "ESP32 Voice device channel — voice-to-text-to-voice with pluggable STT/TTS providers",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setEsp32VoiceRuntime(api.runtime);

    // Register the ESP32 Voice channel
    api.registerChannel({ plugin: esp32VoicePlugin });

    // ── Standalone Voice WebSocket Server ─────────────────────────
    //
    // The OpenClaw Gateway plugin API does NOT support WebSocket upgrade
    // registration — registerHttpRoute() only handles regular HTTP requests.
    // When an ESP32 tries to upgrade to WebSocket on the Gateway port (18789),
    // the Gateway's own upgrade handler intercepts it and routes it to the
    // Gateway's internal WS server instead of this plugin.
    //
    // Solution: spin up a dedicated HTTP server on a separate port (8765).
    // The ESP32 firmware connects directly to this server. No core changes needed.
    //
    const { port } = startStandaloneVoiceServer(VOICE_PORT);

    // ── Gateway HTTP routes (non-WS utilities) ────────────────────

    // Info route (tells callers this path needs a WS connection on the voice port)
    api.registerHttpRoute({
      path: "/__openclaw__/esp32-voice/stream",
      handler: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            service: "esp32-voice",
            type: "websocket",
            hint: `Connect your ESP32 via WebSocket to ws://<your-ip>:${port}/`,
            voicePort: port,
          }),
        );
      },
    });

    // Health endpoint (via Gateway port for convenience)
    api.registerHttpRoute({
      path: "/__openclaw__/esp32-voice/health",
      handler: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            service: "esp32-voice",
            voicePort: port,
            voiceWsUrl: `ws://<your-ip>:${port}/`,
            sttConfigured: Boolean(
              process.env.DEEPGRAM_API_KEY ||
                api.config?.channels?.esp32voice?.sttApiKey,
            ),
            ttsConfigured: Boolean(
              process.env.ELEVENLABS_API_KEY ||
                process.env.XI_API_KEY ||
                api.config?.channels?.esp32voice?.ttsApiKey,
            ),
          }),
        );
      },
    });

    // OTP generation endpoint
    api.registerHttpRoute({
      path: "/__openclaw__/esp32-voice/otp",
      handler: async (_req, res) => {
        const { deviceOtpManager } = await import("./src/device/device-otp.js");
        const code = deviceOtpManager.generateOtp();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code, expiresInSeconds: 300 }));
      },
    });

    // Paired devices listing
    api.registerHttpRoute({
      path: "/__openclaw__/esp32-voice/devices",
      handler: async (_req, res) => {
        const { deviceOtpManager } = await import("./src/device/device-otp.js");
        const devices = deviceOtpManager.listPairedDevices();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ devices }));
      },
    });

    console.log("[esp32voice] Plugin registered successfully");
    console.log(`[esp32voice] Voice WebSocket (standalone): ws://0.0.0.0:${port}/`);
    console.log(`[esp32voice] Point your ESP32 to:          ws://<your-mac-ip>:${port}/`);
    console.log(`[esp32voice] Health check (Gateway port):  http://<gateway>/__openclaw__/esp32-voice/health`);
    console.log(`[esp32voice] Generate OTP:                 http://<gateway>/__openclaw__/esp32-voice/otp`);
  },
};

export default plugin;

// Exports for consumers / third-party provider plugins
export { startStandaloneVoiceServer };
export { sttRegistry } from "./src/stt/stt-registry.js";
export { ttsRegistry } from "./src/tts/tts-registry.js";
export type { SttProvider, SttProviderConfig, SttProviderMeta } from "./src/stt/stt-provider.js";
export type { TtsProvider, TtsProviderConfig, TtsProviderMeta } from "./src/tts/tts-provider.js";
