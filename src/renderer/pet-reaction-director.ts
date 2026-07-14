import type { ChatResponse, PetAction, PetEmotion, PetLocomotion } from "../common/types";

export interface PetReactionInput {
  replyId: string;
  emotion: PetEmotion;
  replyText: string;
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

export interface PetReactionEffects {
  setEmotion(emotion: PetEmotion): void;
  playAction(action: PetAction): void;
}

const STRONG_ACTIONS = new Set<PetAction>(["jump", "cheer", "dance", "surprised"]);
const BLOCKING_MOTIONS = new Set<PetLocomotion>(["dragged", "falling", "landing"]);
const STRONG_ACTION_COOLDOWN_MS = 12_000;

function isBlockingMotion(motion: PetLocomotion): boolean {
  return BLOCKING_MOTIONS.has(motion);
}

export class PetReactionCoordinator {
  private replySequence = 0;
  private voiceActive = false;
  private motion: PetLocomotion = "idle";

  constructor(
    private readonly director: PetReactionDirector,
    private readonly effects: PetReactionEffects,
  ) {}

  handleResponse(response: Pick<ChatResponse, "emotion" | "text">): void {
    this.effects.setEmotion(response.emotion);
    this.play(this.director.choose({
      replyId: String(++this.replySequence),
      emotion: response.emotion,
      replyText: response.text,
      voiceActive: this.voiceActive,
      motion: this.motion,
    }));
  }

  setVoiceActive(active: boolean): void {
    this.voiceActive = active;
    if (!active) this.flush();
  }

  setMotion(motion: PetLocomotion): void {
    const wasBlocking = isBlockingMotion(this.motion);
    this.motion = motion;
    if (wasBlocking && !isBlockingMotion(motion)) this.flush();
  }

  private flush(): void {
    this.play(this.director.flush({ voiceActive: this.voiceActive, motion: this.motion }));
  }

  private play(action: PetAction | undefined): void {
    if (action) this.effects.playAction(action);
  }
}

export class PetReactionDirector {
  private readonly now: () => number;
  private readonly random: () => number;
  private pending?: PetAction;
  private lastReplyId?: string;
  private lastStrongActionAt = Number.NEGATIVE_INFINITY;

  constructor(options: DirectorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  choose(input: PetReactionInput): PetAction | undefined {
    if (input.replyId === this.lastReplyId) return undefined;
    this.lastReplyId = input.replyId;
    const action = this.selectAction(input.emotion, input.replyText);
    if (this.isBlocked(input)) {
      this.pending = action;
      return undefined;
    }
    this.pending = undefined;
    return action ? this.authorize(action) : undefined;
  }

  flush(priority: PetReactionPriority): PetAction | undefined {
    if (this.isBlocked(priority) || !this.pending) return undefined;
    const action = this.pending;
    this.pending = undefined;
    return this.authorize(action);
  }

  private selectAction(emotion: PetEmotion, text: string): PetAction | undefined {
    if (emotion === "comforting") return this.pick(["comfort", "nod"]);
    if (emotion === "shy") return this.pick(["shy", "head-tilt"]);
    if (emotion === "excited") return this.pick(["cheer", "jump", "dance"]);
    if (emotion === "surprised") return "surprised";
    if (emotion === "sleepy") return this.pick(["stretch", "sleep"]);

    if (/你好|嗨|早上好|下午好|晚上好|欢迎/.test(text)) return "wave";
    if (/^(对|是的|没错|好的|可以|当然|嗯)[，,。.!！\s]/.test(text)) return "nod";
    if (/^(不|不要|并非|没有|抱歉)[，,。.!！\s]/.test(text)) return "shake-head";

    if (emotion === "curious") return this.pick(["head-tilt", "nod", "sit"]);
    if (emotion === "thinking") return this.pick(["nod", "head-tilt", "sit"]);
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
}
