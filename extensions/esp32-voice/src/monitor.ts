import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedEsp32VoiceAccount } from "./types.js";
import {
  authenticateEsp32Request,
  parseEsp32RequestBody,
  sendEsp32Response,
  truncateForVoice,
} from "./http-handler.js";
import { getEsp32VoiceRuntime } from "./runtime.js";

type MonitorParams = {
  accountId: string;
  config: OpenClawConfig;
  runtime: ReturnType<typeof getEsp32VoiceRuntime>;
  abortSignal: AbortSignal;
  statusSink: (patch: Record<string, unknown>) => void;
};

/**
 * Start monitoring for ESP32 Voice inbound messages.
 *
 * Registers an HTTP route on the Gateway at:
 *   POST /__openclaw__/esp32-voice/message
 *
 * The ESP32 device sends transcribed text here and receives
 * the AI response synchronously in the HTTP response.
 *
 * Flow:
 * 1. ESP32 captures audio → runs STT → gets text
 * 2. ESP32 POSTs { text, deviceId?, sessionId? } with Bearer token
 * 3. Gateway authenticates, routes to agent, waits for response
 * 4. Gateway responds with { ok, text, sessionId }
 * 5. ESP32 receives text → runs TTS → plays audio
 */
export function monitorEsp32VoiceProvider(params: MonitorParams): void {
  const { statusSink, abortSignal } = params;

  statusSink({
    running: true,
    connected: true,
    lastStartAt: new Date().toISOString(),
  });

  console.log(`[esp32voice] Channel ready. ESP32 devices can POST to the Gateway HTTP endpoint.`);
  console.log(
    `[esp32voice] Endpoint: POST /__openclaw__/esp32-voice/message`,
  );

  // The HTTP handler is registered via the plugin's registerHttpRoute.
  // The monitor just tracks lifecycle state.
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      statusSink({
        running: false,
        connected: false,
        lastStopAt: new Date().toISOString(),
      });
      console.log("[esp32voice] Channel stopped.");
    });
  }
}

/**
 * Process an inbound ESP32 message through the agent and return the response.
 *
 * This is called from the HTTP route handler. It:
 * 1. Validates the authenticated account
 * 2. Sends the transcribed text to the OpenClaw agent
 * 3. Waits for the agent response
 * 4. Truncates the response for voice output
 * 5. Returns the response text for TTS on the device
 */
export async function processEsp32Message(params: {
  text: string;
  account: ResolvedEsp32VoiceAccount;
  deviceId: string;
  sessionId?: string;
}): Promise<{ ok: boolean; text?: string; error?: string; sessionId?: string }> {
  const { text, account, deviceId, sessionId } = params;
  const runtime = getEsp32VoiceRuntime();

  try {
    // Build a voice-optimized system hint if enabled.
    let messageText = text;
    if (account.voiceOptimized) {
      // The agent will receive this as a regular message; the channel's
      // agentPrompt adapter adds the voice-optimization context.
      messageText = text;
    }

    // Route the message through the OpenClaw agent via the runtime.
    const result = await runtime.channel.processInboundMessage({
      channel: "esp32voice",
      from: deviceId,
      text: messageText,
      accountId: account.accountId,
    });

    if (!result || !result.text) {
      return {
        ok: false,
        error: "No response from agent",
        sessionId,
      };
    }

    // Truncate for voice output.
    const responseText = truncateForVoice(result.text, account.maxResponseLength);

    return {
      ok: true,
      text: responseText,
      sessionId: sessionId ?? result.sessionId,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`[esp32voice] Error processing message from ${deviceId}: ${errorMessage}`);
    return {
      ok: false,
      error: `Processing error: ${errorMessage}`,
      sessionId,
    };
  }
}
