import { randomUUID } from "node:crypto";
import type { ChatResponse, HeartbeatEvent, HeartbeatResult, HeartbeatThought } from "../common/types";
import { AgentService } from "./agent-service";
import { MemoryEngine } from "./memory/memory-engine";
import { MemoryRepository } from "./memory/memory-repository";
import { PersonalityEngine } from "./personality/personality-engine";
import { SettingsStore } from "./settings-store";
import { DesktopAwarenessService, type DesktopAwarenessSnapshot } from "./desktop-awareness-service";
import { RelationshipEngine } from "./relationship/relationship-engine";
import { jaccard } from "./memory/memory-utils";

type ProactiveListener = (response: ChatResponse) => void;

export class HeartbeatService {
  private timer?: NodeJS.Timeout;
  private awarenessTimer?: NodeJS.Timeout;
  private running?: Promise<HeartbeatResult>;
  private runningReason?: HeartbeatEvent["reason"];
  private queuedManual?: Promise<HeartbeatResult>;
  private awarenessPulse?: Promise<void>;
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
    if (this.awarenessTimer) clearInterval(this.awarenessTimer);
    this.timer = undefined;
    this.awarenessTimer = undefined;
    const settings = this.settingsStore.get().heartbeat;
    if (!settings.enabled) return;
    this.timer = setInterval(() => {
      void this.run("scheduled").catch((error) => console.error("Scheduled heartbeat failed", error));
    }, settings.intervalMinutes * 60_000);
    this.timer.unref();
    const awareness = this.settingsStore.get().awareness;
    if (awareness.processDetectionEnabled) {
      this.awarenessTimer = setInterval(() => {
        void this.pollForActivityChange().catch((error) => console.error("Awareness heartbeat pulse failed", error));
      }, awareness.processPollMinutes * 60_000);
      this.awarenessTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.awarenessTimer) clearInterval(this.awarenessTimer);
    this.timer = undefined;
    this.awarenessTimer = undefined;
  }

  async recordInteraction(): Promise<void> {
    await this.repository.setMeta({ lastInteractionAt: new Date().toISOString() });
  }

  run(
    reason: HeartbeatEvent["reason"],
    forceProactive = reason === "manual",
    awarenessSnapshot?: DesktopAwarenessSnapshot,
  ): Promise<HeartbeatResult> {
    if (this.running) {
      if (reason !== "manual" || this.runningReason === "manual") return this.running;
      if (!this.queuedManual) {
        const current = this.running;
        this.queuedManual = current.catch(() => undefined).then(() => this.run("manual", true)).finally(() => {
          this.queuedManual = undefined;
        });
      }
      return this.queuedManual;
    }
    this.runningReason = reason;
    this.running = this.performRun(reason, forceProactive, awarenessSnapshot).finally(() => {
      this.running = undefined;
      this.runningReason = undefined;
    });
    return this.running;
  }

  private async performRun(
    reason: HeartbeatEvent["reason"],
    forceProactive: boolean,
    awarenessSnapshot?: DesktopAwarenessSnapshot,
  ): Promise<HeartbeatResult> {
    const settings = this.settingsStore.get().heartbeat;
    if (!this.repository.getMeta().firstHeartbeatAt) {
      await this.repository.setMeta({ firstHeartbeatAt: new Date().toISOString() });
    }
    const proactiveDecision = this.proactiveDecision(forceProactive);
    const includeScreen = reason === "manual" || (reason === "scheduled" && proactiveDecision.allowed);
    const awareness = awarenessSnapshot ?? await this.awareness.observe(reason, { includeScreen });
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
        awareness.applications.map((item) => ({
          kind: item.kind,
          label: item.label,
          newlyStarted: item.newlyStarted,
        })),
      );
    }
    if (relationshipUpdates > 0) this.relationshipListener?.();
    const pendingCount = pendingMemories.length;
    let consolidatedToL3 = 0;
    if (pendingCount >= settings.consolidateAfterItems || (reason === "manual" && pendingCount > 0)) {
      consolidatedToL3 = await this.memory.consolidate((records) => this.agent.extractLongTerm(records));
    }
    const previousThought = this.repository.getRecentHeartbeats(1)[0]?.thought;
    const proposedThought = await this.agent.createHeartbeatThought({
      reason,
      memoryReview: [
        this.memory.reviewSummary(),
        `对自己的认识：${this.personality.getProfile().summary}`,
        `对用户与关系的理解：${this.relationship.getProfile().summary}`,
        previousThought
          ? `上次心跳留下的陪伴重点：${previousThought.relationshipFocus}；当时选择：${previousThought.reason}`
          : "这是首次形成连续的心跳陪伴重点。",
      ].join("\n"),
      canReachOut: proactiveDecision.allowed,
      proactivePolicyReason: proactiveDecision.reason,
      awareness,
      awarenessPrompt: this.awareness.promptText(awareness),
    });
    const repeatedTopic = reason === "manual" || !proposedThought.shouldReachOut
      ? undefined
      : this.repeatedTopicReason(proposedThought.proactiveTopic);
    const thought: HeartbeatThought = repeatedTopic
      ? {
        ...proposedThought,
        shouldReachOut: false,
        proactiveTopic: undefined,
        reason: repeatedTopic,
      }
      : proposedThought;
    let proactiveMessage: string | undefined;
    if (proactiveDecision.allowed && thought.shouldReachOut) {
      const response = await this.agent.createHeartbeatProactiveMessage(thought);
      proactiveMessage = response.text;
      const topicForHistory = awareness.screenSharedWithProvider
        ? "基于一次性屏幕情境的轻量关心"
        : thought.proactiveTopic ?? "心跳主动陪伴";
      await this.relationship.recordProactiveTopic(topicForHistory).catch((error) => {
        console.warn("Proactive topic history failed", error);
      });
      await this.repository.setMeta({ lastProactiveAt: new Date().toISOString() });
      this.proactiveListener?.(response);
    }
    const auditableThought = awareness.screenSharedWithProvider ? this.screenSafeThought(thought) : thought;
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
    const relationship = this.relationship.getProfile();
    const initiative = relationship.careStyle.initiativeAffinity;
    const latestTopic = relationship.recentProactiveTopics.at(-1);
    const dismissedRecently = latestTopic?.feedback === "dismissed"
      && now.getTime() - Date.parse(latestTopic.feedbackAt ?? latestTopic.offeredAt) < 24 * 60 * 60_000;
    const idleFactor = dismissedRecently ? 1.8 : initiative < 0.35 ? 1.5 : initiative > 0.72 ? 0.8 : 1;
    const cooldownFactor = dismissedRecently ? 2 : initiative < 0.35 ? 1.4 : 1;
    const baseline = meta.lastInteractionAt ?? meta.firstHeartbeatAt;
    const lastInteraction = baseline ? Date.parse(baseline) : now.getTime();
    if (now.getTime() - lastInteraction < settings.idleMinutesBeforeChat * idleFactor * 60_000) {
      return { allowed: false, reason: "用户尚未空闲到主动聊天阈值" };
    }
    const lastProactive = meta.lastProactiveAt ? Date.parse(meta.lastProactiveAt) : 0;
    if (now.getTime() - lastProactive < settings.proactiveCooldownMinutes * cooldownFactor * 60_000) {
      return { allowed: false, reason: dismissedRecently ? "用户最近拒绝过主动话题，延长安静时间" : "主动聊天仍在冷却期" };
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
      selfReflection: `我是住在桌面上的宠物；本轮使用独立识图端点的一次性受限观察判断是否适合靠近，图片和视觉正文都没有进入记忆。${personalitySummary}`.slice(0, 180),
      userUnderstanding: relationshipSummary.slice(0, 180),
      relationshipFocus: "只把画面当作当下的低置信情境，不据此给用户贴标签；关心时保持试探并允许纠正。",
      shouldReachOut: thought.shouldReachOut,
      proactiveTopic: thought.shouldReachOut ? "基于一次性桌面情境提供轻量、可拒绝的关心" : undefined,
      reason: thought.shouldReachOut
        ? "一次性桌面情境提示本轮可能存在合适的关心机会"
        : "综合一次性桌面情境后选择不打扰；具体画面没有写入审计",
    };
  }

  private repeatedTopicReason(topic: string | undefined): string | undefined {
    const value = topic?.trim();
    if (!value) return undefined;
    const now = Date.now();
    const repeated = this.relationship.getProfile().recentProactiveTopics.some((item) => {
      const age = now - Date.parse(item.offeredAt);
      const windowMs = item.feedback === "dismissed" ? 72 * 60 * 60_000 : 24 * 60 * 60_000;
      return age >= 0 && age <= windowMs && jaccard(value, item.topic) >= 0.56;
    });
    return repeated ? "近期已经主动提过相似话题，这次选择安静等待新的进展" : undefined;
  }

  private pollForActivityChange(): Promise<void> {
    if (this.awarenessPulse) return this.awarenessPulse;
    this.awarenessPulse = (async () => {
      if (this.running || !this.settingsStore.get().heartbeat.enabled) return;
      const processSnapshot = await this.awareness.observe("scheduled", { includeScreen: false });
      if (!processSnapshot.processScanCompleted || !processSnapshot.applications.some((item) => item.newlyStarted)) return;
      let combined = processSnapshot;
      if (
        this.settingsStore.get().awareness.screenCaptureEnabled
        && this.proactiveDecision(false).allowed
      ) {
        const visualSnapshot = await this.awareness.observe("scheduled", { includeProcess: false });
        combined = {
          ...processSnapshot,
          capturedAt: visualSnapshot.capturedAt,
          screenCaptureAttempted: visualSnapshot.screenCaptureAttempted,
          screenSharedWithProvider: visualSnapshot.screenSharedWithProvider,
          screenStatus: visualSnapshot.screenStatus,
          screenCaptureError: visualSnapshot.screenCaptureError,
          visionAnalysis: visualSnapshot.visionAnalysis,
        };
      }
      await this.run("scheduled", false, combined);
    })().finally(() => {
      this.awarenessPulse = undefined;
    });
    return this.awarenessPulse;
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
