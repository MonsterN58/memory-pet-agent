import { DEFAULT_SETTINGS } from "../common/defaults";
import { BUNDLED_MODEL_DEFINITIONS } from "../common/bundled-models";
import type {
  ChatResponse,
  ComputerActionProposal,
  ComputerAuditEntry,
  ComputerIntegrationState,
  ControlPanelView,
  Live2DModelAssetPackage,
  Live2DModelInfo,
  LocalSpeechModelStatus,
  MemoryRecord,
  MemorySnapshot,
  PetAgentBridge,
  PetAction,
  PetFocus,
  PetMotionFrame,
  PetUiCommand,
  PersonalityProfile,
  RelationshipProfile,
  PublicModelState,
  PublicSettingsState,
} from "../common/types";

type BrowserBundledModel = Live2DModelInfo & { directory: string; settingsFile: string };
type BrowserModelMetadata = Pick<
  Live2DModelInfo,
  "settingsVersion" | "motionGroups" | "motionCount" | "expressionCount" | "lipSyncParameters" | "textureCount"
>;

const BUNDLED_MODEL_METADATA: Record<string, BrowserModelMetadata> = {
  hiyori: {
    settingsVersion: 3, motionGroups: { Idle: 9, TapBody: 1 }, motionCount: 10,
    expressionCount: 0, lipSyncParameters: ["ParamMouthOpenY"], textureCount: 2,
  },
  mao: {
    settingsVersion: 3, motionGroups: { Idle: 2, TapBody: 6 }, motionCount: 8,
    expressionCount: 8, lipSyncParameters: ["ParamA"], textureCount: 1,
  },
  wanko: {
    settingsVersion: 3, motionGroups: { Idle: 4, TapBody: 6, Shake: 2 }, motionCount: 12,
    expressionCount: 0, lipSyncParameters: ["PARAM_MOUTH_OPEN_Y"], textureCount: 1,
  },
  haru: {
    settingsVersion: 3, motionGroups: { Idle: 2, TapBody: 4 }, motionCount: 6,
    expressionCount: 8, lipSyncParameters: ["ParamMouthOpenY"], textureCount: 2,
  },
  mark: {
    settingsVersion: 3, motionGroups: { Idle: 6 }, motionCount: 6,
    expressionCount: 0, lipSyncParameters: ["ParamMouthOpenY"], textureCount: 1,
  },
  nana: {
    settingsVersion: 3, motionGroups: {}, motionCount: 0,
    expressionCount: 0, lipSyncParameters: [], textureCount: 1,
  },
  rice: {
    settingsVersion: 3, motionGroups: { Idle: 1, TapBody: 3 }, motionCount: 4,
    expressionCount: 0, lipSyncParameters: [], textureCount: 2,
  },
  cyannyan: {
    settingsVersion: 3, motionGroups: {}, motionCount: 0,
    expressionCount: 16, lipSyncParameters: ["ParamMouthOpenY"], textureCount: 1,
  },
  xiaoyun: {
    settingsVersion: 3, motionGroups: {}, motionCount: 0,
    expressionCount: 18, lipSyncParameters: ["ParamMouthOpenY"], textureCount: 1,
  },
};

const BUNDLED_MODELS: BrowserBundledModel[] = BUNDLED_MODEL_DEFINITIONS.map((definition) => ({
  id: definition.id,
  name: definition.name,
  source: "bundled",
  origin: definition.origin,
  temperamentSeed: { ...definition.temperamentSeed },
  directory: definition.directory,
  settingsFile: definition.settingsFile,
  ...BUNDLED_MODEL_METADATA[definition.id]!,
}));

