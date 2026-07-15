import { execFile } from "node:child_process";
import type {
  AgentSettings,
  AwarenessChannelStatus,
  DesktopActivityKind,
  HeartbeatAwarenessSummary,
  HeartbeatEvent,
} from "../common/types";
import type { DesktopVisionAnalysis } from "./provider/openai-compatible-vision";

export interface DesktopScreenFrame {
  dataUrl: string;
  width: number;
  height: number;
}

export interface DesktopApplicationActivity {
  kind: DesktopActivityKind;
  label: string;
  processes: string[];
  newlyStarted: boolean;
}

export interface DesktopAwarenessSnapshot {
  capturedAt: string;
  screenCaptureAttempted: boolean;
  screenSharedWithProvider: boolean;
  screenStatus: AwarenessChannelStatus;
  screenCaptureError?: string;
  visionAnalysis?: DesktopVisionAnalysis;
  processScanCompleted: boolean;
  processStatus: AwarenessChannelStatus;
  processScanError?: string;
  applications: DesktopApplicationActivity[];
}

export interface DesktopObserveOptions {
  includeScreen?: boolean;
  includeProcess?: boolean;
}

export interface TasklistProcess {
  processName: string;
  pid: number;
  windowTitle: string;
  windowState: "visible" | "hidden" | "unknown";
}

export interface DesktopAwarenessDependencies {
  captureScreen?: () => Promise<DesktopScreenFrame | undefined>;
  runTasklist?: () => Promise<string>;
  platform?: NodeJS.Platform;
  visionConfigured?: () => Promise<boolean>;
  analyzeScreen?: (frame: DesktopScreenFrame, purpose: "manual" | "heartbeat") => Promise<DesktopVisionAnalysis>;
}

interface ActivityDefinition {
  kind: DesktopActivityKind;
  label: string;
  processNames: Set<string>;
}

