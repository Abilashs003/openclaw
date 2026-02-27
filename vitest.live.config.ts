import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: [
      "extensions/esp32-voice/src/tts/tts-providers.live.test.ts",
      "extensions/esp32-voice/src/stt/stt-providers.live.test.ts",
    ],
    exclude: [],
    pool: "forks",
    maxWorkers: 1,
  },
});
