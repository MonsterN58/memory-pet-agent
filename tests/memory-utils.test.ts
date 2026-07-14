import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryRecord } from "../src/common/types";
import {
  jaccard,
  memoryMatchesTemporalView,
  scoreMemory,
  scoreMemoryBreakdown,
  temporalViewForQuery,
  tokenize,
} from "../src/main/memory/memory-utils";

function memory(content: string, importance: number, updatedAt = new Date().toISOString()): MemoryRecord {
  return {
    id: content,
    tier: "L3",
    kind: "fact",
    content,
    summary: content,
    importance,
    tags: [],
    createdAt: updatedAt,
    updatedAt,
    accessedAt: updatedAt,
    accessCount: 0,
    sourceIds: [],
    topicKey: `test:${content}`,
    revision: 1,
    versionState: "current",
    validFrom: updatedAt,
  };
}

test("中文分词同时包含单字和相邻双字", () => {
  const tokens = tokenize("我喜欢茉莉花茶");
  assert(tokens.has("喜"));
  assert(tokens.has("喜欢"));
  assert(tokens.has("花茶"));
});

test("相似文本的 Jaccard 分数高于无关文本", () => {
  assert(jaccard("用户喜欢茉莉花茶", "我很喜欢茉莉花茶") > jaccard("用户喜欢茉莉花茶", "明天下午下雨"));
});

test("检索优先考虑相关性，同时纳入重要度", () => {
  const relevant = scoreMemory(memory("用户喜欢茉莉花茶", 0.6), "喜欢什么茶");
  const unrelated = scoreMemory(memory("用户明天需要整理书桌", 1), "喜欢什么茶");
  assert(relevant > unrelated);
});

test("检索评分公开每个加权组成项", () => {
  const now = Date.parse("2026-07-14T08:00:00.000Z");
  const score = scoreMemoryBreakdown(
    memory("用户喜欢茉莉花茶", 0.8, new Date(now).toISOString()),
    "喜欢什么茶",
    now,
  );
  assert(score.textRelevance > 0);
  assert.equal(score.importance, 0.8 * 1.7);
  assert.equal(score.recency, 0.8);
  assert.equal(score.frequency, 0);
  assert.equal(score.total, score.textRelevance + score.importance + score.recency + score.frequency);
});

test("检索评分忽略高频虚词但保留具体单字主题", () => {
  const stopwordOnly = scoreMemoryBreakdown(memory("我今天整理了书桌", 0.8), "我想问绿萝");
  const singleCharacterTopic = scoreMemoryBreakdown(memory("用户喜欢猫", 0.8), "聊猫");

  assert.equal(stopwordOnly.textRelevance, 0);
  assert(singleCharacterTopic.textRelevance > 0);
});

test("通用主动话题查询可以通过记忆类型召回候选", () => {
  const preference = {
    ...memory("用户喜欢茉莉花茶", 0.8),
    kind: "preference" as const,
  };
  const fact = {
    ...memory("用户住在杭州", 0.8),
    kind: "fact" as const,
  };
  const query = "近期重要的事、计划、偏好和待跟进话题";

  assert(scoreMemoryBreakdown(preference, query).textRelevance >= 0.75);
  assert(scoreMemoryBreakdown(fact, query).textRelevance >= 0.75);
});

test("普通起止路线不会被误判为记忆变化比较", () => {
  assert.equal(temporalViewForQuery("从南京到杭州怎么坐车"), "current");
  assert.equal(temporalViewForQuery("偏好从咖啡改到花茶"), "comparison");
});

test("历史词只有位于事实或偏好陈述开头时才表示过期", () => {
  const currentPreference = {
    ...memory("我喜欢研究过去时", 0.8),
    kind: "preference" as const,
  };
  const historicalPreference = {
    ...memory("我以前喜欢喝咖啡", 0.8),
    kind: "preference" as const,
  };
  const historicalEpisode = {
    ...memory("以前计划周末露营", 0.8),
    kind: "episode" as const,
  };

  assert.equal(memoryMatchesTemporalView(currentPreference, "current"), true);
  assert.equal(memoryMatchesTemporalView(historicalPreference, "current"), false);
  assert.equal(memoryMatchesTemporalView(historicalEpisode, "current"), true);
});

test("版本状态在没有时间措辞时决定时态视图并排除过渡记录", () => {
  const firstValidFrom = "2026-01-01T00:00:00.000Z";
  const secondValidFrom = "2026-02-01T00:00:00.000Z";
  const thirdValidFrom = "2026-03-01T00:00:00.000Z";
  const superseded = {
    ...memory("用户住在南京", 0.8, firstValidFrom),
    id: "residence-revision-1",
    topicKey: "fact:residence",
    revision: 1,
    versionState: "superseded" as const,
    supersededById: "residence-revision-2",
    validFrom: firstValidFrom,
    validTo: secondValidFrom,
  };
  const current = {
    ...memory("用户住在杭州", 0.8, secondValidFrom),
    id: "residence-revision-2",
    topicKey: "fact:residence",
    revision: 2,
    versionState: "current" as const,
    supersedesId: superseded.id,
    validFrom: secondValidFrom,
  };
  const transition = {
    ...memory("用户住在苏州", 0.8, thirdValidFrom),
    id: "residence-revision-3",
    topicKey: "fact:residence",
    revision: 3,
    versionState: "transition" as const,
    supersedesId: current.id,
    validFrom: thirdValidFrom,
  };

  assert.equal(memoryMatchesTemporalView(current, "current"), true);
  assert.equal(memoryMatchesTemporalView(current, "historical"), false);
  assert.equal(memoryMatchesTemporalView(current, "comparison"), true);
  assert.equal(memoryMatchesTemporalView(superseded, "current"), false);
  assert.equal(memoryMatchesTemporalView(superseded, "historical"), true);
  assert.equal(memoryMatchesTemporalView(superseded, "comparison"), true);
  assert.equal(memoryMatchesTemporalView(transition, "current"), false);
  assert.equal(memoryMatchesTemporalView(transition, "historical"), false);
  assert.equal(memoryMatchesTemporalView(transition, "comparison"), false);
});
