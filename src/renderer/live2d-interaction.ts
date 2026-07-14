import type { PetAction, PetFocus, PetMotionFrame } from "../common/types";

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

const FOCUS_ALIASES: Readonly<Record<keyof FocusBindings, readonly string[]>> = {
  eyeX: ["ParamEyeBallX"],
  eyeY: ["ParamEyeBallY"],
  angleX: ["ParamAngleX", "PARAM_ANGLE_X"],
  angleY: ["ParamAngleY", "PARAM_ANGLE_Y"],
  angleZ: ["ParamAngleZ", "PARAM_ANGLE_Z"],
  bodyX: ["ParamBodyAngleX", "PARAM_BODY_ANGLE_X"],
  bodyY: ["PARAM_BODY_ANGLE_Y"],
  bodyZ: ["PARAM_BODY_ANGLE_Z"],
  earLeft: ["PARAM_EAR_L"],
  earRight: ["PARAM_EAR_R"],
};

const BUNDLED_ACTION_MOTIONS: Record<string, Record<PetAction, SemanticMotion>> = {
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

export function advanceFocus(current: PetFocus, target: PetFocus, damping: number): PetFocus {
  const amount = clamp(Number.isFinite(damping) ? damping : 0, 0, 1);
  return {
    x: clamp(current.x + (target.x - current.x) * amount, -1, 1),
    y: clamp(current.y + (target.y - current.y) * amount, -1, 1),
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
  const duration = PROCEDURAL_ACTION_DURATION[action];
  const progress = clamp(elapsedMs / duration, 0, 1);
  const wave = Math.sin(progress * Math.PI * 2);
  switch (action) {
    case "wave":
      transform.rotation += Math.sin(progress * Math.PI * 2) * 0.08;
      break;
    case "nod":
      transform.translateY += Math.sin(progress * Math.PI * 2) * 5;
      transform.scaleY *= 1 - Math.sin(progress * Math.PI * 2) * 0.025;
      break;
    case "shake-head":
      transform.rotation += Math.cos(progress * Math.PI * 4) * 0.075;
      break;
    case "head-tilt":
      transform.rotation += 0.075 * Math.sin(Math.PI * Math.min(1, progress * 2));
      break;
    case "jump":
      transform.translateY -= Math.sin(progress * Math.PI) * 28;
      break;
    case "cheer":
      transform.translateY -= Math.max(0, wave) * 10;
      transform.scaleX *= 1 + Math.max(0, wave) * 0.045;
      transform.scaleY *= 1 + Math.max(0, wave) * 0.045;
      break;
    case "dance":
      transform.translateX += wave * 10;
      transform.rotation += wave * 0.09;
      break;
    case "sit":
      transform.translateY += 7 * Math.min(1, progress * 4);
      transform.scaleY *= 0.94;
      break;
    case "stretch":
      transform.translateY -= Math.sin(progress * Math.PI) * 4;
      transform.scaleX *= 1 - Math.sin(progress * Math.PI) * 0.04;
      transform.scaleY *= 1 + Math.sin(progress * Math.PI) * 0.1;
      break;
    case "shy":
      transform.translateX -= 4 * Math.sin(progress * Math.PI);
      transform.rotation -= 0.045 * Math.sin(progress * Math.PI);
      transform.scaleX *= 0.98;
      transform.scaleY *= 0.98;
      break;
    case "comfort":
      transform.translateX += wave * 3;
      transform.rotation += wave * 0.025;
      transform.scaleX *= 1 + Math.sin(progress * Math.PI) * 0.018;
      transform.scaleY *= 1 + Math.sin(progress * Math.PI) * 0.018;
      break;
    case "sleep":
      transform.translateY += 6 * Math.min(1, progress * 3);
      transform.rotation -= 0.025;
      transform.scaleX *= 0.97;
      transform.scaleY *= 0.97;
      break;
    case "surprised": {
      const pulse = Math.sin(Math.PI * Math.min(1, progress * 2));
      transform.translateY -= pulse * 8;
      transform.scaleX *= 1 + pulse * 0.08;
      transform.scaleY *= 1 + pulse * 0.08;
      break;
    }
  }
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
