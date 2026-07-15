import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import {
  classifyVisibleApplications,
  DesktopAwarenessService,
  parseTasklistCsv,
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

test("桌面感知默认关闭时不会读取进程或屏幕", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  let processCalls = 0;
  let screenCalls = 0;
  const service = new DesktopAwarenessService(() => settings, {
    platform: "win32",
    providerConfigured: async () => true,
    runTasklist: async () => { processCalls += 1; return FIRST_SCAN; },
    captureScreen: async () => {
      screenCalls += 1;
      return { dataUrl: "data:image/jpeg;base64,SECRET", width: 640, height: 360 };
    },
  });

  const snapshot = await service.observe("scheduled");
  assert.equal(processCalls, 0);
  assert.equal(screenCalls, 0);
  assert.equal(snapshot.screen, undefined);
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
    providerConfigured: async () => true,
    runTasklist: async () => scan++ === 0 ? FIRST_SCAN : SECOND_SCAN,
    captureScreen: async () => {
      screenCalls += 1;
      return { dataUrl: "data:image/jpeg;base64,TRANSIENT_SCREEN_BYTES", width: 640, height: 360 };
    },
  });

  const startup = await service.observe("startup");
  assert.equal(startup.applications[0]?.newlyStarted, false);
  assert.equal(startup.screen, undefined);
  assert.equal(screenCalls, 0);

  const scheduled = await service.observe("scheduled");
  assert.equal(screenCalls, 1);
  assert.equal(scheduled.screen?.dataUrl, "data:image/jpeg;base64,TRANSIENT_SCREEN_BYTES");
  assert.equal(scheduled.applications.find((item) => item.kind === "coding")?.newlyStarted, true);
  assert.match(service.promptText(scheduled), /浏览网页/);
  assert.match(service.promptText(scheduled), /编写或阅读代码/);
  const audit = service.auditSummary(scheduled);
  assert.equal(audit.screenSharedWithProvider, true);
  assert.equal(audit.newApplicationCount, 1);
  assert.doesNotMatch(JSON.stringify(audit), /TRANSIENT_SCREEN_BYTES|agent-service\.ts|Visual Studio Code/);
});

test("屏幕开关开启但聊天模型未配置时不会截屏", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.awareness.screenCaptureEnabled = true;
  let calls = 0;
  const service = new DesktopAwarenessService(() => settings, {
    platform: "win32",
    providerConfigured: async () => false,
    captureScreen: async () => {
      calls += 1;
      return { dataUrl: "data:image/jpeg;base64,NOPE", width: 320, height: 180 };
    },
  });
  const snapshot = await service.observe("manual");
  assert.equal(calls, 0);
  assert.equal(snapshot.screen, undefined);
  assert.equal(snapshot.screenCaptureAttempted, false);
});
