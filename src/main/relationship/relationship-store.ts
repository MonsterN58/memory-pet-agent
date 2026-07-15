import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DesktopActivityKind,
  ProactiveTopicFeedback,
  RelationshipActivityPattern,
  RelationshipCareStyle,
  RelationshipInsight,
  RelationshipInsightKind,
  RelationshipProfile,
  RelationshipProactiveTopic,
  RelationshipSharedMoment,
  RelationshipStage,
} from "../../common/types";
import { clamp } from "../memory/memory-utils";

interface RelationshipDatabase {
  version: 1;
  profile: RelationshipProfile;
  reviewedMemoryIds: string[];
}

const STAGES = new Set<RelationshipStage>(["new", "acquainted", "familiar", "companion"]);
const INSIGHT_KINDS = new Set<RelationshipInsightKind>([
  "identity", "preference", "goal", "routine", "interest", "concern", "work-style", "support-style",
]);
const ACTIVITIES = new Set<DesktopActivityKind>([
  "browsing", "coding", "writing", "office", "communication", "terminal", "design", "media", "gaming",
]);
const FEEDBACK = new Set<ProactiveTopicFeedback>(["pending", "welcomed", "neutral", "dismissed"]);

export function emptyRelationshipProfile(now = new Date().toISOString()): RelationshipProfile {
  return {
    version: 1,
    stage: "new",
    interactionCount: 0,
    insights: [],
    activityPatterns: [],
    sharedMoments: [],
    careStyle: {
      initiativeAffinity: 0.5,
      practicalHelpAffinity: 0.5,
      quietCompanionshipAffinity: 0.5,
      evidenceCount: 0,
      updatedAt: now,
    },
    recentProactiveTopics: [],
    summary: "彼此还在初识，我会从真实互动中慢慢了解你，而不是先替你下定义。",
    createdAt: now,
    updatedAt: now,
  };
}

export class RelationshipStore {
  private readonly filePath: string;
  private database: RelationshipDatabase = {
    version: 1,
    profile: emptyRelationshipProfile(),
    reviewedMemoryIds: [],
  };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.filePath = join(dataDirectory, "relationship-profile.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<RelationshipDatabase>;
      this.database = {
        version: 1,
        profile: sanitizeRelationshipProfile(parsed.profile),
        reviewedMemoryIds: Array.isArray(parsed.reviewedMemoryIds)
          ? parsed.reviewedMemoryIds.filter((id): id is string => typeof id === "string").slice(-1500)
          : [],
      };
      await this.persist();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => undefined);
      }
      this.database = { version: 1, profile: emptyRelationshipProfile(), reviewedMemoryIds: [] };
      await this.persist();
    }
  }

  getProfile(): RelationshipProfile {
    return structuredClone(this.database.profile);
  }

  getReviewedMemoryIds(): string[] {
    return [...this.database.reviewedMemoryIds];
  }

  async save(profile: RelationshipProfile, reviewedMemoryIds: Iterable<string>): Promise<void> {
    this.database = {
      version: 1,
      profile: sanitizeRelationshipProfile(profile),
      reviewedMemoryIds: [...new Set(reviewedMemoryIds)].slice(-1500),
    };
    await this.persist();
  }

  async reset(): Promise<RelationshipProfile> {
    this.database = { version: 1, profile: emptyRelationshipProfile(), reviewedMemoryIds: [] };
    await this.persist();
    return this.getProfile();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.database, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, snapshot, "utf8");
      try {
        await rename(temporaryPath, this.filePath);
      } catch {
        await copyFile(temporaryPath, this.filePath);
        await rm(temporaryPath, { force: true });
      }
    });
    return this.writeQueue;
  }
}

