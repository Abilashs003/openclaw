/**
 * Text-to-Speech (TTS) provider interface.
 *
 * All TTS providers must implement this interface. Providers can be
 * streaming (WebSocket-based, receiving audio chunks in real time) or
 * batch (send complete text, receive full audio).
 *
 * Modeled after OpenClaw's multi-provider architecture — new providers
 * can be added by implementing this interface and registering with
 * the TTS registry.
 */

export type TtsAudioCallback = (pcmChunk: Buffer) => void | Promise<void>;
export type TtsDoneCallback = () => void | Promise<void>;

export interface TtsProviderConfig {
  /** Provider-specific API key. */
  apiKey: string;
  /** Voice identifier (e.g., ElevenLabs voice ID). */
  voiceId?: string;
  /** Model identifier. */
  model?: string;
  /** Language code. */
  language?: string;
  /** Output sample rate in Hz (default: 24000). */
  sampleRate?: number;
  /** Additional provider-specific options. */
  options?: Record<string, unknown>;
}

export interface TtsProvider {
  /** Unique provider identifier (e.g., "elevenlabs", "google", "edge-tts"). */
  readonly id: string;

  /** Human-readable provider name. */
  readonly name: string;

  /** Whether this provider supports real-time streaming. */
  readonly streaming: boolean;

  /** Output sample rate in Hz. */
  readonly outputSampleRate: number;

  /**
   * Called when PCM audio data is received from the TTS service.
   * Audio format: 16-bit signed LE PCM, mono, at `outputSampleRate` Hz.
   * Set this before calling `connect()`.
   */
  onAudio: TtsAudioCallback | null;

  /**
   * Called when the TTS synthesis is complete (all audio sent).
   * Set this before calling `connect()`.
   */
  onDone: TtsDoneCallback | null;

  /**
   * Open a connection to the TTS service.
   * For streaming providers, this opens a WebSocket.
   */
  connect(): Promise<void>;

  /**
   * Send text to be synthesized into speech.
   * For streaming providers: can be called multiple times for partial text.
   * For batch providers: should be called once with the full text.
   *
   * @param text - The text to synthesize.
   */
  synthesize(text: string): Promise<void>;

  /**
   * Signal end of text input and wait for all audio to be delivered.
   * After this resolves, all audio has been sent via `onAudio`.
   */
  flush(): Promise<void>;

  /**
   * Close the connection and release resources.
   */
  close(): Promise<void>;
}

/**
 * Factory function type for creating TTS provider instances.
 */
export type TtsProviderFactory = (config: TtsProviderConfig) => TtsProvider;

/**
 * Metadata about a registered TTS provider.
 */
export interface TtsProviderMeta {
  /** Provider ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description. */
  description: string;
  /** Whether it supports streaming. */
  streaming: boolean;
  /** Required environment variable for the API key. */
  envVar: string;
  /** Default voice ID. */
  defaultVoiceId?: string;
  /** Default model. */
  defaultModel?: string;
  /** Output sample rate. */
  outputSampleRate: number;
  /** Documentation URL. */
  docsUrl?: string;
}
