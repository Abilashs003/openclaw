/**
 * TTS Provider Registry.
 *
 * Central registry for text-to-speech providers. Providers register
 * themselves with a factory function, and the voice session creates
 * instances as needed.
 *
 * Usage:
 *   ttsRegistry.register(elevenlabsMeta, createElevenLabsTts);
 *   const provider = ttsRegistry.create("elevenlabs", { apiKey: "..." });
 */

import type { TtsProvider, TtsProviderConfig, TtsProviderFactory, TtsProviderMeta } from "./tts-provider.js";

interface RegisteredTtsProvider {
  meta: TtsProviderMeta;
  factory: TtsProviderFactory;
}

class TtsRegistry {
  private providers = new Map<string, RegisteredTtsProvider>();

  /**
   * Register a new TTS provider.
   */
  register(meta: TtsProviderMeta, factory: TtsProviderFactory): void {
    if (this.providers.has(meta.id)) {
      console.warn(`[tts-registry] Provider "${meta.id}" is already registered, overwriting.`);
    }
    this.providers.set(meta.id, { meta, factory });
    console.log(`[tts-registry] Registered TTS provider: ${meta.name} (${meta.id})`);
  }

  /**
   * Create an instance of a registered TTS provider.
   */
  create(providerId: string, config: TtsProviderConfig): TtsProvider {
    const registered = this.providers.get(providerId);
    if (!registered) {
      const available = [...this.providers.keys()].join(", ");
      throw new Error(
        `TTS provider "${providerId}" not found. Available: ${available || "none"}`,
      );
    }
    return registered.factory(config);
  }

  /**
   * Get metadata for a registered provider.
   */
  getMeta(providerId: string): TtsProviderMeta | undefined {
    return this.providers.get(providerId)?.meta;
  }

  /**
   * List all registered providers.
   */
  list(): TtsProviderMeta[] {
    return [...this.providers.values()].map((p) => p.meta);
  }

  /**
   * Check if a provider is registered.
   */
  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }
}

/** Global TTS provider registry. */
export const ttsRegistry = new TtsRegistry();