export function sanitizeRelationshipProfile(value: unknown): RelationshipProfile {
  if (!value || typeof value !== "object") return emptyRelationshipProfile();
  const input = value as Partial<RelationshipProfile>;
  const now = new Date().toISOString();
  const fallback = emptyRelationshipProfile(now);
  return {
    version: 1,
    stage: typeof input.stage === "string" && STAGES.has(input.stage) ? input.stage : "new",
    interactionCount: Math.max(0, Math.round(Number(input.interactionCount) || 0)),
    insights: Array.isArray(input.insights)
      ? input.insights.map(sanitizeInsight).filter((item): item is RelationshipInsight => Boolean(item)).slice(-60)
      : [],
    activityPatterns: Array.isArray(input.activityPatterns)
      ? input.activityPatterns
        .map(sanitizeActivityPattern)
        .filter((item): item is RelationshipActivityPattern => Boolean(item))
        .slice(-12)
      : [],
    sharedMoments: Array.isArray(input.sharedMoments)
      ? input.sharedMoments
        .map(sanitizeSharedMoment)
        .filter((item): item is RelationshipSharedMoment => Boolean(item))
        .slice(-16)
      : [],
    careStyle: sanitizeCareStyle(input.careStyle, now),
    recentProactiveTopics: Array.isArray(input.recentProactiveTopics)
      ? input.recentProactiveTopics
        .map(sanitizeProactiveTopic)
        .filter((item): item is RelationshipProactiveTopic => Boolean(item))
        .slice(-24)
      : [],
    summary: cleanString(input.summary, fallback.summary, 700),
    createdAt: validDate(input.createdAt, now),
    updatedAt: validDate(input.updatedAt, now),
  };
}

function sanitizeInsight(value: unknown): RelationshipInsight | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<RelationshipInsight>;
  if (!input.kind || !INSIGHT_KINDS.has(input.kind)) return undefined;
  const topic = cleanString(input.topic, "", 80);
  const summary = cleanString(input.summary, "", 240);
  if (!input.id || !topic || !summary) return undefined;
  const now = new Date().toISOString();
  return {
    id: cleanString(input.id, "", 80),
    kind: input.kind,
    topic,
    summary,
    confidence: clamp(Number(input.confidence) || 0),
    evidenceCount: Math.max(1, Math.round(Number(input.evidenceCount) || 1)),
    sourceIds: Array.isArray(input.sourceIds)
      ? input.sourceIds.filter((id): id is string => typeof id === "string").slice(-80)
      : [],
    createdAt: validDate(input.createdAt, now),
    updatedAt: validDate(input.updatedAt, now),
  };
}

function sanitizeActivityPattern(value: unknown): RelationshipActivityPattern | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<RelationshipActivityPattern>;
  if (!input.activity || !ACTIVITIES.has(input.activity)) return undefined;
  const now = new Date().toISOString();
  return {
    activity: input.activity,
    label: cleanString(input.label, input.activity, 40),
    observations: Math.max(1, Math.round(Number(input.observations) || 1)),
    confidence: clamp(Number(input.confidence) || 0),
    firstSeenAt: validDate(input.firstSeenAt, now),
    lastSeenAt: validDate(input.lastSeenAt, now),
  };
}

function sanitizeSharedMoment(value: unknown): RelationshipSharedMoment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<RelationshipSharedMoment>;
  const id = cleanString(input.id, "", 80);
  const summary = cleanString(input.summary, "", 220);
  if (!id || !summary) return undefined;
  const now = new Date().toISOString();
  return {
    id,
    summary,
    importance: clamp(Number(input.importance) || 0.5),
    sourceIds: Array.isArray(input.sourceIds)
      ? input.sourceIds.filter((item): item is string => typeof item === "string").slice(-60)
      : [],
    happenedAt: validDate(input.happenedAt, now),
    createdAt: validDate(input.createdAt, now),
  };
}

function sanitizeCareStyle(value: unknown, now: string): RelationshipCareStyle {
  const input = value && typeof value === "object" ? value as Partial<RelationshipCareStyle> : {};
  return {
    initiativeAffinity: clamp(finiteNumber(input.initiativeAffinity, 0.5)),
    practicalHelpAffinity: clamp(finiteNumber(input.practicalHelpAffinity, 0.5)),
    quietCompanionshipAffinity: clamp(finiteNumber(input.quietCompanionshipAffinity, 0.5)),
    evidenceCount: Math.max(0, Math.round(Number(input.evidenceCount) || 0)),
    updatedAt: validDate(input.updatedAt, now),
  };
}

function sanitizeProactiveTopic(value: unknown): RelationshipProactiveTopic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<RelationshipProactiveTopic>;
  const id = cleanString(input.id, "", 80);
  const topic = cleanString(input.topic, "", 160);
  if (!id || !topic) return undefined;
  const now = new Date().toISOString();
  return {
    id,
    topic,
    offeredAt: validDate(input.offeredAt, now),
    feedback: input.feedback && FEEDBACK.has(input.feedback) ? input.feedback : "neutral",
    feedbackAt: input.feedbackAt ? validDate(input.feedbackAt, now) : undefined,
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, maxLength) : fallback;
}

function validDate(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}
