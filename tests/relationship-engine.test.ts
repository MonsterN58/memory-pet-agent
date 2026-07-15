import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { MemoryRecord } from "../src/common/types";
import { RelationshipEngine } from "../src/main/relationship/relationship-engine";
import { RelationshipStore } from "../src/main/relationship/relationship-store";

async function createEngine(context: TestContext): Promise<RelationshipEngine> {
  const directory = await mkdtemp(join(tmpdir(), "relationship-engine-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new RelationshipEngine(new RelationshipStore(directory));
  await engine.initialize();
  return engine;
}

test("关系档案从用户证据形成理解，并保留来源而不改写桌宠人格", async (context) => {
  const engine = await createEngine(context);
  const record = memory("m1", "用户：我最近计划做一个有长期记忆的桌宠\n桌宠：我会陪你慢慢完善它", 0.86);
  const updates = await engine.reviewMemories([record], async () => [{
    kind: "goal",
    topic: "长期记忆桌宠",
    summary: "用户正在推进一个拥有长期记忆的桌宠项目",
    confidence: 0.9,
    sourceIds: [record.id],
  }]);

  const profile = engine.getProfile();
  assert(updates >= 1);
  assert.equal(profile.stage, "acquainted");
  assert.equal(profile.insights[0]?.kind, "goal");
  assert.deepEqual(profile.insights[0]?.sourceIds, [record.id]);
  assert.match(engine.contextForPrompt(), /长期记忆的桌宠项目/);
  assert.doesNotMatch(engine.contextForPrompt(), /warmth|playfulness/);
});

test("关系理解遇到相反反馈时采用最新说法并降低确定性", async (context) => {
  const engine = await createEngine(context);
  const first = memory("m1", "用户：我喜欢咖啡\n桌宠：记住啦");
  const second = memory("m2", "用户：我现在不喜欢咖啡了\n桌宠：那我以后不再默认它");
  await engine.reviewMemories([first], async () => [{
    kind: "preference", topic: "咖啡", summary: "用户喜欢咖啡", confidence: 0.9, sourceIds: [first.id],
  }]);
  const before = engine.getProfile().insights[0]?.confidence ?? 0;
  await engine.reviewMemories([second], async () => [{
    kind: "preference", topic: "咖啡", summary: "用户现在不喜欢咖啡", confidence: 0.84, sourceIds: [second.id],
  }]);
  const insight = engine.getProfile().insights[0]!;
  assert.equal(insight.summary, "用户现在不喜欢咖啡");
  assert.equal(insight.evidenceCount, 2);
  assert(insight.confidence < before);
  assert.deepEqual(insight.sourceIds, [first.id, second.id]);
});

test("粗粒度桌面活动重复出现后才进入关系上下文", async (context) => {
  const engine = await createEngine(context);
  await engine.observeDesktopActivities([{ kind: "coding", label: "编写或阅读代码" }]);
  assert.doesNotMatch(engine.contextForPrompt(), /粗粒度活动习惯/);
  await engine.observeDesktopActivities([{ kind: "coding", label: "编写或阅读代码", newlyStarted: false }]);
  assert.equal(engine.getProfile().activityPatterns[0]?.observations, 1);
  await engine.observeDesktopActivities([{ kind: "coding", label: "编写或阅读代码", newlyStarted: true }]);
  await engine.observeDesktopActivities([{ kind: "coding", label: "编写或阅读代码", newlyStarted: true }]);
  const profile = engine.getProfile();
  assert.equal(profile.activityPatterns[0]?.observations, 3);
  assert.match(engine.contextForPrompt(), /粗粒度活动习惯/);
  assert.match(profile.summary, /编写或阅读代码/);
});

test("下一轮用户反馈会调整主动关心节奏", async (context) => {
  const engine = await createEngine(context);
  await engine.recordProactiveTopic("问问项目是否需要一起梳理");
  const before = engine.getProfile().careStyle.initiativeAffinity;
  await engine.observeUserTurn("正好，帮我一起看看吧，谢谢你还记得");
  const welcomed = engine.getProfile();
  assert.equal(welcomed.recentProactiveTopics.at(-1)?.feedback, "welcomed");
  assert(welcomed.careStyle.initiativeAffinity > before);

  await engine.recordProactiveTopic("再次主动询问");
  await engine.observeUserTurn("先不聊，别打扰我");
  const dismissed = engine.getProfile();
  assert.equal(dismissed.recentProactiveTopics.at(-1)?.feedback, "dismissed");
  assert(dismissed.careStyle.initiativeAffinity < welcomed.careStyle.initiativeAffinity);
});

function memory(id: string, content: string, importance = 0.7): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    tier: "L2",
    kind: "episode",
    content,
    summary: content,
    importance,
    tags: ["chat"],
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    accessCount: 0,
    sourceIds: [],
  };
}
