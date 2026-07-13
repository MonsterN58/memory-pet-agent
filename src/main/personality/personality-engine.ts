import type {
  AgentSettings,
  MemoryRecord,
  PersonalityDimension,
  PersonalityProfile,
  PersonalityTraitState,
} from "../../common/types";
import { clamp, summarizeText } from "../memory/memory-utils";
import { PersonalityStore } from "./personality-store";

export interface PersonalitySignal {
  dimension: PersonalityDimension;
  direction: -1 | 1;
  weight: number;
  evidence: string;
}

export type PersonalityAnalyzer = (
  records: MemoryRecord[],
  profile: PersonalityProfile,
) => Promise<PersonalitySignal[] | undefined>;

const DIMENSION_ORDER: PersonalityDimension[] = [
  "warmth", "curiosity", "playfulness", "directness", "initiative", "expressiveness",
];

const DIMENSION_LABELS: Record<PersonalityDimension, { high: string; low: string }> = {
  warmth: { high: "温暖亲近", low: "冷静克制" },
  curiosity: { high: "好奇探索", low: "专注稳重" },
  playfulness: { high: "轻松俏皮", low: "认真严肃" },
  directness: { high: "直接明确", low: "委婉舒缓" },
  initiative: { high: "积极主动", low: "安静等待" },
  expressiveness: { high: "表达丰富", low: "简洁凝练" },
};

