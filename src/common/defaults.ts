import type { AgentSettings } from "./types";

export const DEFAULT_SETTINGS: AgentSettings = {
  agentName: "小忆",
  userName: "朋友",
  personality: {
    learningEnabled: true,
    adaptationRate: 0.18,
    minimumEvidence: 2,
  },
  provider: {
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "",
    temperature: 0.7,
  },
  vision: {
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "",
  },
  heartbeat: {
    enabled: true,
    intervalMinutes: 10,
    l1MaxItems: 16,
    l1MaxAgeMinutes: 30,
    consolidateAfterItems: 4,
    proactiveEnabled: true,
    idleMinutesBeforeChat: 30,
    proactiveCooldownMinutes: 120,
    proactiveDailyLimit: 4,
    quietHoursStart: 23,
    quietHoursEnd: 8,
  },
  awareness: {
    screenCaptureEnabled: false,
    processDetectionEnabled: false,
    processPollMinutes: 2,
  },
  voice: {
    inputEnabled: true,
    outputEnabled: true,
    language: "zh-CN",
    recognitionMode: "local",
    ttsMode: "local",
    ttsBaseUrl: "https://api.openai.com/v1",
    ttsModel: "tts-1",
    ttsVoice: "alloy",
    ttsSpeed: 1,
  },
  computer: {
    enabled: false,
    browserContextEnabled: false,
    clipboardShortcutEnabled: true,
    permissions: {
      "open-url": "ask",
      "copy-text": "ask",
      "save-text-file": "ask",
      "launch-app": "ask",
    },
  },
  window: {
    alwaysOnTop: true,
    roamingEnabled: true,
    roamingSpeed: 1.25,
  },
};
