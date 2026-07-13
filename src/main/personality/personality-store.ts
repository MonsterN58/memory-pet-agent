import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PersonalityDimension, PersonalityProfile, PersonalityTraitState } from "../../common/types";
import { clamp } from "../memory/memory-utils";

const DIMENSIONS = new Set<PersonalityDimension>([
  "warmth", "curiosity", "playfulness", "directness", "initiative", "expressiveness",
]);

interface PersonalityDatabase {
  version: 1;
  profile: PersonalityProfile;
  reviewedMemoryIds: string[];
}

export function emptyPersonalityProfile(now = new Date().toISOString()): PersonalityProfile {
  return {
    version: 1,
    stage: "blank",
    interactionCount: 0,
    traits: [],
    summary: "尚未形成稳定人格，正在从真实互动中认识自己的表达方式。",
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeProfile(value: unknown): PersonalityProfile {
  if (!value || typeof value !== "object") return emptyPersonalityProfile();
  const input = value as Partial<PersonalityProfile>;
  const now = new Date().toISOString();
  const traits = Array.isArray(input.traits)
    ? input.traits.map(sanitizeTrait).filter((trait): trait is PersonalityTraitState => Boolean(trait))
    : [];
  const stages = new Set(["blank", "forming", "developing", "established"]);
  return {
    version: 1,
    stage: typeof input.stage === "string" && stages.has(input.stage)
      ? input.stage as PersonalityProfile["stage"]
      : traits.length ? "forming" : "blank",
    interactionCount: Math.max(0, Math.round(Number(input.interactionCount) || 0)),
    traits,
    summary: typeof input.summary === "string" && input.summary.trim()
      ? input.summary.trim().slice(0, 500)
      : emptyPersonalityProfile(now).summary,
    createdAt: validDate(input.createdAt, now),
    updatedAt: validDate(input.updatedAt, now),
  };
}

function sanitizeTrait(value: unknown): PersonalityTraitState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<PersonalityTraitState>;
  if (!input.dimension || !DIMENSIONS.has(input.dimension)) return undefined;
  const now = new Date().toISOString();
  const score = Number(input.score);
  const confidence = Number(input.confidence);
  return {
    dimension: input.dimension,
    score: clamp(Number.isFinite(score) ? score : 0.5),
    confidence: clamp(Number.isFinite(confidence) ? confidence : 0),
    evidenceCount: Math.max(0, Math.round(Number(input.evidenceCount) || 0)),
    lastEvidence: typeof input.lastEvidence === "string" ? input.lastEvidence.trim().slice(0, 160) : "",
    updatedAt: validDate(input.updatedAt, now),
  };
}

function validDate(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

export class PersonalityStore {
  private readonly filePath: string;
  private database: PersonalityDatabase = {
    version: 1,
    profile: emptyPersonalityProfile(),
    reviewedMemoryIds: [],
  };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.filePath = join(dataDirectory, "personality-profile.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PersonalityDatabase>;
      this.database = {
        version: 1,
        profile: sanitizeProfile(parsed.profile),
        reviewedMemoryIds: Array.isArray(parsed.reviewedMemoryIds)
          ? parsed.reviewedMemoryIds.filter((id): id is string => typeof id === "string").slice(-1000)
          : [],
      };
      await this.persist();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => undefined);
      }
      this.database = { version: 1, profile: emptyPersonalityProfile(), reviewedMemoryIds: [] };
      await this.persist();
    }
  }

  getProfile(): PersonalityProfile {
    return structuredClone(this.database.profile);
  }

  getReviewedMemoryIds(): string[] {
    return [...this.database.reviewedMemoryIds];
  }

  async save(profile: PersonalityProfile, reviewedMemoryIds: Iterable<string>): Promise<void> {
    this.database = {
      version: 1,
      profile: sanitizeProfile(profile),
      reviewedMemoryIds: [...new Set(reviewedMemoryIds)].slice(-1000),
    };
    await this.persist();
  }

  async reset(): Promise<PersonalityProfile> {
    this.database = { version: 1, profile: emptyPersonalityProfile(), reviewedMemoryIds: [] };
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
