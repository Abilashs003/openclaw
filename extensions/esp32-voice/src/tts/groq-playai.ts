/**
 * Groq PlayAI Text-to-Speech provider (batch HTTP).
 *
 * Uses Groq's OpenAI-compatible REST API. Not streaming — full audio
 * is synthesized before delivery begins. Best used as a low-cost fallback.
 *
 * Audio: WAV response → strip 44-byte header → raw PCM (24kHz, 16-bit mono).
 * No new npm dependencies — uses Node.js built-in https module.
 *
 * Docs: https://console.groq.com/docs/text-to-speech
 */

import https from "https";
import type {
  TtsProvider,
  TtsProviderConfig,
  TtsProviderMeta,
  TtsAudioCallback,
  TtsDoneCallback,
} from "./tts-provider.js";
import { ttsRegistry } from "./tts-registry.js";

const WAV_HEADER_BYTES = 44;
const GROQ_TTS_HOST = "api.groq.com";
const GROQ_TTS_PATH = "/openai/v1/audio/speech";

const DEFAULT_VOICE = "troy";
const DEFAULT_MODEL = "canopylabs/orpheus-v1-english";

export class GroqPlayAiTtsProvider implements TtsProvider {
  readonly id = "groq-playai";
  readonly name = "Groq PlayAI";
  readonly streaming = false;  // batch HTTP — not streaming
  readonly outputSampleRate = 24000;

  onAudio: TtsAudioCallback | null = null;
  onDone: TtsDoneCallback | null = null;

  private apiKey: string;
  private voice: string;
  private model: string;
  private textBuffer: string[] = [];

  constructor(config: TtsProviderConfig) {
    this.apiKey = config.apiKey;
    this.voice = config.voiceId ?? DEFAULT_VOICE;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  // No-op: HTTP is stateless
  async connect(): Promise<void> {
    console.log("[groq-playai-tts] Ready (batch HTTP mode)");
  }

  async synthesize(text: string): Promise<void> {
    this.textBuffer.push(text);
  }

  async flush(): Promise<void> {
    const fullText = this.textBuffer.join(" ").trim();
    this.textBuffer = [];

    if (!fullText) {
      this.fireDone();
      return;
    }

    const wavBuffer = await this.fetchWav(fullText);

    // Strip WAV header (44 bytes) to get raw PCM
    const pcm = wavBuffer.subarray(WAV_HEADER_BYTES);

    // Deliver in chunks (same size as voice-session frame buffer)
    const CHUNK_SIZE = 4096;
    for (let offset = 0; offset < pcm.length; offset += CHUNK_SIZE) {
      const chunk = pcm.subarray(offset, offset + CHUNK_SIZE);
      if (this.onAudio) {
        await this.onAudio(chunk);
      }
    }

    this.fireDone();
  }

  // No-op: nothing to close for HTTP
  async close(): Promise<void> {}

  private fetchWav(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: "wav",
      });

      const req = https.request(
        {
          hostname: GROQ_TTS_HOST,
          path: GROQ_TTS_PATH,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`[groq-playai-tts] HTTP ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      );

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private fireDone(): void {
    if (this.onDone) {
      const result = this.onDone();
      if (result instanceof Promise) {
        result.catch((err) => console.error("[groq-playai-tts] Done callback error:", err));
      }
    }
  }
}

export const groqPlayAiMeta: TtsProviderMeta = {
  id: "groq-playai",
  name: "Groq PlayAI",
  description: "Batch HTTP TTS via Groq. Lowest cost option. Higher latency than streaming providers (full synthesis before playback).",
  streaming: false,
  envVar: "GROQ_API_KEY",
  defaultVoiceId: DEFAULT_VOICE,
  defaultModel: DEFAULT_MODEL,
  outputSampleRate: 24000,
  docsUrl: "https://console.groq.com/docs/text-to-speech",
};

ttsRegistry.register(groqPlayAiMeta, (config) => new GroqPlayAiTtsProvider(config));
