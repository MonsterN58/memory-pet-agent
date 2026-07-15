import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import {
  classifyVisibleApplications,
  decodeTasklistOutput,
  DesktopAwarenessService,
  parseTasklistCsv,
  runTasklistOnWindows,
} from "../src/main/desktop-awareness-service";

const FIRST_SCAN = [
  '"chrome.exe","100","Console","1","120,000 K","Running","USER","0:00:02","Project, planning - Chrome"',
  '"msedge.exe","101","Console","1","80,000 K","Running","USER","0:00:01","N/A"',
  '"private-tool.exe","102","Console","1","50,000 K","Running","USER","0:00:01","Secret customer title"',
].join("\r\n");

const SECOND_SCAN = [
  FIRST_SCAN,
  '"Code.exe","200","Console","1","200,000 K","Running","USER","0:00:04","agent-service.ts - Visual Studio Code"',
].join("\r\n");

test("tasklist CSV 只映射已知可见应用，不暴露窗口标题", () => {
  const parsed = parseTasklistCsv(FIRST_SCAN);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.windowTitle, "Project, planning - Chrome");
  const activities = classifyVisibleApplications(parsed);
  assert.deepEqual(activities.map((item) => item.kind), ["browsing"]);
  assert.deepEqual(activities[0]?.processes, ["chrome.exe"]);
  assert.doesNotMatch(JSON.stringify(activities), /Project|Secret customer|planning/);
});

test("tasklist 兼容中文 Windows GBK 输出和暂缺窗口标记", () => {
  const prefix = Buffer.from('"msedge.exe","101","Console","1","80,000 K","Running","USER","0:00:01","', "ascii");
  const suffix = Buffer.from('"\r\n', "ascii");
  const gbkMissingTitle = Buffer.from([0xd4, 0xdd, 0xc8, 0xb1]); // 暂缺
  const decoded = decodeTasklistOutput(Buffer.concat([prefix, gbkMissingTitle, suffix]));
  assert.match(decoded, /暂缺/);
  const processes = parseTasklistCsv(decoded);
  assert.equal(processes[0]?.windowState, "hidden");
  assert.deepEqual(classifyVisibleApplications(processes), []);
});

test("tasklist 忽略 Windows 内部占位窗口，精简扫描不冒充可见窗口", () => {
  for (const title of ["OleMainThreadWndName", "无标题"]) {
    const internalWindow = parseTasklistCsv(
      `"msedge.exe","101","Console","1","80,000 K","Running","USER","0:00:01","${title}"`,
    );
    assert.deepEqual(classifyVisibleApplications(internalWindow), []);
  }

  const compact = parseTasklistCsv('"Code.exe","200","Console","1","200,000 K"');
  assert.equal(compact[0]?.windowState, "unknown");
  assert.deepEqual(classifyVisibleApplications(compact), []);
});

test("tasklist 详情被拒绝时只采用一次 MainWindowHandle 校正且不报告后台进程", async () => {
  let powerShellCalls = 0;
  const output = await runTasklistOnWindows({
    execTasklist: async (args) => {
      if (args.includes("/v")) throw new Error("Access denied");
      return [
        '"Code.exe","200","Console","1","200,000 K"',
        '"steamwebhelper.exe","201","Console","1","150,000 K"',
      ].join("\r\n");
    },
    runPowerShellVisibleProcesses: async () => {
      powerShellCalls += 1;
      return "";
    },
  });
  assert.equal(powerShellCalls, 1);
  assert.deepEqual(classifyVisibleApplications(parseTasklistCsv(output)), []);
});

test("tasklist 详情与 MainWindowHandle 查询都失败时公开失败状态", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.awareness.processDetectionEnabled = true;
  const service = new DesktopAwarenessService(() => settings, {
    platform: "win32",
    runTasklist: () => runTasklistOnWindows({
      execTasklist: async (args) => {
        if (args.includes("/v")) throw new Error("Access denied");
        return '"Code.exe","200","Console","1","200,000 K"';
      },
      runPowerShellVisibleProcesses: async () => {
        throw new Error("PowerShell unavailable");
      },
    }),
  });
  const snapshot = await service.observe("manual", { includeScreen: false });
  assert.equal(snapshot.processScanCompleted, false);
  assert.equal(snapshot.processStatus, "failed");
  assert.deepEqual(snapshot.applications, []);
  assert.match(snapshot.processScanError ?? "", /MainWindowHandle/);
});

