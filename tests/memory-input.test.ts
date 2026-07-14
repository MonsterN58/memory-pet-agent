import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sanitizeMemoryTarget, sanitizeMemoryUpdate } from "../src/main/memory/memory-input";

test("记忆修改只接受有效的 L2/L3 请求", () => {
  const id = randomUUID();
  assert.deepEqual(
    sanitizeMemoryUpdate({
      id,
      tier: "L2",
      content: "  修正内容  ",
      kind: "fact",
      importance: 0.8,
    }),
    {
      id,
      tier: "L2",
      content: "修正内容",
      kind: "fact",
      importance: 0.8,
    },
  );

  const invalidValues: unknown[] = [
    { id, tier: "L1", content: "内容", kind: "fact", importance: 0.8 },
    { id: "not-a-uuid", tier: "L2", content: "内容", kind: "fact", importance: 0.8 },
    { id, tier: "L2", content: " ", kind: "fact", importance: 0.8 },
    { id, tier: "L2", content: "x".repeat(2001), kind: "fact", importance: 0.8 },
    { id, tier: "L2", content: "内容", kind: "dialogue", importance: 0.8 },
    { id, tier: "L2", content: "内容", kind: "fact", importance: Number.NaN },
    { id, tier: "L2", content: "内容", kind: "fact", importance: -0.01 },
    { id, tier: "L2", content: "内容", kind: "fact", importance: 1.01 },
  ];
  for (const value of invalidValues) {
    assert.throws(() => sanitizeMemoryUpdate(value));
  }
});

test("删除目标只接受 UUID 和持久记忆层级", () => {
  const id = randomUUID();
  assert.deepEqual(sanitizeMemoryTarget({ id, tier: "L3" }), { id, tier: "L3" });
  assert.throws(() => sanitizeMemoryTarget({ id, tier: "L1" }), /层级/);
  assert.throws(() => sanitizeMemoryTarget({ id: "memory-1", tier: "L2" }), /ID/);
  assert.throws(() => sanitizeMemoryTarget(null), /格式/);
});
