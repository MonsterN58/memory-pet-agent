import type { PetUiCommand } from "../common/types";

export interface PetUiCommandEffects {
  focusChat(): void;
  stopVoiceInput(): void;
  stopVoiceOutput(): void;
}

export class PetUiLifecycle {
  private suspended = false;

  constructor(private readonly effects: PetUiCommandEffects) {}

  handle(command: PetUiCommand): void {
    switch (command) {
      case "focus-chat":
        this.suspended = false;
        this.effects.focusChat();
        return;
      case "suspend":
        this.suspended = true;
        this.effects.stopVoiceInput();
        this.effects.stopVoiceOutput();
        return;
      default: {
        const exhaustive: never = command;
        throw new Error(`未知桌宠界面命令：${String(exhaustive)}`);
      }
    }
  }

  resume(): void {
    this.suspended = false;
  }

  presentResponse(effect: () => void): boolean {
    if (this.suspended) return false;
    effect();
    return true;
  }
}
