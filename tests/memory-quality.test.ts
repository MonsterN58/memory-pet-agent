import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { MemoryRecord } from "../src/common/types";
import { MemoryRepository } from "../src/main/memory/memory-repository";
import {
  crossDayFollowUpCases,
  factConflictCases,
  preferenceUpdateCases,
  promptInjectionCases,
  userCorrectionCases,
  type MemoryFixture,
} from "./fixtures/memory-quality-cases";

const DAY_MS = 86_400_000;

function memoryRecord(fixture: MemoryFixture, index: number, now: number): MemoryRecord {
  const timestamp = new Date(now - fixture.ageDays * DAY_MS).toISOString();
  return {
    id: randomUUID(),
    tier: "L3",
    kind: fixture.kind,
    content: fixture.content,
    summary: fixture.content,
    importance: fixture.importance ?? 0.8,
    tags: fixture.tags ?? [],
    createdAt: timestamp,
    updatedAt: timestamp,
    accessedAt: timestamp,
    accessCount: 0,
    sourceIds: [`memory-quality-source-${index}`],
  };
}

async function repositoryFor(
  context: TestContext,
  fixtures: MemoryFixture[],
): Promise<MemoryRepository> {
  const directory = await mkdtemp(join(tmpdir(), "memory-quality-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const l3 = fixtures.map((fixture, index) => memoryRecord(fixture, index, now));
  await writeFile(join(directory, "memory-store.json"), JSON.stringify({
    version: 1,
    l2: [],
    l3,
    heartbeatEvents: [],
    meta: {},
  }), "utf8");
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  return repository;
}

test("偏好更新时新值排在旧值前", async (context) => {
  for (const fixtureCase of preferenceUpdateCases) {
    const repository = await repositoryFor(context, fixtureCase.memories);
    const results = await repository.retrieveWithScores(
      fixtureCase.query,
      fixtureCase.expectedContents.length,
    );
    assert.deepEqual(
      results.map(({ memory }) => memory.content),
      fixtureCase.expectedContents,
      fixtureCase.name,
    );
  }
});

test("事实冲突时当前值排在历史值前", async (context) => {
  for (const fixtureCase of factConflictCases) {
    const repository = await repositoryFor(context, fixtureCase.memories);
    const results = await repository.retrieveWithScores(
      fixtureCase.query,
      fixtureCase.expectedContents.length,
    );
    assert.deepEqual(
      results.map(({ memory }) => memory.content),
      fixtureCase.expectedContents,
      fixtureCase.name,
    );
  }
});

test("跨天跟进只召回相关记录", async (context) => {
  for (const fixtureCase of crossDayFollowUpCases) {
    const repository = await repositoryFor(context, fixtureCase.memories);
    const results = await repository.retrieveWithScores(
      fixtureCase.query,
      fixtureCase.memories.length,
    );
    assert.deepEqual(
      results.map(({ memory }) => memory.content),
      fixtureCase.expectedContents,
      fixtureCase.name,
    );
    const accessCounts = new Map(repository.getL3().map((memory) => [memory.content, memory.accessCount]));
    for (const memory of fixtureCase.memories) {
      assert.equal(
        accessCounts.get(memory.content),
        fixtureCase.expectedContents.includes(memory.content) ? 1 : 0,
        fixtureCase.name,
      );
    }
  }
});

test("提示注入内容不进入相关记忆结果", async (context) => {
  for (const fixtureCase of promptInjectionCases) {
    const repository = await repositoryFor(context, fixtureCase.memories);
    const results = await repository.retrieveWithScores(
      fixtureCase.query,
      fixtureCase.memories.length,
    );
    assert.deepEqual(
      results.map(({ memory }) => memory.content),
      fixtureCase.expectedContents,
      fixtureCase.name,
    );
    const accessCounts = new Map(repository.getL3().map((memory) => [memory.content, memory.accessCount]));
    for (const memory of fixtureCase.memories) {
      assert.equal(
        accessCounts.get(memory.content),
        fixtureCase.expectedContents.includes(memory.content) ? 1 : 0,
        fixtureCase.name,
      );
    }
  }
});

test("用户纠错后只召回新值", async (context) => {
  for (const fixtureCase of userCorrectionCases) {
    const repository = await repositoryFor(context, [fixtureCase.original]);
    const original = repository.getL3()[0];
    assert(original, fixtureCase.name);
    await repository.updateMemory({
      id: original.id,
      tier: "L3",
      content: fixtureCase.correctedContent,
      kind: "fact",
      importance: fixtureCase.original.importance ?? 0.8,
    });

    const correctedResults = await repository.retrieveWithScores(fixtureCase.correctedQuery, 1);
    assert.deepEqual(
      correctedResults.map(({ memory }) => memory.content),
      [fixtureCase.correctedContent],
      fixtureCase.name,
    );

    const obsoleteResults = await repository.retrieveWithScores(fixtureCase.obsoleteQuery, 1);
    assert.deepEqual(
      obsoleteResults.map(({ memory }) => memory.content),
      [],
      fixtureCase.name,
    );
  }
});

test("聊天当前视图排除明确历史偏好和事实", async (context) => {
  for (const fixtureCase of [...preferenceUpdateCases, ...factConflictCases]) {
    const repository = await repositoryFor(context, fixtureCase.memories);
    const results = await repository.retrieveForContext(fixtureCase.query, fixtureCase.memories.length);
    assert.deepEqual(results.map((memory) => memory.content), [fixtureCase.expectedContents[0]], fixtureCase.name);
    const accessCounts = new Map(repository.getL3().map((memory) => [memory.content, memory.accessCount]));
    assert.equal(accessCounts.get(fixtureCase.expectedContents[0]!), 1, fixtureCase.name);
    assert.equal(accessCounts.get(fixtureCase.expectedContents[1]!), 0, fixtureCase.name);
  }
});

test("聊天历史视图只返回明确历史证据", async (context) => {
  const fixtureCase = preferenceUpdateCases[0]!;
  const repository = await repositoryFor(context, fixtureCase.memories);
  const results = await repository.retrieveForContext("以前喜欢喝什么", fixtureCase.memories.length);
  assert.deepEqual(results.map((memory) => memory.content), ["以前喜欢喝咖啡"]);
});

test("聊天比较视图同时保留当前和历史证据", async (context) => {
  const fixtureCase = preferenceUpdateCases[0]!;
  const repository = await repositoryFor(context, fixtureCase.memories);
  const results = await repository.retrieveForContext(
    "以前和现在喜欢喝什么，有什么变化",
    fixtureCase.memories.length,
  );
  assert.deepEqual(results.map((memory) => memory.content), fixtureCase.expectedContents);
});
