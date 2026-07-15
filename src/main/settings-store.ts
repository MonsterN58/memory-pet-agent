import { safeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../common/defaults";
import type { AgentSettings, PublicSettingsState, SettingsUpdate } from "../common/types";
import { clamp } from "./memory/memory-utils";

interface SecretFile {
  encryptedApiKey?: string;
  encryptedTtsApiKey?: string;
  ttsKeyMigrated?: boolean;
}

type SettingsInput = Omit<Partial<AgentSettings>, "voice"> & {
  /** v0.1 手写性格提示，仅用于识别并丢弃旧设置。 */
  persona?: unknown;
  voice?: Partial<AgentSettings["voice"]> & {
    /** v0.1 系统 speechSynthesis 设置，仅用于迁移旧数据。 */
    voiceName?: unknown;
    rate?: unknown;
    pitch?: unknown;
  };
};

function stringValue(value: unknown, fallback: string, maxLength = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function validBaseUrl(value: unknown, fallback: string): string {
  const candidate = stringValue(value, fallback, 500).replace(/\/$/, "");
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? candidate : fallback;
  } catch {
    return fallback;
  }
}

export function sanitizeSettings(input: SettingsInput): AgentSettings {
  const provider = input.provider ?? DEFAULT_SETTINGS.provider;
  const personality = input.personality ?? DEFAULT_SETTINGS.personality;
  const heartbeat = input.heartbeat ?? DEFAULT_SETTINGS.heartbeat;
  const voice: NonNullable<SettingsInput["voice"]> = input.voice ?? DEFAULT_SETTINGS.voice;
  const computer = input.computer ?? DEFAULT_SETTINGS.computer;
  const computerPermissions = computer.permissions ?? DEFAULT_SETTINGS.computer.permissions;
  const windowSettings = input.window ?? DEFAULT_SETTINGS.window;
  return {
    agentName: stringValue(input.agentName, DEFAULT_SETTINGS.agentName, 30),
    userName: stringValue(input.userName, DEFAULT_SETTINGS.userName, 30),
    personality: {
      learningEnabled: booleanValue(personality.learningEnabled, DEFAULT_SETTINGS.personality.learningEnabled),
      adaptationRate: numberValue(
        personality.adaptationRate,
        DEFAULT_SETTINGS.personality.adaptationRate,
        0.05,
        0.5,
      ),
      minimumEvidence: Math.round(numberValue(
        personality.minimumEvidence,
        DEFAULT_SETTINGS.personality.minimumEvidence,
        1,
        12,
      )),
    },
    provider: {
      enabled: booleanValue(provider.enabled, DEFAULT_SETTINGS.provider.enabled),
      baseUrl: validBaseUrl(provider.baseUrl, DEFAULT_SETTINGS.provider.baseUrl),
      model: stringValue(provider.model, DEFAULT_SETTINGS.provider.model, 120),
      temperature: clamp(numberValue(provider.temperature, DEFAULT_SETTINGS.provider.temperature, 0, 2), 0, 2),
    },
    heartbeat: {
      enabled: booleanValue(heartbeat.enabled, DEFAULT_SETTINGS.heartbeat.enabled),
      intervalMinutes: numberValue(heartbeat.intervalMinutes, DEFAULT_SETTINGS.heartbeat.intervalMinutes, 1, 1440),
      l1MaxItems: Math.round(numberValue(heartbeat.l1MaxItems, DEFAULT_SETTINGS.heartbeat.l1MaxItems, 4, 100)),
      l1MaxAgeMinutes: numberValue(heartbeat.l1MaxAgeMinutes, DEFAULT_SETTINGS.heartbeat.l1MaxAgeMinutes, 1, 10080),
      consolidateAfterItems: Math.round(
        numberValue(heartbeat.consolidateAfterItems, DEFAULT_SETTINGS.heartbeat.consolidateAfterItems, 1, 50),
      ),
      proactiveEnabled: booleanValue(heartbeat.proactiveEnabled, DEFAULT_SETTINGS.heartbeat.proactiveEnabled),
      idleMinutesBeforeChat: numberValue(
        heartbeat.idleMinutesBeforeChat,
        DEFAULT_SETTINGS.heartbeat.idleMinutesBeforeChat,
        1,
        10080,
      ),
      proactiveCooldownMinutes: numberValue(
        heartbeat.proactiveCooldownMinutes,
        DEFAULT_SETTINGS.heartbeat.proactiveCooldownMinutes,
        5,
        10080,
      ),
      proactiveDailyLimit: Math.round(
        numberValue(heartbeat.proactiveDailyLimit, DEFAULT_SETTINGS.heartbeat.proactiveDailyLimit, 0, 48),
      ),
      quietHoursStart: Math.round(
        numberValue(heartbeat.quietHoursStart, DEFAULT_SETTINGS.heartbeat.quietHoursStart, 0, 23),
      ),
      quietHoursEnd: Math.round(numberValue(heartbeat.quietHoursEnd, DEFAULT_SETTINGS.heartbeat.quietHoursEnd, 0, 23)),
    },
    voice: {
      inputEnabled: booleanValue(voice.inputEnabled, DEFAULT_SETTINGS.voice.inputEnabled),
      outputEnabled: booleanValue(voice.outputEnabled, DEFAULT_SETTINGS.voice.outputEnabled),
      language: stringValue(voice.language, DEFAULT_SETTINGS.voice.language, 30),
      recognitionMode: enumValue(voice.recognitionMode, ["local", "browser"], DEFAULT_SETTINGS.voice.recognitionMode),
      ttsMode: enumValue(voice.ttsMode, ["local", "cloud"], DEFAULT_SETTINGS.voice.ttsMode),
      // 旧版 TTS 与聊天共用 Base URL；首次迁移时保留原有端点，之后独立保存。
      ttsBaseUrl: validBaseUrl(voice.ttsBaseUrl ?? provider.baseUrl, DEFAULT_SETTINGS.voice.ttsBaseUrl),
      ttsModel: stringValue(voice.ttsModel, DEFAULT_SETTINGS.voice.ttsModel, 120)
        || DEFAULT_SETTINGS.voice.ttsModel,
      ttsVoice: stringValue(voice.ttsVoice ?? voice.voiceName, DEFAULT_SETTINGS.voice.ttsVoice, 120)
        || DEFAULT_SETTINGS.voice.ttsVoice,
      ttsSpeed: numberValue(voice.ttsSpeed ?? voice.rate, DEFAULT_SETTINGS.voice.ttsSpeed, 0.25, 4),
    },
    computer: {
      enabled: booleanValue(computer.enabled, DEFAULT_SETTINGS.computer.enabled),
      browserContextEnabled: booleanValue(
        computer.browserContextEnabled,
        DEFAULT_SETTINGS.computer.browserContextEnabled,
      ),
      clipboardShortcutEnabled: booleanValue(
        computer.clipboardShortcutEnabled,
        DEFAULT_SETTINGS.computer.clipboardShortcutEnabled,
      ),
      permissions: {
        "open-url": enumValue(
          computerPermissions["open-url"],
          ["ask", "allow", "deny"],
          DEFAULT_SETTINGS.computer.permissions["open-url"],
        ),
        "copy-text": enumValue(
          computerPermissions["copy-text"],
          ["ask", "allow", "deny"],
          DEFAULT_SETTINGS.computer.permissions["copy-text"],
        ),
        "save-text-file": enumValue(
          computerPermissions["save-text-file"],
          ["ask", "deny"],
          DEFAULT_SETTINGS.computer.permissions["save-text-file"],
        ),
        "launch-app": enumValue(
          computerPermissions["launch-app"],
          ["ask", "allow", "deny"],
          DEFAULT_SETTINGS.computer.permissions["launch-app"],
        ),
      },
    },
    window: {
      alwaysOnTop: booleanValue(windowSettings.alwaysOnTop, DEFAULT_SETTINGS.window.alwaysOnTop),
      roamingEnabled: booleanValue(windowSettings.roamingEnabled, DEFAULT_SETTINGS.window.roamingEnabled),
      roamingSpeed: numberValue(windowSettings.roamingSpeed, DEFAULT_SETTINGS.window.roamingSpeed, 0.4, 4),
    },
  };
}

export class SettingsStore {
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);

  constructor(private readonly dataDirectory: string) {
    this.settingsPath = join(dataDirectory, "settings.json");
    this.secretsPath = join(dataDirectory, "secrets.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.settingsPath, "utf8")) as SettingsInput;
      this.settings = sanitizeSettings({
        ...DEFAULT_SETTINGS,
        ...loaded,
        personality: { ...DEFAULT_SETTINGS.personality, ...loaded.personality },
        provider: { ...DEFAULT_SETTINGS.provider, ...loaded.provider },
        heartbeat: { ...DEFAULT_SETTINGS.heartbeat, ...loaded.heartbeat },
        // 不预先注入新版 voice 默认值，确保 voiceName/rate 旧字段能被迁移。
        voice: loaded.voice ?? DEFAULT_SETTINGS.voice,
        computer: {
          ...DEFAULT_SETTINGS.computer,
          ...loaded.computer,
          permissions: {
            ...DEFAULT_SETTINGS.computer.permissions,
            ...loaded.computer?.permissions,
          },
        },
        window: { ...DEFAULT_SETTINGS.window, ...loaded.window },
      });
      await this.persistSettings();
    } catch {
      this.settings = structuredClone(DEFAULT_SETTINGS);
      await this.persistSettings();
    }
    await this.migrateSharedSecret();
  }

  get(): AgentSettings {
    return structuredClone(this.settings);
  }

  async getPublicState(): Promise<PublicSettingsState> {
    return {
      settings: this.get(),
      hasApiKey: Boolean(await this.getApiKey()),
      hasTtsApiKey: Boolean(await this.getTtsApiKey()),
      dataDirectory: this.dataDirectory,
    };
  }

  async update(update: SettingsUpdate): Promise<PublicSettingsState> {
    this.settings = sanitizeSettings({
      ...this.settings,
      ...update,
      personality: { ...this.settings.personality, ...(update.personality ?? {}) },
      provider: { ...this.settings.provider, ...(update.provider ?? {}) },
      heartbeat: { ...this.settings.heartbeat, ...(update.heartbeat ?? {}) },
      voice: { ...this.settings.voice, ...(update.voice ?? {}) },
      computer: {
        ...this.settings.computer,
        ...(update.computer ?? {}),
        permissions: {
          ...this.settings.computer.permissions,
          ...(update.computer?.permissions ?? {}),
        },
      },
      window: { ...this.settings.window, ...(update.window ?? {}) },
    });
    await this.persistSettings();
    const secrets = await this.readSecrets();
    let secretsChanged = false;
    if (update.clearApiKey) {
      delete secrets.encryptedApiKey;
      secretsChanged = true;
    }
    if (update.clearTtsApiKey) {
      delete secrets.encryptedTtsApiKey;
      secretsChanged = true;
    }
    if (typeof update.apiKey === "string" && update.apiKey.trim()) {
      secrets.encryptedApiKey = this.encryptApiKey(update.apiKey.trim(), "OPENAI_API_KEY");
      secretsChanged = true;
    }
    if (typeof update.ttsApiKey === "string" && update.ttsApiKey.trim()) {
      secrets.encryptedTtsApiKey = this.encryptApiKey(update.ttsApiKey.trim(), "OPENAI_TTS_API_KEY");
      secretsChanged = true;
    }
    if (secretsChanged) await this.writeSecrets(secrets);
    return this.getPublicState();
  }

  async getApiKey(): Promise<string> {
    if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
    try {
      const secrets = await this.readSecrets();
      if (!secrets.encryptedApiKey || !safeStorage.isEncryptionAvailable()) return "";
      return safeStorage.decryptString(Buffer.from(secrets.encryptedApiKey, "base64"));
    } catch {
      return "";
    }
  }

  async getTtsApiKey(): Promise<string> {
    if (process.env.OPENAI_TTS_API_KEY?.trim()) return process.env.OPENAI_TTS_API_KEY.trim();
    try {
      const secrets = await this.readSecrets();
      if (!secrets.encryptedTtsApiKey || !safeStorage.isEncryptionAvailable()) return "";
      return safeStorage.decryptString(Buffer.from(secrets.encryptedTtsApiKey, "base64"));
    } catch {
      return "";
    }
  }

  async providerConfigured(): Promise<boolean> {
    return this.settings.provider.enabled && Boolean(this.settings.provider.model && (await this.getApiKey()));
  }

  private encryptApiKey(apiKey: string, environmentName: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(`当前系统无法使用安全凭据存储，请改用 ${environmentName} 环境变量。`);
    }
    return safeStorage.encryptString(apiKey).toString("base64");
  }

  private async migrateSharedSecret(): Promise<void> {
    const secrets = await this.readSecrets();
    if (secrets.ttsKeyMigrated) return;
    if (secrets.encryptedApiKey && !secrets.encryptedTtsApiKey) {
      secrets.encryptedTtsApiKey = secrets.encryptedApiKey;
    }
    secrets.ttsKeyMigrated = true;
    await this.writeSecrets(secrets);
  }

  private async readSecrets(): Promise<SecretFile> {
    try {
      const value = JSON.parse(await readFile(this.secretsPath, "utf8")) as SecretFile;
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  private async writeSecrets(secrets: SecretFile): Promise<void> {
    await writeFile(this.secretsPath, JSON.stringify(secrets, null, 2), "utf8");
  }

  private async persistSettings(): Promise<void> {
    await writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf8");
  }
}
