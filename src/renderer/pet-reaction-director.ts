import type { ChatResponse, PetAction, PetEmotion, PetLocomotion } from "../common/types";

export interface PetReactionInput {
  replyId: string;
  emotion: PetEmotion;
  replyText: string;
  requestedAction?: PetAction;
  voiceActive: boolean;
  motion: PetLocomotion;
}

export interface PetReactionPriority {
  voiceActive: boolean;
  motion: PetLocomotion;
}

interface DirectorOptions {
  now?: () => number;
  random?: () => number;
}

interface ReactionCoordinatorOptions {
  thinkingDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

export interface PetReactionEffects {
  setEmotion(emotion: PetEmotion): void;
  playAction(action: PetAction): void;
  setThinking?(active: boolean): void;
}

const STRONG_ACTIONS = new Set<PetAction>(["jump", "cheer", "dance", "applaud", "surprised"]);
const BLOCKING_MOTIONS = new Set<PetLocomotion>(["dragged", "falling", "landing"]);
const STRONG_ACTION_COOLDOWN_MS = 12_000;
const MANUAL_ACTION_PRIORITY_MS = 12_000;
const THINKING_POSE_DELAY_MS = 650;

function isBlockingMotion(motion: PetLocomotion): boolean {
  return BLOCKING_MOTIONS.has(motion);
}

export class PetReactionCoordinator {
  private replySequence = 0;
  private voiceActive = false;
  private motion: PetLocomotion = "idle";
  private currentEmotion: PetEmotion = "idle";
  private deferredVoiceEmotion?: PetEmotion;
  private thinking = false;
  private thinkingPoseActive = false;
  private thinkingTimer?: unknown;
  private readonly thinkingDelayMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;

  constructor(
    private readonly director: PetReactionDirector,
    private readonly effects: PetReactionEffects,
    options: ReactionCoordinatorOptions = {},
  ) {
    this.thinkingDelayMs = Math.max(0, options.thinkingDelayMs ?? THINKING_POSE_DELAY_MS);
    this.schedule = options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled ?? ((handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    });
  }

  beginThinking(): void {
    this.suspendThinkingPose();
    this.thinking = true;
    this.currentEmotion = "thinking";
    this.effects.setEmotion("thinking");
    this.scheduleThinkingPose();
  }

  finishThinking(fallbackEmotion?: PetEmotion): void {
    this.thinking = false;
    this.suspendThinkingPose();
    if (fallbackEmotion) {
      this.currentEmotion = fallbackEmotion;
      this.effects.setEmotion(fallbackEmotion);
    }
  }

  handleResponse(response: Pick<ChatResponse, "emotion" | "text" | "requestedAction">): void {
    this.finishThinking();
    this.currentEmotion = response.emotion;
    this.effects.setEmotion(response.emotion);
    if (this.voiceActive) this.deferredVoiceEmotion = response.emotion;
    this.play(this.director.choose({
      replyId: String(++this.replySequence),
      emotion: response.emotion,
      replyText: response.text,
      requestedAction: response.requestedAction,
      voiceActive: this.voiceActive,
      motion: this.motion,
    }));
  }

  setVoiceActive(active: boolean): void {
    const wasActive = this.voiceActive;
    this.voiceActive = active;
    if (active) {
      this.suspendThinkingPose();
      if (!wasActive) this.deferredVoiceEmotion = this.currentEmotion;
      this.effects.setEmotion("listening");
      return;
    }
    if (wasActive) {
      this.currentEmotion = this.deferredVoiceEmotion ?? this.currentEmotion;
      this.effects.setEmotion(this.currentEmotion);
      this.deferredVoiceEmotion = undefined;
    }
    this.flush();
    if (this.thinking) this.scheduleThinkingPose();
  }

  setMotion(motion: PetLocomotion): void {
    const wasBlocking = isBlockingMotion(this.motion);
    this.motion = motion;
    if (isBlockingMotion(motion)) this.suspendThinkingPose();
    if (wasBlocking && !isBlockingMotion(motion)) this.flush();
    if (wasBlocking && !isBlockingMotion(motion) && this.thinking) this.scheduleThinkingPose();
  }

  playManualAction(action: PetAction): void {
    this.suspendThinkingPose();
    this.director.beginManualAction();
    this.effects.playAction(action);
  }

  private flush(): void {
    this.play(this.director.flush({ voiceActive: this.voiceActive, motion: this.motion }));
  }

  private play(action: PetAction | undefined): void {
    if (action) this.effects.playAction(action);
  }

