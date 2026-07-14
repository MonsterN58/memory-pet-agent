import assert from "node:assert/strict";
import test from "node:test";
import { clampMotionFrame, normalizeFocus } from "../src/main/pet-motion";

test("全局指针按 640×480 半径渐进映射", () => {
  assert.deepEqual(normalizeFocus({ x: 960, y: 300 }, { x: 320, y: 780 }), { x: 1, y: 1 });
  assert.deepEqual(normalizeFocus({ x: 640, y: 540 }, { x: 320, y: 780 }), { x: 0.5, y: 0.5 });
});

test("连续运动帧始终限制在安全范围", () => {
  assert.deepEqual(clampMotionFrame({
    state: "dragged", velocityX: 4, velocityY: -3, offsetX: 2, offsetY: -2,
  }), { state: "dragged", velocityX: 1, velocityY: -1, offsetX: 1, offsetY: -1 });
});

test("连续运动帧将非有限数值重置为零", () => {
  assert.deepEqual(clampMotionFrame({
    state: "landing", velocityX: Number.NaN, velocityY: Number.POSITIVE_INFINITY,
    offsetX: Number.NEGATIVE_INFINITY, offsetY: 0,
  }), { state: "landing", velocityX: 0, velocityY: 0, offsetX: 0, offsetY: 0 });
});