const ACTIVITY_DEFINITIONS: ActivityDefinition[] = [
  definition("browsing", "浏览网页", ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"]),
  definition("coding", "编写或阅读代码", [
    "code.exe", "codium.exe", "devenv.exe", "idea64.exe", "pycharm64.exe", "webstorm64.exe",
    "rider64.exe", "androidstudio64.exe", "sublime_text.exe", "cursor.exe", "windsurf.exe", "trae.exe", "zed.exe",
  ]),
  definition("writing", "写作或整理笔记", ["notepad.exe", "notepad++.exe", "obsidian.exe", "typora.exe", "marktext.exe"]),
  definition("office", "处理文档或表格", ["winword.exe", "excel.exe", "powerpnt.exe", "et.exe", "wps.exe", "wpp.exe"]),
  definition("communication", "进行沟通", [
    "wechat.exe", "weixin.exe", "qq.exe", "dingtalk.exe", "feishu.exe", "lark.exe", "teams.exe", "discord.exe", "telegram.exe",
    "chatgpt.exe", "qclaw.exe",
  ]),
  definition("terminal", "使用终端", ["windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "mintty.exe"]),
  definition("design", "设计或制作图像", ["photoshop.exe", "illustrator.exe", "figma.exe", "blender.exe", "krita.exe", "clipstudiopaint.exe"]),
  definition("media", "播放影音内容", ["spotify.exe", "vlc.exe", "potplayermini64.exe", "music.ui.exe", "wmplayer.exe"]),
  definition("gaming", "游戏或浏览游戏库", ["steam.exe", "steamwebhelper.exe", "epicgameslauncher.exe", "battle.net.exe", "goggalaxy.exe", "wegame.exe"]),
];

export class DesktopAwarenessService {
  private previousActivityKinds?: Set<DesktopActivityKind>;
  private readonly runTasklist: () => Promise<string>;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly getSettings: () => AgentSettings,
    private readonly dependencies: DesktopAwarenessDependencies = {},
  ) {
    this.runTasklist = dependencies.runTasklist ?? runTasklistOnWindows;
    this.platform = dependencies.platform ?? process.platform;
  }

  async observe(
    reason: HeartbeatEvent["reason"],
    options: DesktopObserveOptions = {},
  ): Promise<DesktopAwarenessSnapshot> {
    const settings = this.getSettings().awareness;
    const includeProcess = options.includeProcess !== false;
    const includeScreen = options.includeScreen !== false;
    const snapshot: DesktopAwarenessSnapshot = {
      capturedAt: new Date().toISOString(),
      screenCaptureAttempted: false,
      screenSharedWithProvider: false,
      screenStatus: !includeScreen ? "not-requested" : settings.screenCaptureEnabled ? "not-configured" : "disabled",
      processScanCompleted: false,
      processStatus: !includeProcess ? "not-requested" : settings.processDetectionEnabled ? "failed" : "disabled",
      applications: [],
    };

    if (includeProcess && settings.processDetectionEnabled && this.platform === "win32") {
      try {
        const processes = parseTasklistCsv(await this.runTasklist());
        snapshot.applications = this.classifyWithLaunchState(processes);
        snapshot.processScanCompleted = true;
        snapshot.processStatus = snapshot.applications.length ? "completed" : "completed-empty";
      } catch (error) {
        snapshot.processScanError = shortError(error, "可见应用检测失败");
        snapshot.processStatus = "failed";
      }
    } else if (includeProcess && settings.processDetectionEnabled) {
      snapshot.processStatus = "not-supported";
    }

    if (!includeScreen || !settings.screenCaptureEnabled) return snapshot;
    if (reason === "startup") {
      snapshot.screenStatus = "startup-skipped";
      return snapshot;
    }
    const canUseVision = this.dependencies.visionConfigured
      ? await this.dependencies.visionConfigured().catch(() => false)
      : false;
    if (!canUseVision || !this.dependencies.captureScreen || !this.dependencies.analyzeScreen) {
      snapshot.screenStatus = "not-configured";
      snapshot.screenCaptureError = "识图 API 尚未配置完整；请在设置中单独填写识图端点、模型和 API Key。";
      return snapshot;
    }
    snapshot.screenCaptureAttempted = true;
    try {
      const frame = await this.dependencies.captureScreen();
      if (!frame) throw new Error("当前没有可用的屏幕画面");
      snapshot.screenSharedWithProvider = true;
      snapshot.visionAnalysis = await this.dependencies.analyzeScreen(
        frame,
        reason === "manual" ? "manual" : "heartbeat",
      );
      snapshot.screenStatus = "completed";
    } catch (error) {
      snapshot.screenStatus = "failed";
      snapshot.screenCaptureError = shortError(error, "屏幕识图失败");
    }
    return snapshot;
  }

  resetProcessBaseline(): void {
    this.previousActivityKinds = undefined;
  }

  promptText(snapshot: DesktopAwarenessSnapshot): string {
    const visible = snapshot.applications.map((item) => item.label);
    const started = snapshot.applications.filter((item) => item.newlyStarted).map((item) => item.label);
    const payload = {
      capturedAt: snapshot.capturedAt,
      visibleActivities: visible,
      newlyStartedActivities: started,
      processSignalNote: snapshot.processScanCompleted
        ? "这些只是本机固定只读查询推断出的粗粒度活动类别，不代表窗口正文，也不保证用户正在操作。"
        : "本轮没有可用的进程活动信号。",
      visionObservation: snapshot.visionAnalysis ? {
        sceneSummary: snapshot.visionAnalysis.sceneSummary,
        currentTask: snapshot.visionAnalysis.currentTask,
        busyState: snapshot.visionAnalysis.busyState,
        helpOpportunity: snapshot.visionAnalysis.helpOpportunity,
        confidence: snapshot.visionAnalysis.confidence,
      } : undefined,
      screenStatus: snapshot.screenStatus,
      screenNote: snapshot.visionAnalysis
        ? "这是独立识图端点返回的一次性低置信观察；原始图片未进入聊天模型，也不得把观察当作稳定用户事实。"
        : snapshot.screenCaptureError ?? "本轮没有可用的视觉观察。",
      processStatus: snapshot.processStatus,
      processError: snapshot.processScanError,
    };
    return `<desktop_context_data>${JSON.stringify(payload).replace(/</g, "\\u003c")}</desktop_context_data>`;
  }

  auditSummary(snapshot: DesktopAwarenessSnapshot): HeartbeatAwarenessSummary {
    return {
      screenSharedWithProvider: snapshot.screenSharedWithProvider,
      processScanCompleted: snapshot.processScanCompleted,
      visibleApplicationCount: snapshot.applications.length,
      newApplicationCount: snapshot.applications.filter((item) => item.newlyStarted).length,
      activityLabels: snapshot.applications.map((item) => item.label).slice(0, 9),
      screenStatus: snapshot.screenStatus,
      processStatus: snapshot.processStatus,
    };
  }

  private classifyWithLaunchState(processes: TasklistProcess[]): DesktopApplicationActivity[] {
    const visible = processes.filter(hasVisibleWindow);
    const hasBaseline = Boolean(this.previousActivityKinds);
    const previous = this.previousActivityKinds ?? new Set<DesktopActivityKind>();
    const grouped = new Map<DesktopActivityKind, DesktopApplicationActivity>();
    for (const process of visible) {
      const activity = activityForProcess(process.processName);
      if (!activity) continue;
      const current = grouped.get(activity.kind) ?? {
        kind: activity.kind,
        label: activity.label,
        processes: [],
        newlyStarted: false,
      };
      const processName = process.processName.toLowerCase();
      if (!current.processes.includes(processName)) current.processes.push(processName);
      grouped.set(activity.kind, current);
    }
    const currentKinds = new Set(grouped.keys());
    for (const [kind, activity] of grouped) {
      activity.newlyStarted = hasBaseline && !previous.has(kind);
    }
    this.previousActivityKinds = currentKinds;
    return ACTIVITY_DEFINITIONS.flatMap((definition) => {
      const activity = grouped.get(definition.kind);
      return activity ? [activity] : [];
    }).slice(0, 9);
  }
}

export function parseTasklistCsv(csv: string): TasklistProcess[] {
  const rows = csv.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result: TasklistProcess[] = [];
  for (const row of rows) {
    const fields = parseCsvRow(row);
    if (fields.length < 2) continue;
    const processName = fields[0]?.trim() ?? "";
    const pid = Number((fields[1] ?? "").replace(/[^0-9]/g, ""));
    const hasVerboseColumns = fields.length >= 9;
    const windowTitle = hasVerboseColumns ? fields.at(-1)?.trim() ?? "" : "";
    if (!processName || !Number.isFinite(pid) || pid <= 0) continue;
    result.push({
      processName: processName.slice(0, 120),
      pid,
      windowTitle: windowTitle.slice(0, 300),
      windowState: hasVerboseColumns ? windowStateFromTitle(windowTitle) : "unknown",
    });
  }
  return result;
}

export function classifyVisibleApplications(processes: TasklistProcess[]): DesktopApplicationActivity[] {
  const grouped = new Map<DesktopActivityKind, DesktopApplicationActivity>();
  for (const process of processes.filter(hasVisibleWindow)) {
    const definition = activityForProcess(process.processName);
    if (!definition) continue;
    const current = grouped.get(definition.kind) ?? {
      kind: definition.kind,
      label: definition.label,
      processes: [],
      newlyStarted: false,
    };
    const processName = process.processName.toLowerCase();
    if (!current.processes.includes(processName)) current.processes.push(processName);
    grouped.set(definition.kind, current);
  }
  return [...grouped.values()];
}

function definition(kind: DesktopActivityKind, label: string, processNames: string[]): ActivityDefinition {
  return { kind, label, processNames: new Set(processNames.map((name) => name.toLowerCase())) };
}

function activityForProcess(processName: string): ActivityDefinition | undefined {
  const normalized = processName.trim().toLowerCase();
  return ACTIVITY_DEFINITIONS.find((item) => item.processNames.has(normalized));
}

function hasVisibleWindow(process: TasklistProcess): boolean {
  return process.windowState === "visible";
}

const NON_WINDOW_TITLES = new Set([
  "", "n/a", "unknown", "不可用", "未知", "无", "不存在", "暂缺", "不适用", "无标题", "untitled",
  "olemainthreadwndname", "default ime", "msctfime ui",
]);

function windowStateFromTitle(windowTitle: string): TasklistProcess["windowState"] {
  return NON_WINDOW_TITLES.has(windowTitle.trim().toLowerCase()) ? "hidden" : "visible";
}

function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index]!;
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      fields.push(value);
      value = "";
      continue;
    }
    value += character;
  }
  fields.push(value);
  return fields;
}

