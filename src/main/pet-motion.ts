import type { PetFocus, PetMotionFrame } from "../common/types";

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

export function normalizeFocus(cursor: PetFocus, modelCenter: PetFocus): PetFocus {
  return {
    x: clamp((cursor.x - modelCenter.x) / 640),
    y: clamp((modelCenter.y - cursor.y) / 480),
  };
}

export function clampMotionFrame(frame: PetMotionFrame): PetMotionFrame {
  return {
    state: frame.state,
    velocityX: clamp(frame.velocityX),
    velocityY: clamp(frame.velocityY),
    offsetX: clamp(frame.offsetX),
    offsetY: clamp(frame.offsetY),
  };
}
