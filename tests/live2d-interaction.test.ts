import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceFocus,
  resolveFocusBindings,
} from "../src/renderer/live2d-interaction";

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
