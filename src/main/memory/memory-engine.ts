import { randomUUID } from "node:crypto";
import type {
  AgentSettings,
  InstantMemory,
  LongTermCandidate,
  MemoryDeleteInput,
  MemoryRecord,
  MemorySearchResult,
  MemorySnapshot,
  MemoryUpdateInput,
  SpeakerRole,
} from "../../common/types";
import { MemoryRepository } from "./memory-repository";
import { clamp, dedupeCandidates, summarizeText } from "./memory-utils";

export type MemoryReflector = (records: MemoryRecord[]) => Promise<LongTermCandidate[] | undefined>;

export class MemoryEngine {
  private readonly l1: InstantMemory[] = [];

  constructor(
    private readonly repository: MemoryRepository,
    private readonly getSettings: () => AgentSettings,
  ) {}

  recordTurn(role: SpeakerRole, content: string, source = "chat"): InstantMemory {
    const now = new Date().toISOString();
    const record: InstantMemory = {
      id: randomUUID(),
      tier: "L1",
      kind: "dialogue",
      role,
      content: content.trim(),
      summary: summarizeText(content, 90),
      importance: role === "user" ? this.estimateImportance(content) : 0.45,
      tags: [source, role],
      createdAt: now,
      updatedAt: now,
      accessedAt: now,
      accessCount: 0,
      sourceIds: [],
    };
    this.l1.push(record);
    return structuredClone(record);
  }

  async rememberExplicit(content: string): Promise<void> {
    const now = new Date().toISOString();
    await this.repository.enqueueL2([
      {
        id: randomUUID(),
        tier: "L2",
        kind: "fact",
        content: content.trim(),
        summary: summarizeText(content),
        importance: 0.95,
        tags: ["explicit", "user-confirmed"],
        createdAt: now,
        updatedAt: now,
        accessedAt: now,
        accessCount: 0,
        sourceIds: [],
      },
    ]);
  }

  async flushL1(force = false): Promise<number> {
    const settings = this.getSettings().heartbeat;
    const ageThreshold = Date.now() - settings.l1MaxAgeMinutes * 60_000;
    const agedCount = this.l1.filter((item) => Date.parse(item.createdAt) <= ageThreshold).length;
    const overflowCount = Math.max(0, this.l1.length - settings.l1MaxItems);
    let moveCount = force ? this.l1.length : Math.max(agedCount, overflowCount);
    if (moveCount === 1 && this.l1.length > 1) moveCount = 2;
    if (moveCount <= 0) return 0;

    const moving = this.l1.splice(0, moveCount);
    const now = new Date().toISOString();
    const episodes: MemoryRecord[] = [];
    for (let index = 0; index < moving.length; index += 2) {
      const chunk = moving.slice(index, index + 2);
      const content = chunk
        .map((item) => `${item.role === "user" ? "用户" : "桌宠"}：${item.content}`)
        .join("\n");
      episodes.push({
        id: randomUUID(),
        tier: "L2",
        kind: "episode",
        content,
        summary: summarizeText(content),
        importance: Math.max(...chunk.map((item) => item.importance)),
        tags: [...new Set(chunk.flatMap((item) => item.tags))],
        createdAt: chunk[0]?.createdAt ?? now,
        updatedAt: now,
        accessedAt: now,
        accessCount: 0,
        sourceIds: chunk.map((item) => item.id),
      });
    }
    await this.repository.enqueueL2(episodes);
    return episodes.length;
  }

  async consolidate(reflector?: MemoryReflector): Promise<number> {
    const pending = this.repository.getL2();
    if (pending.length === 0) return 0;
    let candidates: LongTermCandidate[] | undefined;
    if (reflector) {
      try {
        candidates = await reflector(pending);
      } catch {
        candidates = undefined;
      }
    }
    const currentById = new Map(this.repository.getL2().map((record) => [record.id, record]));
    const sourcesChanged = pending.some((record) => {
      const current = currentById.get(record.id);
      return !current
        || current.updatedAt !== record.updatedAt
        || current.content !== record.content
        || current.kind !== record.kind
        || current.importance !== record.importance;
    });
    if (sourcesChanged) return 0;
    const finalCandidates = dedupeCandidates(candidates?.length ? candidates : this.heuristicCandidates(pending));
    return this.repository.consumeL2(
      pending.map((item) => item.id),
      finalCandidates,
    );
  }

  async contextFor(query: string, limit = 6): Promise<MemoryRecord[]> {
    const persistent = await this.repository.retrieve(query, limit);
    const instant = this.l1.slice(-6);
    return [...instant, ...persistent].slice(0, limit + 4);
  }

  async search(query: string, limit = 20): Promise<MemorySearchResult[]> {
    return this.repository.retrieveWithScores(query, limit);
  }

  async updateMemory(input: MemoryUpdateInput): Promise<MemorySnapshot> {
    await this.repository.updateMemory(input);
    return this.snapshot();
  }

  async deleteMemory(input: MemoryDeleteInput): Promise<MemorySnapshot> {
    await this.repository.deleteMemory(input);
    return this.snapshot();
  }

  snapshot(): MemorySnapshot {
    return {
      l1: structuredClone(this.l1),
      l2: this.repository.getL2(),
      l3: this.repository.getL3(),
      recentHeartbeats: this.repository.getRecentHeartbeats(),
    };
  }

  reviewSummary(): string {
    const l2 = this.repository.getL2();
    const l3 = this.repository.getL3();
    const focus = [...l2, ...l3]
      .sort((a, b) => b.importance - a.importance || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 3)
      .map((item) => item.summary);
    if (focus.length === 0) return "记忆库刚刚建立，还没有足够内容可供回顾。";
    return `本次回顾了 ${l2.length} 条待整理记忆和 ${l3.length} 条长期记忆；当前关注：${focus.join("；")}`;
  }

  private estimateImportance(content: string): number {
    let score = 0.5;
    if (/记住|重要|一定|生日|名字|喜欢|讨厌|习惯|目标|计划/.test(content)) score += 0.25;
    if (/我叫|我是|我的|以后|不要|必须/.test(content)) score += 0.15;
    if (content.length > 100) score += 0.05;
    return clamp(score);
  }

  private heuristicCandidates(records: MemoryRecord[]): LongTermCandidate[] {
    const sourceIds = records.map((record) => record.id);
    const joined = records.map((record) => record.content).join("\n");
    const result: LongTermCandidate[] = [
      {
        kind: "episode",
        content: joined,
        summary: summarizeText(joined, 120),
        importance: Math.max(...records.map((record) => record.importance), 0.5),
        tags: ["heartbeat", "episode"],
        sourceIds,
      },
    ];

    const userStatements = [...joined.matchAll(/用户：([^\n]+)/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
    for (const statement of userStatements) {
      const preference = /喜欢|偏爱|讨厌|不喜欢|习惯|希望/.test(statement);
      const fact = /我叫|我是|我在|我住|我的|生日|工作|学习|目标|计划/.test(statement);
      if (!preference && !fact) continue;
      result.push({
        kind: preference ? "preference" : "fact",
        content: statement,
        summary: summarizeText(statement),
        importance: preference ? 0.82 : 0.76,
        tags: [preference ? "preference" : "fact", "heuristic"],
        sourceIds,
      });
    }
    return result;
  }
}
