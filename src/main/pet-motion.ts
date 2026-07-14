import type { PetFocus, PetLocomotion, PetMotionFrame } from "../common/types";

export const MOTION_VELOCITY_X_PX_PER_SECOND = 1_000;
export const MOTION_VELOCITY_Y_PX_PER_SECOND = 1_000;
export const LANDING_DURATION_MS = 320;

export interface MotionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LandingTransition {
  state: "landing" | "idle";
  landingUntil?: number;
}

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

export function deriveMotionFrame(
  previousBounds: MotionBounds,
  nextBounds: MotionBounds,
  elapsedMs: number,
  state: PetLocomotion,
): PetMotionFrame {
  const elapsedSeconds = Math.max(1, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1_000;
  const deltaX = nextBounds.x - previousBounds.x;
  const deltaY = nextBounds.y - previousBounds.y;
  return clampMotionFrame({
    state,
    velocityX: deltaX / elapsedSeconds / MOTION_VELOCITY_X_PX_PER_SECOND,
    velocityY: deltaY / elapsedSeconds / MOTION_VELOCITY_Y_PX_PER_SECOND,
    offsetX: deltaX / Math.max(1, nextBounds.width),
    offsetY: deltaY / Math.max(1, nextBounds.height),
  });
}

export function reduceLanding(
  landingUntil: number | undefined,
  now: number,
  groundContact = false,
): LandingTransition {
  if (groundContact) return { state: "landing", landingUntil: now + LANDING_DURATION_MS };
  if (landingUntil !== undefined && now < landingUntil) return { state: "landing", landingUntil };
  return { state: "idle" };
}