test("桌面感知默认关闭时不会读取进程或屏幕", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  let processCalls = 0;
  let screenCalls = 0;
  const service = new DesktopAwarenessService(() => settings, {
    platform: "win32",
    visionConfigured: async () => true,
    runTasklist: async () => { processCalls += 1; return FIRST_SCAN; },
    captureScreen: async () => {
      screenCalls += 1;
      return { dataUrl: "data:image/jpeg;base64,SECRET", width: 640, height: 360 };
    },
  });

  const snapshot = await service.observe("scheduled");
  assert.equal(processCalls, 0);
  assert.equal(screenCalls, 0);
  assert.equal(snapshot.visionAnalysis, undefined);
  assert.equal(snapshot.screenStatus, "disabled");
  assert.equal(snapshot.processScanCompleted, false);
});

test("进程基线识别新活动，截图只在获准的非启动心跳中短时使用", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.awareness.processDetectionEnabled = true;
  settings.awareness.screenCaptureEnabled = true;
  let scan = 0;
  let screenCalls = 0;
  const service = new DesktopAwarenessService(() => settings, {
    platform: "win32",
    visionConfigured: async () => true,
    runTasklist: async () => scan++ === 0 ? FIRST_SCAN : SECOND_SCAN,
    captureScreen: async () => {
      screenCalls += 1;
      return { dataUrl: "data:image/jpeg;base64,TRANSIENT_SCREEN_BYTES", width: 640, height: 360 };
    },
    analyzeScreen: async (frame) => {
      assert.match(frame.dataUrl, /TRANSIENT_SCREEN_BYTES/);
      return {
        sceneSummary: "画面像是在编辑项目代码",
        currentTask: "处理桌宠功能",
        busyState: "focused",
        helpOpportunity: "可以帮忙检查测试",
        confidence: 0.72,
      };
    },
  });

  const startup = await service.observe("startup");
  assert.equal(startup.applications[0]?.newlyStarted, false);
  assert.equal(startup.visionAnalysis, undefined);
  assert.equal(startup.screenStatus, "startup-skipped");
  assert.equal(screenCalls, 0);

  const scheduled = await service.observe("scheduled");
  assert.equal(screenCalls, 1);
  assert.equal(scheduled.visionAnalysis?.currentTask, "处理桌宠功能");
  assert.equal(scheduled.screenSharedWithProvider, true);
  assert.equal(scheduled.applications.find((item) => item.kind === "coding")?.newlyStarted, true);
  assert.match(service.promptText(scheduled), /浏览网页/);
  assert.match(service.promptText(scheduled), /编写或阅读代码/);
  const audit = service.auditSummary(scheduled);
  assert.equal(audit.screenSharedWithProvider, true);
  assert.equal(audit.newApplicationCount, 1);
  assert.doesNotMatch(JSON.stringify(audit), /TRANSIENT_SCREEN_BYTES|agent-service\.ts|Visual Studio Code/);
});

test("屏幕开关开启但独立识图 API 未配置时不会截屏且返回明确状态", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.awareness.screenCaptureEnabled = true;
  let calls = 0;
  const service = new DesktopAwarenessService(() => settings, {
    platform: "win32",
    visionConfigured: async () => false,
    captureScreen: async () => {
      calls += 1;
      return { dataUrl: "data:image/jpeg;base64,NOPE", width: 320, height: 180 };
    },
  });
  const snapshot = await service.observe("manual");
  assert.equal(calls, 0);
  assert.equal(snapshot.visionAnalysis, undefined);
  assert.equal(snapshot.screenCaptureAttempted, false);
  assert.equal(snapshot.screenStatus, "not-configured");
  assert.match(snapshot.screenCaptureError ?? "", /识图 API/);
});

test("应用扫描成功但没有已知类别时返回 completed-empty 而不是失败", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.awareness.processDetectionEnabled = true;
  const service = new DesktopAwarenessService(() => settings, {
    platform: "win32",
    runTasklist: async () => '"private-tool.exe","102","Console","1","50,000 K","Running","USER","0:00:01","Private"',
  });
  const snapshot = await service.observe("manual", { includeScreen: false });
  assert.equal(snapshot.processScanCompleted, true);
  assert.equal(snapshot.processStatus, "completed-empty");
  assert.deepEqual(snapshot.applications, []);
});
