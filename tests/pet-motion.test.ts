import assert from "node:assert/strict";
import test from "node:test";
import {
  clampMotionFrame,
  deriveMotionFrame,
  normalizeFocus,
  reduceLanding,
} from "../src/main/pet-motion";

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

test("拖拽方向和窗口位移会形成有方向的连续运动帧", () => {
  const previous = { x: 100, y: 200, width: 200, height: 400 };
  const right = deriveMotionFrame(previous, { ...previous, x: 120, y: 180 }, 100, "dragged");
  const left = deriveMotionFrame(previous, { ...previous, x: 80, y: 220 }, 100, "dragged");

  assert.ok(right.velocityX > 0);
  assert.ok(left.velocityX < 0);
  assert.ok(right.velocityY < 0);
  assert.ok(left.velocityY > 0);
  assert.equal(right.offsetX, 0.1);
  assert.equal(right.offsetY, -0.05);
  for (const frame of [right, left]) {
    for (const value of [frame.velocityX, frame.velocityY, frame.offsetX, frame.offsetY]) {
      assert.ok(value >= -1 && value <= 1);
    }
  }
});

test("触地后保持 320ms landing 再回到 idle", () => {
  const contact = reduceLanding(undefined, 1_000, true);
  assert.deepEqual(contact, { state: "landing", landingUntil: 1_320 });
  assert.deepEqual(reduceLanding(contact.landingUntil, 1_160), contact);
  assert.deepEqual(reduceLanding(contact.landingUntil, 1_320), { state: "idle" });
});
