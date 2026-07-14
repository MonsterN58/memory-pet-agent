import { DEFAULT_SETTINGS } from "../common/defaults";
import type {
  ChatResponse,
  ControlPanelView,
  Live2DModelAssetPackage,
  Live2DModelInfo,
  MemoryRecord,
  MemorySnapshot,
  PetAgentBridge,
  PetAction,
  PetFocus,
  PetLocomotion,
  PetUiCommand,
  PersonalityProfile,
  PublicModelState,
  PublicSettingsState,
} from "../common/types";

const BUNDLED_MODELS: Array<Live2DModelInfo & { directory: string }> = [
  {
    id: "hiyori", name: "Hiyori（官方样例）", source: "bundled", directory: "Hiyori",
    settingsVersion: 3, motionGroups: { Idle: 9, TapBody: 1 }, motionCount: 10,
    expressionCount: 0, lipSyncParameters: ["ParamMouthOpenY"], textureCount: 2,
  },
  {
    id: "mao", name: "Mao（官方样例）", source: "bundled", directory: "Mao",
    settingsVersion: 3, motionGroups: { Idle: 2, TapBody: 6 }, motionCount: 8,
    expressionCount: 8, lipSyncParameters: ["ParamA"], textureCount: 1,
  },
  {
    id: "wanko", name: "Wanko（官方宠物样例）", source: "bundled", directory: "Wanko",
    settingsVersion: 3, motionGroups: { Idle: 4, TapBody: 6, Shake: 2 }, motionCount: 12,
    expressionCount: 0, lipSyncParameters: ["PARAM_MOUTH_OPEN_Y"], textureCount: 1,
  },
];

