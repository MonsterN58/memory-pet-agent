import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { MemoryRecord, ModelTemperamentSeed, PersonalityProfile } from "../src/common/types";
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

test("空白人格使用模型低置信气质，但不把种子写入人格档案", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-personality-seed-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PersonalityStore(directory);
  const engine = new PersonalityEngine(store, () => structuredClone(DEFAULT_SETTINGS));
  await engine.initialize();

  const before = engine.getProfile();
  const contextText = engine.behaviorContext(PLAYFUL_SEED);
  const after = engine.getProfile();

  assert.match(contextText, /当前模型的初始身体气质：轻快探索者/);
  assert.match(contextText, /source=model-temperament/);
  assert.match(contextText, /不是用户事实，也不会写入人格档案/);
  assert.match(contextText, /playfulness: 认真严肃 ← 0\.86 → 轻松俏皮/);
  assert.deepEqual(after, before);
  assert.equal(after.stage, "blank");
  assert.deepEqual(after.traits, []);
});

test("真实人格证据逐维覆盖模型气质，未成熟维度继续使用种子", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-personality-seed-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PersonalityStore(directory);
  const engine = new PersonalityEngine(store, () => structuredClone(DEFAULT_SETTINGS));
  await engine.initialize();

  await store.save(profileWithTraits([
    trait("directness", 0.91, 0.58, 3),
    trait("warmth", 0.88, 0.08, 4),
  ]), []);

  const contextText = engine.behaviorContext(PLAYFUL_SEED);
  assert.match(contextText, /已有 1\/6 个维度由真实互动证据决定/);
  assert.match(contextText, /directness: 委婉舒缓 ← 0\.91 → 直接明确; confidence=0\.58; evidence=3; source=learned/);
  assert.match(contextText, /warmth: 冷静克制 ← 0\.72 → 温暖亲近; confidence=low; evidence=0; source=model-temperament/);
});

test("成熟人格六个维度全部覆盖模型种子，切换种子不改变档案", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-personality-seed-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PersonalityStore(directory);
  const engine = new PersonalityEngine(store, () => structuredClone(DEFAULT_SETTINGS));
  await engine.initialize();
  const traits = [
    trait("warmth", 0.22, 0.74, 8),
    trait("curiosity", 0.31, 0.68, 7),
    trait("playfulness", 0.27, 0.71, 9),
    trait("directness", 0.79, 0.66, 6),
    trait("initiative", 0.76, 0.63, 6),
    trait("expressiveness", 0.35, 0.69, 8),
  ];
  await store.save(profileWithTraits(traits, "established", 42), []);
  const before = engine.getProfile();

  const first = engine.behaviorContext(PLAYFUL_SEED);
  const second = engine.behaviorContext({
    ...PLAYFUL_SEED,
    label: "安静观察者",
    warmth: 0.95,
    directness: 0.08,
  });

  assert.match(first, /人格成长阶段：established/);
  assert.doesNotMatch(first, /当前模型的初始身体气质/);
  assert.doesNotMatch(first, /source=model-temperament/);
  assert.match(first, /warmth: 冷静克制 ← 0\.22 → 温暖亲近; confidence=0\.74; evidence=8/);
  assert.equal(second, first);
  assert.deepEqual(engine.getProfile(), before);
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

const PLAYFUL_SEED: ModelTemperamentSeed = {
  label: "轻快探索者",
  summary: "身体动作轻盈，面对新鲜事物时更愿意先靠近看看。",
  warmth: 0.72,
  curiosity: 0.9,
  playfulness: 0.86,
  directness: 0.44,
  initiative: 0.68,
  expressiveness: 0.8,
};

function trait(
  dimension: PersonalityProfile["traits"][number]["dimension"],
  score: number,
  confidence: number,
  evidenceCount: number,
): PersonalityProfile["traits"][number] {
  return {
    dimension,
    score,
    confidence,
    evidenceCount,
    lastEvidence: "test evidence",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function profileWithTraits(
  traits: PersonalityProfile["traits"],
  stage: PersonalityProfile["stage"] = "forming",
  interactionCount = 4,
): PersonalityProfile {
  return {
    version: 1,
    stage,
    interactionCount,
    traits,
    summary: "test profile",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