interface WindowsProcessQueryDependencies {
  execTasklist?: (args: string[], timeout: number) => Promise<string>;
  runPowerShellVisibleProcesses?: () => Promise<string>;
}

export async function runTasklistOnWindows(
  dependencies: WindowsProcessQueryDependencies = {},
): Promise<string> {
  const queryTasklist = dependencies.execTasklist ?? execTasklist;
  const queryVisibleProcesses = dependencies.runPowerShellVisibleProcesses ?? runPowerShellVisibleProcesses;
  // Full `tasklist /v` scans can take tens of seconds on Windows 11 because they
  // resolve details for every service process. First collect the cheap process
  // list, then request verbose rows only for the small, hard-coded set of apps
  // this service knows how to classify.
  let compact: string;
  try {
    compact = await queryTasklist(["/fo", "csv", "/nh"], 5_000);
  } catch {
    try {
      return await queryVisibleProcesses();
    } catch {
      throw new Error("本机进程列表和可见窗口查询都没有完成");
    }
  }
  const compactRows = compact.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rowsByName = new Map<string, string[]>();
  for (const row of compactRows) {
    const processName = parseCsvRow(row)[0]?.trim().toLowerCase() ?? "";
    if (!activityForProcess(processName)) continue;
    const rows = rowsByName.get(processName) ?? [];
    rows.push(row);
    rowsByName.set(processName, rows);
  }

  const names = [...rowsByName.keys()];
  if (names.length === 0) return "";
  let detailQueryFailed = false;
  const detailed = await mapWithConcurrency(names, 4, async (processName) => {
    try {
      return await queryTasklist(
        ["/fo", "csv", "/nh", "/v", "/fi", `IMAGENAME eq ${processName}`],
        4_000,
      );
    } catch {
      detailQueryFailed = true;
      return "";
    }
  });
  if (detailQueryFailed) {
    try {
      // Compact tasklist rows only prove that a process exists. They do not prove
      // that the user has a visible window, so use one global MainWindowHandle
      // query to correct every failed verbose lookup instead of reporting tray
      // processes and background helpers as active applications.
      return await queryVisibleProcesses();
    } catch {
      throw new Error("应用详情查询失败，MainWindowHandle 校正也没有完成");
    }
  }
  return detailed.filter(Boolean).join("\r\n");
}

