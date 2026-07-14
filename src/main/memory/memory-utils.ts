import type { LongTermCandidate, MemoryRecord, MemoryScoreBreakdown } from "../../common/types";

const CJK = /[\u3400-\u9fff]/;

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function tokenize(value: string): Set<string> {
  const normalized = normalizeText(value);
  const parts = normalized.match(/[a-z0-9]+|[\u3400-\u9fff]/g) ?? [];
  const tokens = new Set(parts);
  const cjk = parts.filter((part) => CJK.test(part));
  for (let i = 0; i < cjk.length - 1; i += 1) {
    tokens.add(`${cjk[i]}${cjk[i + 1]}`);
  }
  return tokens;
}

export function jaccard(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function scoreMemoryBreakdown(
  memory: MemoryRecord,
  query: string,
  now = Date.now(),
): MemoryScoreBreakdown {
  const queryTokens = tokenize(query);
  const memoryTokens = tokenize(`${memory.summary} ${memory.content} ${memory.tags.join(" ")}`);
  let matches = 0;
  for (const token of queryTokens) if (memoryTokens.has(token)) matches += 1;
  const relevance = queryTokens.size > 0 ? matches / queryTokens.size : 0;
  const ageDays = Math.max(0, now - Date.parse(memory.updatedAt)) / 86_400_000;
  const textRelevance = relevance * 5;
  const importance = memory.importance * 1.7;
  const recency = Math.exp(-ageDays / 30) * 0.8;
  const frequency = Math.min(1, Math.log2(memory.accessCount + 1) / 5) * 0.5;
  return {
    textRelevance,
    importance,
    recency,
    frequency,
    total: textRelevance + importance + recency + frequency,
  };
}

export function scoreMemory(memory: MemoryRecord, query: string, now = Date.now()): number {
  return scoreMemoryBreakdown(memory, query, now).total;
}

export function summarizeText(value: string, maxLength = 100): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

export function dedupeCandidates(candidates: LongTermCandidate[]): LongTermCandidate[] {
  const result: LongTermCandidate[] = [];
  for (const candidate of candidates) {
    const duplicate = result.find(
      (existing) => existing.kind === candidate.kind && jaccard(existing.content, candidate.content) >= 0.72,
    );
    if (duplicate) {
      duplicate.importance = Math.max(duplicate.importance, candidate.importance);
      duplicate.tags = [...new Set([...duplicate.tags, ...candidate.tags])];
      duplicate.sourceIds = [...new Set([...(duplicate.sourceIds ?? []), ...(candidate.sourceIds ?? [])])];
    } else {
      result.push({ ...candidate, importance: clamp(candidate.importance) });
    }
  }
  return result;
}
