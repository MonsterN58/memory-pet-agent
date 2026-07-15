import { randomUUID } from "node:crypto";
import type { ChatResponse, HeartbeatEvent, HeartbeatResult, HeartbeatThought } from "../common/types";
import { AgentService } from "./agent-service";
import { MemoryEngine } from "./memory/memory-engine";
import { MemoryRepository } from "./memory/memory-repository";
import { PersonalityEngine } from "./personality/personality-engine";
import { SettingsStore } from "./settings-store";
import { DesktopAwarenessService } from "./desktop-awareness-service";
import { RelationshipEngine } from "./relationship/relationship-engine";

type ProactiveListener = (response: ChatResponse) => void;

export class HeartbeatService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<HeartbeatResult>;
  private proactiveListener?: ProactiveListener;
  private personalityListener?: () => void;
  private relationshipListener?: () => void;

  constructor(
    private readonly memory: MemoryEngine,
    private readonly repository: MemoryRepository,
    private readonly agent: AgentService,
    private readonly settingsStore: SettingsStore,
    private readonly personality: PersonalityEngine,
    private readonly relationship: RelationshipEngine,
    private readonly awareness: DesktopAwarenessService,
  ) {}

  start(listener: ProactiveListener, personalityListener?: () => void, relationshipListener?: () => void): void {
    this.proactiveListener = listener;
    this.personalityListener = personalityListener;
    this.relationshipListener = relationshipListener;
    this.restartTimer();
    void this.run("startup").catch((error) => console.error("Startup heartbeat failed", error));
  }

  restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    const settings = this.settingsStore.get().heartbeat;
    if (!settings.enabled) return;
    this.timer = setInterval(() => {
      void this.run("scheduled").catch((error) => console.error("Scheduled heartbeat failed", error));
    }, settings.intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async recordInteraction(): Promise<void> {
    await this.repository.setMeta({ lastInteractionAt: new Date().toISOString() });
  }

  run(reason: HeartbeatEvent["reason"], forceProactive = reason === "manual"): Promise<HeartbeatResult> {
    if (this.running) return this.running;
    this.running = this.performRun(reason, forceProactive).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async performRun(
    reason: HeartbeatEvent["reason"],
    forceProactive: boolean,
  ): Promise<HeartbeatResult> {
    const settings = this.settingsStore.get().heartbeat;
    const awareness = await this.awareness.observe(reason);
    const movedToL2 = await this.memory.flushL1(reason === "manual");
    const pendingMemories = this.repository.getL2();
    const personalityUpdates = await this.personality.reviewMemories(
      pendingMemories,
      (records, profile) => this.agent.extractPersonalitySignals(records, profile.summary),
    );
    if (personalityUpdates > 0) this.personalityListener?.();
    let relationshipUpdates = await this.relationship.reviewMemories(
      pendingMemories,
      (records, profile) => this.agent.extractRelationshipSignals(records, profile),
    );
    if (awareness.processScanCompleted && awareness.applications.length) {
      relationshipUpdates += await this.relationship.observeDesktopActivities(
        awareness.applications.map((item) => ({ kind: item.kind, label: item.label })),
      );
    }
    if (relationshipUpdates > 0) this.relationshipListener?.();
    const pendingCount = pendingMemories.length;
    let consolidatedToL3 = 0;
    if (pendingCount >= settings.consolidateAfterItems || (reason === "manual" && pendingCount > 0)) {
      consolidatedToL3 = await this.memory.consolidate((records) => this.agent.extractLongTerm(records));
    }
    const proactiveDecision = this.proactiveDecision(forceProactive);
    const thought = await this.agent.createHeartbeatThought({
      reason,
      memoryReview: [
        this.memory.reviewSummary(),
        `对自己的认识：${this.personality.getProfile().summary}`,
        `对用户与关系的理解：${this.relationship.getProfile().summary}`,
      ].join("\n"),
      canReachOut: proactiveDecision.allowed,
      proactivePolicyReason: proactiveDecision.reason,
      awareness,
      awarenessPrompt: this.awareness.promptText(awareness),
    });
    let proactiveMessage: string | undefined;
    if (proactiveDecision.allowed && thought.shouldReachOut) {
      const response = await this.agent.createHeartbeatProactiveMessage(thought);
      proactiveMessage = response.text;
      const topicForHistory = awareness.screen
        ? "基于一次性屏幕情境的轻量关心"
        : thought.proactiveTopic ?? "心跳主动陪伴";
      await this.relationship.recordProactiveTopic(topicForHistory).catch((error) => {
        console.warn("Proactive topic history failed", error);
      });
      await this.repository.setMeta({ lastProactiveAt: new Date().toISOString() });
      this.proactiveListener?.(response);
    }
    const auditableThought = awareness.screen ? this.screenSafeThought(thought) : thought;
    const event: HeartbeatEvent = {
      id: randomUUID(),
      reason,
      createdAt: new Date().toISOString(),
      movedToL2,
      consolidatedToL3,
      reflection: auditableThought.selfReflection,
      personalityUpdates,
      relationshipUpdates,
      thought: auditableThought,
      awareness: this.awareness.auditSummary(awareness),
      proactiveMessage,
      skippedProactiveReason: proactiveMessage
        ? undefined
        : proactiveDecision.allowed ? auditableThought.reason : proactiveDecision.reason,
    };
    await this.repository.recordHeartbeat(event);
    return {
      event,
      snapshot: this.memory.snapshot(),
      personality: this.personality.getProfile(),
      relationship: this.relationship.getProfile(),
    };
  }

  private proactiveDecision(force: boolean): { allowed: boolean; reason?: string } {
    const settings = this.settingsStore.get().heartbeat;
    if (!settings.proactiveEnabled) return { allowed: false, reason: "主动聊天已关闭" };
    if (force) return { allowed: true };
    const now = new Date();
    if (this.isQuietHour(now.getHours(), settings.quietHoursStart, settings.quietHoursEnd)) {
      return { allowed: false, reason: "当前处于安静时段" };
    }
    const meta = this.repository.getMeta();
    const lastInteraction = meta.lastInteractionAt ? Date.parse(meta.lastInteractionAt) : now.getTime();
    if (now.getTime() - lastInteraction < settings.idleMinutesBeforeChat * 60_000) {
      return { allowed: false, reason: "用户尚未空闲到主动聊天阈值" };
    }
    const lastProactive = meta.lastProactiveAt ? Date.parse(meta.lastProactiveAt) : 0;
    if (now.getTime() - lastProactive < settings.proactiveCooldownMinutes * 60_000) {
      return { allowed: false, reason: "主动聊天仍在冷却期" };
    }
    const today = this.localDateKey(now);
    const todayCount = this.repository
      .getRecentHeartbeats(200)
      .filter((event) => event.proactiveMessage && this.localDateKey(new Date(event.createdAt)) === today).length;
    if (todayCount >= settings.proactiveDailyLimit) {
      return { allowed: false, reason: "已达到今日主动聊天上限" };
    }
    return { allowed: true };
  }

  private screenSafeThought(thought: HeartbeatThought): HeartbeatThought {
    const personalitySummary = this.personality.getProfile().summary;
    const relationshipSummary = this.relationship.getProfile().summary;
    return {
      selfReflection: `我是住在桌面上的宠物；本轮用一次性画面判断是否适合靠近，画面本身没有进入记忆。${personalitySummary}`.slice(0, 180),
      userUnderstanding: relationshipSummary.slice(0, 180),
      relationshipFocus: "只把画面当作当下的低置信情境，不据此给用户贴标签；关心时保持试探并允许纠正。",
      shouldReachOut: thought.shouldReachOut,
      proactiveTopic: thought.shouldReachOut ? "基于一次性桌面情境提供轻量、可拒绝的关心" : undefined,
      reason: thought.shouldReachOut
        ? "一次性桌面情境提示本轮可能存在合适的关心机会"
        : "综合一次性桌面情境后选择不打扰；具体画面没有写入审计",
    };
  }

  private isQuietHour(hour: number, start: number, end: number): boolean {
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  private localDateKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }
}
