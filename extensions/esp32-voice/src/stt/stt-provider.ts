/**
 * Speech-to-Text (STT) provider interface.
 *
 * All STT providers must implement this interface. Providers can be
 * streaming (WebSocket-based, sending audio chunks in real time) or
 * batch (send complete audio, receive transcript).
 *
 * Modeled after OpenClaw's multi-provider architecture — new providers
 * can be added by implementing this interface and registering with
 * the STT registry.
 */

export type SttTranscriptCallback = (text: string, isFinal: boolean) => void | Promise<void>;

/** Called when the STT provider detects end of speech (server-side VAD). */
export type SttSpeechEndCallback = () => void | Promise<void>;

export interface SttProviderConfig {
  /** Provider-specific API key. */
  apiKey: string;
  /** Model identifier (e.g., "nova-2" for Deepgram). */
  model?: string;
  /** Language code (e.g., "en", "es"). */
  language?: string;
  /** Additional provider-specific options. */
  options?: Record<string, unknown>;
}

export interface SttProvider {
  /** Unique provider identifier (e.g., "deepgram", "google", "whisper"). */
  readonly id: string;

  /** Human-readable provider name. */
  readonly name: string;

  /** Whether this provider supports real-time streaming via WebSocket. */
  readonly streaming: boolean;

  /**
   * Called when a transcript (partial or final) is received.
   * Set this before calling `connect()`.
   */
  onTranscript: SttTranscriptCallback | null;

  /**
   * Called when the STT provider detects end of speech via server-side VAD
   * (e.g., Deepgram speech_final). Used to trigger utterance processing
   * automatically when the firmware doesn't send a speech_end message.
   */
  onSpeechEnd?: SttSpeechEndCallback | null;

  /**
   * Open a connection to the STT service.
   * For streaming providers, this opens a WebSocket.
   * For batch providers, this may be a no-op.
   */
  connect(): Promise<void>;

  /**
   * Send an audio chunk to the STT service.
   * For streaming providers: sends Opus/PCM frames in real time.
   * For batch providers: buffers audio until `finalize()` is called.
   *
   * @param audioData - Raw audio bytes (Opus frames from ESP32)
   */
  sendAudio(audioData: Buffer): Promise<void>;

  /**
   * Signal end of audio and retrieve the final transcript.
   * For streaming providers: sends a "close stream" signal and waits.
   * For batch providers: sends buffered audio and waits for result.
   *
   * @returns The complete, final transcript text.
   */
  finalize(): Promise<string>;

  /**
   * Close the connection and release resources.
   */
  close(): Promise<void>;
}

/**
 * Factory function type for creating STT provider instances.
 * Each call creates a fresh provider for one utterance/session.
 */
export type SttProviderFactory = (config: SttProviderConfig) => SttProvider;

/**
 * Metadata about a registered STT provider.
 */
export interface SttProviderMeta {
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
  /** Default model identifier. */
  defaultModel?: string;
  /** Documentation URL. */
  docsUrl?: string;
}
