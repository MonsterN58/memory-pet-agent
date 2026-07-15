import type { ComputerTool } from "../../common/types";

export type AllowedDesktopApp = "notepad" | "calculator" | "file-explorer";

export type ComputerActionDraft =
  | { tool: "open-url"; url: string; label: string }
  | { tool: "copy-text"; text: string }
  | { tool: "save-text-file"; text: string; suggestedName: string }
  | { tool: "launch-app"; app: AllowedDesktopApp; label: string };

export function planComputerAction(input: string): ComputerActionDraft | undefined {
  const text = input.trim().slice(0, 4000);
  if (!text) return undefined;

  const app = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:打开|启动|运行)(?:一下)?\s*(记事本|计算器|文件资源管理器|资源管理器)[。.!！]?$/i,
  );
  if (app) {
    const label = app[1]!;
    return {
      tool: "launch-app",
      app: label === "记事本" ? "notepad" : label === "计算器" ? "calculator" : "file-explorer",
      label,
    };
  }

  const open = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:打开|访问|进入|跳转到)(?:一下)?\s*((?:https?:\/\/|www\.)[^\s<>"']+)[。.!！]?$/i,
  );
  if (open) {
    const url = safeHttpUrl(open[1]!);
    if (url) return { tool: "open-url", url, label: hostLabel(url) };
  }

  const search = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:(?:在|用)(?:浏览器|必应|bing)(?:里|中)?\s*)?(?:搜索|搜一下|查找|查一下)[:：\s]+([\s\S]{1,500}?)[。.!！]?$/i,
  );
  if (search) {
    const query = search[1]!.trim();
    if (query) {
      return {
        tool: "open-url",
        url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
        label: `搜索“${preview(query, 80)}”`,
      };
    }
  }

  const directCopy = text.match(/^(?:请|麻烦)?(?:你)?(?:帮我)?复制[:：]\s*([\s\S]{1,3000})$/i);
  const naturalCopy = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:把)?([\s\S]{1,3000}?)(?:复制到|放到)(?:我的)?剪贴板[。.!！]?$/i,
  );
  const copyText = (directCopy?.[1] ?? naturalCopy?.[1])?.trim();
  if (copyText) return { tool: "copy-text", text: copyText };

  const directSave = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:保存|写入)(?:为|到)?(?:一个)?(?:本地)?(?:文本)?文件[:：]\s*([\s\S]{1,3000})$/i,
  );
  const naturalSave = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:把)?([\s\S]{1,3000}?)(?:保存|写入)(?:为|到)?(?:一个)?(?:本地)?(?:文本)?文件[。.!！]?$/i,
  );
  const saveText = (directSave?.[1] ?? naturalSave?.[1])?.trim();
  if (saveText) {
    return { tool: "save-text-file", text: saveText, suggestedName: "桌宠记录.txt" };
  }

  return undefined;
}

export function toolLabel(tool: ComputerTool): string {
  return {
    "open-url": "打开网页",
    "copy-text": "写入剪贴板",
    "save-text-file": "保存文本文件",
    "launch-app": "启动应用",
  }[tool];
}

export function safeHttpUrl(value: string): string | undefined {
  const candidate = value.trim().replace(/[。.!！,，;；)）\]}]+$/, "");
  try {
    const url = new URL(candidate.startsWith("www.") ? `https://${candidate}` : candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "网页";
  }
}

function preview(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
