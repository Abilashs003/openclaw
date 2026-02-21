/**
 * STT Provider Registry.
 *
 * Central registry for speech-to-text providers. Providers register
 * themselves with a factory function, and the voice session creates
 * instances as needed.
 *
 * Usage:
 *   sttRegistry.register(deepgramMeta, createDeepgramStt);
 *   const provider = sttRegistry.create("deepgram", { apiKey: "..." });
 */

import type { SttProvider, SttProviderConfig, SttProviderFactory, SttProviderMeta } from "./stt-provider.js";

interface RegisteredSttProvider {
  meta: SttProviderMeta;
  factory: SttProviderFactory;
}

class SttRegistry {
  private providers = new Map<string, RegisteredSttProvider>();

  /**
   * Register a new STT provider.
   */
  register(meta: SttProviderMeta, factory: SttProviderFactory): void {
    if (this.providers.has(meta.id)) {
      console.warn(`[stt-registry] Provider "${meta.id}" is already registered, overwriting.`);
    }
    this.providers.set(meta.id, { meta, factory });
    console.log(`[stt-registry] Registered STT provider: ${meta.name} (${meta.id})`);
  }

  /**
   * Create an instance of a registered STT provider.
   */
  create(providerId: string, config: SttProviderConfig): SttProvider {
    const registered = this.providers.get(providerId);
    if (!registered) {
      const available = [...this.providers.keys()].join(", ");
      throw new Error(
        `STT provider "${providerId}" not found. Available: ${available || "none"}`,
      );
    }
    return registered.factory(config);
  }

  /**
   * Get metadata for a registered provider.
   */
  getMeta(providerId: string): SttProviderMeta | undefined {
    return this.providers.get(providerId)?.meta;
  }

  /**
   * List all registered providers.
   */
  list(): SttProviderMeta[] {
    return [...this.providers.values()].map((p) => p.meta);
  }

  /**
   * Check if a provider is registered.
   */
  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }
}

/** Global STT provider registry. */
export const sttRegistry = new SttRegistry();