// 仅用于通过 http:// 的本地浏览器做 UI 预览。Electron 正式运行使用 preload 中的真实桥接。
if (location.protocol.startsWith("http") && !window.petAgent) {
  let settingsState: PublicSettingsState = {
    settings: structuredClone(DEFAULT_SETTINGS),
    hasApiKey: false,
    hasTtsApiKey: false,
    dataDirectory: "本地 UI 预览模式",
  };
  const memory: MemorySnapshot = {
    l1: [{
      ...sampleMemory("L1", "dialogue", "刚刚提到想让长期记忆更容易纠错。", 0.66),
      tier: "L1",
      role: "user",
    }],
    l2: [sampleMemory("L2", "episode", "用户正在设计一个有长期记忆的桌宠 Agent。", 0.82)],
    l3: [sampleMemory("L3", "preference", "用户偏好本地优先、可以主动聊天的桌宠。", 0.9)],
    recentHeartbeats: [],
  };
  let personalityProfile: PersonalityProfile = blankPersonalityProfile();
  const proactiveListeners = new Set<(message: ChatResponse) => void>();
  const settingsListeners = new Set<(state: PublicSettingsState) => void>();
  const locomotionListeners = new Set<(state: PetLocomotion) => void>();
  const focusListeners = new Set<(focus: PetFocus) => void>();
  const uiListeners = new Set<(command: PetUiCommand) => void>();
  const panelListeners = new Set<(view: ControlPanelView) => void>();
  const actionListeners = new Set<(action: PetAction) => void>();
  const modelListeners = new Set<(state: PublicModelState) => void>();
  const personalityListeners = new Set<(profile: PersonalityProfile) => void>();
  let previewDragging = false;
  let resourceModelId = "hiyori";
  let modelState = createModelState(BUNDLED_MODELS[0]!);

  const bridge: PetAgentBridge = {
    async bootstrap() {
      return {
        settings: structuredClone(settingsState),
        memory: structuredClone(memory),
        personality: structuredClone(personalityProfile),
        providerMode: "local",
      };
    },
    async chat(text) {
      const userMemory = sampleMemory("L1", "dialogue", text, 0.6);
      memory.l1.push({ ...userMemory, tier: "L1", role: "user" });
      personalityProfile.interactionCount += 1;
      personalityProfile.stage = "forming";
      personalityProfile.summary = `已观察 ${personalityProfile.interactionCount} 次互动，但证据仍不足，暂不固定任何性格标签。`;
      personalityProfile.updatedAt = new Date().toISOString();
      personalityListeners.forEach((listener) => listener(structuredClone(personalityProfile)));
      return {
        text: "我听到了。等下一次心跳，我会把这段经历送进 L2，再提炼出值得长期保留的部分。",
        emotion: "happy",
        source: "local",
        memoryRefs: [],
      };
    },
    async remember(text) {
      memory.l2.push(sampleMemory("L2", "fact", text, 0.95));
      return structuredClone(memory);
    },
    async searchMemory(query) {
      return [...memory.l3, ...memory.l2]
        .filter((item) => item.content.includes(query))
        .map((item) => ({
          memory: structuredClone(item),
          score: {
            textRelevance: 5,
            importance: item.importance * 1.7,
            recency: 0.8,
            frequency: 0.1,
            total: 5 + item.importance * 1.7 + 0.8 + 0.1,
          },
        }));
    },
    async getMemory() {
      return structuredClone(memory);
    },
    async updateMemory(update) {
      const records = update.tier === "L2" ? memory.l2 : memory.l3;
      const record = records.find((item) => item.id === update.id);
      if (!record) throw new Error("没有找到要修改的记忆");
      record.content = update.content;
      record.summary = update.content;
      record.kind = update.kind;
      record.importance = update.importance;
      record.updatedAt = new Date().toISOString();
      return structuredClone(memory);
    },
    async deleteMemory(target) {
      const records = target.tier === "L2" ? memory.l2 : memory.l3;
      const index = records.findIndex((item) => item.id === target.id);
      if (index < 0) throw new Error("没有找到要删除的记忆");
      records.splice(index, 1);
      return structuredClone(memory);
    },
    async getPersonality() { return structuredClone(personalityProfile); },
    async resetPersonality() {
      personalityProfile = blankPersonalityProfile();
      personalityListeners.forEach((listener) => listener(structuredClone(personalityProfile)));
      return structuredClone(personalityProfile);
    },
    async runHeartbeat() {
      const consolidated = memory.l2.splice(0);
      memory.l3.push(...consolidated.map((item) => ({ ...item, tier: "L3" as const })));
      const event = {
        id: crypto.randomUUID(), reason: "manual" as const, createdAt: new Date().toISOString(),
        movedToL2: 0, consolidatedToL3: consolidated.length, reflection: "预览模式心跳已完成。",
      };
      return { event, snapshot: structuredClone(memory), personality: structuredClone(personalityProfile) };
    },
    async saveSettings(update) {
      settingsState = {
        ...settingsState,
        settings: {
          ...settingsState.settings,
          ...update,
          provider: update.provider ?? settingsState.settings.provider,
          personality: update.personality ?? settingsState.settings.personality,
          heartbeat: update.heartbeat ?? settingsState.settings.heartbeat,
          voice: update.voice ?? settingsState.settings.voice,
          window: update.window ?? settingsState.settings.window,
        },
        hasApiKey: Boolean(update.apiKey) || (settingsState.hasApiKey && !update.clearApiKey),
        hasTtsApiKey: Boolean(update.ttsApiKey)
          || (settingsState.hasTtsApiKey && !update.clearTtsApiKey),
      };
      settingsListeners.forEach((listener) => listener(structuredClone(settingsState)));
      return structuredClone(settingsState);
    },
    async synthesizeSpeech() {
      throw new Error("浏览器预览模式未连接 TTS 服务");
    },
    async getLocalSpeechStatus() {
      return {
        state: "missing",
        modelId: "browser-preview",
        directory: "浏览器预览模式",
        sizeBytes: 0,
        message: "浏览器预览不运行本地 ASR，请在 Electron 中测试",
      };
    },
    async recognizeLocalSpeech() {
      throw new Error("浏览器预览模式未连接本地 ASR");
    },
    async showDataDirectory() {}, async minimize() {}, async close() {},
    async setPetInteraction() {}, async setPetClickThrough() {},
    async startPetDrag() {
      previewDragging = true;
      locomotionListeners.forEach((listener) => listener("dragged"));
    },
    async endPetDrag() {
      previewDragging = false;
      locomotionListeners.forEach((listener) => listener("falling"));
      window.setTimeout(() => locomotionListeners.forEach((listener) => listener("idle")), 500);
    },
    async getModelState() { return structuredClone(modelState); },
    async getActiveModel() {
      const definition = BUNDLED_MODELS.find((item) => item.id === resourceModelId) ?? BUNDLED_MODELS[0]!;
      return loadBrowserModelAssets(definition, modelState.model);
    },
    async importLive2DModel() {
      const source = BUNDLED_MODELS[1]!;
      resourceModelId = source.id;
      modelState = createModelState({
        ...source,
        id: "browser-import-preview",
        name: "Mao（用户导入预览）",
        source: "imported",
        importedAt: new Date().toISOString(),
      }, "imported");
      modelListeners.forEach((listener) => listener(structuredClone(modelState)));
      return {
        cancelled: false,
        state: structuredClone(modelState),
        message: "浏览器预览以 Mao 模拟用户导入；Electron 中会打开真实目录选择器。",
      };
    },
    async selectBundledModel(modelId) {
      const selected = BUNDLED_MODELS.find((item) => item.id === modelId);
      if (!selected) throw new Error("未知的内置 Live2D 模型");
      resourceModelId = selected.id;
      modelState = createModelState(selected);
      modelListeners.forEach((listener) => listener(structuredClone(modelState)));
      return structuredClone(modelState);
    },
    async playPetAction(action) { actionListeners.forEach((listener) => listener(action)); },
    onProactiveMessage(listener) { proactiveListeners.add(listener); return () => proactiveListeners.delete(listener); },
    onSettingsChanged(listener) { settingsListeners.add(listener); return () => settingsListeners.delete(listener); },
    onLocomotion(listener) { locomotionListeners.add(listener); return () => locomotionListeners.delete(listener); },
    onPetFocus(listener) { focusListeners.add(listener); return () => focusListeners.delete(listener); },
    onPetAction(listener) { actionListeners.add(listener); return () => actionListeners.delete(listener); },
    onModelChanged(listener) { modelListeners.add(listener); return () => modelListeners.delete(listener); },
    onUiCommand(listener) { uiListeners.add(listener); return () => uiListeners.delete(listener); },
    onPanelView(listener) { panelListeners.add(listener); return () => panelListeners.delete(listener); },
    onPersonalityChanged(listener) { personalityListeners.add(listener); return () => personalityListeners.delete(listener); },
  };
  window.petAgent = bridge;

  let previewWalking = false;
  window.setInterval(() => {
    if (previewDragging) return;
    previewWalking = !previewWalking;
    locomotionListeners.forEach((listener) => listener(previewWalking ? "walk-right" : "idle"));
  }, 3200);
}

