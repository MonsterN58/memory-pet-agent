import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { ChatResponse, HeartbeatEvent, MemoryRecord } from "../src/common/types";
import type { AgentService, HeartbeatThoughtInput } from "../src/main/agent-service";
import type { DesktopAwarenessService, DesktopAwarenessSnapshot } from "../src/main/desktop-awareness-service";
import { HeartbeatService } from "../src/main/heartbeat-service";
import type { MemoryEngine } from "../src/main/memory/memory-engine";
import type { MemoryRepository } from "../src/main/memory/memory-repository";
import { emptyPersonalityProfile } from "../src/main/personality/personality-store";
import type { PersonalityEngine } from "../src/main/personality/personality-engine";
import type { RelationshipEngine } from "../src/main/relationship/relationship-engine";
import { emptyRelationshipProfile } from "../src/main/relationship/relationship-store";
import type { SettingsStore } from "../src/main/settings-store";

test("心跳按感知、复盘、整理、思考、单次主动开口的顺序执行且不持久化截图", async () => {
  const order: string[] = [];
  const events: HeartbeatEvent[] = [];
  const pending = [memoryRecord()];
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.heartbeat.consolidateAfterItems = 1;
  const screen: DesktopAwarenessSnapshot = {
    capturedAt: new Date().toISOString(),
    screenCaptureAttempted: true,
    screenSharedWithProvider: true,
    screenStatus: "completed",
    visionAnalysis: {
      sceneSummary: "SCREEN_DETAIL 用户似乎在编辑代码",
      currentTask: "继续桌宠项目",
      busyState: "focused",
      helpOpportunity: "可以帮忙检查测试",
      confidence: 0.72,
    },
    processScanCompleted: true,
    processStatus: "completed",
    applications: [{ kind: "coding", label: "编写或阅读代码", processes: ["code.exe"], newlyStarted: true }],
  };
  let thoughtInput: HeartbeatThoughtInput | undefined;
  let proactiveCalls = 0;
  const memory = {
    flushL1: async () => { order.push("flush"); return 1; },
    consolidate: async () => { order.push("consolidate"); return 1; },
    reviewSummary: () => "回顾了一段项目对话",
    snapshot: () => ({ l1: [], l2: [], l3: [], recentHeartbeats: [...events] }),
  } as unknown as MemoryEngine;
  const repository = {
    getL2: () => pending,
    setMeta: async () => undefined,
    getMeta: () => ({}),
    getRecentHeartbeats: () => events,
    recordHeartbeat: async (event: HeartbeatEvent) => { order.push("record"); events.push(event); },
  } as unknown as MemoryRepository;
  const personality = {
    reviewMemories: async () => { order.push("personality"); return 2; },
    getProfile: () => emptyPersonalityProfile("2026-01-01T00:00:00.000Z"),
  } as unknown as PersonalityEngine;
  const relationship = {
    reviewMemories: async () => { order.push("relationship"); return 2; },
    observeDesktopActivities: async () => { order.push("activities"); return 1; },
    recordProactiveTopic: async () => undefined,
    getProfile: () => emptyRelationshipProfile("2026-01-01T00:00:00.000Z"),
  } as unknown as RelationshipEngine;
  const agent = {
    extractPersonalitySignals: async () => undefined,
    extractRelationshipSignals: async () => undefined,
    extractLongTerm: async () => undefined,
    createHeartbeatThought: async (input: HeartbeatThoughtInput) => {
      order.push("thought");
      thoughtInput = input;
      return {
        selfReflection: "我更清楚自己要以桌宠的方式陪伴",
        userUnderstanding: "用户正在推进项目",
        relationshipFocus: "提供轻量帮助",
        shouldReachOut: true,
        proactiveTopic: "用户可能正在编写或阅读代码；询问是否需要一起梳理",
        reason: "出现新的代码活动信号",
      };
    },
    createHeartbeatProactiveMessage: async (): Promise<ChatResponse> => {
      order.push("proactive");
      proactiveCalls += 1;
      return { text: "像是在写代码，需要我一起理一小段吗？", emotion: "curious", source: "local", memoryRefs: [] };
    },
  } as unknown as AgentService;
  const awareness = {
    observe: async () => { order.push("awareness"); return screen; },
    promptText: () => "<desktop_context_data>coarse only</desktop_context_data>",
    auditSummary: () => ({
      screenSharedWithProvider: true,
      processScanCompleted: true,
      visibleApplicationCount: 1,
      newApplicationCount: 1,
      activityLabels: ["编写或阅读代码"],
    }),
  } as unknown as DesktopAwarenessService;
  const service = new HeartbeatService(
    memory,
    repository,
    agent,
    { get: () => structuredClone(settings) } as unknown as SettingsStore,
    personality,
    relationship,
    awareness,
  );

  const result = await service.run("manual", true);
  assert.deepEqual(order, ["awareness", "flush", "personality", "relationship", "activities", "consolidate", "thought", "proactive", "record"]);
  assert.equal(proactiveCalls, 1);
  assert.equal(thoughtInput?.canReachOut, true);
  assert.equal(result.event.relationshipUpdates, 3);
  assert.equal(result.event.awareness?.screenSharedWithProvider, true);
  assert.doesNotMatch(JSON.stringify(result.event), /SCREEN_DETAIL|data:image|code\.exe/);
});

