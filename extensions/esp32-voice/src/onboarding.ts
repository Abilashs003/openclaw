/**
 * ESP32 Voice — Setup Wizard (ChannelOnboardingAdapter)
 *
 * Runs automatically when the user does:
 *   openclaw channels add --channel esp32voice
 *
 * Guides the user through:
 *   Step 1 — Login to Cheeko dashboard (browser link + pairing token)
 *   Step 2 — STT setup (Deepgram API key)
 *   Step 3 — TTS setup (ElevenLabs API key + voice)
 *   Step 4 — Add device (browser link to dashboard)
 *
 * Logout / re-setup:
 *   openclaw channels add --channel esp32voice   (re-runs this wizard)
 *   To fully reset: remove CHEEKO_PAIR from ~/.openclaw/.env
 */

import {
  formatDocsLink,
  type ChannelOnboardingAdapter,
  type WizardPrompter,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { detectLocalIp } from "./voice/voice-endpoint.js";

// Dashboard UI URL — shown to user to open in browser (Vue frontend)
const DASHBOARD_URL = process.env.CHEEKO_DASHBOARD_URL?.replace(/\/$/, "") || "http://64.227.170.31:8001";

// Backend API URL — used for REST calls (manager-api-node, port 8002 + /toy context path)
const BACKEND_API_URL = process.env.CHEEKO_API_URL?.replace(/\/$/, "") || "http://64.227.170.31:8002/toy";

const VOICE_PORT = process.env.ESP32_VOICE_PORT || "8765";

// ── Env helpers ───────────────────────────────────────────────────────────────

function readEnvFile(): string[] {
  const envPath = getEnvPath();
  if (!existsSync(envPath)) return [];
  return readFileSync(envPath, "utf8").split("\n");
}

function getEnvPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
  return join(stateDir, ".env");
}

function saveToEnv(pairs: Record<string, string>): void {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  const envPath = getEnvPath();
  let lines = readEnvFile();

  for (const [key, value] of Object.entries(pairs)) {
    const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx !== -1) {
      lines[idx] = line;
    } else {
      lines.push(line);
    }
  }

  writeFileSync(envPath, lines.join("\n").trimEnd() + "\n", "utf8");
}

function clearFromEnv(keys: string[]): void {
  const envPath = getEnvPath();
  if (!existsSync(envPath)) return;
  let lines = readFileSync(envPath, "utf8").split("\n");
  lines = lines.filter((l) => !keys.some((k) => l.trimStart().startsWith(`${k}=`)));
  writeFileSync(envPath, lines.join("\n").trimEnd() + "\n", "utf8");
}

function getEnvValue(key: string): string | undefined {
  // Check process.env first (already loaded)
  if (process.env[key]) return process.env[key];
  // Then check .env file directly
  const lines = readEnvFile();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.slice(key.length + 1).trim();
    }
  }
  return undefined;
}

// ── Gateway token helper ───────────────────────────────────────────────────────

/**
 * Read the OpenClaw gateway token from process.env or ~/.openclaw/openclaw.json.
 * The plugin needs this to authenticate its internal WebSocket connection to the gateway.
 */
function readGatewayToken(): string | undefined {
  // Already in env — daemon mode injects it, or user set it manually
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;

  // Fall back to reading from ~/.openclaw/openclaw.json → gateway.auth.token
  try {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
    const configPath = join(stateDir, "openclaw.json");
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const token = (raw?.gateway as Record<string, unknown>)?.auth;
      const authToken = (token as Record<string, unknown>)?.token;
      if (authToken && typeof authToken === "string") return authToken;
    }
  } catch {
    // Ignore parse errors — config may not exist yet
  }
  return undefined;
}

// ── Browser helper ────────────────────────────────────────────────────────────

/**
 * Open a URL in the user's default browser.
 * macOS: open, Linux: xdg-open, Windows: start
 */
function openInBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => { /* best-effort — ignore if browser can't open */ });
    child.unref();
  } catch {
    // Ignore — browser open is non-critical
  }
}

// ── Step 1 — Cheeko Dashboard Login + Pairing ─────────────────────────────────

