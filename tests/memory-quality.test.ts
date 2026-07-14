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
type LegacyMemoryRecord = Omit<
  MemoryRecord,
  | "topicKey"
  | "revision"
  | "versionState"
  | "supersedesId"
  | "supersededById"
  | "validFrom"
  | "validTo"
>;

function memoryRecord(fixture: MemoryFixture, index: number, now: number): LegacyMemoryRecord {
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

test("用户纠错后面板保留旧值审计且当前上下文只召回新值", async (context) => {
  for (const fixtureCase of userCorrectionCases) {
    const repository = await repositoryFor(context, [fixtureCase.original]);
    const original = repository.getL3()[0];
    assert(original, fixtureCase.name);
    const corrected = await repository.updateMemory({
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
    assert.deepEqual(correctedResults.map(({ memory }) => memory.id), [corrected.id], fixtureCase.name);

    const obsoleteResults = await repository.retrieveWithScores(fixtureCase.obsoleteQuery, 1);
    assert.deepEqual(
      obsoleteResults.map(({ memory }) => memory.content),
      [fixtureCase.original.content],
      fixtureCase.name,
    );
    assert.deepEqual(obsoleteResults.map(({ memory }) => memory.id), [original.id], fixtureCase.name);
    assert.equal(obsoleteResults[0]?.memory.versionState, "superseded", fixtureCase.name);

    const obsoleteContext = await repository.retrieveForContext(fixtureCase.obsoleteQuery, 1);
    assert.deepEqual(obsoleteContext, [], fixtureCase.name);
  }
});

test("版本状态门控当前、历史和比较检索且 transition 永不计入访问", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-quality-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const firstAt = "2026-01-01T00:00:00.000Z";
  const secondAt = "2026-02-01T00:00:00.000Z";
  const thirdAt = "2026-03-01T00:00:00.000Z";
  const topicKey = "fact:residence";
  const supersededId = randomUUID();
  const currentId = randomUUID();
  const transitionId = randomUUID();
  const missingPredecessorId = randomUUID();
  const superseded: MemoryRecord = {
    id: supersededId,
    tier: "L3",
    kind: "fact",
    content: "用户住在南京",
    summary: "用户住在南京",
    importance: 0.8,
    tags: ["residence"],
    createdAt: firstAt,
    updatedAt: firstAt,
    accessedAt: firstAt,
    accessCount: 0,
    sourceIds: ["residence-source"],
    topicKey,
    revision: 1,
    versionState: "superseded",
    supersededById: currentId,
    validFrom: firstAt,
    validTo: secondAt,
  };
  const current: MemoryRecord = {
    id: currentId,
    tier: "L3",
    kind: "fact",
    content: "用户住在杭州",
    summary: "用户住在杭州",
    importance: 0.8,
    tags: ["residence"],
    createdAt: secondAt,
    updatedAt: secondAt,
    accessedAt: secondAt,
    accessCount: 0,
    sourceIds: ["residence-source"],
    topicKey,
    revision: 2,
    versionState: "current",
    supersedesId: supersededId,
    validFrom: secondAt,
  };
  const transition: MemoryRecord = {
    id: transitionId,
    tier: "L3",
    kind: "fact",
    content: "用户住在苏州",
    summary: "用户住在苏州",
    importance: 0.8,
    tags: ["residence"],
    createdAt: thirdAt,
    updatedAt: thirdAt,
    accessedAt: thirdAt,
    accessCount: 0,
    sourceIds: ["residence-source"],
    topicKey: "fact:pending-residence",
    revision: 2,
    versionState: "transition",
    supersedesId: missingPredecessorId,
    validFrom: thirdAt,
  };
  await writeFile(join(directory, "memory-store.json"), JSON.stringify({
    version: 2,
    l2: [],
    l3: [superseded, current, transition],
    heartbeatEvents: [],
    meta: {},
  }), "utf8");
  const repository = new MemoryRepository(directory);
  await repository.initialize();

  const currentResults = await repository.retrieveForContext("用户住哪里", 3);
  assert.deepEqual(currentResults.map((memory) => memory.id), [currentId]);

  const historicalResults = await repository.retrieveForContext("以前用户住哪里", 3);
  assert.deepEqual(historicalResults.map((memory) => memory.id), [supersededId]);

  const comparisonResults = await repository.retrieveForContext("用户住哪里，前后有什么变化", 3);
  assert.deepEqual(
    comparisonResults.map((memory) => memory.id).sort(),
    [currentId, supersededId].sort(),
  );

  const accessCounts = new Map(repository.getL3().map((memory) => [memory.id, memory.accessCount]));
  assert.equal(accessCounts.get(currentId), 2);
  assert.equal(accessCounts.get(supersededId), 2);
  assert.equal(accessCounts.get(transitionId), 0);
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