test("定时心跳不满足空闲策略时仍思考但不会从旁路主动聊天", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  let canReachOut: boolean | undefined;
  let proactiveCalls = 0;
  const service = new HeartbeatService(
    {
      flushL1: async () => 0,
      reviewSummary: () => "暂无新记忆",
      snapshot: () => ({ l1: [], l2: [], l3: [], recentHeartbeats: [] }),
    } as unknown as MemoryEngine,
    {
      getL2: () => [],
      getMeta: () => ({ lastInteractionAt: new Date().toISOString() }),
      setMeta: async () => undefined,
      getRecentHeartbeats: () => [],
      recordHeartbeat: async () => undefined,
    } as unknown as MemoryRepository,
    {
      createHeartbeatThought: async (input: HeartbeatThoughtInput) => {
        canReachOut = input.canReachOut;
        return {
          selfReflection: "保持安静也是陪伴",
          userUnderstanding: "用户刚互动过",
          relationshipFocus: "不打扰",
          shouldReachOut: false,
          reason: input.proactivePolicyReason ?? "不打扰",
        };
      },
      createHeartbeatProactiveMessage: async () => {
        proactiveCalls += 1;
        throw new Error("不应执行");
      },
    } as unknown as AgentService,
    { get: () => structuredClone(settings) } as unknown as SettingsStore,
    {
      reviewMemories: async () => 0,
      getProfile: () => emptyPersonalityProfile(),
    } as unknown as PersonalityEngine,
    {
      reviewMemories: async () => 0,
      getProfile: () => emptyRelationshipProfile(),
    } as unknown as RelationshipEngine,
    {
      observe: async () => ({
        capturedAt: new Date().toISOString(),
        screenCaptureAttempted: false,
        screenSharedWithProvider: false,
        screenStatus: "disabled",
        processScanCompleted: false,
        processStatus: "disabled",
        applications: [],
      }),
      promptText: () => "none",
      auditSummary: () => ({
        screenSharedWithProvider: false,
        processScanCompleted: false,
        visibleApplicationCount: 0,
        newApplicationCount: 0,
        activityLabels: [],
      }),
    } as unknown as DesktopAwarenessService,
  );

  const result = await service.run("scheduled");
  assert.equal(canReachOut, false);
  assert.equal(proactiveCalls, 0);
  assert.match(result.event.skippedProactiveReason ?? "", /空闲/);
});

test("从未聊天的新用户会从首次心跳开始累计空闲时间并允许主动靠近", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.heartbeat.idleMinutesBeforeChat = 1;
  settings.heartbeat.quietHoursStart = 0;
  settings.heartbeat.quietHoursEnd = 0;
  const meta = { firstHeartbeatAt: new Date(Date.now() - 2 * 60_000).toISOString() };
  let canReachOut = false;
  let proactiveCalls = 0;
  const repository = {
    getL2: () => [],
    getMeta: () => ({ ...meta }),
    setMeta: async (patch: Partial<typeof meta> & { lastProactiveAt?: string }) => Object.assign(meta, patch),
    getRecentHeartbeats: () => [],
    recordHeartbeat: async () => undefined,
  } as unknown as MemoryRepository;
  const service = new HeartbeatService(
    basicMemory(),
    repository,
    {
      createHeartbeatThought: async (input: HeartbeatThoughtInput) => {
        canReachOut = input.canReachOut;
        return {
          selfReflection: "我可以轻轻靠近",
          userUnderstanding: "仍在初识",
          relationshipFocus: "给对方拒绝空间",
          shouldReachOut: input.canReachOut,
          proactiveTopic: input.canReachOut ? "问问是否需要一个小帮助" : undefined,
          reason: input.canReachOut ? "空闲阈值已满足" : input.proactivePolicyReason ?? "不打扰",
        };
      },
      createHeartbeatProactiveMessage: async () => {
        proactiveCalls += 1;
        return { text: "需要我搭把手吗？", emotion: "curious", source: "local", memoryRefs: [] };
      },
    } as unknown as AgentService,
    { get: () => structuredClone(settings) } as unknown as SettingsStore,
    basicPersonality(),
    basicRelationship(),
    basicAwareness(),
  );
  await service.run("scheduled");
  assert.equal(canReachOut, true);
  assert.equal(proactiveCalls, 1);
});