async function stepCheekoLogin(prompter: WizardPrompter): Promise<boolean> {
  const existingPair = getEnvValue("CHEEKO_PAIR");

  // Already paired — offer to re-pair or skip
  if (existingPair) {
    await prompter.note(
      [
        "You are already connected to the Cheeko dashboard.",
        `Pairing token: ${existingPair.slice(0, 4)}****`,
        "",
        "To disconnect: clear CHEEKO_PAIR from ~/.openclaw/.env",
        "To re-pair: run openclaw channels add --channel esp32voice",
      ].join("\n"),
      "Already connected",
    );

    const rePair = await prompter.confirm({
      message: "Re-connect to Cheeko dashboard with a new token?",
      initialValue: false,
    });
    if (!rePair) return true; // Skip, already paired
  }

  // Auto-open the dashboard in the user's browser
  openInBrowser(`${DASHBOARD_URL}/login`);

  // Show login instructions
  await prompter.note(
    [
      "Step 1: The Cheeko dashboard has been opened in your browser.",
      "",
      `${formatDocsLink(`${DASHBOARD_URL}/login`, "Open Cheeko Dashboard →")}`,
      "(opens automatically — click if it didn't open)",
      "",
      "After logging in, go to:",
      "  Settings → Connect OpenClaw",
      "",
      "The dashboard will show a pairing token like:   XK9-2M4",
      "Copy ONLY the short token — not the full command.",
      "",
      "Example: if you see  CHEEKO_PAIR=XK9-2M4  just paste  XK9-2M4",
    ].join("\n"),
    "Connect to Cheeko",
  );

  const rawInput = String(
    await prompter.text({
      message: "Paste your Cheeko pairing token (e.g. XK9-2M4)",
      placeholder: "XK9-2M4",
      validate: (v) => {
        const raw = String(v ?? "").trim();
        if (!raw) return "Required — get it from the Cheeko dashboard";
        // Extract token even if user pasted the full command
        const extracted = extractTokenFromInput(raw);
        if (!extracted || extracted.length < 3) return "Token seems too short — paste just the short code (e.g. XK9-2M4)";
        return undefined;
      },
    }),
  ).trim();

  // Auto-extract token if user pasted the full command string
  // e.g. "CHEEKO_PAIR=8S5-CXU openclaw gateway" → "8S5-CXU"
  const token = extractTokenFromInput(rawInput);
  if (!token) {
    await prompter.note("❌ Could not extract token from input. Please try again.", "Invalid token");
    return false;
  }

  // Save the token locally immediately — works even when the dashboard API isn't live yet.
  // The gateway will attempt to register with the dashboard on every startup.
  const localIp = detectLocalIp();
  const voiceUrl = `ws://${localIp}:${VOICE_PORT}/`;

  saveToEnv({
    CHEEKO_PAIR: token,
    CHEEKO_DASHBOARD_URL: DASHBOARD_URL,
  });

  // Try to register with the dashboard (best-effort — non-blocking if API not ready yet)
  await prompter.note(
    [
      "Attempting to register your OpenClaw with the Cheeko dashboard...",
      "(This is optional — your token is already saved locally.)",
    ].join("\n"),
    "Connecting...",
  );

  try {
    const response = await fetch(`${BACKEND_API_URL}/api/openclaw/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, url: voiceUrl, localIp }),
      signal: AbortSignal.timeout(10_000),
    });

    // Try to parse JSON response, but handle HTML error pages gracefully
    let data: { ok?: boolean; error?: string } = {};
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      data = (await response.json()) as { ok?: boolean; error?: string };
    } else {
      // Dashboard returned HTML (endpoint not implemented yet) — treat as pending
      await prompter.note(
        [
          `⚠️  Dashboard API not ready yet (HTTP ${response.status}).`,
          "Your token has been saved locally.",
          "",
          `Token saved: ${token.slice(0, 3)}****`,
          `Voice URL:   ${voiceUrl}`,
          "",
          "The gateway will auto-register when the dashboard API is available.",
          "Run: openclaw gateway",
        ].join("\n"),
        "Token saved locally",
      );
      return true;
    }

    if (!response.ok || !data.ok) {
      // API returned an error — still saved locally, warn the user
      await prompter.note(
        [
          `⚠️  Dashboard registration returned an error: ${data.error ?? `HTTP ${response.status}`}`,
          "",
          "Your token has been saved locally and will be used on next gateway start.",
          `Token: ${token.slice(0, 3)}****`,
        ].join("\n"),
        "Saved locally (dashboard error)",
      );
      return true; // Continue setup — token is saved, gateway will retry
    }

    await prompter.note(
      [
        `✅ Connected! Your voice URL is registered:`,
        `   ${voiceUrl}`,
        "",
        "Your Cheeko devices will now connect to this machine.",
        "Token saved — future gateway starts auto-register.",
      ].join("\n"),
      "Dashboard connected",
    );

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Network error — token still saved locally
    await prompter.note(
      [
        `⚠️  Could not reach Cheeko dashboard: ${msg}`,
        "",
        "Your token has been saved locally.",
        `Token: ${token.slice(0, 3)}****`,
        `Voice URL: ${voiceUrl}`,
        "",
        "The gateway will auto-register when the dashboard is reachable.",
        "Run: openclaw gateway",
      ].join("\n"),
      "Token saved (dashboard unreachable)",
    );
    return true; // Continue setup — token is saved, gateway will retry
  }
}

/**
 * Extract the pairing token from user input.
 * Handles cases where the user pasted the full command:
 *   "CHEEKO_PAIR=XK9-2M4 openclaw gateway"  →  "XK9-2M4"
 *   "XK9-2M4"                                →  "XK9-2M4"
 *   "export CHEEKO_PAIR=XK9-2M4"             →  "XK9-2M4"
 */
function extractTokenFromInput(raw: string): string | null {
  const trimmed = raw.trim();

  // Try to extract from CHEEKO_PAIR=<token> pattern
  const envMatch = trimmed.match(/CHEEKO_PAIR=([^\s]+)/);
  if (envMatch) {
    return envMatch[1].trim();
  }

  // If it looks like a plain token (no spaces, no equals sign), use it directly
  if (!trimmed.includes(" ") && !trimmed.includes("=")) {
    return trimmed;
  }

  // Try to find a token-like value (alphanumeric + hyphens, 3-20 chars)
  const tokenMatch = trimmed.match(/\b([A-Z0-9]{2,8}-[A-Z0-9]{2,8})\b/i);
  if (tokenMatch) {
    return tokenMatch[1].trim();
  }

  // Last resort: take the first whitespace-separated word if it's short enough
  const firstWord = trimmed.split(/\s+/)[0];
  if (firstWord && firstWord.length >= 3 && firstWord.length <= 30) {
    return firstWord;
  }

  return null;
}

// ── Step 2 — STT Setup (multi-provider) ───────────────────────────────────────

const STT_PROVIDERS_INFO = [
  {
    value: "deepgram",
    label: "Deepgram",
    hint: "Streaming, Opus native, ~150ms, $0.46/hr",
    envVar: "DEEPGRAM_API_KEY",
    docsUrl: "https://console.deepgram.com",
    keyPlaceholder: "dg-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    value: "soniox",
    label: "Soniox",
    hint: "Streaming, <200ms, cheapest ($0.12/hr)",
    envVar: "SONIOX_API_KEY",
    docsUrl: "https://console.soniox.com",
    keyPlaceholder: "Your API key",
  },
  {
    value: "elevenlabs-stt",
    label: "ElevenLabs STT",
    hint: "Streaming, ~150ms, 90+ languages",
    envVar: "ELEVENLABS_STT_API_KEY",
    docsUrl: "https://elevenlabs.io/app/settings/api-keys",
    keyPlaceholder: "Your API key",
  },
  {
    value: "assemblyai",
    label: "AssemblyAI",
    hint: "Streaming, 307ms, $0.15/hr, 333hr free",
    envVar: "ASSEMBLYAI_API_KEY",
    docsUrl: "https://www.assemblyai.com/app",
    keyPlaceholder: "Your API key",
  },
  {
    value: "gladia",
    label: "Gladia",
    hint: "Streaming, Opus native, 270ms, 100+ langs",
    envVar: "GLADIA_API_KEY",
    docsUrl: "https://app.gladia.io",
    keyPlaceholder: "Your API key",
  },
] as const;

async function stepSttSetup(prompter: WizardPrompter): Promise<void> {
  const currentProvider = getEnvValue("STT_PROVIDER") ?? "deepgram";

  const selectedProvider = String(
    await prompter.select({
      message: "Which STT provider do you want to use?",
      options: STT_PROVIDERS_INFO.map((p) => ({
        value: p.value,
        label: p.label,
        hint: p.hint,
      })),
      initialValue: currentProvider,
    }),
  );

  const info = STT_PROVIDERS_INFO.find((p) => p.value === selectedProvider)!;
  const existingKey = getEnvValue(info.envVar);

  if (existingKey) {
    const update = await prompter.confirm({
      message: `${info.label} API key already set (${existingKey.slice(0, 8)}...). Update it?`,
      initialValue: false,
    });
    if (!update) {
      saveToEnv({ STT_PROVIDER: selectedProvider });
      await prompter.note(`✅ STT provider set to ${info.label}.`, "STT ready");
      return;
    }
  } else {
    await prompter.note(
      [
        `ESP32 Voice will use ${info.label} for Speech-to-Text (STT).`,
        `You need a ${info.label} API key.`,
        "",
        `${formatDocsLink(info.docsUrl, `Get ${info.label} API key →`)}`,
      ].join("\n"),
      `STT Setup — ${info.label}`,
    );
  }

  const key = String(
    await prompter.text({
      message: `${info.label} API key`,
      placeholder: info.keyPlaceholder,
      validate: (v) => {
        if (!String(v ?? "").trim()) return "Required";
        return undefined;
      },
    }),
  ).trim();

  const model = String(
    await prompter.text({
      message: "Model (optional, press Enter for default)",
      placeholder: "default",
      initialValue: getEnvValue("STT_MODEL") ?? "",
    }),
  ).trim();

  const toSave: Record<string, string> = {
    STT_PROVIDER: selectedProvider,
    [info.envVar]: key,
  };
  if (model) toSave.STT_MODEL = model;
  saveToEnv(toSave);

  await prompter.note(`✅ ${info.label} API key saved.`, "STT ready");
}

// ── Step 3 — TTS Setup (multi-provider) ───────────────────────────────────────

const TTS_PROVIDERS_INFO = [
  {
    value: "elevenlabs",
    label: "ElevenLabs",
    hint: "Streaming, high quality, ~300ms",
    envVar: "ELEVENLABS_API_KEY",
    docsUrl: "https://elevenlabs.io/app/settings/api-keys",
    defaultVoice: "21m00Tcm4TlvDq8ikWAM",
    voiceHint: "21m00Tcm4TlvDq8ikWAM (Rachel)",
  },
  {
    value: "rime",
    label: "Rime",
    hint: "Streaming, native PCM, low latency",
    envVar: "RIME_API_KEY",
    docsUrl: "https://rime.ai/docs",
    defaultVoice: "arcas",
    voiceHint: "arcas",
  },
  {
    value: "inworld",
    label: "Inworld",
    hint: "Streaming, <120ms, best latency",
    envVar: "INWORLD_API_KEY",
    docsUrl: "https://inworld.ai/tts-api",
    defaultVoice: "inworld.neutral",
    voiceHint: "inworld.neutral",
  },
  {
    value: "cartesia",
    label: "Cartesia",
    hint: "Streaming, ~80ms, production-grade",
    envVar: "CARTESIA_API_KEY",
    docsUrl: "https://docs.cartesia.ai",
    defaultVoice: "a0e99841-438c-4a64-b679-ae501e7d6091",
    voiceHint: "a0e99841-... (Barbershop Man)",
  },
  {
    value: "smallest-ai",
    label: "Smallest.ai",
    hint: "Streaming, raw PCM, 24kHz",
    envVar: "SMALLEST_AI_API_KEY",
    docsUrl: "https://waves-docs.smallest.ai",
    defaultVoice: "ashley",
    voiceHint: "ashley",
  },
  {
    value: "groq-playai",
    label: "Groq PlayAI",
    hint: "Batch (cheapest), reuses GROQ_API_KEY",
    envVar: "GROQ_API_KEY",
    docsUrl: "https://console.groq.com/docs/text-to-speech",
    defaultVoice: "troy",
    voiceHint: "troy",
  },
] as const;

async function stepTtsSetup(prompter: WizardPrompter): Promise<void> {
  const currentProvider = getEnvValue("TTS_PROVIDER") ?? "elevenlabs";

  const selectedProvider = String(
    await prompter.select({
      message: "Which TTS provider do you want to use?",
      options: TTS_PROVIDERS_INFO.map((p) => ({
        value: p.value,
        label: `${p.label}`,
        hint: p.hint,
      })),
      initialValue: currentProvider,
    }),
  );

  const info = TTS_PROVIDERS_INFO.find((p) => p.value === selectedProvider)!;
  const existingKey = getEnvValue(info.envVar);

  if (existingKey) {
    const update = await prompter.confirm({
      message: `${info.label} API key already set (${existingKey.slice(0, 8)}...). Update it?`,
      initialValue: false,
    });
    if (!update) {
      saveToEnv({ TTS_PROVIDER: selectedProvider });
      await prompter.note(`✅ TTS provider set to ${info.label}.`, "TTS ready");
      return;
    }
  } else {
    await prompter.note(
      [
        `ESP32 Voice will use ${info.label} for Text-to-Speech (TTS).`,
        `You need a ${info.label} API key.`,
        "",
        `${formatDocsLink(info.docsUrl, `Get ${info.label} API key →`)}`,
      ].join("\n"),
      `TTS Setup — ${info.label}`,
    );
  }

  const key = String(
    await prompter.text({
      message: `${info.label} API key`,
      placeholder: "Your API key",
      validate: (v) => {
        if (!String(v ?? "").trim()) return "Required";
        return undefined;
      },
    }),
  ).trim();

  const voiceId = String(
    await prompter.text({
      message: `Voice ID (optional, press Enter for default: ${info.voiceHint})`,
      placeholder: info.defaultVoice,
      initialValue: getEnvValue(`${info.envVar.replace("_API_KEY", "")}_VOICE_ID`) ?? "",
    }),
  ).trim();

  const toSave: Record<string, string> = {
    TTS_PROVIDER: selectedProvider,
    [info.envVar]: key,
  };
  const voiceEnvKey = `${info.envVar.replace("_API_KEY", "")}_VOICE_ID`;
  if (voiceId) toSave[voiceEnvKey] = voiceId;
  saveToEnv(toSave);

  await prompter.note(`✅ ${info.label} API key saved.`, "TTS ready");
}

// ── Step 4 — Add Device ────────────────────────────────────────────────────────

async function stepAddDevice(prompter: WizardPrompter): Promise<void> {
  // Auto-open the add-device page in the user's browser
  openInBrowser(`${DASHBOARD_URL}/devices/add`);

  await prompter.note(
    [
      "Now add your Cheeko device:",
      "",
      "1. Power on your Cheeko device",
      "2. Wait for it to connect to WiFi",
      "3. It will speak a 6-digit code",
      "4. Enter that code on the dashboard:",
      "",
      `${formatDocsLink(`${DASHBOARD_URL}/devices/add`, "Add device on dashboard →")}`,
      "(opens automatically — click if it didn't open)",
      "",
      "Once added, reboot the device — it will connect to your OpenClaw automatically.",
    ].join("\n"),
    "Add your Cheeko device",
  );

  await prompter.confirm({
    message: "Device added? (press Enter to continue)",
    initialValue: true,
  });
}

// ── Logout helper ─────────────────────────────────────────────────────────────

async function stepLogout(prompter: WizardPrompter): Promise<void> {
  const existing = getEnvValue("CHEEKO_PAIR");
  if (!existing) {
    await prompter.note("No Cheeko connection found — nothing to disconnect.", "Not connected");
    return;
  }

  const confirm = await prompter.confirm({
    message: "Disconnect from Cheeko dashboard? (removes saved pairing token)",
    initialValue: false,
  });

  if (!confirm) return;

  clearFromEnv(["CHEEKO_PAIR", "CHEEKO_DASHBOARD_URL"]);
  await prompter.note(
    [
      "✅ Disconnected from Cheeko dashboard.",
      "",
      "To reconnect: run  openclaw channels add --channel esp32voice",
    ].join("\n"),
    "Disconnected",
  );
}

// ── Main onboarding adapter ───────────────────────────────────────────────────

export const esp32VoiceOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "esp32voice",

  getStatus: async ({ cfg }) => {
    const hasPair = Boolean(getEnvValue("CHEEKO_PAIR"));
    const sttProvider = getEnvValue("STT_PROVIDER") ?? "deepgram";
    const sttMeta = STT_PROVIDERS_INFO.find((p) => p.value === sttProvider) ?? STT_PROVIDERS_INFO[0];
    const hasSTT = Boolean(getEnvValue(sttMeta.envVar));
    const ttsProvider = getEnvValue("TTS_PROVIDER") ?? "elevenlabs";
    const ttsMeta = TTS_PROVIDERS_INFO.find((p) => p.value === ttsProvider) ?? TTS_PROVIDERS_INFO[0];
    const hasTTS = Boolean(getEnvValue(ttsMeta.envVar));
    const configured = hasPair && hasSTT && hasTTS;

    const overallStatus = configured ? "configured" : "needs setup";
    const lines: string[] = [];
    lines.push(`ESP32 Voice: ${overallStatus}`);
    lines.push(`  Cheeko dashboard: ${hasPair ? "✅ connected" : "❌ not connected"}`);
    lines.push(`  STT (${sttMeta.label}):   ${hasSTT ? "✅ configured" : "❌ missing key"}`);
    lines.push(`  TTS (${ttsMeta.label}): ${hasTTS ? "✅ configured" : "❌ missing key"}`);

    return {
      channel: "esp32voice",
      configured,
      statusLines: lines,
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 1 : 0,
    };
  },

  configure: async ({ cfg, prompter }) => {
    // ── Intro ──────────────────────────────────────────────────────
    await prompter.note(
      [
        "This wizard sets up your Cheeko ESP32 voice device.",
        "",
        "Steps:",
        "  1. Connect to Cheeko dashboard",
        "  2. Set up Speech-to-Text (STT provider)",
        "  3. Set up Text-to-Speech (TTS provider)",
        "  4. Add your device",
        "",
        "Run: openclaw gateway   when done to start the voice server.",
      ].join("\n"),
      "🦞 Cheeko ESP32 Voice Setup",
    );

    // ── Auto-save gateway token ────────────────────────────────────
    // The plugin needs OPENCLAW_GATEWAY_TOKEN to authenticate with the gateway WebSocket.
    // Read it from openclaw.json and persist it to .env so it's always available at runtime.
    const gatewayToken = readGatewayToken();
    if (gatewayToken) {
      saveToEnv({ OPENCLAW_GATEWAY_TOKEN: gatewayToken });
    } else {
      await prompter.note(
        [
          "⚠️  Could not find your OpenClaw gateway token.",
          "",
          "The plugin needs this to connect to the gateway.",
          "Run this first to set up OpenClaw:",
          "  openclaw onboard",
          "",
          "Then re-run: openclaw channels add",
        ].join("\n"),
        "Gateway token missing",
      );
      return { cfg };
    }

    // Check if user wants to logout instead
    const existing = getEnvValue("CHEEKO_PAIR");
    if (existing) {
      const action = await prompter.select({
        message: "What would you like to do?",
        options: [
          { value: "reconfigure", label: "Reconfigure / update settings" },
          { value: "logout", label: "Disconnect from Cheeko dashboard" },
        ],
        initialValue: "reconfigure",
      });

      if (String(action) === "logout") {
        await stepLogout(prompter);
        return { cfg };
      }
    }

    // ── Step 1: Dashboard login ────────────────────────────────────
    const loginOk = await stepCheekoLogin(prompter);
    if (!loginOk) {
      await prompter.note(
        [
          "Setup incomplete — Cheeko dashboard not connected.",
          "Re-run when ready: openclaw channels add --channel esp32voice",
        ].join("\n"),
        "Setup paused",
      );
      return { cfg };
    }

    // ── Step 2: STT ────────────────────────────────────────────────
    await stepSttSetup(prompter);

    // ── Step 3: TTS ────────────────────────────────────────────────
    await stepTtsSetup(prompter);

    // ── Step 4: Add device ─────────────────────────────────────────
    await stepAddDevice(prompter);

    // ── Done ───────────────────────────────────────────────────────
    const localIp = detectLocalIp();
    await prompter.note(
      [
        "✅ Setup complete!",
        "",
        "Your configuration:",
        `  Voice server : ws://${localIp}:${VOICE_PORT}/`,
        `  Dashboard    : ${DASHBOARD_URL}`,
        `  STT          : ${(STT_PROVIDERS_INFO.find((p) => p.value === (getEnvValue("STT_PROVIDER") ?? "deepgram")) ?? STT_PROVIDERS_INFO[0]).label} ${getEnvValue("STT_MODEL") ?? "(default model)"}`,
        `  TTS          : ${(TTS_PROVIDERS_INFO.find((p) => p.value === (getEnvValue("TTS_PROVIDER") ?? "elevenlabs")) ?? TTS_PROVIDERS_INFO[0]).label} (${getEnvValue((TTS_PROVIDERS_INFO.find((p) => p.value === (getEnvValue("TTS_PROVIDER") ?? "elevenlabs")) ?? TTS_PROVIDERS_INFO[0]).envVar.replace("_API_KEY", "") + "_VOICE_ID") ?? "default voice"})`,
        "",
        "Start the voice server:",
        "  openclaw gateway",
        "",
        "Re-run setup anytime:",
        "  openclaw channels add --channel esp32voice",
      ].join("\n"),
      "🎉 All done!",
    );

    return { cfg, accountId: DEFAULT_ACCOUNT_ID };
  },

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...(cfg as any).channels,
      esp32voice: {
        ...(cfg as any).channels?.esp32voice,
        enabled: false,
      },
    },
  }),
};
