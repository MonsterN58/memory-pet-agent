import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import { sanitizeSettings } from "../src/main/settings-store";

test("设置清洗会限制危险或越界输入", () => {
  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    agentName: "a".repeat(100),
    persona: "旧版固定人格提示词",
    personality: { learningEnabled: true, adaptationRate: 99, minimumEvidence: 0 },
    provider: { ...DEFAULT_SETTINGS.provider, baseUrl: "file:///tmp/secrets", temperature: 99 },
    heartbeat: { ...DEFAULT_SETTINGS.heartbeat, intervalMinutes: 0, proactiveDailyLimit: 999 },
    voice: {
      ...DEFAULT_SETTINGS.voice,
      recognitionMode: "remote" as never,
      ttsMode: "system-or-cloud" as never,
      ttsBaseUrl: "javascript:alert('tts')",
      ttsModel: "m".repeat(200),
      ttsVoice: "v".repeat(200),
      ttsSpeed: 9,
    },
    window: { ...DEFAULT_SETTINGS.window, roamingSpeed: 99 },
  });
  assert.equal(settings.agentName.length, 30);
  assert.equal(settings.personality.adaptationRate, 0.5);
  assert.equal(settings.personality.minimumEvidence, 1);
  assert.equal("persona" in settings, false);
  assert.equal(settings.provider.baseUrl, DEFAULT_SETTINGS.provider.baseUrl);
  assert.equal(settings.provider.temperature, 2);
  assert.equal(settings.heartbeat.intervalMinutes, 1);
  assert.equal(settings.heartbeat.proactiveDailyLimit, 48);
  assert.equal(settings.voice.recognitionMode, "local");
  assert.equal(settings.voice.ttsMode, "local");
  assert.equal(settings.voice.ttsBaseUrl, DEFAULT_SETTINGS.voice.ttsBaseUrl);
  assert.equal(settings.voice.ttsModel.length, 120);
  assert.equal(settings.voice.ttsVoice.length, 120);
  assert.equal(settings.voice.ttsSpeed, 4);
  assert.equal(settings.window.roamingSpeed, 4);
});

test("旧版系统语音设置会迁移到 TTS 音色和语速", () => {
  const settings = sanitizeSettings({
    voice: {
      inputEnabled: true,
      outputEnabled: true,
      language: "zh-CN",
      voiceName: "nova",
      rate: 1.4,
    },
  });
  assert.equal(settings.voice.ttsModel, "tts-1");
  assert.equal(settings.voice.ttsVoice, "nova");
  assert.equal(settings.voice.ttsSpeed, 1.4);
  assert.equal("voiceName" in settings.voice, false);
});

test("旧版共享端点会迁移为独立 TTS Base URL", () => {
  const settings = sanitizeSettings({
    provider: {
      ...DEFAULT_SETTINGS.provider,
      baseUrl: "https://legacy.example.com/v1",
    },
    voice: {
      inputEnabled: true,
      outputEnabled: true,
      language: "zh-CN",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
      ttsSpeed: 1,
    },
  });
  assert.equal(settings.voice.ttsBaseUrl, "https://legacy.example.com/v1");
});
