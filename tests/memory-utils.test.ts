import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryRecord } from "../src/common/types";
import { jaccard, scoreMemory, scoreMemoryBreakdown, tokenize } from "../src/main/memory/memory-utils";

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
