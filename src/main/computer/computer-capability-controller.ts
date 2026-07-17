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
import type { BrowserCommandRequest, BrowserCommandResult } from "./browser-context-server";
import type { OfficeAutomationRequest, OfficeAutomationResult } from "./office-automation-service";

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
  executeBrowserCommand?(request: BrowserCommandRequest): Promise<BrowserCommandResult>;
  executeOffice?(request: OfficeAutomationRequest): Promise<OfficeAutomationResult>;
  persistPermission(tool: ComputerTool, policy: ComputerPermissionPolicy): Promise<void>;
  now?: () => Date;
}

export interface ComputerPlanOutcome {
  proposal?: ComputerActionProposal;
  warning?: string;
}

export interface ComputerBatchPlanOutcome {
  proposals: ComputerActionProposal[];
  warning?: string;
}

interface PendingAction {
  proposal: ComputerActionProposal;
  draft: ComputerActionDraft;
  auditId: string;
}

interface PendingPlan {
  id: string;
  currentStep: number;
  total: number;
  proposalIds: string[];
}

const MAX_AUDIT_ITEMS = 500;
const ACTION_TTL_MS = 5 * 60 * 1000;
const PERSISTENT_PERMISSION_TOOLS = new Set<ComputerTool>(["open-url", "copy-text", "launch-app"]);

export class ComputerCapabilityController {
  private readonly statePath: string;
  private state: ComputerAccessFile = freshState();
  private readonly pending = new Map<string, PendingAction>();
  private readonly plans = new Map<string, PendingPlan>();
  private readonly executingAuditIds = new Set<string>();
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
    this.pending.clear();
    this.plans.clear();
    this.executingAuditIds.clear();
    const recoveredAt = this.now().toISOString();
    for (const entry of this.state.audit) {
      if (entry.status !== "pending") continue;
      entry.status = "cancelled";
      entry.detail = "应用已重启，未执行的操作预览已失效";
      entry.updatedAt = recoveredAt;
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
    this.pending.clear();
    this.plans.clear();
    this.state.audit = this.state.audit.filter((entry) => this.executingAuditIds.has(entry.id));
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
    return this.planDraft(draft);
  }

