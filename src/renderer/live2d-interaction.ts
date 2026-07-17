import type { PetAction, PetEmotion, PetFocus, PetMotionFrame } from "../common/types";

export interface FocusBindings {
  eyeX?: number;
  eyeY?: number;
  angleX?: number;
  angleY?: number;
  angleZ?: number;
  bodyX?: number;
  bodyY?: number;
  bodyZ?: number;
  earLeft?: number;
  earRight?: number;
}

export interface PetTransform {
  translateX: number;
  translateY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface SemanticMotion {
  group: string;
  index: number;
}

export interface ThinkingPose {
  eyeX: number;
  eyeY: number;
  headX: number;
  headY: number;
  headZ: number;
  bodyX: number;
  bodyY: number;
  earLeft: number;
  earRight: number;
  translateX: number;
  translateY: number;
  rotation: number;
}

export interface ProceduralActionPose {
  eyeX: number;
  eyeY: number;
  headX: number;
  headY: number;
  headZ: number;
  bodyX: number;
  bodyY: number;
  bodyZ: number;
  earLeft: number;
  earRight: number;
}

const FOCUS_ALIASES: Readonly<Record<keyof FocusBindings, readonly string[]>> = {
  eyeX: ["ParamEyeBallX"],
  eyeY: ["ParamEyeBallY"],
  angleX: ["ParamAngleX", "PARAM_ANGLE_X"],
  angleY: ["ParamAngleY", "PARAM_ANGLE_Y"],
  angleZ: ["ParamAngleZ", "PARAM_ANGLE_Z"],
  bodyX: ["ParamBodyAngleX", "PARAM_BODY_ANGLE_X"],
  bodyY: ["ParamBodyAngleY", "PARAM_BODY_ANGLE_Y"],
  bodyZ: ["ParamBodyAngleZ", "PARAM_BODY_ANGLE_Z"],
  earLeft: ["PARAM_EAR_L"],
  earRight: ["PARAM_EAR_R"],
};

const BUNDLED_ACTION_MOTIONS: Record<string, Partial<Record<PetAction, SemanticMotion>>> = {
  hiyori: {
    wave: { group: "Idle", index: 4 },
    nod: { group: "Idle", index: 1 },
    "shake-head": { group: "Idle", index: 2 },
    "head-tilt": { group: "Idle", index: 5 },
    jump: { group: "Idle", index: 7 },
    cheer: { group: "Idle", index: 6 },
    dance: { group: "Idle", index: 5 },
    sit: { group: "Idle", index: 1 },
    stretch: { group: "Idle", index: 8 },
    shy: { group: "Idle", index: 2 },
    comfort: { group: "TapBody", index: 0 },
    sleep: { group: "Idle", index: 3 },
    surprised: { group: "Idle", index: 6 },
    bow: { group: "Idle", index: 1 },
    applaud: { group: "Idle", index: 6 },
    peek: { group: "Idle", index: 5 },
    ponder: { group: "Idle", index: 3 },
    present: { group: "Idle", index: 4 },
  },
  mao: {
    wave: { group: "TapBody", index: 0 },
    nod: { group: "TapBody", index: 1 },
    "shake-head": { group: "TapBody", index: 2 },
    "head-tilt": { group: "TapBody", index: 1 },
    jump: { group: "TapBody", index: 3 },
    cheer: { group: "TapBody", index: 4 },
    dance: { group: "TapBody", index: 4 },
    sit: { group: "Idle", index: 1 },
    stretch: { group: "TapBody", index: 3 },
    shy: { group: "TapBody", index: 2 },
    comfort: { group: "TapBody", index: 0 },
    sleep: { group: "Idle", index: 0 },
    surprised: { group: "TapBody", index: 5 },
    bow: { group: "TapBody", index: 1 },
    applaud: { group: "TapBody", index: 4 },
    peek: { group: "TapBody", index: 1 },
    ponder: { group: "Idle", index: 1 },
    present: { group: "TapBody", index: 0 },
  },
  wanko: {
    wave: { group: "TapBody", index: 1 },
    nod: { group: "TapBody", index: 0 },
    "shake-head": { group: "Shake", index: 0 },
    "head-tilt": { group: "TapBody", index: 2 },
    jump: { group: "TapBody", index: 3 },
    cheer: { group: "Shake", index: 1 },
    dance: { group: "Shake", index: 0 },
    sit: { group: "Idle", index: 1 },
    stretch: { group: "TapBody", index: 4 },
    shy: { group: "TapBody", index: 2 },
    comfort: { group: "TapBody", index: 0 },
    sleep: { group: "Idle", index: 3 },
    surprised: { group: "TapBody", index: 5 },
    bow: { group: "TapBody", index: 0 },
    applaud: { group: "Shake", index: 1 },
    peek: { group: "TapBody", index: 2 },
    ponder: { group: "Idle", index: 1 },
    present: { group: "TapBody", index: 1 },
  },
  haru: {
    wave: { group: "TapBody", index: 0 },
    nod: { group: "Idle", index: 1 },
    cheer: { group: "TapBody", index: 2 },
    shy: { group: "TapBody", index: 3 },
    comfort: { group: "TapBody", index: 1 },
    surprised: { group: "TapBody", index: 2 },
    applaud: { group: "TapBody", index: 2 },
    present: { group: "TapBody", index: 0 },
  },
  mark: {
    wave: { group: "Idle", index: 1 },
    nod: { group: "Idle", index: 2 },
    cheer: { group: "Idle", index: 3 },
    dance: { group: "Idle", index: 4 },
    surprised: { group: "Idle", index: 5 },
    present: { group: "Idle", index: 1 },
  },
  rice: {
    wave: { group: "TapBody", index: 0 },
    cheer: { group: "TapBody", index: 1 },
    dance: { group: "TapBody", index: 2 },
    applaud: { group: "TapBody", index: 1 },
    present: { group: "TapBody", index: 0 },
  },
};

const BUNDLED_EMOTION_EXPRESSIONS: Record<string, Partial<Record<PetEmotion, number>>> = {
  mao: {
    idle: 0, happy: 1, excited: 1, thinking: 4, curious: 3, listening: 6,
    speaking: 0, comforting: 5, shy: 7, surprised: 6, sleepy: 2,
  },
  haru: {
    idle: 0, happy: 4, excited: 1, thinking: 7, curious: 5, listening: 0,
    speaking: 0, comforting: 4, shy: 6, surprised: 5, sleepy: 4,
  },
  cyannyan: {
    idle: 15, happy: 3, excited: 9, thinking: 7, curious: 7, listening: 15,
    speaking: 3, comforting: 4, shy: 1, surprised: 13, sleepy: 8,
  },
  xiaoyun: {
    idle: 14, happy: 3, excited: 0, thinking: 9, curious: 10, listening: 15,
    speaking: 16, comforting: 2, shy: 1, surprised: 11, sleepy: 3,
  },
};

const PROCEDURAL_ACTION_DURATION: Record<PetAction, number> = {
  wave: 1_600,
  nod: 1_000,
  "shake-head": 1_100,
  "head-tilt": 1_300,
  jump: 1_200,
  cheer: 1_600,
  dance: 2_400,
  sit: 2_000,
  stretch: 1_800,
  shy: 1_800,
  comfort: 2_200,
  sleep: 3_500,
  surprised: 900,
  bow: 1_800,
  applaud: 2_200,
  peek: 1_700,
  ponder: 2_300,
  present: 1_900,
};

export function resolveFocusBindings(parameterIds: readonly string[]): FocusBindings {
  const indices = new Map<string, number>();
  parameterIds.forEach((id, index) => indices.set(id, index));
  const bindings: FocusBindings = {};
  for (const [binding, aliases] of Object.entries(FOCUS_ALIASES) as Array<[
    keyof FocusBindings,
    readonly string[],
  ]>) {
    const alias = aliases.find((candidate) => indices.has(candidate));
    if (alias !== undefined) bindings[binding] = indices.get(alias);
  }
  return bindings;
}

export function resolveLipSyncParameters(
  parameterIds: readonly string[],
  declaredParameters: readonly string[],
): string[] {
  const available = new Set(parameterIds);
  const resolved = declaredParameters.filter((id, index) => (
    available.has(id) && declaredParameters.indexOf(id) === index
  ));
  for (const fallback of ["ParamMouthOpenY", "PARAM_MOUTH_OPEN_Y"]) {
    if (available.has(fallback) && !resolved.includes(fallback)) resolved.push(fallback);
  }
  return resolved;
}

export function advanceFocus(current: PetFocus, target: PetFocus, damping: number): PetFocus {
  const amount = clamp(Number.isFinite(damping) ? damping : 0, 0, 1);
  return {
    x: clamp(current.x + (target.x - current.x) * amount, -1, 1),
    y: clamp(current.y + (target.y - current.y) * amount, -1, 1),
  };
}

/** A restrained, model-independent thinking pose layered over idle motion. */
export function computeThinkingPose(elapsedMs: number, weight: number): ThinkingPose {
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const amount = clamp(Number.isFinite(weight) ? weight : 0, 0, 1);
  if (amount === 0) {
    return {
      eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0,
      bodyX: 0, bodyY: 0, earLeft: 0, earRight: 0,
      translateX: 0, translateY: 0, rotation: 0,
    };
  }
  const breathe = Math.sin((safeElapsed / 3_200) * Math.PI * 2);
  return {
    eyeX: (-0.3 + breathe * 0.035) * amount,
    eyeY: (0.16 + breathe * 0.02) * amount,
    headX: (-2.4 + breathe * 0.35) * amount,
    headY: (1.3 + breathe * 0.2) * amount,
    headZ: (4.6 + breathe * 0.35) * amount,
    bodyX: (-1.15 + breathe * 0.12) * amount,
    bodyY: 0.35 * amount,
    earLeft: (0.08 + breathe * 0.015) * amount,
    earRight: (-0.04 - breathe * 0.01) * amount,
    translateX: -1.4 * amount,
    translateY: (1.2 + breathe * 0.35) * amount,
    rotation: (0.024 + breathe * 0.003) * amount,
  };
}

export function resolveActionMotion(
  modelId: string,
  action: PetAction,
  motionGroups: Readonly<Record<string, number>>,
): SemanticMotion | undefined {
  const selected = BUNDLED_ACTION_MOTIONS[modelId]?.[action];
  if (!selected) return undefined;
  const count = motionGroups[selected.group];
  if (typeof count !== "number" || !Number.isInteger(count) || count <= selected.index || selected.index < 0) {
    return undefined;
  }
  return { ...selected };
}

export function resolveEmotionExpression(
  modelId: string,
  emotion: PetEmotion,
  expressionCount: number,
): number | undefined {
  const index = BUNDLED_EMOTION_EXPRESSIONS[modelId]?.[emotion];
  if (!Number.isInteger(index) || index === undefined || index < 0 || index >= expressionCount) return undefined;
  return index;
}

export function motionDurationMs(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const meta = (value as { Meta?: unknown }).Meta;
  if (!meta || typeof meta !== "object") return undefined;
  const duration = (meta as { Duration?: unknown }).Duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return undefined;
  return Math.round(clamp(duration * 1_000, 600, 12_000));
}

export function proceduralActionDurationMs(action: PetAction): number {
  return PROCEDURAL_ACTION_DURATION[action];
}

/** Standard/legacy Cubism parameters layered onto imported models without a semantic motion. */
export function computeProceduralActionPose(action: PetAction, elapsedMs: number): ProceduralActionPose {
  const progress = normalizedActionProgress(action, elapsedMs);
  if (progress <= 0 || progress >= 1) return neutralActionPose();
  const hold = actionEnvelope(progress);
  const pulse = Math.sin(progress * Math.PI);
  const sway = actionOscillation(progress, 1.5);
  const quick = actionOscillation(progress, 2.25);
  const bounce = Math.abs(Math.sin(progress * Math.PI * 3)) * hold;

  switch (action) {
    case "wave":
      return actionPose({ headZ: sway * 2.8, bodyX: -sway * 1.1 });
    case "nod":
      return actionPose({ headY: quick * 8, bodyY: quick * 1.8 });
    case "shake-head":
      return actionPose({ eyeX: quick * 0.3, headX: quick * 10, bodyX: -quick * 2 });
    case "head-tilt":
      return actionPose({ eyeX: -0.12 * hold, headZ: 7 * hold, bodyX: -1.5 * hold });
    case "jump":
      return actionPose({ headY: pulse * 4, bodyY: pulse * 2, earLeft: pulse * 0.16, earRight: pulse * 0.16 });
    case "cheer":
      return actionPose({ headY: bounce * 5, headZ: quick * 2.5, bodyY: bounce * 2.5, earLeft: bounce * 0.2, earRight: bounce * 0.2 });
    case "dance":
      return actionPose({ eyeX: quick * 0.22, headX: quick * 5, headZ: quick * 7, bodyX: -quick * 4 });
    case "sit":
      return actionPose({ headY: -2 * hold, bodyY: -4 * hold, bodyZ: 1.5 * hold });
    case "stretch":
      return actionPose({ headY: pulse * 7, bodyY: pulse * 5, earLeft: pulse * 0.15, earRight: pulse * 0.15 });
    case "shy":
      return actionPose({ eyeX: -0.28 * hold, eyeY: -0.1 * hold, headX: -3 * hold, headY: -2 * hold, headZ: -6 * hold, bodyX: -2 * hold });
    case "comfort":
      return actionPose({ eyeY: -0.06 * hold, headY: 2 * hold, headZ: sway * 2.2, bodyX: -sway });
    case "sleep":
      return actionPose({ eyeY: -0.28 * hold, headY: -5 * hold, headZ: -4 * hold, bodyY: -3 * hold, earLeft: -0.12 * hold, earRight: -0.12 * hold });
    case "surprised":
      return actionPose({ eyeY: pulse * 0.38, headY: pulse * 8, bodyY: pulse * 3, earLeft: pulse * 0.35, earRight: pulse * 0.35 });
    case "bow":
      return actionPose({ eyeY: -0.15 * hold, headY: -11 * hold, bodyY: -6 * hold, bodyZ: 2 * hold });
    case "applaud":
      return actionPose({ headY: bounce * 4, headZ: quick * 3, bodyY: bounce * 2, earLeft: bounce * 0.18, earRight: bounce * 0.18 });
    case "peek":
      return actionPose({ eyeX: 0.65 * hold, eyeY: 0.06 * hold, headX: 12 * hold, headZ: -4 * hold, bodyX: 5 * hold, earLeft: 0.18 * hold, earRight: -0.08 * hold });
    case "ponder":
      return actionPose({ eyeX: -0.38 * hold, eyeY: 0.18 * hold, headX: -2 * hold, headY: 2 * hold, headZ: 6 * hold, bodyX: -1.2 * hold, earLeft: 0.1 * hold, earRight: -0.05 * hold });
    case "present":
      return actionPose({ eyeX: 0.35 * hold, headX: 8 * hold, headY: 1.5 * hold, headZ: -4 * hold, bodyX: 3 * hold });
  }
}

export function computePetTransform(
  frame: PetMotionFrame,
  action?: PetAction,
  actionElapsedMs = 0,
  landingElapsedMs = 0,
): PetTransform {
  const transform: PetTransform = {
    translateX: 0,
    translateY: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };

  if (frame.state === "dragged") {
    transform.translateX = -frame.offsetX * 42 - frame.velocityX * 8;
    transform.translateY = frame.offsetY * 12;
    transform.rotation = frame.velocityX * 0.13;
    const stretch = Math.max(0, -frame.velocityY) * 0.07;
    transform.scaleX -= stretch * 0.45;
    transform.scaleY += stretch;
  } else if (frame.state === "falling") {
    const stretch = Math.max(0, frame.velocityY) * 0.1;
    transform.rotation = frame.velocityX * 0.11;
    transform.scaleX -= stretch * 0.42;
    transform.scaleY += stretch;
  } else if (frame.state === "landing") {
    const elapsed = clamp(landingElapsedMs, 0, 320);
    if (elapsed <= 160) {
      const progress = elapsed / 160;
      transform.translateY = interpolate(8, -3, progress);
      transform.scaleX = interpolate(1.1, 0.97, progress);
      transform.scaleY = interpolate(0.86, 1.06, progress);
    } else {
      const progress = (elapsed - 160) / 160;
      transform.translateY = interpolate(-3, 0, progress);
      transform.scaleX = interpolate(0.97, 1, progress);
      transform.scaleY = interpolate(1.06, 1, progress);
    }
  }

  if (action) applyProceduralAction(transform, action, actionElapsedMs);
  return transform;
}

function applyProceduralAction(transform: PetTransform, action: PetAction, elapsedMs: number): void {
  const progress = normalizedActionProgress(action, elapsedMs);
  if (progress <= 0 || progress >= 1) return;
  const hold = actionEnvelope(progress);
  const pulse = Math.sin(progress * Math.PI);
  const sway = actionOscillation(progress, 1.5);
  const quick = actionOscillation(progress, 2.25);
  const bounce = Math.abs(Math.sin(progress * Math.PI * 3)) * hold;
  switch (action) {
    case "wave":
      transform.translateX += sway * 1.8;
      transform.rotation += sway * 0.075;
      break;
    case "nod":
      transform.translateY += quick * 4;
      transform.scaleY *= 1 - quick * 0.018;
      break;
    case "shake-head":
      transform.translateX += quick * 2;
      transform.rotation += quick * 0.085;
      break;
    case "head-tilt":
      transform.translateX -= hold * 1.5;
      transform.rotation += hold * 0.075;
      break;
    case "jump":
      transform.translateY -= pulse * 28;
      break;
    case "cheer":
      transform.translateY -= bounce * 10;
      transform.scaleX *= 1 + bounce * 0.045;
      transform.scaleY *= 1 + bounce * 0.045;
      break;
    case "dance":
      transform.translateX += quick * 10;
      transform.rotation += quick * 0.09;
      break;
    case "sit":
      transform.translateY += 7 * hold;
      transform.scaleX *= 1 + hold * 0.018;
      transform.scaleY *= 1 - hold * 0.06;
      break;
    case "stretch":
      transform.translateY -= pulse * 4;
      transform.scaleX *= 1 - pulse * 0.04;
      transform.scaleY *= 1 + pulse * 0.1;
      break;
    case "shy":
      transform.translateX -= 4 * pulse;
      transform.rotation -= 0.045 * pulse;
      transform.scaleX *= 1 - pulse * 0.02;
      transform.scaleY *= 1 - pulse * 0.02;
      break;
    case "comfort":
      transform.translateX += sway * 3;
      transform.rotation += sway * 0.025;
      transform.scaleX *= 1 + pulse * 0.018;
      transform.scaleY *= 1 + pulse * 0.018;
      break;
    case "sleep":
      transform.translateY += 6 * hold + sway * 0.6;
      transform.rotation -= 0.025 * hold;
      transform.scaleX *= 1 - hold * 0.03;
      transform.scaleY *= 1 - hold * 0.03;
      break;
    case "surprised": {
      const surprise = pulse * pulse;
      transform.translateY -= surprise * 8;
      transform.scaleX *= 1 + surprise * 0.08;
      transform.scaleY *= 1 + surprise * 0.08;
      break;
    }
    case "bow":
      transform.translateY += 8 * hold;
      transform.scaleX *= 1 + hold * 0.025;
      transform.scaleY *= 1 - hold * 0.04;
      break;
    case "applaud":
      transform.translateX += quick * 2;
      transform.translateY -= bounce * 6;
      transform.rotation += quick * 0.035;
      transform.scaleX *= 1 + bounce * 0.025;
      transform.scaleY *= 1 + bounce * 0.025;
      break;
    case "peek":
      transform.translateX += 11 * hold + quick * 1.4;
      transform.rotation -= 0.04 * hold;
      break;
    case "ponder":
      transform.translateX -= 1.5 * hold;
      transform.translateY += 2 * hold;
      transform.rotation += 0.045 * hold + sway * 0.004;
      transform.scaleX *= 1 - hold * 0.01;
      transform.scaleY *= 1 - hold * 0.01;
      break;
    case "present":
      transform.translateX -= 7 * hold;
      transform.rotation -= 0.035 * hold;
      transform.scaleX *= 1 + hold * 0.012;
      transform.scaleY *= 1 + hold * 0.012;
      break;
  }
}

function normalizedActionProgress(action: PetAction, elapsedMs: number): number {
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return clamp(safeElapsed / PROCEDURAL_ACTION_DURATION[action], 0, 1);
}

function actionEnvelope(progress: number, attack = 0.16, release = 0.18): number {
  const fadeIn = smoothStep(clamp(progress / attack, 0, 1));
  const fadeOut = smoothStep(clamp((1 - progress) / release, 0, 1));
  return fadeIn * fadeOut;
}

function actionOscillation(progress: number, cycles: number): number {
  return Math.sin(progress * Math.PI * 2 * cycles) * actionEnvelope(progress);
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

function neutralActionPose(): ProceduralActionPose {
  return {
    eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0,
    bodyX: 0, bodyY: 0, bodyZ: 0, earLeft: 0, earRight: 0,
  };
}

function actionPose(values: Partial<ProceduralActionPose>): ProceduralActionPose {
  return { ...neutralActionPose(), ...values };
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
