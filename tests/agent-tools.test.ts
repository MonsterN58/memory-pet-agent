import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
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
        processScanCompleted: false,
        applications: [],
      }),
    },
    computer: {
      planDraft: async () => ({}),
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

test("desktop_observe 只把短时图片作为消息附件，工具文本不含图片字节和窗口信息", async () => {
  const fixture = runtimeFixture({
    awareness: {
      observe: async () => ({
        capturedAt: new Date().toISOString(),
        screen: { dataUrl: "data:image/jpeg;base64,SCREEN_BYTES", width: 960, height: 540 },
        screenCaptureAttempted: true,
        processScanCompleted: true,
        applications: [{ kind: "coding", label: "编写或阅读代码", processes: ["code.exe"], newlyStarted: true }],
      }),
    },
  });
  fixture.settings.awareness.screenCaptureEnabled = true;
  fixture.settings.awareness.processDetectionEnabled = true;
  const turn = fixture.runtime.startTurn("看看我现在在做什么");

  const result = await fixture.runtime.execute(call("desktop_observe", { reason: "用户明确询问" }), turn);

  assert.equal(result.image?.image_url.url, "data:image/jpeg;base64,SCREEN_BYTES");
  assert.doesNotMatch(result.content, /SCREEN_BYTES|code\.exe|Secret customer title/);
  assert.deepEqual(fixture.observedActivities, [{ kind: "coding", label: "编写或阅读代码" }]);
  assert.equal(turn.traces[0]?.status, "completed");
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