  async planDraft(value: ComputerActionDraft): Promise<ComputerPlanOutcome> {
    const draft = sanitizeDraft(value);
    const settings = this.dependencies.getSettings().computer;
    if (!settings.enabled) {
      return { warning: "电脑协作尚未启用，可在设置中开启后再让我执行。" };
    }
    if (draft.tool === "browser-control" && !settings.browserContextEnabled) {
      return { warning: "浏览器桥接尚未启用，请先在电脑协作设置中开启并完成扩展配对。" };
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
    const now = this.now();
    const proposal = this.createProposal(draft, policy, now);
    const auditId = await this.addAudit({
      source: "chat",
      kind: "tool",
      action: draft.tool,
      summary: `${proposal.title}：${trimPreview(proposal.preview, 140)}`,
      status: "pending",
    });
    this.pending.set(proposal.id, { proposal, draft, auditId });
    return { proposal };
  }

  async planDrafts(
    values: readonly ComputerActionDraft[],
    title = "协作计划",
  ): Promise<ComputerBatchPlanOutcome> {
    if (!Array.isArray(values) || values.length < 2 || values.length > 4) {
      throw new Error("协作计划必须包含 2～4 个步骤");
    }
    const drafts = values.map((value) => sanitizeDraft(value));
    const settings = this.dependencies.getSettings().computer;
    if (!settings.enabled) return { proposals: [], warning: "电脑协作尚未启用，可在设置中开启后再让我执行。" };
    if (drafts.some((draft) => draft.tool === "browser-control") && !settings.browserContextEnabled) {
      return { proposals: [], warning: "计划包含浏览器操作，请先在电脑协作设置中开启桥接并完成扩展配对。" };
    }
    const denied = drafts.find((draft) => settings.permissions[draft.tool] === "deny");
    if (denied) {
      return { proposals: [], warning: `计划中的“${toolLabel(denied.tool)}”权限当前设为禁止。` };
    }
    await this.pruneExpired();
    const planId = randomUUID();
    const planTitle = trimPreview(title.replace(/\u0000/g, "").trim() || "协作计划", 80);
    const now = this.now();
    const proposals = drafts.map((draft, index) => this.createProposal(
      draft,
      settings.permissions[draft.tool],
      now,
      { id: planId, title: planTitle, step: index + 1, total: drafts.length },
    ));
    const auditEntries = proposals.map((proposal) => this.createAuditEntry({
      source: "chat",
      kind: "tool",
      action: proposal.tool,
      summary: `${proposal.title}：${trimPreview(proposal.preview, 140)}`,
      status: "pending",
    }));
    const auditIds = new Set(auditEntries.map((entry) => entry.id));
    this.state.audit.push(...auditEntries);
    this.state.audit = this.state.audit.slice(-MAX_AUDIT_ITEMS);
    try {
      await this.persist();
    } catch (error) {
      this.state.audit = this.state.audit.filter((entry) => !auditIds.has(entry.id));
      throw error;
    }
    proposals.forEach((proposal, index) => {
      this.pending.set(proposal.id, { proposal, draft: drafts[index]!, auditId: auditEntries[index]!.id });
    });
    this.plans.set(planId, {
      id: planId,
      currentStep: 1,
      total: proposals.length,
      proposalIds: proposals.map((proposal) => proposal.id),
    });
    return { proposals };
  }

  async execute(id: string, decision: ComputerActionDecision): Promise<ComputerActionResult> {
    await this.pruneExpired();
    const pending = this.pending.get(id);
    if (!pending) throw new Error("该操作预览已过期，请重新发起");
    const { proposal, draft, auditId } = pending;
    if (!proposal.allowedDecisions.includes(decision)) throw new Error("该操作不支持所选授权方式");
    this.assertCurrentPlanStep(proposal);
    // 在任何外部异步操作前消费 ID，保证同一审批最多执行一次。
    this.pending.delete(id);
    this.executingAuditIds.add(auditId);
    const computerSettings = this.dependencies.getSettings().computer;
    const policy = computerSettings.permissions[proposal.tool];
    let status: ComputerActionResult["status"];
    let message: string;
    if (!computerSettings.enabled || policy === "deny") {
      status = "denied";
      message = "权限已关闭，操作没有执行。";
    } else if (decision === "deny") {
      status = "denied";
      message = "好，这次不做。";
    } else {
      ({ status, message } = await this.performAction(draft, proposal, decision));
    }

    const auditDetail = status === "denied"
      ? decision === "deny" ? "用户拒绝操作" : "权限在执行前被关闭"
      : message;
    const auditWarnings: string[] = [];
    try {
      await this.finishAudit(auditId, status, decision, auditDetail);
    } catch (error) {
      auditWarnings.push(error instanceof Error ? error.message : "审计写入失败");
    }
    if (status === "completed") this.advancePlan(proposal);
    else {
      try {
        await this.stopPlan(proposal, `计划因第 ${proposal.plan?.step ?? 1} 步未完成而停止`);
      } catch (error) {
        auditWarnings.push(error instanceof Error ? error.message : "计划收尾审计失败");
      }
    }
    if (auditWarnings.length > 0) message = `${message}；操作结果已确认，但本地审计暂未完整落盘。`;
    this.executingAuditIds.delete(auditId);
    return { id, status, message };
  }

  private createProposal(
    draft: ComputerActionDraft,
    policy: ComputerPermissionPolicy,
    now: Date,
    plan?: NonNullable<ComputerActionProposal["plan"]>,
  ): ComputerActionProposal {
    const trusted = policy === "allow" || this.sessionAllowed.has(draft.tool);
    return {
      id: randomUUID(),
      tool: draft.tool,
      title: toolLabel(draft.tool),
      description: descriptionFor(draft),
      preview: previewFor(draft),
      severity: draft.tool === "save-text-file" || draft.tool === "office-write" ? "warning" : "info",
      requiresApproval: !trusted,
      allowedDecisions: trusted
        ? ["allow-once", "deny"]
        : PERSISTENT_PERMISSION_TOOLS.has(draft.tool)
          ? ["allow-once", "allow-session", "allow-always", "deny"]
          : ["allow-once", "deny"],
      expiresAt: new Date(now.getTime() + ACTION_TTL_MS).toISOString(),
      ...(plan ? { plan } : {}),
    };
  }

  private createAuditEntry(
    value: Omit<ComputerAuditEntry, "id" | "createdAt" | "updatedAt">,
  ): ComputerAuditEntry {
    const now = this.now().toISOString();
    return { ...value, id: randomUUID(), createdAt: now, updatedAt: now };
  }

  private assertCurrentPlanStep(proposal: ComputerActionProposal): void {
    if (!proposal.plan) return;
    const plan = this.plans.get(proposal.plan.id);
    if (!plan) throw new Error("该协作计划已经停止，请重新发起");
    if (plan.currentStep !== proposal.plan.step) {
      throw new Error(`请先完成协作计划的第 ${plan.currentStep} 步`);
    }
  }

  private advancePlan(proposal: ComputerActionProposal): void {
    if (!proposal.plan) return;
    const plan = this.plans.get(proposal.plan.id);
    if (!plan) return;
    if (proposal.plan.step >= plan.total) this.plans.delete(plan.id);
    else plan.currentStep = proposal.plan.step + 1;
  }

  private async stopPlan(proposal: ComputerActionProposal, detail: string): Promise<void> {
    if (!proposal.plan) return;
    const plan = this.plans.get(proposal.plan.id);
    if (!plan) return;
    this.plans.delete(plan.id);
    let changed = false;
    const now = this.now().toISOString();
    for (const proposalId of plan.proposalIds) {
      const pending = this.pending.get(proposalId);
      if (!pending) continue;
      this.pending.delete(proposalId);
      const audit = this.state.audit.find((entry) => entry.id === pending.auditId);
      if (!audit || audit.status !== "pending") continue;
      audit.status = "cancelled";
      audit.detail = detail.slice(0, 300);
      audit.updatedAt = now;
      changed = true;
    }
    if (changed) await this.persist();
  }

  private async performAction(
    draft: ComputerActionDraft,
    proposal: ComputerActionProposal,
    decision: ComputerActionDecision,
  ): Promise<Pick<ComputerActionResult, "status" | "message">> {
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
          if (result.cancelled) return { status: "cancelled", message: "已取消保存。" };
          message = result.path ? `已保存到 ${result.path}` : "文本文件已保存";
          break;
        }
        case "launch-app":
          await this.dependencies.launchApp(draft.app);
          message = `已启动${draft.label}`;
          break;
        case "browser-control": {
          if (!this.dependencies.executeBrowserCommand) throw new Error("浏览器操作桥接尚未就绪");
          const result = await this.dependencies.executeBrowserCommand({
            action: draft.action,
            ...(draft.text ? { text: draft.text } : {}),
          });
          if (!result.ok) throw new Error(result.message);
          message = result.message;
          break;
        }
        case "office-write": {
          if (!this.dependencies.executeOffice) throw new Error("Office 自动化服务尚未就绪");
          const request: OfficeAutomationRequest = draft.operation === "word-append"
            ? { operation: draft.operation, text: draft.text }
            : draft.operation === "excel-write"
              ? { operation: draft.operation, startCell: draft.startCell, content: draft.content }
              : { operation: draft.operation, title: draft.title, body: draft.body };
          const result = await this.dependencies.executeOffice(request);
          message = result.message;
          break;
        }
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
      return { status: "completed", message };
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "操作执行失败",
      };
    }
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private async pruneExpired(): Promise<void> {
    const now = this.now().getTime();
    const expiredPlans = new Set<string>();
    for (const item of this.pending.values()) {
      if (Date.parse(item.proposal.expiresAt) <= now && item.proposal.plan) {
        expiredPlans.add(item.proposal.plan.id);
      }
    }
    let changed = false;
    for (const [id, item] of this.pending) {
      const planExpired = item.proposal.plan && expiredPlans.has(item.proposal.plan.id);
      if (Date.parse(item.proposal.expiresAt) > now && !planExpired) continue;
      this.pending.delete(id);
      const audit = this.state.audit.find((entry) => entry.id === item.auditId);
      if (audit && audit.status === "pending") {
        audit.status = "cancelled";
        audit.detail = planExpired ? "协作计划中的操作预览已过期，余下步骤已停止" : "操作预览已过期";
        audit.updatedAt = this.now().toISOString();
        changed = true;
      }
    }
    expiredPlans.forEach((planId) => this.plans.delete(planId));
    if (changed) await this.persist();
  }

  private async addAudit(
    value: Omit<ComputerAuditEntry, "id" | "createdAt" | "updatedAt">,
  ): Promise<string> {
    const entry = this.createAuditEntry(value);
    this.state.audit.push(entry);
    this.state.audit = this.state.audit.slice(-MAX_AUDIT_ITEMS);
    try {
      await this.persist();
    } catch (error) {
      this.state.audit = this.state.audit.filter((item) => item.id !== entry.id);
      throw error;
    }
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

function sanitizeDraft(value: ComputerActionDraft): ComputerActionDraft {
  if (!value || typeof value !== "object" || typeof value.tool !== "string") {
    throw new Error("电脑工具参数格式无效");
  }
  switch (value.tool) {
    case "open-url": {
      const url = typeof value.url === "string" ? safeDraftUrl(value.url) : undefined;
      if (!url) throw new Error("只能打开有效的 http(s) 网页地址");
      const label = typeof value.label === "string" && value.label.trim()
        ? trimPreview(value.label, 100)
        : new URL(url).hostname;
      return { tool: "open-url", url, label };
    }
    case "copy-text": {
      const text = typeof value.text === "string" ? value.text.trim().slice(0, 3000) : "";
      if (!text) throw new Error("写入剪贴板的文本为空");
      return { tool: "copy-text", text };
    }
    case "save-text-file": {
      const text = typeof value.text === "string" ? value.text.trim().slice(0, 3000) : "";
      if (!text) throw new Error("保存文本为空");
      const rawName = typeof value.suggestedName === "string" ? value.suggestedName : "桌宠记录.txt";
      const suggestedName = rawName
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
        .replace(/^\.+/, "")
        .trim()
        .slice(0, 100) || "桌宠记录.txt";
      return { tool: "save-text-file", text, suggestedName };
    }
    case "launch-app": {
      if (!new Set<AllowedDesktopApp>(["notepad", "calculator", "file-explorer"]).has(value.app)) {
        throw new Error("应用不在桌宠白名单中");
      }
      const label = { notepad: "记事本", calculator: "计算器", "file-explorer": "资源管理器" }[value.app];
      return { tool: "launch-app", app: value.app, label };
    }
    case "browser-control": {
      const actions = new Set([
        "reload", "go-back", "go-forward",
        "scroll-up", "scroll-down", "scroll-top", "scroll-bottom", "find-text",
      ]);
      if (!actions.has(value.action)) throw new Error("浏览器操作不在允许范围内");
      const text = value.action === "find-text"
        ? (typeof value.text === "string" ? value.text.replace(/\u0000/g, "").trim().slice(0, 200) : "")
        : undefined;
      if (value.action === "find-text" && !text) throw new Error("页内查找内容为空");
      const label = value.action === "reload"
        ? "刷新当前网页"
        : value.action === "go-back"
          ? "返回上一页"
          : value.action === "go-forward"
            ? "前进到下一页"
        : value.action === "scroll-up"
          ? "向上滚动当前网页"
          : value.action === "scroll-down"
            ? "向下滚动当前网页"
            : value.action === "scroll-top"
              ? "回到网页顶部"
              : value.action === "scroll-bottom"
                ? "滚动到网页底部"
            : `查找“${trimPreview(text!, 80)}”`;
      return { tool: "browser-control", action: value.action, ...(text ? { text } : {}), label };
    }
    case "office-write": {
      switch (value.operation) {
        case "word-append": {
          const text = sanitizeOfficeText(value.text, "Word 追加文本", 20_000);
          return { tool: "office-write", operation: value.operation, text };
        }
        case "excel-write": {
          const start = parseExcelStartCell(value.startCell);
          const table = sanitizeExcelContent(value.content);
          if (start.row + table.rowCount - 1 > 1_048_576 || start.column + table.columnCount - 1 > 16_384) {
            throw new Error("Excel 写入区域超出了工作表边界");
          }
          return { tool: "office-write", operation: value.operation, startCell: start.reference, content: table.content };
        }
        case "powerpoint-add-slide": {
          const title = sanitizeOfficeText(value.title, "PowerPoint 标题", 300);
          const body = sanitizeOfficeText(value.body, "PowerPoint 正文", 12_000);
          return { tool: "office-write", operation: value.operation, title, body };
        }
      }
    }
    default: {
      const exhaustive: never = value;
      throw new Error(`未知电脑工具：${String((exhaustive as { tool?: unknown }).tool)}`);
    }
  }
}

function safeDraftUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
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
    "browser-control", "office-write",
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
    case "browser-control": return "将由已配对的扩展在当前活动标签页执行一次受限操作。";
    case "office-write": return "将通过 Windows Office COM 写入当前已打开且可编辑的文档；不主动调用宏，但已有文档事件仍由 Office 自身处理。";
  }
}

