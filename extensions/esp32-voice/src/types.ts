import type { DmPolicy } from "openclaw/plugin-sdk";

// ── STT / TTS Provider Config ─────────────────────────────────

export type SttProviderChoice = "deepgram" | "google" | "whisper" | "azure" | string;
export type TtsProviderChoice = "elevenlabs" | "google" | "edge-tts" | "azure" | string;

// ── Device / Account Config ───────────────────────────────────

/**
 * Configuration for a single ESP32 Voice device account.
 */
export type Esp32VoiceAccountConfig = {
  /** Optional human-readable name for this device. */
  name?: string;
  /** If false, do not accept messages from this device. Default: true. */
  enabled?: boolean;

  // ── Authentication ──
  /**
   * Shared secret token for device authentication.
   * Generated during OTP pairing or set manually.
   */
  deviceToken?: string;
  /** Unique device identifier. */
  deviceId?: string;

  // ── Security ──
  /** DM security policy. Default: "pairing". */
  dmPolicy?: DmPolicy;
  /** Allowlist of device IDs allowed to communicate. */
  allowFrom?: string[];

  // ── STT Configuration ──
  /** Speech-to-text provider ID. Default: "deepgram". */
  sttProvider?: SttProviderChoice;
  /** STT API key (overrides env var). */
  sttApiKey?: string;
  /** STT model (e.g., "nova-2" for Deepgram). */
  sttModel?: string;

  // ── TTS Configuration ──
  /** Text-to-speech provider ID. Default: "elevenlabs". */
  ttsProvider?: TtsProviderChoice;
  /** TTS API key (overrides env var). */
  ttsApiKey?: string;
  /** TTS voice ID. */
  ttsVoiceId?: string;
  /** TTS model ID. */
  ttsModel?: string;

  // ── Voice Pipeline ──
  /** Max response length in characters. Default: 500. */
  maxResponseLength?: number;
  /** Whether to optimize prompts for voice output. Default: true. */
  voiceOptimized?: boolean;
  /** Language code (ISO 639-1). Default: "en". */
  language?: string;
};

/**
 * Top-level ESP32 Voice channel configuration.
 * Supports single-device (flat) and multi-device (accounts map) modes.
 */
export type Esp32VoiceConfig = {
  /** Per-device configuration (multi-device mode). */
  accounts?: Record<string, Esp32VoiceAccountConfig>;
} & Esp32VoiceAccountConfig;

/**
 * Resolved account with computed defaults and source tracking.
 */
export type ResolvedEsp32VoiceAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  deviceToken?: string;
  deviceTokenSource: "config" | "env" | "none";
  deviceId?: string;
  sttProvider: string;
  sttApiKey?: string;
  sttModel?: string;
  ttsProvider: string;
  ttsApiKey?: string;
  ttsVoiceId?: string;
  ttsModel?: string;
  maxResponseLength: number;
  voiceOptimized: boolean;
  language: string;
  config: Esp32VoiceAccountConfig;
};

// ── Voice Protocol Messages ───────────────────────────────────

/**
 * Hello message sent by the ESP32 during WebSocket handshake.
 * Contains OpenClaw credentials, STT/TTS provider config, and optional OTP.
 */
export type Esp32VoiceHelloMessage = {
  type: "hello";
  /** Device identifier. */
  deviceId?: string;
  /** Device firmware version. */
  version?: number;
  /** Transport type (always "websocket" for ESP32). */
  transport?: string;
  /** Audio parameters. */
  audio_params?: {
    format: string;
    sample_rate: number;
    channels: number;
    frame_duration?: number;
  };
  /** OTP code for initial pairing. */
  otp?: string;
  /** OpenClaw Gateway credentials. */
  openclaw?: {
    url: string;
    token: string;
  };
  /** STT provider overrides. */
  stt?: {
    provider?: string;
    apiKey?: string;
    model?: string;
  };
  /** TTS provider overrides. */
  tts?: {
    provider?: string;
    apiKey?: string;
    voiceId?: string;
    model?: string;
  };
  /** Language code. */
  language?: string;
};