// 仅用于通过 http:// 的本地浏览器做 UI 预览。Electron 正式运行使用 preload 中的真实桥接。
if (location.protocol.startsWith("http") && !window.petAgent) {
  let settingsState: PublicSettingsState = {
    settings: structuredClone(DEFAULT_SETTINGS),
    hasApiKey: false,
    hasVisionApiKey: false,
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
  let relationshipProfile: RelationshipProfile = blankRelationshipProfile();
  const proactiveListeners = new Set<(message: ChatResponse) => void>();
  const settingsListeners = new Set<(state: PublicSettingsState) => void>();
  const localSpeechStatusListeners = new Set<(status: LocalSpeechModelStatus) => void>();
  const motionListeners = new Set<(frame: PetMotionFrame) => void>();
  const focusListeners = new Set<(focus: PetFocus) => void>();
  const uiListeners = new Set<(command: PetUiCommand) => void>();
  const panelListeners = new Set<(view: ControlPanelView) => void>();
  const actionListeners = new Set<(action: PetAction) => void>();
  const modelListeners = new Set<(state: PublicModelState) => void>();
  const personalityListeners = new Set<(profile: PersonalityProfile) => void>();
  const relationshipListeners = new Set<(profile: RelationshipProfile) => void>();
  let previewDragging = false;
  let resourceModelId = "hiyori";
  let modelState = createModelState(BUNDLED_MODELS[0]!);
  const computerAudit: ComputerAuditEntry[] = [];

  function computerState(): ComputerIntegrationState {
    const enabled = settingsState.settings.computer.enabled;
    return {
      enabled,
      browserContextEnabled: settingsState.settings.computer.browserContextEnabled,
      browserBridgeRunning: enabled && settingsState.settings.computer.browserContextEnabled,
      browserBridgeMessage: "浏览器预览模式不会启动真实本机桥接",
      endpoint: "http://127.0.0.1:32145",
      pairingToken: "browser-preview-pairing-token",
      extensionDirectory: "browser-extension",
      clipboardShortcutEnabled: settingsState.settings.computer.clipboardShortcutEnabled,
      clipboardShortcutRegistered: false,
      clipboardShortcut: "Ctrl+Shift+E",
      sessionAllowedTools: [],
      recentAudit: structuredClone(computerAudit),
    };
  }

  const bridge: PetAgentBridge = {
    async bootstrap() {
      return {
        settings: structuredClone(settingsState),
        memory: structuredClone(memory),
        personality: structuredClone(personalityProfile),
        relationship: structuredClone(relationshipProfile),
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
      relationshipProfile.interactionCount += 1;
      relationshipProfile.stage = relationshipProfile.interactionCount >= 3 ? "acquainted" : "new";
      relationshipProfile.summary = `我们已经有 ${relationshipProfile.interactionCount} 次互动，仍在从真实交流中确认彼此的习惯。`;
      relationshipProfile.updatedAt = new Date().toISOString();
      relationshipListeners.forEach((listener) => listener(structuredClone(relationshipProfile)));
      const planPreview = text.includes("协作计划");
      const singlePreview = text.includes("操作预览");
      const planId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const previewAction: ComputerActionProposal[] | undefined = planPreview
        ? ([
            {
              id: crypto.randomUUID(),
              tool: "open-url",
              title: "打开项目主页",
              description: "使用默认浏览器打开固定地址。",
              preview: "https://github.com/MonsterN58/memory-pet-agent",
              severity: "info",
              requiresApproval: true,
              allowedDecisions: ["allow-once", "deny"],
              expiresAt,
            },
            {
              id: crypto.randomUUID(),
              tool: "copy-text",
              title: "写入剪贴板",
              description: "把固定摘要写入系统剪贴板。",
              preview: "记忆桌宠：动作与协作能力验收完成",
              severity: "info",
              requiresApproval: true,
              allowedDecisions: ["allow-once", "deny"],
              expiresAt,
            },
            {
              id: crypto.randomUUID(),
              tool: "office-write",
              title: "写入 Office",
              description: "向当前已打开的 Word 文档追加纯文本，不自动保存。",
              preview: "Word 追加：动作与协作能力验收完成",
              severity: "warning",
              requiresApproval: true,
              allowedDecisions: ["allow-once", "deny"],
              expiresAt,
            },
          ] satisfies ComputerActionProposal[]).map((proposal, index, proposals) => ({
            ...proposal,
            plan: {
              id: planId,
              title: "桌宠协作验收",
              step: index + 1,
              total: proposals.length,
            },
          }))
        : singlePreview
          ? [{
              id: crypto.randomUUID(),
              tool: "open-url",
              title: "打开项目主页",
              description: "我会使用默认浏览器打开这个网页，地址在确认后不会变化。",
              preview: "https://github.com/MonsterN58/memory-pet-agent",
              severity: "info",
              requiresApproval: true,
              allowedDecisions: ["allow-once", "allow-session", "allow-always", "deny"],
              expiresAt,
            }]
          : undefined;
      const previewTools = text.includes("工具调用") || previewAction ? [
        {
          callId: crypto.randomUUID(),
          name: "memory_search" as const,
          label: "回想记忆",
          status: "completed" as const,
          summary: "找到 2 条相关记忆",
        },
        ...(previewAction ? [{
          callId: crypto.randomUUID(),
          name: planPreview ? "computer_work_plan" as const : "computer_open_url" as const,
          label: planPreview ? "准备协作计划" : "准备打开网页",
          status: "approval-required" as const,
          summary: "等待用户确认",
        }] : []),
      ] : undefined;
      return {
        text: planPreview
          ? "我把这项工作整理成了三步，会一项一项等你确认；任何一步停下，后面的步骤也会一起停止。"
          : text.includes("长回复")
          ? "我会先陪你把这件事慢慢说清楚。你不需要一次把所有情绪整理好，我们可以从今天最让你在意的那一小段开始；如果你愿意，我也会记住其中真正重要的变化，等以后再聊到时自然地接上，而不是像第一次听见那样重新问你。"
          : "我听到了。重要的部分我会慢慢记住，也会在以后合适的时候自然接上。",
        emotion: "happy",
        source: "local",
        memoryRefs: [],
        computerActions: previewAction,
        toolCalls: previewTools,
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
    async getRelationship() { return structuredClone(relationshipProfile); },
    async resetRelationship() {
      relationshipProfile = blankRelationshipProfile();
      relationshipListeners.forEach((listener) => listener(structuredClone(relationshipProfile)));
      return structuredClone(relationshipProfile);
    },
    async runHeartbeat() {
      const consolidated = memory.l2.splice(0);
      memory.l3.push(...consolidated.map((item) => ({ ...item, tier: "L3" as const })));
      const event = {
        id: crypto.randomUUID(), reason: "manual" as const, createdAt: new Date().toISOString(),
        movedToL2: 0, consolidatedToL3: consolidated.length, reflection: "预览模式心跳已完成。",
      };
      memory.recentHeartbeats.unshift(event);
      memory.recentHeartbeats = memory.recentHeartbeats.slice(0, 20);
      return {
        event,
        snapshot: structuredClone(memory),
        personality: structuredClone(personalityProfile),
        relationship: structuredClone(relationshipProfile),
      };
    },
    async saveSettings(update) {
      settingsState = {
        ...settingsState,
        settings: {
          ...settingsState.settings,
          ...update,
          provider: update.provider ?? settingsState.settings.provider,
          vision: update.vision ?? settingsState.settings.vision,
          personality: update.personality ?? settingsState.settings.personality,
          heartbeat: update.heartbeat ?? settingsState.settings.heartbeat,
          awareness: update.awareness ?? settingsState.settings.awareness,
          voice: update.voice ?? settingsState.settings.voice,
          computer: update.computer ?? settingsState.settings.computer,
          window: update.window ?? settingsState.settings.window,
        },
        hasApiKey: Boolean(update.apiKey) || (settingsState.hasApiKey && !update.clearApiKey),
        hasVisionApiKey: Boolean(update.visionApiKey)
          || (settingsState.hasVisionApiKey && !update.clearVisionApiKey),
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
        runtimeState: "not-started",
        runtimeMessage: "浏览器预览未启动本地识别运行时",
      };
    },
    async recognizeLocalSpeech() {
      throw new Error("浏览器预览模式未连接本地 ASR");
    },
    async cancelLocalSpeechRecognition() {},
    async showDataDirectory() {}, async minimize() {}, async close() {},
    async setPetInteraction() {}, async setPetClickThrough() {},
    async startPetDrag() {
      previewDragging = true;
      motionListeners.forEach((listener) => listener({
        state: "dragged", velocityX: 0.35, velocityY: -0.15, offsetX: 0.04, offsetY: -0.03,
      }));
    },
    async endPetDrag() {
      previewDragging = false;
      motionListeners.forEach((listener) => listener({
        state: "falling", velocityX: 0.35, velocityY: 0.55, offsetX: 0, offsetY: 0.04,
      }));
      window.setTimeout(() => motionListeners.forEach((listener) => listener({
        state: "landing", velocityX: 0.2, velocityY: 0.8, offsetX: 0, offsetY: 0.04,
      })), 180);
      window.setTimeout(() => motionListeners.forEach((listener) => listener({
        state: "idle", velocityX: 0, velocityY: 0, offsetX: 0, offsetY: 0,
      })), 500);
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
        origin: "user-import",
        temperamentSeed: undefined,
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
    async getComputerIntegrationState() { return computerState(); },
    async rotateComputerPairingToken() { return computerState(); },
    async copyComputerPairingInfo() {},
    async openBrowserExtensionDirectory() {},
    async clearComputerAudit() { computerAudit.splice(0); return computerState(); },
    async executeComputerAction(id, decision) {
      return {
        id,
        status: decision === "deny" ? "denied" : "completed",
        message: decision === "deny" ? "好，这次不做。" : "浏览器预览已模拟执行",
      };
    },
    onProactiveMessage(listener) { proactiveListeners.add(listener); return () => proactiveListeners.delete(listener); },
    onSettingsChanged(listener) { settingsListeners.add(listener); return () => settingsListeners.delete(listener); },
    onLocalSpeechStatusChanged(listener) {
      localSpeechStatusListeners.add(listener);
      return () => localSpeechStatusListeners.delete(listener);
    },
    onPetMotion(listener) { motionListeners.add(listener); return () => motionListeners.delete(listener); },
    onPetFocus(listener) { focusListeners.add(listener); return () => focusListeners.delete(listener); },
    onPetAction(listener) { actionListeners.add(listener); return () => actionListeners.delete(listener); },
    onModelChanged(listener) { modelListeners.add(listener); return () => modelListeners.delete(listener); },
    onUiCommand(listener) { uiListeners.add(listener); return () => uiListeners.delete(listener); },
    onPanelView(listener) { panelListeners.add(listener); return () => panelListeners.delete(listener); },
    onPersonalityChanged(listener) { personalityListeners.add(listener); return () => personalityListeners.delete(listener); },
    onRelationshipChanged(listener) { relationshipListeners.add(listener); return () => relationshipListeners.delete(listener); },
  };
  window.petAgent = bridge;

  window.addEventListener("pointermove", (event) => {
    const focus = {
      x: Math.max(-1, Math.min(1, (event.clientX - window.innerWidth / 2) / 640)),
      y: Math.max(-1, Math.min(1, (window.innerHeight / 2 - event.clientY) / 480)),
    };
    focusListeners.forEach((listener) => listener(focus));
  }, { passive: true });

  let previewWalking = false;
  window.setInterval(() => {
    if (previewDragging) return;
    previewWalking = !previewWalking;
    motionListeners.forEach((listener) => listener({
      state: previewWalking ? "walk-right" : "idle",
      velocityX: previewWalking ? 0.16 : 0,
      velocityY: 0,
      offsetX: previewWalking ? 0.012 : 0,
      offsetY: 0,
    }));
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

function blankRelationshipProfile(): RelationshipProfile {
  const now = new Date().toISOString();
  return {
    version: 1,
    stage: "new",
    interactionCount: 0,
    insights: [],
    activityPatterns: [],
    sharedMoments: [],
    careStyle: {
      initiativeAffinity: 0.5,
      practicalHelpAffinity: 0.5,
      quietCompanionshipAffinity: 0.5,
      evidenceCount: 0,
      updatedAt: now,
    },
    recentProactiveTopics: [],
    summary: "彼此还在初识，我会从真实互动中慢慢了解你，而不是先替你下定义。",
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
  const {
    id, name, source, origin, temperamentSeed, settingsVersion, motionGroups,
    motionCount, expressionCount, lipSyncParameters, textureCount, importedAt,
  } = model;
  return {
    id, name, source, origin, temperamentSeed: temperamentSeed ? { ...temperamentSeed } : undefined,
    settingsVersion, motionGroups: { ...motionGroups }, motionCount,
    expressionCount, lipSyncParameters: [...lipSyncParameters], textureCount, importedAt,
  };
}

async function loadBrowserModelAssets(
  definition: BrowserBundledModel,
  info: Live2DModelInfo,
): Promise<Live2DModelAssetPackage> {
  const modelFile = definition.settingsFile;
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
