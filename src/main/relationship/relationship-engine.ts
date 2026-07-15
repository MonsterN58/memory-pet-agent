import { randomUUID } from "node:crypto";
import type {
  DesktopActivityKind,
  MemoryRecord,
  ProactiveTopicFeedback,
  RelationshipInsightKind,
  RelationshipProfile,
} from "../../common/types";
import { clamp, summarizeText } from "../memory/memory-utils";
import { RelationshipStore } from "./relationship-store";

export interface RelationshipSignal {
  kind: RelationshipInsightKind;
  topic: string;
  summary: string;
  confidence: number;
  sourceIds: string[];
}

export interface ObservedDesktopActivity {
  kind: DesktopActivityKind;
  label: string;
}

export type RelationshipAnalyzer = (
  records: MemoryRecord[],
  profile: RelationshipProfile,
) => Promise<RelationshipSignal[] | undefined>;

const INSIGHT_KINDS = new Set<RelationshipInsightKind>([
  "identity", "preference", "goal", "routine", "interest", "concern", "work-style", "support-style",
]);

export class RelationshipEngine {
  private reviewedMemoryIds = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly store: RelationshipStore) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.reviewedMemoryIds = new Set(this.store.getReviewedMemoryIds());
  }

  getProfile(): RelationshipProfile {
    return this.store.getProfile();
  }

  async observeUserTurn(text: string): Promise<number> {
    return this.enqueue(async () => {
      const value = text.trim();
      if (!value) return 0;
      const profile = this.store.getProfile();
      profile.interactionCount += 1;
      let updates = this.applyCareEvidence(profile, value);
      updates += this.resolveLatestProactiveFeedback(profile, value);
      const directSignal = supportStyleSignal(value);
      if (directSignal) {
        this.applySignals(profile, [{ ...directSignal, sourceIds: [] }]);
        updates += 1;
      }
      this.refreshProfile(profile);
      await this.store.save(profile, this.reviewedMemoryIds);
      return updates;
    });
  }

  async reviewMemories(records: MemoryRecord[], analyzer?: RelationshipAnalyzer): Promise<number> {
    return this.enqueue(async () => {
      const fresh = records.filter((record) => !this.reviewedMemoryIds.has(record.id)).slice(0, 40);
      if (!fresh.length) return 0;
      const profile = this.store.getProfile();
      let signals: RelationshipSignal[] | undefined;
      if (analyzer) {
        try {
          signals = await analyzer(fresh, profile);
        } catch {
          signals = undefined;
        }
      }
      if (!signals?.length) signals = this.localSignals(fresh);
      const valid = signals.filter(validSignal).slice(0, 30);
      this.applySignals(profile, valid);
      const moments = this.captureSharedMoments(profile, fresh);
      fresh.forEach((record) => this.reviewedMemoryIds.add(record.id));
      this.refreshProfile(profile);
      await this.store.save(profile, this.reviewedMemoryIds);
      return valid.length + moments;
    });
  }

  async observeDesktopActivities(activities: ObservedDesktopActivity[]): Promise<number> {
    return this.enqueue(async () => {
      const unique = new Map(activities.map((item) => [item.kind, item]));
      if (!unique.size) return 0;
      const profile = this.store.getProfile();
      const now = new Date().toISOString();
      for (const activity of unique.values()) {
        const current = profile.activityPatterns.find((item) => item.activity === activity.kind);
        if (current) {
          current.observations += 1;
          current.confidence = clamp(0.25 + current.observations * 0.13, 0, 0.94);
          current.label = activity.label.slice(0, 40);
          current.lastSeenAt = now;
        } else {
          profile.activityPatterns.push({
            activity: activity.kind,
            label: activity.label.slice(0, 40),
            observations: 1,
            confidence: 0.38,
            firstSeenAt: now,
            lastSeenAt: now,
          });
        }
      }
      profile.activityPatterns = profile.activityPatterns
        .sort((left, right) => right.observations - left.observations || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
        .slice(0, 12);
      this.refreshProfile(profile);
      await this.store.save(profile, this.reviewedMemoryIds);
      return unique.size;
    });
  }

  async recordProactiveTopic(topic: string): Promise<void> {
    await this.enqueue(async () => {
      const value = summarizeText(topic, 150);
      if (!value) return;
      const profile = this.store.getProfile();
      const now = new Date().toISOString();
      for (const entry of profile.recentProactiveTopics) {
        if (entry.feedback === "pending") {
          entry.feedback = "neutral";
          entry.feedbackAt = now;
        }
      }
      profile.recentProactiveTopics.push({
        id: randomUUID(),
        topic: value,
        offeredAt: now,
        feedback: "pending",
      });
      profile.recentProactiveTopics = profile.recentProactiveTopics.slice(-24);
      profile.updatedAt = now;
      await this.store.save(profile, this.reviewedMemoryIds);
    });
  }

  async reset(): Promise<RelationshipProfile> {
    return this.enqueue(async () => {
      this.reviewedMemoryIds.clear();
      return this.store.reset();
    });
  }

  contextForPrompt(): string {
    const profile = this.store.getProfile();
    const insights = profile.insights
      .filter((item) => item.confidence >= 0.55 || item.evidenceCount >= 2)
      .sort((left, right) => right.confidence - left.confidence || right.evidenceCount - left.evidenceCount)
      .slice(0, 8);
    const activities = profile.activityPatterns
      .filter((item) => item.observations >= 3 && item.confidence >= 0.55)
      .slice(0, 4);
    const moments = profile.sharedMoments.slice(-3);
    return [
      `关系阶段：${profile.stage}；累计互动：${profile.interactionCount}。`,
      `关系摘要：${profile.summary}`,
      "以下是可修正的用户理解，只能自然影响回应，不能逐条背诵或当作永久标签：",
      ...(insights.length
        ? insights.map((item) => `- [${item.kind}] ${item.summary}（置信 ${item.confidence.toFixed(2)}，证据 ${item.evidenceCount}）`)
        : ["- 目前没有足够稳定的用户理解，优先倾听而不是猜测。"]),
      ...(activities.length
        ? ["本机进程信号形成的粗粒度活动习惯：", ...activities.map((item) => `- ${item.label}（观察 ${item.observations} 次）`)]
        : []),
      ...(moments.length
        ? ["共同经历的片段：", ...moments.map((item) => `- ${item.summary}`)]
        : []),
      `关心方式：主动接近 ${profile.careStyle.initiativeAffinity.toFixed(2)}；实际帮忙 ${profile.careStyle.practicalHelpAffinity.toFixed(2)}；安静陪伴 ${profile.careStyle.quietCompanionshipAffinity.toFixed(2)}。`,
    ].join("\n");
  }

  private applySignals(profile: RelationshipProfile, signals: RelationshipSignal[]): void {
    const now = new Date().toISOString();
    for (const signal of signals.filter(validSignal)) {
      const topicKey = normalizeTopic(signal.topic);
      const existing = profile.insights.find(
        (item) => item.kind === signal.kind && normalizeTopic(item.topic) === topicKey,
      );
      if (!existing) {
        profile.insights.push({
          id: randomUUID(),
          kind: signal.kind,
          topic: signal.topic.trim().slice(0, 80),
          summary: signal.summary.trim().slice(0, 240),
          confidence: clamp(signal.confidence * 0.86),
          evidenceCount: 1,
          sourceIds: [...new Set(signal.sourceIds)].slice(-80),
          createdAt: now,
          updatedAt: now,
        });
        continue;
      }
      const contradicts = polarity(existing.summary) !== 0
        && polarity(signal.summary) !== 0
        && polarity(existing.summary) !== polarity(signal.summary);
      existing.evidenceCount += 1;
      existing.summary = signal.summary.trim().slice(0, 240);
      existing.confidence = contradicts
        ? clamp(signal.confidence * 0.82)
        : clamp(existing.confidence * 0.7 + signal.confidence * 0.3 + 0.055);
      existing.sourceIds = [...new Set([...existing.sourceIds, ...signal.sourceIds])].slice(-80);
      existing.updatedAt = now;
    }
    profile.insights = profile.insights
      .sort((left, right) => right.confidence - left.confidence || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 60);
  }

  private localSignals(records: MemoryRecord[]): RelationshipSignal[] {
    const signals: RelationshipSignal[] = [];
    for (const record of records) {
      const userTexts = userTextsFromRecord(record);
      for (const text of userTexts) {
        const definitions: Array<{ kind: RelationshipInsightKind; pattern: RegExp; confidence: number }> = [
          { kind: "support-style", pattern: /(先别给我建议|不想听建议|陪我(?:待着|聊聊|一会儿)|提醒我|主动问我|别主动|不要打扰)/, confidence: 0.86 },
          { kind: "preference", pattern: /(?:我)?(?:喜欢|偏爱|讨厌|不喜欢|更喜欢)([^。！？\n]{1,42})/, confidence: 0.8 },
          { kind: "goal", pattern: /(?:我)?(?:正在|准备|计划|打算|希望|想要)([^。！？\n]{2,58})/, confidence: 0.72 },
          { kind: "routine", pattern: /(?:我)?(?:通常|经常|每天|每周|习惯于?|总会)([^。！？\n]{2,48})/, confidence: 0.7 },
          { kind: "interest", pattern: /(?:我)?(?:对|最近在关注)([^。！？\n]{1,42})(?:感兴趣|很关注|有兴趣)?/, confidence: 0.66 },
          { kind: "concern", pattern: /(?:我)?(?:担心|焦虑|害怕|压力(?:来自|是)?)([^。！？\n]{1,52})/, confidence: 0.7 },
          { kind: "identity", pattern: /(?:我叫|我是|我在|我住在|我的工作是|我学的是)([^。！？\n]{1,48})/, confidence: 0.78 },
          { kind: "work-style", pattern: /(?:我)?(?:做事|工作|学习时)([^。！？\n]{2,52})/, confidence: 0.68 },
        ];
        let added = 0;
        for (const definition of definitions) {
          const match = text.match(definition.pattern);
          if (!match) continue;
          const topic = summarizeText(match[1] || match[0], 52).replace(/^[，,:：\s]+/, "");
          if (!topic) continue;
          signals.push({
            kind: definition.kind,
            topic,
            summary: summarizeText(text, 180),
            confidence: definition.confidence,
            sourceIds: [record.id],
          });
          added += 1;
          if (added >= 2) break;
        }
      }
    }
    return signals;
  }

  private captureSharedMoments(profile: RelationshipProfile, records: MemoryRecord[]): number {
    let added = 0;
    for (const record of records) {
      if (record.kind !== "episode" || record.importance < 0.72) continue;
      if (!/用户：/.test(record.content) || !/桌宠：/.test(record.content)) continue;
      if (profile.sharedMoments.some((item) => item.sourceIds.includes(record.id))) continue;
      profile.sharedMoments.push({
        id: randomUUID(),
        summary: summarizeText(record.summary || record.content, 190),
        importance: record.importance,
        sourceIds: [record.id],
        happenedAt: record.createdAt,
        createdAt: new Date().toISOString(),
      });
      added += 1;
    }
    profile.sharedMoments = profile.sharedMoments
      .sort((left, right) => right.importance - left.importance || Date.parse(right.happenedAt) - Date.parse(left.happenedAt))
      .slice(0, 16);
    return added;
  }

  private applyCareEvidence(profile: RelationshipProfile, text: string): number {
    const care = profile.careStyle;
    let updates = 0;
    const shift = (field: "initiativeAffinity" | "practicalHelpAffinity" | "quietCompanionshipAffinity", amount: number) => {
      care[field] = clamp(care[field] + amount);
      updates += 1;
    };
    if (/主动|提醒我|记得问我|可以来找我|多关心/.test(text)) shift("initiativeAffinity", 0.08);
    if (/别主动|不要打扰|别提醒|等我找你|安静点/.test(text)) shift("initiativeAffinity", -0.13);
    if (/帮我做|给我方案|想想办法|一起解决|实际一点/.test(text)) shift("practicalHelpAffinity", 0.08);
    if (/先别给.*建议|不想听.*建议|不用解决/.test(text)) shift("practicalHelpAffinity", -0.1);
    if (/陪我|听我说|待一会|安静陪/.test(text)) shift("quietCompanionshipAffinity", 0.1);
    if (updates) {
      care.evidenceCount += updates;
      care.updatedAt = new Date().toISOString();
    }
    return updates;
  }

  private resolveLatestProactiveFeedback(profile: RelationshipProfile, text: string): number {
    const latest = [...profile.recentProactiveTopics].reverse().find((item) => item.feedback === "pending");
    if (!latest) return 0;
    const age = Date.now() - Date.parse(latest.offeredAt);
    const feedback: ProactiveTopicFeedback = age > 12 * 60 * 60_000
      ? "neutral"
      : /别问|别管|不用|不要打扰|烦|先不聊|闭嘴/.test(text)
        ? "dismissed"
        : /谢谢|好呀|可以|正好|想聊|帮我|你还记得|嗯嗯|陪我/.test(text)
          ? "welcomed"
          : "neutral";
    latest.feedback = feedback;
    latest.feedbackAt = new Date().toISOString();
    if (feedback === "welcomed") profile.careStyle.initiativeAffinity = clamp(profile.careStyle.initiativeAffinity + 0.07);
    if (feedback === "dismissed") profile.careStyle.initiativeAffinity = clamp(profile.careStyle.initiativeAffinity - 0.14);
    if (feedback !== "neutral") {
      profile.careStyle.evidenceCount += 1;
      profile.careStyle.updatedAt = latest.feedbackAt;
    }
    return 1;
  }

  private refreshProfile(profile: RelationshipProfile): void {
    const stable = profile.insights.filter((item) => item.confidence >= 0.55 || item.evidenceCount >= 2);
    const patterns = profile.activityPatterns.filter((item) => item.observations >= 3 && item.confidence >= 0.55);
    if (profile.interactionCount >= 40 && stable.length >= 6 && profile.sharedMoments.length >= 3) profile.stage = "companion";
    else if (profile.interactionCount >= 15 && stable.length >= 3) profile.stage = "familiar";
    else if (profile.interactionCount >= 3 || stable.length >= 1) profile.stage = "acquainted";
    else profile.stage = "new";
    const insights = stable.slice(0, 3).map((item) => item.summary);
    const activity = patterns.slice(0, 2).map((item) => item.label);
    if (!insights.length && !activity.length) {
      profile.summary = profile.interactionCount
        ? `已经有 ${profile.interactionCount} 次互动，但我仍在谨慎确认你的习惯和需要。`
        : "彼此还在初识，我会从真实互动中慢慢了解你，而不是先替你下定义。";
    } else {
      profile.summary = [
        insights.length ? `我逐渐记住了：${insights.join("；")}` : "",
        activity.length ? `常见的桌面活动有：${activity.join("、")}` : "",
      ].filter(Boolean).join("。") + "。这些理解会接受你之后的纠正。";
    }
    profile.updatedAt = new Date().toISOString();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function userTextsFromRecord(record: MemoryRecord): string[] {
  const dialogue = [...record.content.matchAll(/用户：([^\n]+)/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (dialogue.length) return dialogue;
  if (record.tags.includes("user-confirmed") && !/用户从(?:网页|文件|剪贴板)/.test(record.content)) {
    return [record.content.trim()];
  }
  return [];
}

function supportStyleSignal(text: string): Omit<RelationshipSignal, "sourceIds"> | undefined {
  const match = text.match(/(先别给我建议|不想听建议|陪我(?:待着|聊聊|一会儿)|提醒我|主动问我|别主动|不要打扰)/);
  if (!match) return undefined;
  return {
    kind: "support-style",
    topic: "关心方式",
    summary: summarizeText(text, 180),
    confidence: 0.86,
  };
}

function validSignal(signal: RelationshipSignal): boolean {
  return INSIGHT_KINDS.has(signal.kind)
    && typeof signal.topic === "string"
    && Boolean(signal.topic.trim())
    && typeof signal.summary === "string"
    && Boolean(signal.summary.trim())
    && Number.isFinite(signal.confidence)
    && signal.confidence > 0
    && Array.isArray(signal.sourceIds);
}

function normalizeTopic(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、,.!?：:；;“”"'（）()\-]/g, "").slice(0, 80);
}

function polarity(value: string): -1 | 0 | 1 {
  if (/不喜欢|讨厌|不要|不想|别|避免/.test(value)) return -1;
  if (/喜欢|希望|想要|偏爱|需要|习惯/.test(value)) return 1;
  return 0;
}
