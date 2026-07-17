import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PET_ACTIONS, type PetMotionFrame } from "../src/common/types";
import {
  advanceFocus,
  computeProceduralActionPose,
  computeThinkingPose,
  computePetTransform,
  motionDurationMs,
  proceduralActionDurationMs,
  resolveActionMotion,
  resolveEmotionExpression,
  resolveFocusBindings,
  resolveLipSyncParameters,
} from "../src/renderer/live2d-interaction";

const ACTIONS = PET_ACTIONS;

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
  assert.deepEqual(resolveFocusBindings(["ParamBodyAngleY", "ParamBodyAngleZ"]), {
    bodyY: 0,
    bodyZ: 1,
  });
});

test("口型优先使用声明参数并为实际存在的标准参数安全兜底", () => {
  assert.deepEqual(
    resolveLipSyncParameters(
      ["ParamMouthOpenY", "ParamA", "ParamEyeBallX"],
      ["ParamA", "Missing", "ParamA"],
    ),
    ["ParamA", "ParamMouthOpenY"],
  );
  assert.deepEqual(resolveLipSyncParameters(["PARAM_MOUTH_OPEN_Y"], []), ["PARAM_MOUTH_OPEN_Y"]);
  assert.deepEqual(resolveLipSyncParameters(["ParamEyeBallX"], ["ParamMouthOpenY"]), []);
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

test("思考姿态保持克制的视线、头身与整体偏移", () => {
  assert.deepEqual(computeThinkingPose(1_000, 0), {
    eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0,
    bodyX: 0, bodyY: 0, earLeft: 0, earRight: 0,
    translateX: 0, translateY: 0, rotation: 0,
  });
  const pose = computeThinkingPose(800, 1);
  assert.ok(pose.eyeX < 0 && pose.eyeX > -0.4);
  assert.ok(pose.eyeY > 0 && pose.eyeY < 0.25);
  assert.ok(pose.headZ > 3 && pose.headZ < 6);
  assert.ok(Math.abs(pose.rotation) < 0.04);
  assert.ok(Object.values(pose).every(Number.isFinite));

  const clamped = computeThinkingPose(Number.NaN, 8);
  assert.ok(Math.abs(clamped.headZ) < 6);
  assert.ok(Math.abs(clamped.translateX) < 2);
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

test("三套内置模型的 18 个语义动作都映射到有效组和索引", () => {
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

test("六套新增模型只绑定合理的真实 motion，其余动作稳定走程序化兜底", () => {
  const models = {
    haru: { groups: { Idle: 2, TapBody: 4 }, mapped: 8 },
    mark: { groups: { Idle: 6 }, mapped: 6 },
    nana: { groups: {}, mapped: 0 },
    rice: { groups: { Idle: 1, TapBody: 3 }, mapped: 5 },
    cyannyan: { groups: {}, mapped: 0 },
    xiaoyun: { groups: {}, mapped: 0 },
  };
  for (const [modelId, model] of Object.entries(models)) {
    let mapped = 0;
    for (const action of ACTIONS) {
      const motionRef = resolveActionMotion(modelId, action, model.groups);
      if (!motionRef) continue;
      mapped += 1;
      assert.ok((model.groups as Record<string, number>)[motionRef.group]! > motionRef.index);
      assert.ok(motionRef.index >= 0);
    }
    assert.equal(mapped, model.mapped, `${modelId} real motion count`);
  }
});

test("Haru、Cyannyan 与小云的情绪表情映射保持有效且可区分", () => {
  const counts = { haru: 8, cyannyan: 16, xiaoyun: 18 };
  for (const [modelId, count] of Object.entries(counts)) {
    for (const emotion of ["idle", "happy", "thinking", "shy", "surprised"] as const) {
      const index = resolveEmotionExpression(modelId, emotion, count);
      assert.notEqual(index, undefined, `${modelId}/${emotion}`);
      assert.ok(index! >= 0 && index! < count);
    }
  }
  assert.notEqual(
    resolveEmotionExpression("cyannyan", "happy", 16),
    resolveEmotionExpression("cyannyan", "surprised", 16),
  );
  assert.equal(resolveEmotionExpression("mark", "happy", 0), undefined);
  assert.equal(resolveEmotionExpression("xiaoyun", "happy", 2), undefined);
});

test("真实 motion3 元数据决定动作时长并限制在 600 到 12000ms", () => {
  const fixtures: Array<[string, number]> = [
    ["src/renderer/public/live2d/Hiyori/motions/Hiyori_m05.motion3.json", 8_570],
    ["src/renderer/public/live2d/Mao/motions/special_02.motion3.json", 9_370],
    ["src/renderer/public/live2d/Wanko/motions/idle_04.motion3.json", 10_367],
    ["src/renderer/public/live2d/Haru/motions/haru_g_m26.motion3.json", 4_970],
    ["src/renderer/public/live2d/Mark/motions/mark_m04.motion3.json", 4_833],
    ["src/renderer/public/live2d/Rice/motions/mtn_03.motion3.json", 8_000],
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

test("程序化动作从中性姿态平滑进入并在结束时精确复位", () => {
  const idle = motion("idle", 0, 0);
  const neutralTransform = {
    translateX: 0, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1,
  };
  const neutralPose = {
    eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0,
    bodyX: 0, bodyY: 0, bodyZ: 0, earLeft: 0, earRight: 0,
  };
  for (const action of ACTIONS) {
    const duration = proceduralActionDurationMs(action);
    assert.deepEqual(computePetTransform(idle, action, 0), neutralTransform, `${action} 起点跳变`);
    assert.deepEqual(computePetTransform(idle, action, duration), neutralTransform, `${action} 终点未复位`);
    assert.deepEqual(computeProceduralActionPose(action, 0), neutralPose, `${action} 参数起点跳变`);
    assert.deepEqual(computeProceduralActionPose(action, duration), neutralPose, `${action} 参数终点未复位`);
  }
});

test("新增协作语义动作具有彼此可区分的全身和参数反馈", () => {
  const idle = motion("idle", 0, 0);
  const actions = ["bow", "applaud", "peek", "ponder", "present"] as const;
  const transforms = actions.map((action) => {
    const elapsed = proceduralActionDurationMs(action) * 0.25;
    return computePetTransform(idle, action, elapsed);
  });
  assert.equal(new Set(transforms.map((transform) => JSON.stringify(transform))).size, actions.length);

  const bow = computeProceduralActionPose("bow", proceduralActionDurationMs("bow") * 0.25);
  const applaud = computeProceduralActionPose("applaud", proceduralActionDurationMs("applaud") * 0.25);
  const peek = computeProceduralActionPose("peek", proceduralActionDurationMs("peek") * 0.25);
  const ponder = computeProceduralActionPose("ponder", proceduralActionDurationMs("ponder") * 0.25);
  const present = computeProceduralActionPose("present", proceduralActionDurationMs("present") * 0.25);
  assert.ok(bow.headY < -8 && bow.bodyY < -4);
  assert.ok(applaud.headY > 2 && Math.abs(applaud.headZ) > 1);
  assert.ok(peek.eyeX > 0.5 && peek.headX > 8);
  assert.ok(ponder.eyeX < -0.3 && ponder.headZ > 4);
  assert.ok(present.eyeX > 0.25 && present.headX > 6);
});

function motion(state: PetMotionFrame["state"], velocityX: number, velocityY: number): PetMotionFrame {
  return { state, velocityX, velocityY, offsetX: velocityX * 0.05, offsetY: velocityY * 0.05 };
}