export class PersonalityEngine {
  private reviewedMemoryIds = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: PersonalityStore,
    private readonly getSettings: () => AgentSettings,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.reviewedMemoryIds = new Set(this.store.getReviewedMemoryIds());
  }

  getProfile(): PersonalityProfile {
    return this.store.getProfile();
  }

  async observeDialogue(userText: string): Promise<number> {
    return this.enqueue(async () => {
      const settings = this.getSettings().personality;
      if (!settings.learningEnabled) return 0;
      const profile = this.store.getProfile();
      profile.interactionCount += 1;
      const signals = this.localSignals(userText);
      this.applySignals(profile, signals, settings.adaptationRate, settings.minimumEvidence);
      await this.store.save(profile, this.reviewedMemoryIds);
      return signals.length;
    });
  }

  async reviewMemories(records: MemoryRecord[], analyzer?: PersonalityAnalyzer): Promise<number> {
    return this.enqueue(async () => {
      const settings = this.getSettings().personality;
      if (!settings.learningEnabled) return 0;
      const fresh = records.filter((record) => !this.reviewedMemoryIds.has(record.id)).slice(0, 30);
      if (!fresh.length) return 0;

      const profile = this.store.getProfile();
      let signals: PersonalitySignal[] | undefined;
      if (analyzer) {
        try {
          signals = await analyzer(fresh, profile);
        } catch {
          signals = undefined;
        }
      }
      if (!signals?.length) {
        signals = fresh.flatMap((record) => this.userTextFromMemory(record).flatMap((text) => this.localSignals(text)));
      }
      signals = signals.filter(validSignal).slice(0, 24);
      this.applySignals(profile, signals, settings.adaptationRate * 0.65, settings.minimumEvidence);
      fresh.forEach((record) => this.reviewedMemoryIds.add(record.id));
      await this.store.save(profile, this.reviewedMemoryIds);
      return signals.length;
    });
  }

  async reset(): Promise<PersonalityProfile> {
    return this.enqueue(async () => {
      this.reviewedMemoryIds.clear();
      return this.store.reset();
    });
  }

  behaviorContext(): string {
    const profile = this.store.getProfile();
    const minimumEvidence = this.getSettings().personality.minimumEvidence;
    const active = profile.traits.filter((trait) => trait.evidenceCount >= minimumEvidence && trait.confidence >= 0.12);
    if (!active.length) {
      return [
        "人格成长状态：空白或仍在观察期，没有足够证据形成稳定特质。",
        "本轮保持中性、自然和诚实，不预设温柔、活泼等固定人设；后续只依据累计互动逐渐形成表达倾向。",
      ].join("\n");
    }
    return [
      `人格成长阶段：${profile.stage}；累计互动：${profile.interactionCount}。`,
      "以下是证据驱动的连续状态（0=左侧倾向，1=右侧倾向），只能按置信度柔和体现，不得把它们宣称为用户事实：",
      ...active.map((trait) => {
        const labels = DIMENSION_LABELS[trait.dimension];
        return `- ${trait.dimension}: ${labels.low} ← ${trait.score.toFixed(2)} → ${labels.high}; confidence=${trait.confidence.toFixed(2)}; evidence=${trait.evidenceCount}`;
      }),
    ].join("\n");
  }

  private localSignals(text: string): PersonalitySignal[] {
    const value = text.trim();
    if (!value) return [];
    const evidence = summarizeText(value, 80);
    const signals: PersonalitySignal[] = [];
    const add = (dimension: PersonalityDimension, direction: -1 | 1, weight: number) => {
      signals.push({ dimension, direction, weight, evidence });
    };

    if (/谢谢|辛苦|陪我|安慰|理解我|难过|焦虑|开心|晚安|早安|温暖|亲切/.test(value)) add("warmth", 1, 0.72);
    if (/别安慰|不用关心|保持客观|只说事实|不要共情|冷静一点/.test(value)) add("warmth", -1, 0.9);
    if (/为什么|怎么做到|想知道|好奇|展开说|细说|还有什么|能不能解释/.test(value)) add("curiosity", 1, 0.58);
    if (/别问|不要追问|不用解释|到此为止|不想展开/.test(value)) add("curiosity", -1, 0.85);
    if (/哈哈|嘿嘿|笑死|有趣|可爱|卖萌|玩笑|[😀-🙏]/u.test(value)) add("playfulness", 1, 0.7);
    if (/严肃|正式|不要卖萌|别开玩笑|别用表情/.test(value)) add("playfulness", -1, 0.92);
    if (/直接|结论|别废话|马上|现在开始|只要结果|简明|干脆/.test(value)) add("directness", 1, 0.82);
    if (/委婉|慢慢说|语气柔和|别太直接/.test(value)) add("directness", -1, 0.78);
    if (/主动|提醒我|陪着我|你决定|自行|自动|继续做|不要停/.test(value)) add("initiative", 1, 0.82);
    if (/别主动|不要打扰|等我再说|先不用|不要提醒/.test(value)) add("initiative", -1, 0.95);
    if (/详细|展开|多说|完整说明|讲故事|描述一下|丰富/.test(value)) add("expressiveness", 1, 0.7);
    if (/简短|简洁|一句话|少说|不要解释|精简/.test(value)) add("expressiveness", -1, 0.86);
    return signals;
  }

  private userTextFromMemory(record: MemoryRecord): string[] {
    const matches = [...record.content.matchAll(/用户：([^\n]+)/g)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value));
    return matches;
  }

  private applySignals(
    profile: PersonalityProfile,
    signals: PersonalitySignal[],
    adaptationRate: number,
    minimumEvidence: number,
  ): void {
    const traits = new Map(profile.traits.map((trait) => [trait.dimension, trait]));
    const now = new Date().toISOString();
    for (const signal of signals.filter(validSignal)) {
      const current = traits.get(signal.dimension) ?? this.newTrait(signal.dimension, now);
      const centered = current.score - 0.5;
      const agrees = Math.abs(centered) < 0.03 || Math.sign(centered) === signal.direction;
      const resistance = 1 - current.confidence * 0.45;
      current.score = clamp(current.score + signal.direction * signal.weight * adaptationRate * resistance);
      current.confidence = clamp(current.confidence + signal.weight * (agrees ? 0.11 : -0.065));
      current.evidenceCount += 1;
      current.lastEvidence = signal.evidence.trim().slice(0, 160);
      current.updatedAt = now;
      traits.set(signal.dimension, current);
    }
    profile.traits = DIMENSION_ORDER.flatMap((dimension) => {
      const trait = traits.get(dimension);
      return trait ? [trait] : [];
    });
    profile.updatedAt = now;
    this.refreshSummary(profile, minimumEvidence);
  }

  private refreshSummary(profile: PersonalityProfile, minimumEvidence: number): void {
    const active = profile.traits.filter(
      (trait) => trait.evidenceCount >= minimumEvidence && Math.abs(trait.score - 0.5) >= 0.06,
    );
    const averageConfidence = active.length
      ? active.reduce((total, trait) => total + trait.confidence, 0) / active.length
      : 0;
    if (profile.interactionCount === 0 && profile.traits.length === 0) profile.stage = "blank";
    else if (profile.interactionCount >= 30 && active.length >= 4 && averageConfidence >= 0.5) profile.stage = "established";
    else if (profile.interactionCount >= 10 || active.length >= 3) profile.stage = "developing";
    else profile.stage = "forming";

    if (!active.length) {
      profile.summary = profile.stage === "blank"
        ? "尚未形成稳定人格，正在从真实互动中认识自己的表达方式。"
        : `已观察 ${profile.interactionCount} 次互动，但证据仍不足，暂不固定任何性格标签。`;
      return;
    }
    const descriptions = active.map((trait) => {
      const label = trait.score >= 0.5
        ? DIMENSION_LABELS[trait.dimension].high
        : DIMENSION_LABELS[trait.dimension].low;
      return `${label}（${Math.round(trait.confidence * 100)}%）`;
    });
    profile.summary = `正在形成：${descriptions.join("、")}。这些倾向会随之后的互动继续修正。`;
  }

  private newTrait(dimension: PersonalityDimension, now: string): PersonalityTraitState {
    return { dimension, score: 0.5, confidence: 0, evidenceCount: 0, lastEvidence: "", updatedAt: now };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validSignal(signal: PersonalitySignal): boolean {
  return DIMENSION_ORDER.includes(signal.dimension)
    && (signal.direction === -1 || signal.direction === 1)
    && Number.isFinite(signal.weight)
    && signal.weight > 0
    && typeof signal.evidence === "string"
    && Boolean(signal.evidence.trim());
}