interface PowerShellProcessRow {
  processName?: unknown;
  pid?: unknown;
}

function runPowerShellVisibleProcesses(): Promise<string> {
  const executable = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${[
    "Get-Process",
    "Where-Object { $_.MainWindowHandle -ne 0 }",
    "ForEach-Object { [pscustomobject]@{ processName = ($_.ProcessName + '.exe'); pid = $_.Id } }",
    "ConvertTo-Json -Compress",
  ].join(" | ")}`;
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: 512 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = stdout.trim() ? JSON.parse(stdout) as PowerShellProcessRow | PowerShellProcessRow[] : [];
          const rows = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((item) => {
            const processName = typeof item.processName === "string" ? item.processName.trim() : "";
            const pid = Number(item.pid);
            if (!processName || !Number.isFinite(pid) || pid <= 0 || !activityForProcess(processName)) return [];
            return [`${csvField(processName)},${csvField(String(pid))},"","","","","","","visible"`];
          });
          resolve(rows.join("\r\n"));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function execTasklist(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tasklist.exe`,
      args,
      { encoding: null, windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(decodeTasklistOutput(stdout));
      },
    );
  });
}

export function decodeTasklistOutput(output: Uint8Array): string {
  if (output.length >= 2 && output[0] === 0xff && output[1] === 0xfe) {
    return Buffer.from(output.subarray(2)).toString("utf16le");
  }
  // tasklist writes through the active Windows ANSI code page when stdout is a
  // pipe. Chinese Windows therefore emits GBK bytes even in a UTF-8 Node app.
  return new TextDecoder("gbk").decode(output);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function shortError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/[\r\n]+/g, " ").slice(0, 180) || fallback;
}
