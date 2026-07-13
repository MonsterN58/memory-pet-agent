import { randomUUID } from "node:crypto";
import type { ChatResponse, HeartbeatEvent, HeartbeatResult } from "../common/types";
import { AgentService } from "./agent-service";
import { MemoryEngine } from "./memory/memory-engine";
import { MemoryRepository } from "./memory/memory-repository";
import { PersonalityEngine } from "./personality/personality-engine";
import { SettingsStore } from "./settings-store";

type ProactiveListener = (response: ChatResponse) => void;

export class HeartbeatService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<HeartbeatResult>;
  private proactiveListener?: ProactiveListener;
  private personalityListener?: () => void;

  constructor(
    private readonly memory: MemoryEngine,
    private readonly repository: MemoryRepository,
    private readonly agent: AgentService,
    private readonly settingsStore: SettingsStore,
    private readonly personality: PersonalityEngine,
  ) {}

  start(listener: ProactiveListener, personalityListener?: () => void): void {
    this.proactiveListener = listener;
    this.personalityListener = personalityListener;
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
    const movedToL2 = await this.memory.flushL1(reason === "manual");
    const pendingMemories = this.repository.getL2();
    const personalityUpdates = await this.personality.reviewMemories(
      pendingMemories,
      (records, profile) => this.agent.extractPersonalitySignals(records, profile.summary),
    );
    if (personalityUpdates > 0) this.personalityListener?.();
    const pendingCount = pendingMemories.length;
    let consolidatedToL3 = 0;
    if (pendingCount >= settings.consolidateAfterItems || (reason === "manual" && pendingCount > 0)) {
      consolidatedToL3 = await this.memory.consolidate((records) => this.agent.extractLongTerm(records));
    }
    const reflection = await this.agent.createReflection(
      `${this.memory.reviewSummary()}\n人格成长：${this.personality.getProfile().summary}`,
    );
    const proactiveDecision = this.proactiveDecision(forceProactive);
    let proactiveMessage: string | undefined;
    if (proactiveDecision.allowed) {
      const response = await this.agent.createProactiveMessage();
      proactiveMessage = response.text;
      await this.repository.setMeta({ lastProactiveAt: new Date().toISOString() });
      this.proactiveListener?.(response);
    }
    const event: HeartbeatEvent = {
      id: randomUUID(),
      reason,
      createdAt: new Date().toISOString(),
      movedToL2,
      consolidatedToL3,
      reflection,
      personalityUpdates,
      proactiveMessage,
      skippedProactiveReason: proactiveDecision.allowed ? undefined : proactiveDecision.reason,
    };
    await this.repository.recordHeartbeat(event);
    return { event, snapshot: this.memory.snapshot(), personality: this.personality.getProfile() };
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

  private isQuietHour(hour: number, start: number, end: number): boolean {
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  private localDateKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }
}
