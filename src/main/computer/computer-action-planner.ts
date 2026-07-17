import type { ComputerTool } from "../../common/types";
import type { BrowserCommandAction } from "./browser-context-server";
import type { OfficeAutomationRequest } from "./office-automation-service";

export type AllowedDesktopApp = "notepad" | "calculator" | "file-explorer";

export type ComputerActionDraft =
  | { tool: "open-url"; url: string; label: string }
  | { tool: "copy-text"; text: string }
  | { tool: "save-text-file"; text: string; suggestedName: string }
  | { tool: "launch-app"; app: AllowedDesktopApp; label: string }
  | { tool: "browser-control"; action: BrowserCommandAction; text?: string; label: string }
  | ({ tool: "office-write" } & OfficeAutomationRequest);

export function planComputerActions(input: string): ComputerActionDraft[] {
  const text = input.trim().slice(0, 12_000);
  if (!text) return [];
  const segments = text
    .split(/\s*(?:[；;]|[，,]?\s*(?:然后|接着|随后|再))\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (segments.length >= 2 && segments.length <= 4) {
    const planned = segments.map((segment) => planComputerAction(segment));
    if (planned.every((item): item is ComputerActionDraft => Boolean(item))) return planned;
  }
  const single = planComputerAction(text);
  return single ? [single] : [];
}

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

  const browserFind = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:在)?(?:当前)?(?:网页|页面|浏览器标签页)(?:中|里)?(?:查找|找一下|搜索)[:：\s]+([\s\S]{1,200}?)[。.!！]?$/i,
  );
  if (browserFind?.[1]?.trim()) {
    const query = browserFind[1].trim();
    return { tool: "browser-control", action: "find-text", text: query, label: `查找“${preview(query, 80)}”` };
  }

  const browserHistory = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:让)?(?:浏览器|当前网页|当前页面)?(?:返回|后退)(?:到)?上一页[。.!！]?$/i,
  );
  if (browserHistory) return { tool: "browser-control", action: "go-back", label: "返回上一页" };
  const browserForward = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:让)?(?:浏览器|当前网页|当前页面)?(?:前进)(?:到)?下一页[。.!！]?$/i,
  );
  if (browserForward) return { tool: "browser-control", action: "go-forward", label: "前进到下一页" };
  const browserEdge = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:把|让)?(?:当前)?(?:网页|页面|浏览器|标签页)?(?:滚动|滚|回到|跳到)(?:至|到)?(?:页面|网页)?(顶部|顶端|底部|末尾)[。.!！]?$/i,
  );
  if (browserEdge) {
    const action: BrowserCommandAction = browserEdge[1] === "顶部" || browserEdge[1] === "顶端"
      ? "scroll-top"
      : "scroll-bottom";
    return { tool: "browser-control", action, label: action === "scroll-top" ? "回到网页顶部" : "滚动到网页底部" };
  }

  const browserAction = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:把|让)?(?:当前)?(?:网页|页面|浏览器|标签页)?(?:往|向)?(上滚|下滚|上翻|下翻|刷新|重新加载)(?:动|一下|当前网页|当前页面|网页|页面|浏览器|标签页)*[。.!！]?$/i,
  );
  if (browserAction) {
    const verb = browserAction[1]!;
    const action: BrowserCommandAction = verb === "刷新" || verb === "重新加载"
      ? "reload"
      : verb === "上滚" || verb === "上翻"
        ? "scroll-up"
        : "scroll-down";
    const label = action === "reload" ? "刷新当前网页" : action === "scroll-up" ? "向上滚动当前网页" : "向下滚动当前网页";
    return { tool: "browser-control", action, label };
  }

  const wordDirect = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:在|向)?\s*(?:当前)?Word(?:文档)?\s*(?:中|里)?\s*(?:追加|写入)[:：]\s*([\s\S]{1,3000})$/i,
  );
  const wordNatural = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:把)?([\s\S]{1,3000}?)(?:追加|写入)(?:到|进)?(?:当前)?Word(?:文档)?[。.!！]?$/i,
  );
  const wordText = (wordDirect?.[1] ?? wordNatural?.[1])?.trim();
  if (wordText) return { tool: "office-write", operation: "word-append", text: wordText };

  const excelDirect = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:在|向)?\s*(?:当前)?Excel(?:工作表)?(?:的)?\s*([A-Z]{1,3}[1-9][0-9]{0,6})(?:单元格)?(?:开始)?\s*(?:写入|填入)[:：]\s*([\s\S]{1,3000})$/i,
  );
  const excelNatural = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:把)?([\s\S]{1,3000}?)(?:写入|填入)(?:到|进)?(?:当前)?Excel(?:工作表)?(?:的)?\s*([A-Z]{1,3}[1-9][0-9]{0,6})(?:单元格)?[。.!！]?$/i,
  );
  const excelContent = (excelDirect?.[2] ?? excelNatural?.[1])?.trim();
  const excelCell = (excelDirect?.[1] ?? excelNatural?.[2])?.toUpperCase();
  if (excelContent && excelCell) {
    return { tool: "office-write", operation: "excel-write", startCell: excelCell, content: excelContent };
  }

  const powerpoint = text.match(
    /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:在|向)?\s*(?:当前)?(?:PowerPoint|PPT)(?:演示文稿)?(?:中|里)?\s*(?:新增|添加)(?:一)?(?:页|张)(?:幻灯片)?[:：\s]*标题[:：]\s*([\s\S]{1,300}?)[；;，,]\s*正文[:：]\s*([\s\S]{1,3000})$/i,
  );
  if (powerpoint) {
    return {
      tool: "office-write",
      operation: "powerpoint-add-slide",
      title: powerpoint[1]!.trim(),
      body: powerpoint[2]!.trim(),
    };
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
    "browser-control": "操作当前网页",
    "office-write": "写入 Office",
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
