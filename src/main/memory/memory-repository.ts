import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  HeartbeatEvent,
  LongTermCandidate,
  MemoryDeleteInput,
  MemoryRecord,
  MemorySearchResult,
  MemoryUpdateInput,
} from "../../common/types";
import { clamp, jaccard, scoreMemoryBreakdown, summarizeText } from "./memory-utils";

interface MemoryMeta {
  lastInteractionAt?: string;
  lastProactiveAt?: string;
}

interface MemoryDatabase {
  version: 1;
  l2: MemoryRecord[];
  l3: MemoryRecord[];
  heartbeatEvents: HeartbeatEvent[];
  meta: MemoryMeta;
}

const EMPTY_DATABASE: MemoryDatabase = {
  version: 1,
  l2: [],
  l3: [],
  heartbeatEvents: [],
  meta: {},
};

export const MIN_RETRIEVAL_TEXT_RELEVANCE = 0.75;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryRepository {
  private readonly filePath: string;
  private database: MemoryDatabase = clone(EMPTY_DATABASE);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.filePath = join(dataDirectory, "memory-store.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<MemoryDatabase>;
      this.database = {
        version: 1,
        l2: Array.isArray(parsed.l2) ? parsed.l2 : [],
        l3: Array.isArray(parsed.l3) ? parsed.l3 : [],
        heartbeatEvents: Array.isArray(parsed.heartbeatEvents) ? parsed.heartbeatEvents : [],
        meta: parsed.meta ?? {},
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        await rename(this.filePath, corruptPath).catch(() => undefined);
      }
      this.database = clone(EMPTY_DATABASE);
      await this.persist();
    }
  }

  getL2(): MemoryRecord[] {
    return clone(this.database.l2);
  }

  getL3(): MemoryRecord[] {
    return clone(this.database.l3);
  }

  getRecentHeartbeats(limit = 20): HeartbeatEvent[] {
    return clone(this.database.heartbeatEvents.slice(-limit).reverse());
  }

  getMeta(): MemoryMeta {
    return clone(this.database.meta);
  }

  async setMeta(patch: Partial<MemoryMeta>): Promise<void> {
    this.database.meta = { ...this.database.meta, ...patch };
    await this.persist();
  }

  async enqueueL2(records: MemoryRecord[]): Promise<void> {
    this.database.l2.push(...clone(records));
    await this.persist();
  }

  async updateMemory(input: MemoryUpdateInput): Promise<MemoryRecord> {
    const records = input.tier === "L2" ? this.database.l2 : this.database.l3;
    const record = records.find((item) => item.id === input.id);
    if (!record) throw new Error("没有找到要修改的记忆");
    record.content = input.content;
    record.summary = summarizeText(input.content);
    record.kind = input.kind;
    record.importance = clamp(input.importance);
    record.updatedAt = new Date().toISOString();
    await this.persist();
    return clone(record);
  }

  async deleteMemory(input: MemoryDeleteInput): Promise<void> {
    const records = input.tier === "L2" ? this.database.l2 : this.database.l3;
    const index = records.findIndex((item) => item.id === input.id);
    if (index < 0) throw new Error("没有找到要删除的记忆");
    records.splice(index, 1);
    await this.persist();
  }

  async consumeL2(sourceIds: string[], candidates: LongTermCandidate[]): Promise<number> {
    const sourceIdSet = new Set(sourceIds);
    const now = new Date().toISOString();
    this.database.l2 = this.database.l2.filter((record) => !sourceIdSet.has(record.id));

    let changed = 0;
    for (const candidate of candidates) {
      const existing = this.database.l3.find(
        (record) => record.kind === candidate.kind && jaccard(record.content, candidate.content) >= 0.76,
      );
      if (existing) {
        existing.content = candidate.content.length >= existing.content.length ? candidate.content : existing.content;
        existing.summary = candidate.summary || existing.summary;
        existing.importance = clamp(Math.max(existing.importance, candidate.importance));
        existing.tags = [...new Set([...existing.tags, ...candidate.tags])];
        existing.sourceIds = [...new Set([...existing.sourceIds, ...(candidate.sourceIds ?? sourceIds)])];
        existing.updatedAt = now;
      } else {
        this.database.l3.push({
          id: randomUUID(),
          tier: "L3",
          kind: candidate.kind,
          content: candidate.content,
          summary: candidate.summary || summarizeText(candidate.content),
          importance: clamp(candidate.importance),
          tags: [...new Set(candidate.tags)],
          createdAt: now,
          updatedAt: now,
          accessedAt: now,
          accessCount: 0,
          sourceIds: candidate.sourceIds ?? sourceIds,
        });
      }
      changed += 1;
    }
    await this.persist();
    return changed;
  }

  async retrieveWithScores(query: string, limit = 6): Promise<MemorySearchResult[]> {
    const now = Date.now();
    const ranked = [...this.database.l3, ...this.database.l2]
      .map((memory) => ({ memory, score: scoreMemoryBreakdown(memory, query, now) }))
      .filter(({ score }) => score.textRelevance >= MIN_RETRIEVAL_TEXT_RELEVANCE)
      .sort((a, b) => b.score.total - a.score.total)
      .slice(0, limit);
    const accessedAt = new Date(now).toISOString();
    for (const { memory } of ranked) {
      memory.accessCount += 1;
      memory.accessedAt = accessedAt;
    }
    if (ranked.length > 0) await this.persist();
    return clone(ranked);
  }

  async retrieve(query: string, limit = 6): Promise<MemoryRecord[]> {
    return (await this.retrieveWithScores(query, limit)).map(({ memory }) => memory);
  }

  async recordHeartbeat(event: HeartbeatEvent): Promise<void> {
    this.database.heartbeatEvents.push(clone(event));
    this.database.heartbeatEvents = this.database.heartbeatEvents.slice(-200);
    await this.persist();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
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