test("定时心跳运行中触发手动心跳会在当前轮结束后补跑", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.heartbeat.proactiveEnabled = false;
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const reasons: HeartbeatEvent["reason"][] = [];
  const meta: { firstHeartbeatAt?: string } = { firstHeartbeatAt: new Date().toISOString() };
  let thoughtCalls = 0;
  const service = new HeartbeatService(
    basicMemory(),
    {
      getL2: () => [],
      getMeta: () => ({ ...meta }),
      setMeta: async (patch: Partial<typeof meta>) => Object.assign(meta, patch),
      getRecentHeartbeats: () => [],
      recordHeartbeat: async () => undefined,
    } as unknown as MemoryRepository,
    {
      createHeartbeatThought: async (input: HeartbeatThoughtInput) => {
        thoughtCalls += 1;
        if (thoughtCalls === 1) {
          enteredFirst();
          await gate;
        }
        return {
          selfReflection: "完成一轮思考",
          userUnderstanding: "继续了解",
          relationshipFocus: "保持连续",
          shouldReachOut: false,
          reason: input.proactivePolicyReason ?? "安静",
        };
      },
    } as unknown as AgentService,
    { get: () => structuredClone(settings) } as unknown as SettingsStore,
    basicPersonality(),
    basicRelationship(),
    {
      ...basicAwareness(),
      observe: async (reason: HeartbeatEvent["reason"]) => {
        reasons.push(reason);
        return emptyAwarenessSnapshot();
      },
    } as unknown as DesktopAwarenessService,
  );
  const scheduled = service.run("scheduled");
  await entered;
  const manual = service.run("manual", true);
  releaseFirst();
  await scheduled;
  const manualResult = await manual;
  assert.deepEqual(reasons, ["scheduled", "manual"]);
  assert.equal(thoughtCalls, 2);
  assert.equal(manualResult.event.reason, "manual");
});

function emptyAwarenessSnapshot(): DesktopAwarenessSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    screenCaptureAttempted: false,
    screenSharedWithProvider: false,
    screenStatus: "disabled",
    processScanCompleted: false,
    processStatus: "disabled",
    applications: [],
  };
}

function basicAwareness(): DesktopAwarenessService {
  return {
    observe: async () => emptyAwarenessSnapshot(),
    promptText: () => "none",
    auditSummary: () => ({
      screenSharedWithProvider: false,
      processScanCompleted: false,
      visibleApplicationCount: 0,
      newApplicationCount: 0,
      activityLabels: [],
      screenStatus: "disabled",
      processStatus: "disabled",
    }),
  } as unknown as DesktopAwarenessService;
}

function basicMemory(): MemoryEngine {
  return {
    flushL1: async () => 0,
    reviewSummary: () => "暂无新记忆",
    snapshot: () => ({ l1: [], l2: [], l3: [], recentHeartbeats: [] }),
  } as unknown as MemoryEngine;
}

function basicPersonality(): PersonalityEngine {
  return {
    reviewMemories: async () => 0,
    getProfile: () => emptyPersonalityProfile(),
  } as unknown as PersonalityEngine;
}

function basicRelationship(): RelationshipEngine {
  return {
    reviewMemories: async () => 0,
    getProfile: () => emptyRelationshipProfile(),
    recordProactiveTopic: async () => undefined,
  } as unknown as RelationshipEngine;
}

function memoryRecord(): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: "memory-1",
    tier: "L2",
    kind: "episode",
    content: "用户：我在继续做桌宠项目\n桌宠：我陪你一起完善",
    summary: "一起完善桌宠项目",
    importance: 0.8,
    tags: ["chat"],
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    accessCount: 0,
    sourceIds: [],
  };
}