  private scheduleThinkingPose(): void {
    if (!this.thinking || this.thinkingTimer !== undefined || this.thinkingPoseActive) return;
    this.thinkingTimer = this.schedule(() => {
      this.thinkingTimer = undefined;
      if (!this.thinking || !this.director.allowsAutomatic({
        voiceActive: this.voiceActive,
        motion: this.motion,
      })) return;
      this.thinkingPoseActive = true;
      this.effects.setThinking?.(true);
    }, this.thinkingDelayMs);
  }

  private suspendThinkingPose(): void {
    if (this.thinkingTimer !== undefined) {
      this.cancelScheduled(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
    if (!this.thinkingPoseActive) return;
    this.thinkingPoseActive = false;
    this.effects.setThinking?.(false);
  }
}

export class PetReactionDirector {
  private readonly now: () => number;
  private readonly random: () => number;
  private pending?: PetAction;
  private lastReplyId?: string;
  private lastStrongActionAt = Number.NEGATIVE_INFINITY;
  private automaticSuppressedUntil = Number.NEGATIVE_INFINITY;

  constructor(options: DirectorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  choose(input: PetReactionInput): PetAction | undefined {
    if (input.replyId === this.lastReplyId) return undefined;
    this.lastReplyId = input.replyId;
    if (this.automaticActionSuppressed()) {
      this.pending = undefined;
      return undefined;
    }
    const action = input.requestedAction ?? this.selectAction(input.emotion, input.replyText);
    if (this.isBlocked(input)) {
      this.pending = action;
      return undefined;
    }
    this.pending = undefined;
    return action ? this.authorize(action) : undefined;
  }

  flush(priority: PetReactionPriority): PetAction | undefined {
    if (this.automaticActionSuppressed()) {
      this.pending = undefined;
      return undefined;
    }
    if (this.isBlocked(priority) || !this.pending) return undefined;
    const action = this.pending;
    this.pending = undefined;
    return this.authorize(action);
  }

  beginManualAction(): void {
    this.pending = undefined;
    this.automaticSuppressedUntil = this.now() + MANUAL_ACTION_PRIORITY_MS;
  }

  allowsAutomatic(priority: PetReactionPriority): boolean {
    return !this.automaticActionSuppressed() && !this.isBlocked(priority);
  }

  private selectAction(emotion: PetEmotion, text: string): PetAction | undefined {
    if (emotion === "comforting") return this.pick(["comfort", "nod"]);
    if (emotion === "shy") return this.pick(["shy", "head-tilt"]);
    if (emotion === "surprised") return "surprised";
    if (emotion === "sleepy") return this.pick(["stretch", "sleep"]);

    if (/你好|嗨|早上好|下午好|晚上好|欢迎/.test(text)) return "wave";
    if (/^(对|是的|没错|好的|可以|当然|嗯)[，,。.!！\s]/.test(text)) return "nod";
    if (/^(不|不要|并非|没有|抱歉)[，,。.!！\s]/.test(text)) return "shake-head";
    if (/谢谢|感谢|多亏你|辛苦你了/.test(text)) return "bow";
    if (/我来看看|让我看看|先看看|查看一下|瞧一眼|观察一下/.test(text)) return "peek";
    if (/整理好了|结果如下|方案如下|已经写好|已经准备好|给你展示/.test(text)) return "present";
    if (/成功|完成|搞定|通过了|做到了/.test(text) && (emotion === "happy" || emotion === "excited")) {
      return this.pick(["applaud", "cheer", "present"]);
    }

    if (emotion === "excited") return this.pick(["cheer", "jump", "dance", "applaud"]);
    if (emotion === "curious") return this.pick(["head-tilt", "peek", "nod", "sit"]);
    if (emotion === "thinking") return this.pick(["ponder", "nod", "head-tilt", "sit"]);
    if (emotion === "happy") {
      if (this.random() > 0.35) return undefined;
      return this.pick(["wave", "cheer"]);
    }
    return undefined;
  }

  private pick(actions: readonly PetAction[]): PetAction {
    const normalized = Math.max(0, Math.min(0.999_999, this.random()));
    return actions[Math.floor(normalized * actions.length)]!;
  }

  private authorize(action: PetAction): PetAction | undefined {
    if (!STRONG_ACTIONS.has(action)) return action;
    const now = this.now();
    if (now - this.lastStrongActionAt < STRONG_ACTION_COOLDOWN_MS) return undefined;
    this.lastStrongActionAt = now;
    return action;
  }

  private isBlocked(priority: PetReactionPriority): boolean {
    return priority.voiceActive || isBlockingMotion(priority.motion);
  }

  private automaticActionSuppressed(): boolean {
    return this.now() < this.automaticSuppressedUntil;
  }
}
