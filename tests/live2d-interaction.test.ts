import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { PetAction, PetMotionFrame } from "../src/common/types";
import {
  advanceFocus,
  computePetTransform,
  motionDurationMs,
  proceduralActionDurationMs,
  resolveFocusBindings,
  resolveActionMotion,
} from "../src/renderer/live2d-interaction";

const ACTIONS: PetAction[] = [
  "wave", "nod", "shake-head", "head-tilt", "jump", "cheer", "dance",
  "sit", "stretch", "shy", "comfort", "sleep", "surprised",
];

test("标准 Cubism 参数会解析为真实索引", () => {
  const bindings = resolveFocusBindings([
    "ParamMouthOpenY",
    "ParamEyeBallX",
    "ParamEyeBallY",
    "ParamAngleX",
    "ParamAngleY",
    "ParamAngleZ",
    "ParamBodyAngleX",
  ]);

  assert.deepEqual(bindings, {
    eyeX: 1,
    eyeY: 2,
    angleX: 3,
    angleY: 4,
    angleZ: 5,
    bodyX: 6,
  });
});

test("Wanko 旧式参数回退到头身与双耳且不虚构眼球绑定", () => {
  const bindings = resolveFocusBindings([
    "PARAM_ANGLE_X",
    "PARAM_ANGLE_Y",
    "PARAM_ANGLE_Z",
    "PARAM_BODY_ANGLE_X",
    "PARAM_BODY_ANGLE_Y",
    "PARAM_BODY_ANGLE_Z",
    "PARAM_EAR_L",
    "PARAM_EAR_R",
  ]);

  assert.deepEqual(bindings, {
    angleX: 0,
    angleY: 1,
    angleZ: 2,
    bodyX: 3,
    bodyY: 4,
    bodyZ: 5,
    earLeft: 6,
    earRight: 7,
  });
  assert.equal(bindings.eyeX, undefined);
  assert.equal(bindings.eyeY, undefined);
});

test("参数能力不完整时只返回真实存在的索引", () => {
  assert.deepEqual(resolveFocusBindings(["ParamEyeBallX", "ParamAngleY"]), {
    eyeX: 0,
    angleY: 1,
  });
  assert.deepEqual(resolveFocusBindings([]), {});
});

test("焦点阻尼朝目标渐进且不会越过目标", () => {
  assert.deepEqual(
    advanceFocus({ x: 0, y: 0 }, { x: 1, y: -1 }, 0.25),
    { x: 0.25, y: -0.25 },
  );
  assert.deepEqual(
    advanceFocus({ x: 0.9, y: -0.9 }, { x: 1, y: -1 }, 4),
    { x: 1, y: -1 },
  );
});

test("连续拖拽、下落和 320ms 落地曲线产生自然变形", () => {
  const right = computePetTransform(motion("dragged", 0.8, -0.4));
  const left = computePetTransform(motion("dragged", -0.8, -0.4));
  assert.ok(right.rotation > 0);
  assert.ok(left.rotation < 0);

  const falling = computePetTransform(motion("falling", 0.4, 0.9));
  assert.ok(falling.scaleY > 1);

  const compressed = computePetTransform(motion("landing", 0, 1), undefined, 0, 0);
  const rebound = computePetTransform(motion("landing", 0, 0), undefined, 0, 160);
  const neutral = computePetTransform(motion("landing", 0, 0), undefined, 0, 320);
  assert.ok(compressed.scaleY < 1 && compressed.scaleX > 1);
  assert.ok(rebound.scaleY > 1);
  assert.deepEqual(neutral, {
    translateX: 0, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1,
  });
});

test("三套内置模型的 13 个语义动作都映射到有效组和索引", () => {
  const models = {
    hiyori: { Idle: 9, TapBody: 1 },
    mao: { Idle: 2, TapBody: 6 },
    wanko: { Idle: 4, TapBody: 6, Shake: 2 },
  };
  for (const [modelId, groups] of Object.entries(models)) {
    for (const action of ACTIONS) {
      const motionRef = resolveActionMotion(modelId, action, groups);
      assert.ok(motionRef, `${modelId}/${action} 缺少动作映射`);
      assert.ok((groups as Record<string, number>)[motionRef.group]! > motionRef.index);
      assert.ok(motionRef.index >= 0);
    }
  }
  assert.equal(resolveActionMotion("imported-model", "wave", { TapBody: 2 }), undefined);
});

test("真实 motion3 元数据决定动作时长并限制在 600 到 12000ms", () => {
  const fixtures: Array<[string, number]> = [
    ["src/renderer/public/live2d/Hiyori/motions/Hiyori_m05.motion3.json", 8_570],
    ["src/renderer/public/live2d/Mao/motions/special_02.motion3.json", 9_370],
    ["src/renderer/public/live2d/Wanko/motions/idle_04.motion3.json", 10_367],
  ];
  for (const [path, expected] of fixtures) {
    const json = JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as unknown;
    assert.equal(motionDurationMs(json), expected);
  }
  assert.equal(motionDurationMs({ Meta: { Duration: 0.1 } }), 600);
  assert.equal(motionDurationMs({ Meta: { Duration: 99 } }), 12_000);
  assert.equal(motionDurationMs({ Meta: {} }), undefined);
});

test("导入模型缺少 motion 时每个语义动作都有确定的程序化反馈", () => {
  const idle = motion("idle", 0, 0);
  for (const action of ACTIONS) {
    const duration = proceduralActionDurationMs(action);
    assert.ok(duration >= 600 && duration <= 12_000);
    const transform = computePetTransform(idle, action, duration * 0.25, 0);
    assert.ok(Object.values(transform).every(Number.isFinite));
    assert.notDeepEqual(transform, {
      translateX: 0, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1,
    }, `${action} 没有可见程序化反馈`);
  }
});

function motion(state: PetMotionFrame["state"], velocityX: number, velocityY: number): PetMotionFrame {
  return { state, velocityX, velocityY, offsetX: velocityX * 0.05, offsetY: velocityY * 0.05 };
}
