import type { LongTermCandidate, MemoryRecord, MemoryScoreBreakdown } from "../../common/types";

const CJK = /[\u3400-\u9fff]/;
const CJK_RETRIEVAL_STOPWORDS = new Set(
  "我你他她它的了是在和与也就都而及着或这那很还把被让给对从到会能要想说吗呢啊呀吧什么怎样".split(""),
);
const MEMORY_KIND_RETRIEVAL_TERMS: Record<MemoryRecord["kind"], string> = {
  dialogue: "近期对话",
  episode: "近期计划待跟进话题",
  fact: "近期重要的事",
  preference: "近期偏好",
  reflection: "近期反思",
};

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

export function retrievalTokens(value: string): Set<string> {
  const parts = normalizeText(value).match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? [];
  const tokens = new Set<string>();
  for (const part of parts) {
    if (!CJK.test(part)) {
      tokens.add(part);
      continue;
    }
    const characters = [...part];
    for (const character of characters) {
      if (!CJK_RETRIEVAL_STOPWORDS.has(character)) tokens.add(character);
    }
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.add(`${characters[index]}${characters[index + 1]}`);
    }
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
  const queryTokens = retrievalTokens(query);
  const memoryTokens = retrievalTokens(
    `${memory.summary} ${memory.content} ${memory.tags.join(" ")} ${MEMORY_KIND_RETRIEVAL_TERMS[memory.kind]}`,
  );
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
