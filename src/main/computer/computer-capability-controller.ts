import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentSettings,
  ComputerActionDecision,
  ComputerActionProposal,
  ComputerActionResult,
  ComputerAuditEntry,
  ComputerPermissionPolicy,
  ComputerTool,
  SharedComputerContext,
} from "../../common/types";
import {
  type AllowedDesktopApp,
  type ComputerActionDraft,
  planComputerAction,
  toolLabel,
} from "./computer-action-planner";

interface ComputerAccessFile {
  version: 1;
  pairingToken: string;
  audit: ComputerAuditEntry[];
}

export interface ComputerCapabilityDependencies {
  getSettings(): AgentSettings;
  openUrl(url: string): Promise<void>;
  copyText(text: string): void;
  saveText(suggestedName: string, text: string): Promise<{ cancelled: boolean; path?: string }>;
  launchApp(app: AllowedDesktopApp): Promise<void>;
  persistPermission(tool: ComputerTool, policy: ComputerPermissionPolicy): Promise<void>;
  now?: () => Date;
}

export interface ComputerPlanOutcome {
  proposal?: ComputerActionProposal;
  warning?: string;
}

interface PendingAction {
  proposal: ComputerActionProposal;
  draft: ComputerActionDraft;
  auditId: string;
}

const MAX_AUDIT_ITEMS = 500;
const ACTION_TTL_MS = 5 * 60 * 1000;
const PERSISTENT_PERMISSION_TOOLS = new Set<ComputerTool>(["open-url", "copy-text", "launch-app"]);

