import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { MemoryRecord } from "../src/common/types";
import { PersonalityEngine } from "../src/main/personality/personality-engine";
import { PersonalityStore } from "../src/main/personality/personality-store";

test("人格初始为空，并在重复对话证据后逐渐形成", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-personality-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings = structuredClone(DEFAULT_SETTINGS);
  const engine = new PersonalityEngine(new PersonalityStore(directory), () => settings);
  await engine.initialize();

  const initial = engine.getProfile();
  assert.equal(initial.stage, "blank");
  assert.equal(initial.interactionCount, 0);
  assert.deepEqual(initial.traits, []);

  await engine.observeDialogue("请直接给结论，别废话");
  await engine.observeDialogue("继续保持直接、简明的表达");
  const formed = engine.getProfile();
  const directness = formed.traits.find((trait) => trait.dimension === "directness");
  assert.equal(formed.stage, "forming");
  assert.equal(formed.interactionCount, 2);
  assert((directness?.score ?? 0) > 0.7);
  assert.equal(directness?.evidenceCount, 2);
  assert.match(formed.summary, /直接明确/);

  const reloaded = new PersonalityEngine(new PersonalityStore(directory), () => settings);
  await reloaded.initialize();
  assert.equal(reloaded.getProfile().traits.find((trait) => trait.dimension === "directness")?.evidenceCount, 2);
});

test("相反反馈会修正人格，而不是永久锁定第一次标签", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-personality-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new PersonalityEngine(new PersonalityStore(directory), () => structuredClone(DEFAULT_SETTINGS));
  await engine.initialize();
  await engine.observeDialogue("直接说结论，别废话");
  await engine.observeDialogue("请继续直接一点");
  const before = engine.getProfile().traits.find((trait) => trait.dimension === "directness")!;

  await engine.observeDialogue("这次请委婉一些，别太直接");
  await engine.observeDialogue("语气柔和一点，慢慢说");
  const after = engine.getProfile().traits.find((trait) => trait.dimension === "directness")!;
  assert(after.score < before.score);
  assert(after.confidence < before.confidence);

  const reset = await engine.reset();
  assert.equal(reset.stage, "blank");
  assert.equal(reset.interactionCount, 0);
  assert.deepEqual(reset.traits, []);
});

test("心跳人格复盘只处理一次同一条 L2 记忆", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-personality-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new PersonalityEngine(new PersonalityStore(directory), () => structuredClone(DEFAULT_SETTINGS));
  await engine.initialize();
  const record = sampleMemory("l2-1", "用户：希望你以后主动提醒我\n桌宠：好的。 ");
  let analyzerCalls = 0;
  const analyzer = async () => {
    analyzerCalls += 1;
    return [{ dimension: "initiative" as const, direction: 1 as const, weight: 0.9, evidence: "用户反复希望主动跟进" }];
  };

  assert.equal(await engine.reviewMemories([record], analyzer), 1);
  assert.equal(await engine.reviewMemories([record], analyzer), 0);
  assert.equal(analyzerCalls, 1);
  assert.equal(engine.getProfile().traits.find((trait) => trait.dimension === "initiative")?.evidenceCount, 1);
});

function sampleMemory(id: string, content: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    tier: "L2",
    kind: "episode",
    content,
    summary: content,
    importance: 0.8,
    tags: ["chat"],
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    accessCount: 0,
    sourceIds: [],
  };
}
