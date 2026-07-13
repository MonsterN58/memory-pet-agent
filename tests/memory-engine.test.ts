import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import { MemoryEngine } from "../src/main/memory/memory-engine";
import { MemoryRepository } from "../src/main/memory/memory-repository";

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