function previewFor(draft: ComputerActionDraft): string {
  switch (draft.tool) {
    case "open-url": return draft.url;
    case "copy-text": return trimPreview(draft.text, 500);
    case "save-text-file": return trimPreview(draft.text, 500);
    case "launch-app": return draft.label;
    case "browser-control": return draft.label;
    case "office-write": {
      if (draft.operation === "word-append") return `Word 追加：${trimPreview(draft.text, 500)}`;
      if (draft.operation === "excel-write") {
        const content = typeof draft.content === "string"
          ? draft.content
          : draft.content.map((row) => row.join("\t")).join("\n");
        return `Excel ${draft.startCell} 起：${trimPreview(content, 500)}`;
      }
      return `PowerPoint 新增页｜${trimPreview(draft.title, 120)}｜${trimPreview(draft.body, 360)}`;
    }
  }
}

function sanitizeOfficeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const text = value.replace(/\u0000/g, "").trim();
  if (!text) throw new Error(`${label}为空`);
  if (text.length > maxLength) throw new Error(`${label}超过长度限制`);
  return text;
}

function sanitizeExcelContent(value: unknown): {
  content: string | string[][];
  rowCount: number;
  columnCount: number;
} {
  let sourceRows: unknown[][];
  let content: string | string[][];
  if (typeof value === "string") {
    if (!value.trim()) throw new Error("Excel 写入内容为空");
    if (value.includes("\u0000")) throw new Error("Excel 写入内容包含无效字符");
    if (value.length > 40_000) throw new Error("Excel 写入内容超过长度限制");
    const text = value.replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    while (lines.length > 1 && lines.at(-1) === "") lines.pop();
    sourceRows = lines.map((line) => line.split("\t"));
    content = text;
  } else if (Array.isArray(value)) {
    sourceRows = value;
    content = [];
  } else {
    throw new Error("Excel 写入内容必须是 TSV 文本或二维文本数组");
  }
  if (sourceRows.length < 1 || sourceRows.length > 200) throw new Error("Excel 单次写入需为 1～200 行");
  let cells = 0;
  let totalCharacters = 0;
  let columnCount = 0;
  const rows = sourceRows.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 50) throw new Error("Excel 每行需包含 1～50 个单元格");
    cells += row.length;
    columnCount = Math.max(columnCount, row.length);
    return row.map((cell) => {
      if (typeof cell !== "string") throw new Error("Excel 单元格必须是文本");
      if (cell.includes("\u0000")) throw new Error("Excel 单元格包含无效字符");
      if (cell.length > 8_000) throw new Error("Excel 单元格超过长度限制");
      totalCharacters += cell.length;
      return cell;
    });
  });
  if (sourceRows.length * columnCount > 2_000 || cells > 2_000) {
    throw new Error("Excel 单次写入最多为 2000 个单元格");
  }
  if (totalCharacters > 40_000) throw new Error("Excel 写入内容超过总长度限制");
  if (Array.isArray(content)) content = rows;
  return { content, rowCount: rows.length, columnCount };
}

function parseExcelStartCell(value: unknown): { reference: string; row: number; column: number } {
  const reference = typeof value === "string" ? value.trim().toUpperCase() : "";
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(reference);
  if (!match) throw new Error("Excel 起始单元格必须使用 A1 格式");
  let column = 0;
  for (const character of match[1]!) column = (column * 26) + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16_384 || row > 1_048_576) throw new Error("Excel 起始单元格超出了工作表边界");
  return { reference, row, column };
}

function trimPreview(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
