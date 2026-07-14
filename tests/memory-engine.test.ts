import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { MemoryRecord, PersistentMemoryTier } from "../src/common/types";
import { MemoryEngine } from "../src/main/memory/memory-engine";
import { MemoryRepository } from "../src/main/memory/memory-repository";

function persistentRecord(tier: PersistentMemoryTier, content: string): MemoryRecord {
  const timestamp = "2026-01-02T03:04:05.000Z";
  return {
    id: randomUUID(),
    tier,
    kind: "fact",
    content,
    summary: content,
    importance: 0.7,
    tags: ["test", "system-tag"],
    createdAt: timestamp,
    updatedAt: timestamp,
    accessedAt: timestamp,
    accessCount: 3,
    sourceIds: [randomUUID()],
  };
}

test("心跳把 L1 对话迁移到 L2 并整理为 L3", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const engine = new MemoryEngine(repository, () => settings);

  engine.recordTurn("user", "我喜欢茉莉花茶，请记住");
  engine.recordTurn("assistant", "好的，我会记住。");
  assert.equal(engine.snapshot().l1.length, 2);

  const moved = await engine.flushL1(true);
  assert.equal(moved, 1);
  assert.equal(engine.snapshot().l1.length, 0);
  assert.equal(engine.snapshot().l2.length, 1);

  const consolidated = await engine.consolidate();
  assert(consolidated >= 2);
  assert.equal(engine.snapshot().l2.length, 0);
  assert(engine.snapshot().l3.some((item) => item.kind === "preference" && item.content.includes("茉莉花茶")));

  const reloaded = new MemoryRepository(directory);
  await reloaded.initialize();
  assert(reloaded.getL3().some((item) => item.content.includes("茉莉花茶")));
});

test("用户明确保存的内容先进入 L2", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const engine = new MemoryEngine(repository, () => structuredClone(DEFAULT_SETTINGS));
  await engine.rememberExplicit("我的生日是十月三日");
  const [saved] = engine.snapshot().l2;
  assert.equal(saved?.tier, "L2");
  assert.equal(saved?.importance, 0.95);
});

test("记忆搜索返回排序记录和可解释评分", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const engine = new MemoryEngine(repository, () => structuredClone(DEFAULT_SETTINGS));
  await engine.rememberExplicit("用户喜欢茉莉花茶");
  await engine.rememberExplicit("用户明天需要整理书桌");

  const results = await engine.search("喜欢什么茶");

  assert.equal(results.length, 2);
  assert(results[0]?.memory.content.includes("茉莉花茶"));
  assert((results[0]?.score.textRelevance ?? 0) > 0);
  assert((results[0]?.score.total ?? 0) > (results[1]?.score.total ?? 0));
});

test("L2 修正保留来源和不可变字段并持久化", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const original = persistentRecord("L2", "我的生日是十月三日");
  await repository.enqueueL2([original]);
  const engine = new MemoryEngine(repository, () => structuredClone(DEFAULT_SETTINGS));

  const snapshot = await engine.updateMemory({
    id: original.id,
    tier: "L2",
    content: "我的生日是十月四日",
    kind: "fact",
    importance: 0.99,
  });

  const updated = snapshot.l2[0]!;
  assert.equal(updated.id, original.id);
  assert.equal(updated.tier, original.tier);
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.accessedAt, original.accessedAt);
  assert.equal(updated.accessCount, original.accessCount);
  assert.deepEqual(updated.sourceIds, original.sourceIds);
  assert.deepEqual(updated.tags, original.tags);
  assert.equal(updated.content, "我的生日是十月四日");
  assert.equal(updated.summary, "我的生日是十月四日");
  assert.equal(updated.importance, 0.99);
  assert.notEqual(updated.updatedAt, original.updatedAt);

  const reloaded = new MemoryRepository(directory);
  await reloaded.initialize();
  assert.deepEqual(reloaded.getL2()[0], updated);
});

test("L3 修正持久化且不存在的记忆返回明确错误", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const sourceId = randomUUID();
  await repository.consumeL2([], [{
    kind: "preference",
    content: "用户喜欢红茶",
    summary: "用户喜欢红茶",
    importance: 0.8,
    tags: ["preference"],
    sourceIds: [sourceId],
  }]);
  const original = repository.getL3()[0]!;

  const updated = await repository.updateMemory({
    id: original.id,
    tier: "L3",
    content: "用户喜欢茉莉花茶",
    kind: "preference",
    importance: 0.92,
  });

  assert.equal(updated.content, "用户喜欢茉莉花茶");
  assert.deepEqual(updated.sourceIds, [sourceId]);
  const reloaded = new MemoryRepository(directory);
  await reloaded.initialize();
  assert.equal(reloaded.getL3()[0]?.content, "用户喜欢茉莉花茶");
  await assert.rejects(
    repository.updateMemory({
      id: randomUUID(), tier: "L3", content: "不存在", kind: "fact", importance: 0.5,
    }),
    /没有找到要修改的记忆/,
  );
});

