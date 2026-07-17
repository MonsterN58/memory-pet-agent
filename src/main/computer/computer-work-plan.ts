import type { ComputerActionDraft } from "./computer-action-planner";
import { safeHttpUrl } from "./computer-action-planner";

export const COMPUTER_WORK_PLAN_KINDS = [
  "open-url",
  "copy-text",
  "save-text-file",
  "launch-app",
  "browser-reload",
  "browser-go-back",
  "browser-go-forward",
  "browser-scroll-up",
  "browser-scroll-down",
  "browser-scroll-top",
  "browser-scroll-bottom",
  "browser-find-text",
  "word-append",
  "excel-write",
  "powerpoint-add-slide",
] as const;

export type ComputerWorkPlanKind = (typeof COMPUTER_WORK_PLAN_KINDS)[number];

export interface ParsedComputerWorkPlan {
  title: string;
  drafts: ComputerActionDraft[];
}

const KIND_SET = new Set<string>(COMPUTER_WORK_PLAN_KINDS);

export function parseComputerWorkPlan(value: unknown): ParsedComputerWorkPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("协作计划参数格式无效");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 4) {
    throw new Error("协作计划必须包含 2～4 个步骤");
  }
  const title = optionalText(input.title, 80) || "协作计划";
  return { title, drafts: input.steps.map(parseStep) };
}

function parseStep(value: unknown): ComputerActionDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("协作计划步骤格式无效");
  const step = value as Record<string, unknown>;
  const kind = requiredText(step.kind, "kind", 40) as ComputerWorkPlanKind;
  if (!KIND_SET.has(kind)) throw new Error(`协作计划包含未知步骤：${kind}`);
  switch (kind) {
    case "open-url": {
      const url = safeHttpUrl(requiredText(step.url, "url", 2_000));
      if (!url) throw new Error("协作计划只能打开 http(s) 网页");
      return { tool: "open-url", url, label: optionalText(step.label, 100) || new URL(url).hostname };
    }
    case "copy-text": return { tool: "copy-text", text: requiredText(step.text, "text", 3_000) };
    case "save-text-file": return {
      tool: "save-text-file",
      text: requiredText(step.text, "text", 3_000),
      suggestedName: optionalText(step.suggested_name, 100) || "桌宠记录.txt",
    };
    case "launch-app": {
      const app = requiredText(step.app, "app", 30);
      if (app !== "notepad" && app !== "calculator" && app !== "file-explorer") {
        throw new Error("协作计划中的应用不在白名单中");
      }
      return {
        tool: "launch-app",
        app,
        label: { notepad: "记事本", calculator: "计算器", "file-explorer": "资源管理器" }[app],
      };
    }
    case "browser-reload": return browserStep("reload", "刷新当前网页");
    case "browser-go-back": return browserStep("go-back", "返回上一页");
    case "browser-go-forward": return browserStep("go-forward", "前进到下一页");
    case "browser-scroll-up": return browserStep("scroll-up", "向上滚动当前网页");
    case "browser-scroll-down": return browserStep("scroll-down", "向下滚动当前网页");
    case "browser-scroll-top": return browserStep("scroll-top", "回到网页顶部");
    case "browser-scroll-bottom": return browserStep("scroll-bottom", "滚动到网页底部");
    case "browser-find-text": {
      const text = requiredText(step.text, "text", 200);
      return { tool: "browser-control", action: "find-text", text, label: `查找“${preview(text, 80)}”` };
    }
    case "word-append": return {
      tool: "office-write",
      operation: "word-append",
      text: requiredText(step.text, "text", 3_000),
    };
    case "excel-write": return {
      tool: "office-write",
      operation: "excel-write",
      startCell: requiredText(step.start_cell, "start_cell", 16),
      content: requiredTableText(step.text, "text", 3_000),
    };
    case "powerpoint-add-slide": return {
      tool: "office-write",
      operation: "powerpoint-add-slide",
      title: requiredText(step.title, "title", 300),
      body: requiredText(step.text, "text", 3_000),
    };
  }
}

function browserStep(
  action: Exclude<Extract<ComputerActionDraft, { tool: "browser-control" }>["action"], "find-text">,
  label: string,
): ComputerActionDraft {
  return { tool: "browser-control", action, label };
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function optionalText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, maxLength) : "";
}

function requiredTableText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  if (value.includes("\u0000")) throw new Error(`${name} 包含无效字符`);
  if (value.length > maxLength) throw new Error(`${name} 超过长度限制`);
  return value.replace(/\r\n?/g, "\n");
}

function preview(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
