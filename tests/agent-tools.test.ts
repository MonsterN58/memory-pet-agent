import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import { PET_ACTIONS } from "../src/common/types";
import type {
  ComputerActionProposal,
  MemoryRecord,
  PersonalityProfile,
  RelationshipProfile,
} from "../src/common/types";
import {
  AgentToolRuntime,
  runAgentToolLoop,
  type AgentToolRuntimeDependencies,
} from "../src/main/agent-tools";
import type { ProviderMessage, ProviderToolCall } from "../src/main/provider/openai-compatible";

function profiles(): { personality: PersonalityProfile; relationship: RelationshipProfile } {
  const now = new Date().toISOString();
  return {
    personality: {
      version: 1,
      stage: "forming",
      interactionCount: 4,
      traits: [],
      summary: "正在谨慎形成自己的表达方式。",
      createdAt: now,
      updatedAt: now,
    },
    relationship: {
      version: 1,
      stage: "acquainted",
      interactionCount: 6,
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
      summary: "正在慢慢了解用户。",
      createdAt: now,
      updatedAt: now,
    },
  };
}

function runtimeFixture(overrides: Partial<AgentToolRuntimeDependencies> = {}) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const saved: string[] = [];
  const observedActivities: Array<{ kind: string; label: string }> = [];
  const profile = profiles();
  const memoryResult: MemoryRecord = {
      id: "memory-1",
      tier: "L3",
      kind: "preference",
      content: "用户目前喜欢红茶",
      summary: "目前喜欢红茶",
      importance: 0.8,
      tags: ["preference"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      accessCount: 0,
      sourceIds: [],
  };
  const dependencies: AgentToolRuntimeDependencies = {
    memory: {
      recall: async () => [memoryResult],
      rememberExplicit: async (content) => { saved.push(content); },
    },
    personality: { getProfile: () => structuredClone(profile.personality) },
    relationship: {
      getProfile: () => structuredClone(profile.relationship),
      observeDesktopActivities: async (activities) => {
        observedActivities.push(...activities);
        return activities.length;
      },
    },
    awareness: {
      observe: async () => ({
        capturedAt: new Date().toISOString(),
        screenCaptureAttempted: false,
        screenSharedWithProvider: false,
        screenStatus: "disabled",
        processScanCompleted: false,
        processStatus: "disabled",
        applications: [],
      }),
    },
    computer: {
      planDraft: async () => ({}),
      planDrafts: async () => ({ proposals: [] }),
      planFromChat: async () => ({}),
    },
    getSettings: () => settings,
    ...overrides,
  };
  return { runtime: new AgentToolRuntime(dependencies), settings, saved, observedActivities, memoryResult };
}

function call(name: string, args: Record<string, unknown>, id = `call-${name}`): ProviderToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("pet_action schema 与共享动作契约一致并接受新增协作动作", async () => {
  const fixture = runtimeFixture();
  const definition = fixture.runtime.definitions().find((item) => item.function.name === "pet_action");
  const properties = definition?.function.parameters.properties as Record<string, { enum?: string[] }> | undefined;
  assert.deepEqual(properties?.action?.enum, [...PET_ACTIONS]);

  for (const action of ["bow", "applaud", "peek", "ponder", "present"] as const) {
    const turn = fixture.runtime.startTurn(`请做 ${action}`);
    const result = await fixture.runtime.execute(call("pet_action", { action }, `call-${action}`), turn);
    assert.equal(turn.requestedAction, action);
    assert.match(result.content, new RegExp(`"action":"${action}"`));
  }

  const rejected = fixture.runtime.startTurn("做一个不存在的动作");
  const result = await fixture.runtime.execute(call("pet_action", { action: "teleport" }), rejected);
  assert.equal(rejected.requestedAction, undefined);
  assert.match(result.content, /未知桌宠动作/);
});

test("memory_store 只保存用户明确要求记住的原话，不采用模型改写内容", async () => {
  const fixture = runtimeFixture();
  const turn = fixture.runtime.startTurn("请记住：我现在喜欢红茶");

  const result = await fixture.runtime.execute(
    call("memory_store", { content: "用户拥有一座城堡" }),
    turn,
  );

  assert.deepEqual(fixture.saved, ["我现在喜欢红茶"]);
  assert.match(result.content, /"tier":"L2"/);
  assert.equal(turn.traces[0]?.status, "completed");
});

