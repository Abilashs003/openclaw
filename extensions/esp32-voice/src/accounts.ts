import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { Esp32VoiceAccountConfig, ResolvedEsp32VoiceAccount } from "./types.js";

/**
 * List all configured ESP32 Voice account IDs.
 */
export function listEsp32VoiceAccountIds(cfg: OpenClawConfig): string[] {
  const section = cfg.channels?.esp32voice as Esp32VoiceAccountConfig & {
    accounts?: Record<string, Esp32VoiceAccountConfig>;
  };
  if (!section) {
    return [];
  }

  const ids = new Set<string>();

  // Base-level config counts as the "default" account.
  if (section.deviceToken || section.deviceId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  // Named accounts.
  if (section.accounts) {
    for (const key of Object.keys(section.accounts)) {
      ids.add(normalizeAccountId(key));
    }
  }

  return [...ids];
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultEsp32VoiceAccountId(cfg: OpenClawConfig): string {
  const ids = listEsp32VoiceAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a fully populated account config for a given account ID.
 * Merges base-level config ← per-account overrides ← env vars.
 */
export function resolveEsp32VoiceAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedEsp32VoiceAccount {
  const { cfg, accountId: rawAccountId } = params;
  const accountId = normalizeAccountId(rawAccountId ?? DEFAULT_ACCOUNT_ID);

  const section = cfg.channels?.esp32voice as Esp32VoiceAccountConfig & {
    accounts?: Record<string, Esp32VoiceAccountConfig>;
  };

  const base: Esp32VoiceAccountConfig = section ?? {};
  const perAccount = section?.accounts?.[accountId] ?? {};

  // Per-account fields override base fields.
  const merged: Esp32VoiceAccountConfig = { ...base, ...perAccount };

  // ── Resolve device token ──
  let deviceToken = merged.deviceToken?.trim() || undefined;
  let deviceTokenSource: "config" | "env" | "none" = deviceToken ? "config" : "none";
  if (!deviceToken) {
    const envToken = process.env.ESP32_VOICE_DEVICE_TOKEN?.trim();
    if (envToken) {
      deviceToken = envToken;
      deviceTokenSource = "env";
    }
  }

  // ── Resolve STT API key ──
  let sttApiKey = merged.sttApiKey?.trim() || undefined;
  if (!sttApiKey) {
    sttApiKey = process.env.DEEPGRAM_API_KEY?.trim() || undefined;
  }

  // ── Resolve TTS API key ──
  let ttsApiKey = merged.ttsApiKey?.trim() || undefined;
  if (!ttsApiKey) {
    ttsApiKey = process.env.ELEVENLABS_API_KEY?.trim() || process.env.XI_API_KEY?.trim() || undefined;
  }

  // ── Resolve TTS voice ID ──
  let ttsVoiceId = merged.ttsVoiceId?.trim() || undefined;
  if (!ttsVoiceId) {
    ttsVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || undefined;
  }

  return {
    accountId,
    name: merged.name,
    enabled: merged.enabled !== false,
    deviceToken,
    deviceTokenSource,
    deviceId: merged.deviceId || accountId,
    sttProvider: merged.sttProvider ?? "deepgram",
    sttApiKey,
    sttModel: merged.sttModel,
    ttsProvider: merged.ttsProvider ?? "elevenlabs",
    ttsApiKey,
    ttsVoiceId,
    ttsModel: merged.ttsModel,
    maxResponseLength: merged.maxResponseLength ?? 500,
    voiceOptimized: merged.voiceOptimized !== false,
    language: merged.language ?? "en",
    config: merged,
  };
}