test("L2 和 L3 删除后重载仍不存在", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const l2 = persistentRecord("L2", "待删除的 L2");
  await repository.enqueueL2([l2]);
  await repository.consumeL2([], [{
    kind: "fact", content: "待删除的 L3", summary: "待删除的 L3", importance: 0.5,
    tags: ["test"], sourceIds: [l2.id],
  }]);
  const l3 = repository.getL3()[0]!;
  const engine = new MemoryEngine(repository, () => structuredClone(DEFAULT_SETTINGS));

  await engine.deleteMemory({ id: l2.id, tier: "L2" });
  const snapshot = await engine.deleteMemory({ id: l3.id, tier: "L3" });
  assert.equal(snapshot.l2.length, 0);
  assert.equal(snapshot.l3.length, 0);

  const reloaded = new MemoryRepository(directory);
  await reloaded.initialize();
  assert.equal(reloaded.getL2().length, 0);
  assert.equal(reloaded.getL3().length, 0);
  await assert.rejects(
    repository.deleteMemory({ id: randomUUID(), tier: "L2" }),
    /没有找到要删除的记忆/,
  );
});

test("并发修正和删除经过写队列后保持最终状态", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const first = persistentRecord("L2", "需要修正");
  const second = persistentRecord("L2", "需要删除");
  await repository.enqueueL2([first, second]);

  await Promise.all([
    repository.updateMemory({
      id: first.id, tier: "L2", content: "已经修正", kind: "reflection", importance: 0.6,
    }),
    repository.deleteMemory({ id: second.id, tier: "L2" }),
  ]);
  await repository.flush();

  const reloaded = new MemoryRepository(directory);
  await reloaded.initialize();
  assert.equal(reloaded.getL2().length, 1);
  assert.equal(reloaded.getL2()[0]?.id, first.id);
  assert.equal(reloaded.getL2()[0]?.content, "已经修正");
  assert.equal(reloaded.getL2()[0]?.kind, "reflection");
});

test("整理等待期间删除 L2 不会把过期内容写回 L3", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const engine = new MemoryEngine(repository, () => structuredClone(DEFAULT_SETTINGS));
  await engine.rememberExplicit("这条内容将在整理期间删除");
  const pending = engine.snapshot().l2[0]!;
  let releaseReflector!: () => void;
  let markStarted!: () => void;
  const reflectorStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const reflectorGate = new Promise<void>((resolve) => { releaseReflector = resolve; });

  const consolidating = engine.consolidate(async () => {
    markStarted();
    await reflectorGate;
    return [{
      kind: "fact",
      content: pending.content,
      summary: pending.summary,
      importance: pending.importance,
      tags: ["stale"],
      sourceIds: [pending.id],
    }];
  });
  await reflectorStarted;
  await engine.deleteMemory({ id: pending.id, tier: "L2" });
  releaseReflector();

  assert.equal(await consolidating, 0);
  assert.equal(engine.snapshot().l3.length, 0);
});

test("整理等待期间修正 L2 会丢弃旧版本提炼结果", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  const engine = new MemoryEngine(repository, () => structuredClone(DEFAULT_SETTINGS));
  await engine.rememberExplicit("旧的偏好内容");
  const pending = engine.snapshot().l2[0]!;
  let releaseReflector!: () => void;
  let markStarted!: () => void;
  const reflectorStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const reflectorGate = new Promise<void>((resolve) => { releaseReflector = resolve; });

  const consolidating = engine.consolidate(async () => {
    markStarted();
    await reflectorGate;
    return [{
      kind: "preference",
      content: pending.content,
      summary: pending.summary,
      importance: pending.importance,
      tags: ["stale"],
      sourceIds: [pending.id],
    }];
  });
  await reflectorStarted;
  await engine.updateMemory({
    id: pending.id,
    tier: "L2",
    content: "修正后的偏好内容",
    kind: "preference",
    importance: 0.9,
  });
  releaseReflector();

  assert.equal(await consolidating, 0);
  assert.equal(engine.snapshot().l2[0]?.content, "修正后的偏好内容");
  assert.equal(engine.snapshot().l3.length, 0);
});