function blankPersonalityProfile(): PersonalityProfile {
  const now = new Date().toISOString();
  return {
    version: 1,
    stage: "blank",
    interactionCount: 0,
    traits: [],
    summary: "尚未形成稳定人格，正在从真实互动中认识自己的表达方式。",
    createdAt: now,
    updatedAt: now,
  };
}

function createModelState(model: Live2DModelInfo, kind: PublicModelState["kind"] = "bundled"): PublicModelState {
  return {
    kind,
    model: publicInfo(model),
    bundledModels: BUNDLED_MODELS.map(publicInfo),
  };
}

function publicInfo(model: Live2DModelInfo): Live2DModelInfo {
  const { id, name, source, settingsVersion, motionGroups, motionCount, expressionCount, lipSyncParameters, textureCount, importedAt } = model;
  return {
    id, name, source, settingsVersion, motionGroups: { ...motionGroups }, motionCount,
    expressionCount, lipSyncParameters: [...lipSyncParameters], textureCount, importedAt,
  };
}

async function loadBrowserModelAssets(
  definition: Live2DModelInfo & { directory: string },
  info: Live2DModelInfo,
): Promise<Live2DModelAssetPackage> {
  const modelFile = `${definition.directory}.model3.json`;
  const base = `./live2d/${encodeURIComponent(definition.directory)}/`;
  const settingsResponse = await fetch(`${base}${encodeURIComponent(modelFile)}`);
  if (!settingsResponse.ok) throw new Error(`无法读取浏览器预览模型：${settingsResponse.status}`);
  const settingsText = await settingsResponse.text();
  const settings = JSON.parse(settingsText) as {
    FileReferences: {
      Moc: string; Textures: string[]; Physics?: string; Pose?: string; UserData?: string; DisplayInfo?: string;
      Motions?: Record<string, Array<{ File: string; Sound?: string }>>;
      Expressions?: Array<{ File: string }>;
    };
  };
  const paths = new Set<string>([modelFile, settings.FileReferences.Moc, ...settings.FileReferences.Textures]);
  for (const value of [settings.FileReferences.Physics, settings.FileReferences.Pose, settings.FileReferences.UserData, settings.FileReferences.DisplayInfo]) {
    if (value) paths.add(value);
  }
  for (const motions of Object.values(settings.FileReferences.Motions ?? {})) {
    for (const motion of motions) {
      paths.add(motion.File);
      if (motion.Sound) paths.add(motion.Sound);
    }
  }
  for (const expression of settings.FileReferences.Expressions ?? []) paths.add(expression.File);
  const files = await Promise.all([...paths].map(async (path) => {
    if (path === modelFile) {
      return { path, mimeType: "application/json", base64: bytesToBase64(new TextEncoder().encode(settingsText)) };
    }
    const response = await fetch(`${base}${path.split("/").map(encodeURIComponent).join("/")}`);
    if (!response.ok) throw new Error(`模型资源加载失败：${path}`);
    return {
      path,
      mimeType: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
      base64: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
    };
  }));
  return { info: publicInfo(info), files };
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return window.btoa(result);
}

function sampleMemory(
  tier: MemoryRecord["tier"], kind: MemoryRecord["kind"], content: string, importance: number,
): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), tier, kind, content, summary: content, importance, tags: ["preview"],
    createdAt: now, updatedAt: now, accessedAt: now, accessCount: 1, sourceIds: [],
  };
}
