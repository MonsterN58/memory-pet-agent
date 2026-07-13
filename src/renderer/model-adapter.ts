import type { PetAction, PetEmotion, PetFocus, PetLocomotion } from "../common/types";

export interface PetModelAdapter {
  readonly id: string;
  mount(container: HTMLElement): Promise<void> | void;
  setState(state: PetEmotion): void;
  setLocomotion(state: PetLocomotion): void;
  setFocus(focus: PetFocus): void;
  playAction(action: PetAction): boolean;
  speak(text: string): Promise<void>;
  resize(width: number, height: number): void;
  destroy(): void;
}

/**
 * 默认 CSS 后备桌宠。Live2D 或其他 Canvas 模型只需实现
 * PetModelAdapter，并在 renderer.ts 的 createModel() 中替换实例。
 */
export class DefaultPetAdapter implements PetModelAdapter {
  readonly id = "default-css-pet";
  private root?: HTMLElement;
  private state: PetEmotion = "idle";
  private speakTimer?: number;
  private focus: PetFocus = { x: 0, y: 0 };

  mount(container: HTMLElement): void {
    const root = document.createElement("div");
    root.className = "pet-model state-idle";
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", "桌宠小忆");
    root.innerHTML = `
      <div class="pet-antenna"><span></span></div>
      <div class="pet-body">
        <div class="pet-face">
          <i class="eye eye-left"></i><i class="eye eye-right"></i>
          <i class="cheek cheek-left"></i><i class="cheek cheek-right"></i>
          <i class="mouth"></i>
        </div>
        <div class="pet-shine"></div>
      </div>
      <div class="pet-shadow"></div>`;
    container.replaceChildren(root);
    this.root = root;
    this.setFocus(this.focus);
  }

  setState(state: PetEmotion): void {
    if (!this.root) return;
    this.root.classList.remove(`state-${this.state}`);
    this.state = state;
    this.root.classList.add(`state-${state}`);
  }

  setLocomotion(state: PetLocomotion): void {
    if (!this.root) return;
    this.root.dataset.locomotion = state;
  }

  setFocus(focus: PetFocus): void {
    this.focus = focus;
    this.root?.style.setProperty("--focus-x", String(focus.x));
    this.root?.style.setProperty("--focus-y", String(focus.y));
  }

  playAction(action: PetAction): boolean {
    if (!this.root) return false;
    this.root.dataset.action = action;
    window.setTimeout(() => {
      if (this.root?.dataset.action === action) delete this.root.dataset.action;
    }, 1400);
    return true;
  }

  async speak(text: string): Promise<void> {
    this.setState("speaking");
    if (this.speakTimer) window.clearTimeout(this.speakTimer);
    await new Promise<void>((resolve) => {
      this.speakTimer = window.setTimeout(() => {
        this.setState("happy");
        window.setTimeout(() => this.setState("idle"), 900);
        resolve();
      }, Math.min(5000, Math.max(900, text.length * 90)));
    });
  }

  resize(_width: number, _height: number): void {
    // CSS 默认模型自适应容器；2D Canvas 适配器可在此更新画布尺寸。
  }

  destroy(): void {
    if (this.speakTimer) window.clearTimeout(this.speakTimer);
    this.root?.remove();
    this.root = undefined;
  }
}
