import { BrowserWindow, screen } from "electron";
import type { AgentSettings, PetFocus, PetLocomotion } from "../common/types";

type PauseReason = "pointer" | "focus";

export class DesktopMovementController {
  private timer?: NodeJS.Timeout;
  private readonly pauseReasons = new Set<PauseReason>();
  private dragging = false;
  private falling = false;
  private dragOffset = { x: 0, y: 0 };
  private fallVelocity = 0;
  private targetX?: number;
  private nextDecisionAt = Date.now() + 2500;
  private lastSignal: PetLocomotion = "idle";
  private lastFocus?: PetFocus;
  private lastFocusAt = 0;

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly getSettings: () => AgentSettings,
    private readonly signal: (state: PetLocomotion) => void,
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
      if (!this.dragging && !this.falling) this.emit("idle");
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
    this.targetX = undefined;
    this.emit("dragged");
  }

  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.falling = true;
    this.fallVelocity = 2;
    this.targetX = undefined;
    this.emit("falling");
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
    this.targetX = undefined;
    this.nextDecisionAt = Date.now() + 2200;
    this.emit("idle");
  }

  wake(): void {
    this.nextDecisionAt = Date.now() + 500;
  }

  private tick(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed() || !window.isVisible()) {
      this.emit("idle");
      return;
    }
    this.emitFocus(window);

    if (this.dragging) {
      this.followCursor(window);
      return;
    }

    if (this.falling) {
      this.fallToGround(window);
      return;
    }

    const settings = this.getSettings().window;
    if (!settings.roamingEnabled || this.pauseReasons.size > 0) {
      this.emit("idle");
      return;
    }

    const bounds = window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const minX = workArea.x;
    const maxX = workArea.x + workArea.width - bounds.width;
    const groundY = workArea.y + workArea.height - bounds.height;
    if (bounds.y !== groundY) window.setPosition(bounds.x, groundY, false);

    if (this.targetX === undefined) {
      if (Date.now() < this.nextDecisionAt) {
        this.emit("idle");
        return;
      }
      const range = Math.max(1, maxX - minX);
      const candidate = Math.round(minX + range * (0.08 + Math.random() * 0.84));
      if (Math.abs(candidate - bounds.x) < 90) {
        this.nextDecisionAt = Date.now() + 1200;
        return;
      }
      this.targetX = candidate;
    }

    const delta = this.targetX - bounds.x;
    const direction = Math.sign(delta);
    const step = Math.max(1, settings.roamingSpeed * 1.8);
    if (Math.abs(delta) <= step) {
      window.setPosition(Math.round(this.targetX), groundY, false);
      this.targetX = undefined;
      this.nextDecisionAt = Date.now() + 2800 + Math.random() * 5200;
      this.emit("idle");
      return;
    }

    const nextX = Math.max(minX, Math.min(maxX, bounds.x + direction * step));
    window.setPosition(Math.round(nextX), groundY, false);
    this.emit(direction < 0 ? "walk-left" : "walk-right");
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
    this.emit("dragged");
  }

  private fallToGround(window: BrowserWindow): void {
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
      this.nextDecisionAt = Date.now() + 900;
      this.emit("idle");
      return;
    }

    this.fallVelocity = Math.min(30, this.fallVelocity + 2.2);
    const y = Math.min(groundY, bounds.y + this.fallVelocity);
    window.setPosition(Math.round(x), Math.round(y), false);
    this.emit("falling");
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
  }

  private emit(state: PetLocomotion): void {
    if (state === this.lastSignal) return;
    this.lastSignal = state;
    this.signal(state);
  }

  private emitFocus(window: BrowserWindow): void {
    const now = Date.now();
    if (now - this.lastFocusAt < 32) return;
    this.lastFocusAt = now;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const modelHeight = Math.min(330, bounds.height);
    const focus = {
      x: this.clamp((cursor.x - (bounds.x + bounds.width / 2)) / Math.max(1, bounds.width / 2), -1, 1),
      y: this.clamp(((bounds.y + bounds.height - modelHeight / 2) - cursor.y) / Math.max(1, modelHeight / 2), -1, 1),
    };
    if (
      this.lastFocus
      && Math.abs(focus.x - this.lastFocus.x) < 0.006
      && Math.abs(focus.y - this.lastFocus.y) < 0.006
    ) return;
    this.lastFocus = focus;
    this.signalFocus(focus);
  }
}
