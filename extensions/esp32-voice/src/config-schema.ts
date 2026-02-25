import { DmPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const Esp32VoiceAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),

    // Auth
    deviceToken: z.string().optional(),
    deviceId: z.string().optional(),

    // Security
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),

    // STT
    sttProvider: z.string().optional().default("deepgram"),
    sttApiKey: z.string().optional(),
    sttModel: z.string().optional(),

    // TTS
    ttsProvider: z.enum([
      "elevenlabs",
      "rime",
      "inworld",
      "cartesia",
      "smallest-ai",
      "groq-playai",
    ]).optional().default("elevenlabs"),
    ttsApiKey: z.string().optional(),
    ttsVoiceId: z.string().optional(),
    ttsModel: z.string().optional(),

    // Voice pipeline
    maxResponseLength: z.number().int().positive().optional().default(500),
    voiceOptimized: z.boolean().optional().default(true),
    language: z.string().optional().default("en"),
  })
  .strict();

export const Esp32VoiceConfigSchema = Esp32VoiceAccountSchemaBase.extend({
  accounts: z.record(z.string(), Esp32VoiceAccountSchemaBase.optional()).optional(),
});
