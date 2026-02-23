import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { Esp32VoiceConfigSchema } from "./config-schema.js";
import {
  listEsp32VoiceAccountIds,
  resolveDefaultEsp32VoiceAccountId,
  resolveEsp32VoiceAccount,
  type ResolvedEsp32VoiceAccount,
} from "./accounts.js";
import { monitorEsp32VoiceProvider } from "./monitor.js";
import { getEsp32VoiceRuntime } from "./runtime.js";
import { esp32VoiceOnboardingAdapter } from "./onboarding.js";

const meta = {
  id: "esp32voice",
  label: "ESP32 Voice",
  selectionLabel: "ESP32 Voice (plugin)",
  detailLabel: "ESP32 Voice Device",
  docsPath: "/channels/esp32-voice",
  docsLabel: "esp32-voice",
  blurb: "ESP32 IoT voice device — speech-to-text-to-speech via HTTP.",
  systemImage: "waveform",
  order: 90,
  quickstartAllowFrom: false,
} as const;

export const esp32VoicePlugin: ChannelPlugin<ResolvedEsp32VoiceAccount> = {
  id: "esp32voice",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
  },
  reload: { configPrefixes: ["channels.esp32voice"] },
  configSchema: buildChannelConfigSchema(Esp32VoiceConfigSchema),
  config: {
    listAccountIds: (cfg) => listEsp32VoiceAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveEsp32VoiceAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultEsp32VoiceAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "esp32voice",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "esp32voice",
        accountId,
        clearBaseFields: ["deviceToken", "deviceId", "name"],
      }),
    isConfigured: (account) => Boolean(account.deviceToken),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.deviceToken),
      deviceTokenSource: account.deviceTokenSource,
      deviceId: account.deviceId,
      language: account.language,
      voiceOptimized: account.voiceOptimized,
      maxResponseLength: account.maxResponseLength,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveEsp32VoiceAccount({ cfg, accountId }).config.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) => allowFrom.filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.esp32voice?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.esp32voice.accounts.${resolvedAccountId}.`
        : "channels.esp32voice.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("esp32voice"),
        normalizeEntry: (raw) => raw.trim().toLowerCase(),
      };
    },
    collectWarnings: () => [],
  },
  pairing: {
    idLabel: "esp32DeviceId",
    normalizeAllowEntry: (entry) => entry.trim().toLowerCase(),
    notifyApproval: async ({ id }) => {
      console.log(`[esp32voice] Device ${id} approved for pairing`);
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getEsp32VoiceRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 500,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to ESP32 Voice requires --to <deviceId>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text }) => {
      // Outbound to ESP32 is handled via the HTTP response (synchronous).
      // This is for CLI `openclaw message send --channel esp32voice` support.
      console.log(`[esp32voice] Outbound message to ${to}: ${text.slice(0, 100)}...`);
      return {
        channel: "esp32voice" as const,
        ok: true,
        messageId: `esp32-${Date.now()}`,
      };
    },
  },
  messaging: {
    normalizeTarget: (target) => target.trim().toLowerCase(),
    targetResolver: {
      looksLikeId: (id) => /^esp32[a-z0-9_-]*$/i.test(id),
      hint: "<deviceId>",
    },
  },
  // Agent prompt: add voice-optimization context so the AI knows responses
  // will be converted to speech on the device.
  agentPrompt: {
    systemPromptSuffix: () =>
      [
        "",
        "## ESP32 Voice Channel Context",
        "The user is communicating via an ESP32 IoT voice device.",
        "Your responses will be converted to speech (TTS) and played through a speaker.",
        "Keep responses concise, conversational, and natural for spoken delivery.",
        "Avoid markdown formatting, code blocks, lists, and URLs — they don't translate well to speech.",
        "Aim for 1-3 sentences unless the user asks for detail.",
        "",
      ].join("\n"),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      deviceTokenSource: snapshot.deviceTokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      deviceId: snapshot.deviceId ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.deviceToken),
      deviceTokenSource: account.deviceTokenSource,
      deviceId: account.deviceId,
      language: account.language,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "esp32voice",
        accountId,
        name,
      }),
    validateInput: () => {
      // No token required — the WebSocket voice pipeline does not need a
      // pre-configured device token. Devices authenticate via OTP pairing
      // at runtime. The onboarding wizard handles full setup interactively.
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const token = input.botToken ?? input.token;
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "esp32voice",
        accountId,
        name: input.name,
      });

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            esp32voice: {
              ...namedConfig.channels?.esp32voice,
              enabled: true,
              ...(token ? { deviceToken: token } : {}),
            },
          },
        };
      }
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          esp32voice: {
            ...namedConfig.channels?.esp32voice,
            enabled: true,
            accounts: {
              ...namedConfig.channels?.esp32voice?.accounts,
              [accountId]: {
                ...namedConfig.channels?.esp32voice?.accounts?.[accountId],
                enabled: true,
                ...(token ? { deviceToken: token } : {}),
              },
            },
          },
        },
      };
    },
  },
  onboarding: esp32VoiceOnboardingAdapter,
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        deviceId: account.deviceId,
        deviceTokenSource: account.deviceTokenSource,
      });
      ctx.log?.info(`[${account.accountId}] starting ESP32 Voice channel`);
      return monitorEsp32VoiceProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: getEsp32VoiceRuntime(),
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