export class ComputerCapabilityController {
  private readonly statePath: string;
  private state: ComputerAccessFile = freshState();
  private readonly pending = new Map<string, PendingAction>();
  private readonly sessionAllowed = new Set<ComputerTool>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string, private readonly dependencies: ComputerCapabilityDependencies) {
    this.statePath = join(dataDirectory, "computer-access.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<ComputerAccessFile>;
      this.state = {
        version: 1,
        pairingToken: validToken(loaded.pairingToken) ? loaded.pairingToken : createToken(),
        audit: Array.isArray(loaded.audit) ? loaded.audit.filter(validAudit).slice(-MAX_AUDIT_ITEMS) : [],
      };
    } catch {
      this.state = freshState();
    }
    await this.persist();
  }

  pairingToken(): string {
    return this.state.pairingToken;
  }

  sessionAllowedTools(): ComputerTool[] {
    return [...this.sessionAllowed];
  }

  recentAudit(limit = 30): ComputerAuditEntry[] {
    return structuredClone(this.state.audit.slice(-Math.max(0, limit)).reverse());
  }

  async rotatePairingToken(): Promise<string> {
    this.state.pairingToken = createToken();
    await this.addAudit({
      source: "settings",
      kind: "context",
      action: "pairing-token",
      summary: "重新生成浏览器扩展配对令牌",
      status: "completed",
    });
    return this.state.pairingToken;
  }

  async clearAudit(): Promise<void> {
    this.state.audit = [];
    await this.persist();
  }

  async recordContext(context: SharedComputerContext, status: ComputerAuditEntry["status"], detail?: string): Promise<void> {
    const sourceLabel = context.source === "browser" ? "浏览器" : context.source === "file" ? "文件" : "剪贴板";
    await this.addAudit({
      source: context.source,
      kind: "context",
      action: context.action,
      summary: `${sourceLabel}：${trimPreview(context.title || context.text, 140)}`,
      status,
      detail: detail?.slice(0, 300),
    });
  }

  async planFromChat(input: string): Promise<ComputerPlanOutcome> {
    const draft = planComputerAction(input);
    if (!draft) return {};
    const settings = this.dependencies.getSettings().computer;
    if (!settings.enabled) {
      return { warning: "电脑协作尚未启用，可在设置中开启后再让我执行。" };
    }
    const policy = settings.permissions[draft.tool];
    if (policy === "deny") {
      await this.addAudit({
        source: "chat",
        kind: "tool",
        action: draft.tool,
        summary: `${toolLabel(draft.tool)}被当前权限策略拦截`,
        status: "denied",
      });
      return { warning: `“${toolLabel(draft.tool)}”权限当前设为禁止，操作没有执行。` };
    }

    await this.pruneExpired();
    const id = randomUUID();
    const now = this.now();
    const trusted = policy === "allow" || this.sessionAllowed.has(draft.tool);
    const proposal: ComputerActionProposal = {
      id,
      tool: draft.tool,
      title: toolLabel(draft.tool),
      description: descriptionFor(draft),
      preview: previewFor(draft),
      severity: draft.tool === "save-text-file" ? "warning" : "info",
      requiresApproval: !trusted,
      allowedDecisions: trusted
        ? ["allow-once", "deny"]
        : PERSISTENT_PERMISSION_TOOLS.has(draft.tool)
          ? ["allow-once", "allow-session", "allow-always", "deny"]
          : ["allow-once", "deny"],
      expiresAt: new Date(now.getTime() + ACTION_TTL_MS).toISOString(),
    };
    const auditId = await this.addAudit({
      source: "chat",
      kind: "tool",
      action: draft.tool,
      summary: `${proposal.title}：${trimPreview(proposal.preview, 140)}`,
      status: "pending",
    });
    this.pending.set(id, { proposal, draft, auditId });
    return { proposal };
  }

  async execute(id: string, decision: ComputerActionDecision): Promise<ComputerActionResult> {
    await this.pruneExpired();
    const pending = this.pending.get(id);
    if (!pending) throw new Error("该操作预览已过期，请重新发起");
    const { proposal, draft, auditId } = pending;
    if (!proposal.allowedDecisions.includes(decision)) throw new Error("该操作不支持所选授权方式");
    const policy = this.dependencies.getSettings().computer.permissions[proposal.tool];
    if (!this.dependencies.getSettings().computer.enabled || policy === "deny") {
      this.pending.delete(id);
      await this.finishAudit(auditId, "denied", decision, "权限在执行前被关闭");
      return { id, status: "denied", message: "权限已关闭，操作没有执行。" };
    }
    if (decision === "deny") {
      this.pending.delete(id);
      await this.finishAudit(auditId, "denied", decision, "用户拒绝操作");
      return { id, status: "denied", message: "好，这次不做。" };
    }

    try {
      let message: string;
      switch (draft.tool) {
        case "open-url":
          await this.dependencies.openUrl(draft.url);
          message = `已打开 ${draft.label}`;
          break;
        case "copy-text":
          this.dependencies.copyText(draft.text);
          message = "已复制到剪贴板";
          break;
        case "save-text-file": { // 每次都由原生保存对话框决定最终路径。
          const result = await this.dependencies.saveText(draft.suggestedName, draft.text);
          if (result.cancelled) {
            this.pending.delete(id);
            await this.finishAudit(auditId, "cancelled", decision, "用户取消保存对话框");
            return { id, status: "cancelled", message: "已取消保存。" };
          }
          message = result.path ? `已保存到 ${result.path}` : "文本文件已保存";
          break;
        }
        case "launch-app":
          await this.dependencies.launchApp(draft.app);
          message = `已启动${draft.label}`;
          break;
      }
      if (decision === "allow-session") this.sessionAllowed.add(proposal.tool);
      if (decision === "allow-always") {
        try {
          await this.dependencies.persistPermission(proposal.tool, "allow");
        } catch (error) {
          const reason = error instanceof Error ? error.message : "设置保存失败";
          message = `${message}；长期权限未保存，下次仍会询问（${reason}）`;
        }
      }
      this.pending.delete(id);
      await this.finishAudit(auditId, "completed", decision, message);
      return { id, status: "completed", message };
    } catch (error) {
      this.pending.delete(id);
      const message = error instanceof Error ? error.message : "操作执行失败";
      await this.finishAudit(auditId, "failed", decision, message);
      return { id, status: "failed", message };
    }
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private async pruneExpired(): Promise<void> {
    const now = this.now().getTime();
    let changed = false;
    for (const [id, item] of this.pending) {
      if (Date.parse(item.proposal.expiresAt) > now) continue;
      this.pending.delete(id);
      const audit = this.state.audit.find((entry) => entry.id === item.auditId);
      if (audit && audit.status === "pending") {
        audit.status = "cancelled";
        audit.detail = "操作预览已过期";
        audit.updatedAt = this.now().toISOString();
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private async addAudit(
    value: Omit<ComputerAuditEntry, "id" | "createdAt" | "updatedAt">,
  ): Promise<string> {
    const now = this.now().toISOString();
    const entry: ComputerAuditEntry = { ...value, id: randomUUID(), createdAt: now, updatedAt: now };
    this.state.audit.push(entry);
    this.state.audit = this.state.audit.slice(-MAX_AUDIT_ITEMS);
    await this.persist();
    return entry.id;
  }

  private async finishAudit(
    id: string,
    status: ComputerAuditEntry["status"],
    decision: ComputerActionDecision,
    detail: string,
  ): Promise<void> {
    const entry = this.state.audit.find((item) => item.id === id);
    if (!entry) return;
    entry.status = status;
    entry.decision = decision;
    entry.detail = detail.slice(0, 300);
    entry.updatedAt = this.now().toISOString();
    await this.persist();
  }

  private persist(): Promise<void> {
    const operation = async () => {
      const temporaryPath = `${this.statePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(this.state, null, 2), "utf8");
      await rename(temporaryPath, this.statePath);
    };
    this.persistQueue = this.persistQueue.then(operation, operation);
    return this.persistQueue;
  }
}

function freshState(): ComputerAccessFile {
  return { version: 1, pairingToken: createToken(), audit: [] };
}

function createToken(): string {
  return randomBytes(32).toString("base64url");
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,80}$/.test(value);
}

function validAudit(value: unknown): value is ComputerAuditEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ComputerAuditEntry>;
  const sources = new Set(["chat", "browser", "clipboard", "file", "settings"]);
  const kinds = new Set(["context", "tool"]);
  const actions = new Set([
    "open-url", "copy-text", "save-text-file", "launch-app",
    "explain", "summarize", "chat", "remember", "pairing-token",
  ]);
  const statuses = new Set(["pending", "completed", "denied", "cancelled", "failed"]);
  const decisions = new Set(["allow-once", "allow-session", "allow-always", "deny"]);
  return typeof item.id === "string"
    && typeof item.source === "string" && sources.has(item.source)
    && typeof item.kind === "string" && kinds.has(item.kind)
    && typeof item.action === "string" && actions.has(item.action)
    && typeof item.summary === "string" && item.summary.length <= 500
    && typeof item.status === "string" && statuses.has(item.status)
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string"
    && (item.decision === undefined || decisions.has(item.decision))
    && (item.detail === undefined || (typeof item.detail === "string" && item.detail.length <= 500));
}

function descriptionFor(draft: ComputerActionDraft): string {
  switch (draft.tool) {
    case "open-url": return "将使用系统默认浏览器打开这个地址。";
    case "copy-text": return "将覆盖系统剪贴板中的当前文本。";
    case "save-text-file": return "确认后仍会弹出系统保存窗口，由你选择文件名和位置。";
    case "launch-app": return `将启动 Windows ${draft.label}。`;
  }
}

function previewFor(draft: ComputerActionDraft): string {
  switch (draft.tool) {
    case "open-url": return draft.url;
    case "copy-text": return trimPreview(draft.text, 500);
    case "save-text-file": return trimPreview(draft.text, 500);
    case "launch-app": return draft.label;
  }
}

function trimPreview(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