test("desktop_observe 只回填独立识图文本，聊天工具结果不含图片字节和窗口信息", async () => {
  const fixture = runtimeFixture({
    awareness: {
      observe: async () => ({
        capturedAt: new Date().toISOString(),
        screenCaptureAttempted: true,
        screenSharedWithProvider: true,
        screenStatus: "completed",
        visionAnalysis: {
          sceneSummary: "像是在阅读项目代码",
          currentTask: "检查桌宠实现",
          busyState: "focused",
          helpOpportunity: "可以协助检查测试",
          confidence: 0.7,
        },
        processScanCompleted: true,
        processStatus: "completed",
        applications: [{ kind: "coding", label: "编写或阅读代码", processes: ["code.exe"], newlyStarted: true }],
      }),
    },
  });
  fixture.settings.awareness.screenCaptureEnabled = true;
  fixture.settings.awareness.processDetectionEnabled = true;
  const turn = fixture.runtime.startTurn("看看我现在在做什么");

  const result = await fixture.runtime.execute(call("desktop_observe", { reason: "用户明确询问" }), turn);

  assert.match(result.content, /检查桌宠实现/);
  assert.doesNotMatch(result.content, /SCREEN_BYTES|data:image|code\.exe|Secret customer title/);
  assert.deepEqual(fixture.observedActivities, [{ kind: "coding", label: "编写或阅读代码", newlyStarted: true }]);
  assert.equal(turn.traces[0]?.status, "completed");
});

test("桌面两条通道没有结果时给出精确诊断而不是猜测临时权限", async () => {
  const fixture = runtimeFixture({
    awareness: {
      observe: async () => ({
        capturedAt: new Date().toISOString(),
        screenCaptureAttempted: false,
        screenSharedWithProvider: false,
        screenStatus: "not-configured",
        screenCaptureError: "识图 API 尚未配置完整",
        processScanCompleted: true,
        processStatus: "completed-empty",
        applications: [],
      }),
    },
  });
  fixture.settings.awareness.processDetectionEnabled = true;
  fixture.settings.awareness.screenCaptureEnabled = true;
  const turn = fixture.runtime.startTurn("看看我现在在做什么");
  await fixture.runtime.execute(call("desktop_observe", { reason: "用户明确询问" }), turn);
  assert.match(turn.desktopDiagnostic ?? "", /应用扫描成功/);
  assert.match(turn.desktopDiagnostic ?? "", /识图 API 尚未配置完整/);
  assert.doesNotMatch(turn.desktopDiagnostic ?? "", /可能是临时权限/);
});

test("聊天端点未调用工具时，明确桌面请求仍执行本机观察并返回结果", async () => {
  const fixture = runtimeFixture({
    awareness: {
      observe: async () => ({
        capturedAt: new Date().toISOString(),
        screenCaptureAttempted: false,
        screenSharedWithProvider: false,
        screenStatus: "disabled",
        processScanCompleted: true,
        processStatus: "completed",
        applications: [{
          kind: "coding",
          label: "编写或阅读代码",
          processes: ["code.exe"],
          newlyStarted: false,
        }],
      }),
    },
  });
  fixture.settings.awareness.processDetectionEnabled = true;
  const turn = fixture.runtime.startTurn("看看我现在在做什么");

  await fixture.runtime.ensureDeterministicBehaviors(turn, false);

  assert.equal(turn.desktopObserved, true);
  assert.match(turn.desktopDiagnostic ?? "", /编写或阅读代码/);
  assert.equal(turn.traces.some((item) => item.callId.startsWith("local-") && item.name === "desktop_observe"), true);
});

