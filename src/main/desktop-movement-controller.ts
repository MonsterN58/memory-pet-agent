import { BrowserWindow, screen } from "electron";
import type { AgentSettings, PetFocus, PetLocomotion, PetMotionFrame } from "../common/types";
import {
  clampMotionFrame,
  deriveMotionFrame,
  normalizeFocus,
  reduceLanding,
  type MotionBounds,
} from "./pet-motion";

type PauseReason = "pointer" | "focus";

export class DesktopMovementController {
  private timer?: NodeJS.Timeout;
  private readonly pauseReasons = new Set<PauseReason>();
  private dragging = false;
  private falling = false;
  private dragOffset = { x: 0, y: 0 };
  private fallVelocity = 0;
  private fallVelocityX = 0;
  private landingUntil?: number;
  private targetX?: number;
  private nextDecisionAt = Date.now() + 2500;
  private previousBounds?: MotionBounds;
  private previousMotionAt = Date.now();
  private lastMotion: PetMotionFrame = {
    state: "idle", velocityX: 0, velocityY: 0, offsetX: 0, offsetY: 0,
  };
  private lastFocus?: PetFocus;
  private lastFocusAt = 0;

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly getSettings: () => AgentSettings,
    private readonly signal: (frame: PetMotionFrame) => void,
    private readonly signalFocus: (focus: PetFocus) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 33);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setInteracting(active: boolean, reason: PauseReason = "pointer"): void {
    if (active) {
      this.pauseReasons.add(reason);
      this.targetX = undefined;
      this.nextDecisionAt = Date.now() + 1800;
      if (!this.dragging && !this.falling && this.landingUntil === undefined) this.emitCurrent("idle");
      return;
    }

    const removed = this.pauseReasons.delete(reason);
    if (removed && this.pauseReasons.size === 0) this.nextDecisionAt = Date.now() + 450;
  }

  beginDrag(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    this.dragOffset = {
      x: cursor.x - bounds.x,
      y: cursor.y - bounds.y,
    };
    this.dragging = true;
    this.falling = false;
    this.fallVelocity = 0;
    this.fallVelocityX = 0;
    this.landingUntil = undefined;
    this.targetX = undefined;
    this.resetMotionTracking(bounds);
    this.emitMotion("dragged", bounds);
  }

  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.falling = true;
    this.fallVelocity = 2;
    this.fallVelocityX = this.lastMotion.velocityX;
    this.targetX = undefined;
    this.emitCurrent("falling", true);
  }

  resetPosition(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    const workArea = screen.getPrimaryDisplay().workArea;
    const bounds = window.getBounds();
    const x = workArea.x + workArea.width - bounds.width - 30;
    const y = workArea.y + workArea.height - bounds.height;
    window.setPosition(x, y, false);
    this.dragging = false;
    this.falling = false;
    this.fallVelocity = 0;
    this.fallVelocityX = 0;
    this.landingUntil = undefined;
    this.targetX = undefined;
    this.nextDecisionAt = Date.now() + 2200;
    const nextBounds = { ...bounds, x, y };
    this.resetMotionTracking(nextBounds);
    this.emitMotion("idle", nextBounds);
  }

  wake(): void {
    this.nextDecisionAt = Date.now() + 500;
  }

  private tick(): void {
    const now = Date.now();
    const window = this.getWindow();
    if (!window || window.isDestroyed() || !window.isVisible()) {
      this.signal({ state: "idle", velocityX: 0, velocityY: 0, offsetX: 0, offsetY: 0 });
      return;
    }
    this.emitFocus(window);

    if (this.dragging) {
      this.followCursor(window);
      return;
    }

    if (this.falling) {
      this.fallToGround(window, now);
      return;
    }

    if (this.landingUntil !== undefined) {
      const landing = reduceLanding(this.landingUntil, now);
      if (landing.state === "landing") {
        this.emitMotion("landing", window.getBounds(), now);
      } else {
        this.landingUntil = undefined;
        this.fallVelocityX = 0;
        this.nextDecisionAt = now + 900;
        this.emitMotion("idle", window.getBounds(), now);
      }
      return;
    }

    const settings = this.getSettings().window;
    if (!settings.roamingEnabled || this.pauseReasons.size > 0) {
      this.emitMotion("idle", window.getBounds(), now);
      return;
    }

    const bounds = window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const minX = workArea.x;
    const maxX = workArea.x + workArea.width - bounds.width;
    const groundY = workArea.y + workArea.height - bounds.height;
    if (bounds.y !== groundY) window.setPosition(bounds.x, groundY, false);
    const groundedBounds = bounds.y === groundY ? bounds : { ...bounds, y: groundY };

    if (this.targetX === undefined) {
      if (now < this.nextDecisionAt) {
        this.emitMotion("idle", groundedBounds, now);
        return;
      }
      const range = Math.max(1, maxX - minX);
      const candidate = Math.round(minX + range * (0.08 + Math.random() * 0.84));
      if (Math.abs(candidate - bounds.x) < 90) {
        this.nextDecisionAt = now + 1200;
        this.emitMotion("idle", groundedBounds, now);
        return;
      }
      this.targetX = candidate;
    }

    const delta = this.targetX - bounds.x;
    const direction = Math.sign(delta);
    const step = Math.max(1, settings.roamingSpeed * 1.8);
    if (Math.abs(delta) <= step) {
      window.setPosition(Math.round(this.targetX), groundY, false);
      const nextBounds = { ...groundedBounds, x: Math.round(this.targetX), y: groundY };
      this.targetX = undefined;
      this.nextDecisionAt = now + 2800 + Math.random() * 5200;
      this.emitMotion("idle", nextBounds, now);
      return;
    }

    const nextX = Math.max(minX, Math.min(maxX, bounds.x + direction * step));
    window.setPosition(Math.round(nextX), groundY, false);
    this.emitMotion(
      direction < 0 ? "walk-left" : "walk-right",
      { ...groundedBounds, x: Math.round(nextX), y: groundY },
      now,
    );
  }

  private followCursor(window: BrowserWindow): void {
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const workArea = screen.getDisplayNearestPoint(cursor).workArea;
    const minX = workArea.x;
    const maxX = workArea.x + workArea.width - bounds.width;
    const minY = workArea.y;
    const maxY = workArea.y + workArea.height - bounds.height;
    const x = this.clamp(cursor.x - this.dragOffset.x, minX, maxX);
    const y = this.clamp(cursor.y - this.dragOffset.y, minY, maxY);
    if (bounds.x !== x || bounds.y !== y) window.setPosition(Math.round(x), Math.round(y), false);
    this.emitMotion("dragged", { ...bounds, x: Math.round(x), y: Math.round(y) });
  }

  private fallToGround(window: BrowserWindow, now: number): void {
    const bounds = window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const minX = workArea.x;
    const maxX = workArea.x + workArea.width - bounds.width;
    const groundY = workArea.y + workArea.height - bounds.height;
    const x = this.clamp(bounds.x, minX, maxX);

    if (bounds.y >= groundY) {
      window.setPosition(Math.round(x), groundY, false);
      this.falling = false;
      this.fallVelocity = 0;
      const landing = reduceLanding(undefined, now, true);
      this.landingUntil = landing.landingUntil;
      this.emitMotion("landing", { ...bounds, x: Math.round(x), y: groundY }, now, true);
      return;
    }

    this.fallVelocity = Math.min(30, this.fallVelocity + 2.2);
    const y = Math.min(groundY, bounds.y + this.fallVelocity);
    window.setPosition(Math.round(x), Math.round(y), false);
    const nextBounds = { ...bounds, x: Math.round(x), y: Math.round(y) };
    if (y >= groundY) {
      this.falling = false;
      this.fallVelocity = 0;
      const landing = reduceLanding(undefined, now, true);
      this.landingUntil = landing.landingUntil;
      this.emitMotion("landing", nextBounds, now, true);
      return;
    }
    this.emitMotion("falling", nextBounds, now, true);
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
  }

  private emitCurrent(state: PetLocomotion, preserveFallVelocityX = false): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) {
      this.signal({ state, velocityX: 0, velocityY: 0, offsetX: 0, offsetY: 0 });
      return;
    }
    this.emitMotion(state, window.getBounds(), Date.now(), preserveFallVelocityX);
  }

  private emitMotion(
    state: PetLocomotion,
    bounds: MotionBounds,
    now = Date.now(),
    preserveFallVelocityX = false,
  ): void {
    const previous = this.previousBounds ?? bounds;
    const frame = deriveMotionFrame(previous, bounds, now - this.previousMotionAt, state);
    const nextFrame = preserveFallVelocityX
      ? clampMotionFrame({ ...frame, velocityX: this.fallVelocityX })
      : frame;
    this.previousBounds = { ...bounds };
    this.previousMotionAt = now;
    this.lastMotion = nextFrame;
    this.signal(nextFrame);
  }

  private resetMotionTracking(bounds: MotionBounds): void {
    this.previousBounds = { ...bounds };
    this.previousMotionAt = Date.now();
    this.lastMotion = { state: "idle", velocityX: 0, velocityY: 0, offsetX: 0, offsetY: 0 };
  }

  private emitFocus(window: BrowserWindow): void {
    const now = Date.now();
    if (now - this.lastFocusAt < 32) return;
    this.lastFocusAt = now;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const focus = normalizeFocus(cursor, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height - Math.min(330, bounds.height) / 2,
    });
    if (
      this.lastFocus
      && Math.abs(focus.x - this.lastFocus.x) < 0.006
      && Math.abs(focus.y - this.lastFocus.y) < 0.006
    ) return;
    this.lastFocus = focus;
    this.signalFocus(focus);
  }
}
