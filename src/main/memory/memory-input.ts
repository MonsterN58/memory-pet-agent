import type {
  EditableMemoryKind,
  MemoryDeleteInput,
  MemoryUpdateInput,
  PersistentMemoryTier,
} from "../../common/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERSISTENT_TIERS = new Set<PersistentMemoryTier>(["L2", "L3"]);
const EDITABLE_KINDS = new Set<EditableMemoryKind>(["episode", "fact", "preference", "reflection"]);

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("记忆请求格式无效");
  }
  return value as Record<string, unknown>;
}

function memoryTarget(value: unknown): MemoryDeleteInput {
  const input = objectValue(value);
  if (typeof input.id !== "string" || !UUID_PATTERN.test(input.id)) {
    throw new Error("记忆 ID 无效");
  }
  if (typeof input.tier !== "string" || !PERSISTENT_TIERS.has(input.tier as PersistentMemoryTier)) {
    throw new Error("只允许修改 L2 或 L3 记忆层级");
  }
  return { id: input.id, tier: input.tier as PersistentMemoryTier };
}

export function sanitizeMemoryTarget(value: unknown): MemoryDeleteInput {
  return memoryTarget(value);
}

export function sanitizeMemoryUpdate(value: unknown): MemoryUpdateInput {
  const input = objectValue(value);
  const target = memoryTarget(input);
  if (typeof input.content !== "string") {
    throw new Error("记忆内容必须是文本");
  }
  const content = input.content.trim();
  if (!content) throw new Error("记忆内容不能为空");
  if (content.length > 2000) throw new Error("记忆内容最多 2000 个字符");
  if (typeof input.kind !== "string" || !EDITABLE_KINDS.has(input.kind as EditableMemoryKind)) {
    throw new Error("记忆类型无效");
  }
  if (typeof input.importance !== "number" || !Number.isFinite(input.importance)
    || input.importance < 0 || input.importance > 1) {
    throw new Error("记忆重要度必须在 0 到 1 之间");
  }
  return {
    ...target,
    content,
    kind: input.kind as EditableMemoryKind,
    importance: input.importance,
  };
}
