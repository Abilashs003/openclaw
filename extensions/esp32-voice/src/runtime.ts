import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setEsp32VoiceRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getEsp32VoiceRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("ESP32 Voice runtime not initialized");
  }
  return runtime;
}