test("电脑 function tool 只生成参数固定的待确认预览", async () => {
  const proposal: ComputerActionProposal = {
    id: "00000000-0000-4000-8000-000000000001",
    tool: "open-url",
    title: "打开网页",
    description: "使用默认浏览器打开",
    preview: "https://example.com/",
    severity: "info",
    requiresApproval: true,
    allowedDecisions: ["allow-once", "deny"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const fixture = runtimeFixture({
    computer: {
      planDraft: async () => ({ proposal }),
      planDrafts: async () => ({ proposals: [] }),
      planFromChat: async () => ({ proposal }),
    },
  });
  const turn = fixture.runtime.startTurn("打开项目主页");

  const result = await fixture.runtime.execute(call("computer_open_url", { url: "https://example.com" }), turn);

  assert.equal(turn.proposals[0]?.id, proposal.id);
  assert.equal(turn.traces[0]?.status, "approval-required");
  assert.match(result.content, /approval_required/);
  assert.match(result.content, /仍需用户/);
});

test("先阻断后成功生成预览时会清除旧阻断信息", async () => {
  let attempts = 0;
  const fixture = runtimeFixture({
    computer: {
      planDraft: async (draft) => {
        attempts += 1;
        if (attempts === 1) return { warning: "第一次权限检查未通过" };
        return {
          proposal: {
            id: "00000000-0000-4000-8000-000000000099",
            tool: draft.tool,
            title: "待确认操作",
            description: "参数已固定",
            preview: "预览",
            severity: "info",
            requiresApproval: true,
            allowedDecisions: ["allow-once", "deny"],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
      planDrafts: async () => ({ proposals: [] }),
      planFromChat: async () => ({}),
    },
  });
  const turn = fixture.runtime.startTurn("打开项目页");
  await fixture.runtime.execute(call("computer_open_url", { url: "https://example.com/first" }, "blocked"), turn);
  assert.match(turn.blockingMessage ?? "", /第一次/);
  await fixture.runtime.execute(call("computer_open_url", { url: "https://example.com/second" }, "success"), turn);
  assert.equal(turn.blockingMessage, undefined);
  assert.equal(turn.proposals.length, 1);
});

test("浏览器与 Office function tools 只形成受限草稿并逐项等待确认", async () => {
  const drafts: unknown[] = [];
  let nextId = 20;
  const fixture = runtimeFixture({
    computer: {
      planDraft: async (draft) => {
        drafts.push(structuredClone(draft));
        nextId += 1;
        return {
          proposal: {
            id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
            tool: draft.tool,
            title: "待确认操作",
            description: "参数已固定",
            preview: "预览",
            severity: draft.tool === "office-write" ? "warning" : "info",
            requiresApproval: true,
            allowedDecisions: ["allow-once", "deny"],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
      planDrafts: async () => ({ proposals: [] }),
      planFromChat: async () => ({}),
    },
  });

  const definitionNames = fixture.runtime.definitions().map((item) => item.function.name);
  for (const name of [
    "computer_browser_control",
    "computer_word_append",
    "computer_excel_write",
    "computer_powerpoint_add_slide",
  ]) assert.ok(definitionNames.includes(name));

  await fixture.runtime.execute(
    call("computer_browser_control", { action: "find-text", text: "Live2D" }),
    fixture.runtime.startTurn("在网页里找 Live2D"),
  );
  await fixture.runtime.execute(
    call("computer_word_append", { text: "会议结论" }),
    fixture.runtime.startTurn("写入 Word"),
  );
  await fixture.runtime.execute(
    call("computer_excel_write", { start_cell: "B2", content: "\t状态\n小忆\t" }),
    fixture.runtime.startTurn("写入 Excel"),
  );
  await fixture.runtime.execute(
    call("computer_powerpoint_add_slide", { title: "周报", body: "本周完成三项任务" }),
    fixture.runtime.startTurn("写入 PowerPoint"),
  );

  assert.deepEqual(drafts, [
    { tool: "browser-control", action: "find-text", text: "Live2D", label: "当前网页" },
    { tool: "office-write", operation: "word-append", text: "会议结论" },
    { tool: "office-write", operation: "excel-write", startCell: "B2", content: "\t状态\n小忆\t" },
    { tool: "office-write", operation: "powerpoint-add-slide", title: "周报", body: "本周完成三项任务" },
  ]);
});

test("computer_work_plan 为 2～4 个步骤生成同组且有序的确认预览", async () => {
  const steps = [
    { kind: "launch-app", app: "calculator" },
    { kind: "browser-scroll-bottom" },
    { kind: "word-append", text: "已经检查到文档末尾" },
    { kind: "excel-write", start_cell: "B2", text: "项目\t状态\n桌宠\t完成" },
  ];
  const expectedDrafts = [
    { tool: "launch-app", app: "calculator", label: "计算器" },
    { tool: "browser-control", action: "scroll-bottom", label: "滚动到网页底部" },
    { tool: "office-write", operation: "word-append", text: "已经检查到文档末尾" },
    { tool: "office-write", operation: "excel-write", startCell: "B2", content: "项目\t状态\n桌宠\t完成" },
  ];

  for (const total of [2, 4]) {
    const receivedDrafts: unknown[] = [];
    const fixture = runtimeFixture({
      computer: {
        planDraft: async () => ({}),
        planDrafts: async (drafts) => {
          receivedDrafts.push(...structuredClone(drafts));
          return {
            proposals: drafts.map((draft, index): ComputerActionProposal => ({
              id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
              tool: draft.tool,
              title: `步骤 ${index + 1}`,
              description: "参数已固定",
              preview: `预览 ${index + 1}`,
              severity: draft.tool === "office-write" ? "warning" : "info",
              requiresApproval: true,
              allowedDecisions: ["allow-once", "deny"],
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            })),
          };
        },
        planFromChat: async () => ({}),
      },
    });
    const turn = fixture.runtime.startTurn("按步骤帮我处理");

    const result = await fixture.runtime.execute(call("computer_work_plan", {
      title: "整理工作现场",
      steps: steps.slice(0, total),
    }, `call-plan-${total}`), turn);

    assert.deepEqual(receivedDrafts, expectedDrafts.slice(0, total));
    assert.equal(turn.computerActionPlanned, true);
    assert.equal(turn.proposals.length, total);
    const planIds = new Set(turn.proposals.map((proposal) => proposal.plan?.id));
    assert.equal(planIds.size, 1);
    assert.match([...planIds][0] ?? "", /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    assert.deepEqual(turn.proposals.map((proposal) => proposal.plan && ({
      title: proposal.plan.title,
      step: proposal.plan.step,
      total: proposal.plan.total,
    })), Array.from({ length: total }, (_, index) => ({
      title: "整理工作现场",
      step: index + 1,
      total,
    })));
    assert.equal(turn.traces.length, 1);
    assert.equal(turn.traces[0]?.name, "computer_work_plan");
    assert.equal(turn.traces[0]?.status, "approval-required");
    assert.match(result.content, /approval_required/);
    for (const proposal of turn.proposals) assert.match(result.content, new RegExp(proposal.id));
  }
});

test("离线复合工作句会自动形成逐步确认的协作计划", async () => {
  const receivedDrafts: unknown[] = [];
  let singleDraftCalls = 0;
  const fixture = runtimeFixture({
    computer: {
      planDraft: async () => {
        singleDraftCalls += 1;
        return {};
      },
      planDrafts: async (drafts) => {
        receivedDrafts.push(...structuredClone(drafts));
        return {
          proposals: drafts.map((draft, index): ComputerActionProposal => ({
            id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
            tool: draft.tool,
            title: `离线步骤 ${index + 1}`,
            description: "参数已固定",
            preview: `离线预览 ${index + 1}`,
            severity: "info",
            requiresApproval: true,
            allowedDecisions: ["allow-once", "deny"],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          })),
        };
      },
      planFromChat: async () => ({}),
    },
  });
  const turn = fixture.runtime.startTurn(
    "打开 https://example.com，然后向下滚动网页，再在当前网页查找：安装",
  );

  await fixture.runtime.ensureDeterministicBehaviors(turn, false);

  assert.equal(singleDraftCalls, 0);
  assert.deepEqual(receivedDrafts, [
    { tool: "open-url", url: "https://example.com/", label: "example.com" },
    { tool: "browser-control", action: "scroll-down", label: "向下滚动当前网页" },
    { tool: "browser-control", action: "find-text", text: "安装", label: "查找“安装”" },
  ]);
  assert.equal(turn.proposals.length, 3);
  assert.deepEqual(turn.proposals.map((proposal) => proposal.plan?.step), [1, 2, 3]);
  assert.equal(new Set(turn.proposals.map((proposal) => proposal.plan?.id)).size, 1);
  assert.equal(turn.traces[0]?.name, "computer_work_plan");
  assert.equal(turn.traces[0]?.status, "approval-required");
});

test("Agent 工具循环回传 assistant tool_calls 与 tool 结果后再生成最终回复", async () => {
  const fixture = runtimeFixture();
  const turn = fixture.runtime.startTurn("你还记得我喜欢什么茶吗？");
  const requests: ProviderMessage[][] = [];
  let round = 0;
  const provider = {
    completeWithTools: async (messages: ProviderMessage[]) => {
      requests.push(structuredClone(messages));
      round += 1;
      return round === 1
        ? { toolCalls: [call("memory_search", { query: "喜欢的茶", limit: 3 }, "call-memory")], content: undefined }
        : { toolCalls: [], content: "我记得，你现在喜欢红茶。" };
    },
    complete: async () => "我记得，你现在喜欢红茶。",
  };

  const text = await runAgentToolLoop(
    provider,
    [{ role: "user", content: "你还记得我喜欢什么茶吗？" }],
    fixture.runtime,
    turn,
  );

  assert.equal(text, "我记得，你现在喜欢红茶。");
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call-memory"), true);
  assert.equal(requests[1]?.some((message) => message.role === "tool" && message.tool_call_id === "call-memory"), true);
  assert.deepEqual([...turn.memoryRefs], [fixture.memoryResult.id]);
});
