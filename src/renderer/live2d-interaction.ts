import type { PetFocus } from "../common/types";

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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
