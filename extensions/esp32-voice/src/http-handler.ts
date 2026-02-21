import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveEsp32VoiceAccount, listEsp32VoiceAccountIds } from "./accounts.js";
import type {
  Esp32VoiceInboundMessage,
  Esp32VoiceOutboundResponse,
  ResolvedEsp32VoiceAccount,
} from "./types.js";

/**
 * Authenticate an incoming ESP32 HTTP request.
 *
 * Checks the `Authorization: Bearer <token>` header against all configured
 * device account tokens. Returns the matching account or null.
 */
export function authenticateEsp32Request(
  req: IncomingMessage,
  cfg: OpenClawConfig,
): ResolvedEsp32VoiceAccount | null {
  const authHeader = req.headers.authorization?.trim();
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  if (!token) {
    return null;
  }

  // Check all configured accounts for a matching device token.
  const accountIds = listEsp32VoiceAccountIds(cfg);
  for (const accountId of accountIds) {
    const account = resolveEsp32VoiceAccount({ cfg, accountId });
    if (account.enabled && account.deviceToken && account.deviceToken === token) {
      return account;
    }
  }

  return null;
}

/**
 * Parse the JSON body from an ESP32 POST request.
 */
export async function parseEsp32RequestBody(req: IncomingMessage): Promise<{
  ok: boolean;
  data?: Esp32VoiceInboundMessage;
  error?: string;
}> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const maxBodySize = 64 * 1024; // 64 KB max body

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBodySize) {
        resolve({ ok: false, error: "Request body too large (max 64 KB)" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(raw);

        if (!parsed || typeof parsed.text !== "string") {
          resolve({
            ok: false,
            error: 'Invalid request body: expected JSON with "text" field',
          });
          return;
        }

        const message: Esp32VoiceInboundMessage = {
          text: parsed.text.trim(),
          deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId.trim() : undefined,
          language: typeof parsed.language === "string" ? parsed.language.trim() : undefined,
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : undefined,
        };

        if (!message.text) {
          resolve({ ok: false, error: "Empty text field" });
          return;
        }

        resolve({ ok: true, data: message });
      } catch {
        resolve({ ok: false, error: "Invalid JSON in request body" });
      }
    });

    req.on("error", (err) => {
      resolve({ ok: false, error: `Request error: ${err.message}` });
    });
  });
}

/**
 * Send a JSON response back to the ESP32 device.
 */
export function sendEsp32Response(
  res: ServerResponse,
  status: number,
  body: Esp32VoiceOutboundResponse,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    // ESP32 may not handle CORS but include for debugging from browsers.
    "Access-Control-Allow-Origin": "*",
  });
  res.end(json);
}

/**
 * Truncate response text to the configured maximum length.
 * Tries to break at a sentence boundary when possible.
 */
export function truncateForVoice(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Try to break at the last sentence boundary within the limit.
  const truncated = text.slice(0, maxLength);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf(".\n"),
  );

  if (lastSentenceEnd > maxLength * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }

  // Fall back to word boundary.
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace).trim() + "…";
  }

  return truncated.trim() + "…";
}
