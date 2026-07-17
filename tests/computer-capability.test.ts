import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { AgentSettings, ComputerPermissionPolicy, ComputerTool } from "../src/common/types";
import {
  ComputerCapabilityController,
  type ComputerCapabilityDependencies,
} from "../src/main/computer/computer-capability-controller";
import { planComputerAction, planComputerActions, safeHttpUrl } from "../src/main/computer/computer-action-planner";

async function controllerFixture(
  context: { after(callback: () => void | Promise<void>): void },
  overrides: Partial<ComputerCapabilityDependencies> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-computer-review-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  settings.computer.enabled = true;
  settings.computer.browserContextEnabled = true;
  const dependencies: ComputerCapabilityDependencies = {
    getSettings: () => structuredClone(settings),
    openUrl: async () => {},
    copyText: () => {},
    saveText: async () => ({ cancelled: false }),
    launchApp: async () => {},
    persistPermission: async () => {},
    ...overrides,
  };
  const controller = new ComputerCapabilityController(directory, dependencies);
  await controller.initialize();
  return { controller, settings, directory, dependencies };
}

test("自然语言工作规划只生成白名单内的固定参数动作", () => {
  assert.deepEqual(planComputerAction("帮我打开 https://example.com/docs"), {
    tool: "open-url",
    url: "https://example.com/docs",
    label: "example.com",
  });
  assert.deepEqual(planComputerAction("帮我搜索 Live2D Cubism 5"), {
    tool: "open-url",
    url: "https://www.bing.com/search?q=Live2D%20Cubism%205",
    label: "搜索“Live2D Cubism 5”",
  });
  assert.deepEqual(planComputerAction("把 hello world 复制到剪贴板"), {
    tool: "copy-text",
    text: "hello world",
  });
  assert.deepEqual(planComputerAction("把会议结论保存为文本文件"), {
    tool: "save-text-file",
    text: "会议结论",
    suggestedName: "桌宠记录.txt",
  });
  assert.deepEqual(planComputerAction("打开计算器"), {
    tool: "launch-app",
    app: "calculator",
    label: "计算器",
  });
  assert.deepEqual(planComputerAction("刷新当前网页"), {
    tool: "browser-control",
    action: "reload",
    label: "刷新当前网页",
  });
  assert.deepEqual(planComputerAction("向下滚动网页"), {
    tool: "browser-control",
    action: "scroll-down",
    label: "向下滚动当前网页",
  });
  assert.deepEqual(planComputerAction("在当前网页查找：Live2D"), {
    tool: "browser-control",
    action: "find-text",
    text: "Live2D",
    label: "查找“Live2D”",
  });
  assert.deepEqual(planComputerAction("浏览器返回上一页"), {
    tool: "browser-control",
    action: "go-back",
    label: "返回上一页",
  });
  assert.deepEqual(planComputerAction("把网页滚动到底部"), {
    tool: "browser-control",
    action: "scroll-bottom",
    label: "滚动到网页底部",
  });
  assert.deepEqual(planComputerAction("在 Word 中追加：会议结论"), {
    tool: "office-write",
    operation: "word-append",
    text: "会议结论",
  });
  assert.deepEqual(planComputerAction("在 Excel B2 写入：姓名\t状态\n小忆\t完成"), {
    tool: "office-write",
    operation: "excel-write",
    startCell: "B2",
    content: "姓名\t状态\n小忆\t完成",
  });
  assert.deepEqual(planComputerAction("在 PPT 添加一页：标题：周报；正文：本周完成三项任务"), {
    tool: "office-write",
    operation: "powerpoint-add-slide",
    title: "周报",
    body: "本周完成三项任务",
  });
  assert.equal(planComputerAction("你觉得计算器好用吗"), undefined);
  assert.equal(safeHttpUrl("javascript:alert(1)"), undefined);
  assert.equal(safeHttpUrl("file:///C:/secret.txt"), undefined);
});

test("明确的复合工作请求会拆成最多四个仍需逐项审批的固定步骤", () => {
  assert.deepEqual(
    planComputerActions("打开 https://example.com，然后向下滚动网页，再在当前网页查找：安装"),
    [
      { tool: "open-url", url: "https://example.com/", label: "example.com" },
      { tool: "browser-control", action: "scroll-down", label: "向下滚动当前网页" },
      { tool: "browser-control", action: "find-text", text: "安装", label: "查找“安装”" },
    ],
  );
  assert.deepEqual(planComputerActions("打开计算器"), [
    { tool: "launch-app", app: "calculator", label: "计算器" },
  ]);
  assert.deepEqual(
    planComputerActions("打开计算器，然后做一件不在白名单里的事"),
    [],
  );
});

test("浏览器和 Office 工具每次确认后只执行固定的单步参数", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-computer-browser-office-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  settings.computer.enabled = true;
  settings.computer.browserContextEnabled = true;
  const calls: string[] = [];
  const controller = new ComputerCapabilityController(directory, {
    getSettings: () => structuredClone(settings),
    openUrl: async () => {},
    copyText: () => {},
    saveText: async () => ({ cancelled: true }),
    launchApp: async () => {},
    executeBrowserCommand: async (request) => {
      calls.push(`browser:${request.action}:${request.text ?? ""}`);
      return {
        id: "00000000-0000-4000-8000-000000000011",
        action: request.action,
        ok: true,
        message: "已在当前网页完成操作",
        completedAt: new Date().toISOString(),
      };
    },
    executeOffice: async (request) => {
      calls.push(`office:${request.operation}`);
      if (request.operation === "word-append") {
        return {
          operation: request.operation,
          application: "word",
          message: "已向当前 Word 文档追加文本。",
          charactersWritten: request.text.length,
        };
      }
      if (request.operation === "excel-write") {
        return {
          operation: request.operation,
          application: "excel",
          message: "已写入当前 Excel 工作表。",
          startCell: request.startCell,
          rowsWritten: 1,
          columnsWritten: 1,
          cellsWritten: 1,
        };
      }
      return {
        operation: request.operation,
        application: "powerpoint",
        message: "已在当前 PowerPoint 中添加一页。",
      };
    },
    persistPermission: async () => {},
  });
  await controller.initialize();

  const browser = await controller.planDraft({
    tool: "browser-control",
    action: "find-text",
    text: "  Live2D  ",
    label: "模型提供的标签不会被信任",
  });
  assert.ok(browser.proposal);
  assert.equal(browser.proposal.preview, "查找“Live2D”");
  assert.deepEqual(browser.proposal.allowedDecisions, ["allow-once", "deny"]);
  const browserResult = await controller.execute(browser.proposal.id, "allow-once");
  assert.equal(browserResult.status, "completed");

  const office = await controller.planDraft({
    tool: "office-write",
    operation: "word-append",
    text: "  会议结论  ",
  });
  assert.ok(office.proposal);
  assert.equal(office.proposal.severity, "warning");
  assert.deepEqual(office.proposal.allowedDecisions, ["allow-once", "deny"]);
  const officeResult = await controller.execute(office.proposal.id, "allow-once");
  assert.equal(officeResult.status, "completed");

  assert.deepEqual(calls, ["browser:find-text:Live2D", "office:word-append"]);
  assert.ok(controller.recentAudit().some((item) => item.action === "browser-control" && item.status === "completed"));
  assert.ok(controller.recentAudit().some((item) => item.action === "office-write" && item.status === "completed"));
});

test("协作计划会先校验全部步骤，再一次生成 2～4 个独立审批预览", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-computer-plan-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  settings.computer.enabled = true;
  settings.computer.browserContextEnabled = true;
  const controller = new ComputerCapabilityController(directory, {
    getSettings: () => structuredClone(settings),
    openUrl: async () => {},
    copyText: () => {},
    saveText: async () => ({ cancelled: true }),
    launchApp: async () => {},
    executeBrowserCommand: async (request) => ({
      id: crypto.randomUUID(), action: request.action, ok: true,
      message: "浏览器步骤完成", completedAt: new Date().toISOString(),
    }),
    persistPermission: async () => {},
  });
  await controller.initialize();

  settings.computer.permissions["copy-text"] = "deny";
  const denied = await controller.planDrafts([
    { tool: "open-url", url: "https://example.com", label: "示例" },
    { tool: "copy-text", text: "摘要" },
  ]);
  assert.equal(denied.proposals.length, 0);
  assert.match(denied.warning ?? "", /写入剪贴板.*禁止/);

  settings.computer.permissions["copy-text"] = "ask";
  const planned = await controller.planDrafts([
    { tool: "open-url", url: "https://example.com", label: "示例" },
    { tool: "browser-control", action: "scroll-bottom", label: "滚动到底部" },
  ]);
  assert.equal(planned.proposals.length, 2);
  assert.notEqual(planned.proposals[0]?.id, planned.proposals[1]?.id);
  assert.deepEqual(planned.proposals.map((item) => item.allowedDecisions), [
    ["allow-once", "allow-session", "allow-always", "deny"],
    ["allow-once", "deny"],
  ]);
});

test("电脑能力控制器按本次、会话、始终和拒绝策略执行并审计", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-computer-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  settings.computer.enabled = true;
  const calls: string[] = [];
  const controller = new ComputerCapabilityController(directory, {
    getSettings: () => structuredClone(settings),
    openUrl: async (url) => { calls.push(`open:${url}`); },
    copyText: (text) => { calls.push(`copy:${text}`); },
    saveText: async (_name, text) => {
      calls.push(`save:${text}`);
      return { cancelled: false, path: "D:\\result.txt" };
    },
    launchApp: async (app) => { calls.push(`app:${app}`); },
    persistPermission: async (tool: ComputerTool, policy: ComputerPermissionPolicy) => {
      settings.computer.permissions[tool] = policy;
      calls.push(`permission:${tool}:${policy}`);
    },
  });
  await controller.initialize();

  const first = await controller.planFromChat("帮我打开 https://example.com");
  assert.ok(first.proposal);
  assert.equal(first.proposal.requiresApproval, true);
  assert.deepEqual(first.proposal.allowedDecisions, ["allow-once", "allow-session", "allow-always", "deny"]);
  const firstResult = await controller.execute(first.proposal.id, "allow-session");
  assert.equal(firstResult.status, "completed");
  assert.match(calls[0]!, /^open:https:\/\/example\.com\/?$/);

  const sessionAction = await controller.planFromChat("打开 https://example.org");
  assert.equal(sessionAction.proposal?.requiresApproval, false);
  assert.deepEqual(controller.sessionAllowedTools(), ["open-url"]);

  const copy = await controller.planFromChat("复制：桌宠测试");
  assert.ok(copy.proposal);
  const copyResult = await controller.execute(copy.proposal.id, "allow-always");
  assert.equal(copyResult.status, "completed");
  assert.ok(calls.includes("copy:桌宠测试"));
  assert.ok(calls.includes("permission:copy-text:allow"));

  const save = await controller.planFromChat("保存为文本文件：要保存的内容");
  assert.ok(save.proposal);
  assert.deepEqual(save.proposal.allowedDecisions, ["allow-once", "deny"]);
  await assert.rejects(() => controller.execute(save.proposal!.id, "allow-always"), /不支持所选授权方式/);
  const denied = await controller.execute(save.proposal.id, "deny");
  assert.equal(denied.status, "denied");
  assert.equal(calls.some((item) => item.startsWith("save:")), false);

  const audit = controller.recentAudit();
  assert.ok(audit.some((item) => item.action === "open-url" && item.status === "completed"));
  assert.ok(audit.some((item) => item.action === "copy-text" && item.decision === "allow-always"));
  assert.ok(audit.some((item) => item.action === "save-text-file" && item.status === "denied"));
});

test("禁止策略和关闭总开关会在执行前拦截", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-computer-deny-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  const controller = new ComputerCapabilityController(directory, {
    getSettings: () => structuredClone(settings),
    openUrl: async () => {},
    copyText: () => {},
    saveText: async () => ({ cancelled: true }),
    launchApp: async () => {},
    persistPermission: async () => {},
  });
  await controller.initialize();

  const disabled = await controller.planFromChat("打开 https://example.com");
  assert.match(disabled.warning ?? "", /尚未启用/);
  assert.equal(disabled.proposal, undefined);

  settings.computer.enabled = true;
  const bridgeDisabled = await controller.planDraft({
    tool: "browser-control",
    action: "reload",
    label: "刷新当前网页",
  });
  assert.match(bridgeDisabled.warning ?? "", /浏览器桥接尚未启用/);
  assert.equal(bridgeDisabled.proposal, undefined);

  settings.computer.permissions["open-url"] = "deny";
  const denied = await controller.planFromChat("打开 https://example.com");
  assert.match(denied.warning ?? "", /权限.*禁止/);
  assert.equal(denied.proposal, undefined);
});

test("模型工具草稿在主进程再次清洗 URL、文本长度和建议文件名", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-computer-tool-draft-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  settings.computer.enabled = true;
  let savedName = "";
  let savedText = "";
  const controller = new ComputerCapabilityController(directory, {
    getSettings: () => structuredClone(settings),
    openUrl: async () => {},
    copyText: () => {},
    saveText: async (name, text) => {
      savedName = name;
      savedText = text;
      return { cancelled: false, path: "D:\\result.txt" };
    },
    launchApp: async () => {},
    persistPermission: async () => {},
  });
  await controller.initialize();

  await assert.rejects(() => controller.planDraft({
    tool: "open-url",
    url: "file:///C:/secret.txt",
    label: "本地文件",
  }), /http\(s\)/);
  await assert.rejects(() => controller.planDraft({
    tool: "office-write",
    operation: "excel-write",
    startCell: "XFE1",
    content: "越界",
  }), /工作表边界/);
  await assert.rejects(() => controller.planDraft({
    tool: "office-write",
    operation: "excel-write",
    startCell: "XFD1048576",
    content: "一\t二",
  }), /写入区域.*边界/);

  const planned = await controller.planDraft({
    tool: "save-text-file",
    text: `  ${"内容".repeat(2000)}  `,
    suggestedName: "..\\..\\危险:name?.md",
  });
  assert.ok(planned.proposal);
  const result = await controller.execute(planned.proposal.id, "allow-once");
  assert.equal(result.status, "completed");
  assert.equal(savedText.length, 3000);
  assert.equal(savedName.includes("\\"), false);
  assert.equal(savedName.includes(":"), false);
});

test("操作完成后长期权限保存失败不会把已执行动作误记为失败", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-computer-permission-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  settings.computer.enabled = true;
  let copied = "";
  const controller = new ComputerCapabilityController(directory, {
    getSettings: () => structuredClone(settings),
    openUrl: async () => {},
    copyText: (text) => { copied = text; },
    saveText: async () => ({ cancelled: true }),
    launchApp: async () => {},
    persistPermission: async () => { throw new Error("磁盘忙"); },
  });
  await controller.initialize();

  const planned = await controller.planFromChat("复制：已经完成的内容");
  assert.ok(planned.proposal);
  const result = await controller.execute(planned.proposal.id, "allow-always");
  assert.equal(copied, "已经完成的内容");
  assert.equal(result.status, "completed");
  assert.match(result.message, /长期权限未保存.*磁盘忙/);
  assert.ok(controller.recentAudit().some((item) => item.status === "completed" && /长期权限未保存/.test(item.detail ?? "")));
});

test("过期操作会撤销待确认状态并写入审计", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-computer-expiry-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  settings.computer.enabled = true;
  let now = new Date("2026-07-15T00:00:00.000Z");
  const controller = new ComputerCapabilityController(directory, {
    getSettings: () => structuredClone(settings),
    openUrl: async () => {},
    copyText: () => {},
    saveText: async () => ({ cancelled: true }),
    launchApp: async () => {},
    persistPermission: async () => {},
    now: () => now,
  });
  await controller.initialize();

  const planned = await controller.planFromChat("打开 https://example.com");
  assert.ok(planned.proposal);
  now = new Date("2026-07-15T00:06:00.000Z");
  await assert.rejects(() => controller.execute(planned.proposal!.id, "allow-once"), /已过期/);
  assert.ok(controller.recentAudit().some((item) => (
    item.action === "open-url"
    && item.status === "cancelled"
    && item.detail === "操作预览已过期"
  )));
});

test("同一审批 ID 并发提交时只执行一次底层操作", async (context) => {
  let calls = 0;
  const { controller } = await controllerFixture(context, {
    openUrl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  const planned = await controller.planDraft({
    tool: "open-url", url: "https://example.com/concurrent", label: "并发测试",
  });
  assert.ok(planned.proposal);

  const results = await Promise.allSettled([
    controller.execute(planned.proposal.id, "allow-once"),
    controller.execute(planned.proposal.id, "allow-once"),
  ]);

  assert.equal(calls, 1);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(results.find((item) => item.status === "fulfilled")?.value.status, "completed");
});

test("主进程强制协作计划按序执行并在拒绝后撤销余下步骤", async (context) => {
  const calls: string[] = [];
  const { controller } = await controllerFixture(context, {
    openUrl: async () => { calls.push("open"); },
    copyText: () => { calls.push("copy"); },
  });
  const planned = await controller.planDrafts([
    { tool: "open-url", url: "https://example.com/plan", label: "计划页面" },
    { tool: "copy-text", text: "计划摘要" },
  ], "顺序测试");
  assert.equal(planned.proposals[0]?.plan?.title, "顺序测试");
  await assert.rejects(
    () => controller.execute(planned.proposals[1]!.id, "allow-once"),
    /先完成.*第 1 步/,
  );
  assert.deepEqual(calls, []);
  assert.equal((await controller.execute(planned.proposals[0]!.id, "allow-once")).status, "completed");
  assert.equal((await controller.execute(planned.proposals[1]!.id, "allow-once")).status, "completed");
  assert.deepEqual(calls, ["open", "copy"]);

  const stopped = await controller.planDrafts([
    { tool: "open-url", url: "https://example.com/stop", label: "停止测试" },
    { tool: "copy-text", text: "不应执行" },
  ]);
  assert.equal((await controller.execute(stopped.proposals[0]!.id, "deny")).status, "denied");
  await assert.rejects(
    () => controller.execute(stopped.proposals[1]!.id, "allow-once"),
    /过期|重新发起/,
  );
  const cancelled = controller.recentAudit().find((item) => item.summary.includes("不应执行"));
  assert.equal(cancelled?.status, "cancelled");
  assert.doesNotMatch(cancelled?.detail ?? "", /用户拒绝/);
});

test("计划批量落盘失败不会留下孤立 pending 或审计", async (context) => {
  const { controller } = await controllerFixture(context);
  const internals = controller as unknown as { persist(): Promise<void> };
  const originalPersist = internals.persist.bind(controller);
  internals.persist = async () => { throw new Error("模拟磁盘错误"); };

  await assert.rejects(() => controller.planDrafts([
    { tool: "open-url", url: "https://example.com/a", label: "A" },
    { tool: "copy-text", text: "B" },
  ]), /模拟磁盘错误/);
  assert.deepEqual(controller.recentAudit(), []);

  internals.persist = originalPersist;
  const recovered = await controller.planDraft({ tool: "copy-text", text: "恢复后可继续" });
  assert.ok(recovered.proposal);
});

test("清空审计会同步撤销未执行预览，重启会收尾旧 pending", async (context) => {
  const fixture = await controllerFixture(context);
  const pending = await fixture.controller.planDraft({ tool: "copy-text", text: "待清空" });
  assert.ok(pending.proposal);
  await fixture.controller.clearAudit();
  assert.deepEqual(fixture.controller.recentAudit(), []);
  await assert.rejects(
    () => fixture.controller.execute(pending.proposal!.id, "allow-once"),
    /过期|重新发起/,
  );

  const stale = await fixture.controller.planDraft({ tool: "copy-text", text: "跨重启 pending" });
  assert.ok(stale.proposal);
  const restarted = new ComputerCapabilityController(fixture.directory, fixture.dependencies);
  await restarted.initialize();
  const recoveredAudit = restarted.recentAudit().find((item) => item.summary.includes("跨重启"));
  assert.equal(recoveredAudit?.status, "cancelled");
  assert.match(recoveredAudit?.detail ?? "", /重启/);
});

test("审计落盘失败不会把已完成操作误报为失败", async (context) => {
  let calls = 0;
  const { controller } = await controllerFixture(context, {
    openUrl: async () => { calls += 1; },
  });
  const planned = await controller.planDraft({
    tool: "open-url", url: "https://example.com/audit", label: "审计测试",
  });
  assert.ok(planned.proposal);
  const internals = controller as unknown as { persist(): Promise<void> };
  const originalPersist = internals.persist.bind(controller);
  internals.persist = async () => { throw new Error("模拟审计写入失败"); };

  const result = await controller.execute(planned.proposal.id, "allow-once");
  internals.persist = originalPersist;
  assert.equal(calls, 1);
  assert.equal(result.status, "completed");
  assert.match(result.message, /结果已确认.*审计/);
});

test("Excel TSV 会保留首尾空单元格", async (context) => {
  let captured: unknown;
  const { controller } = await controllerFixture(context, {
    executeOffice: async (request) => {
      captured = structuredClone(request);
      return {
        operation: "excel-write", application: "excel", message: "已写入",
        startCell: "A1", rowsWritten: 2, columnsWritten: 2, cellsWritten: 4,
      };
    },
  });
  const content = "\tB\nA\t";
  const planned = await controller.planDraft({
    tool: "office-write", operation: "excel-write", startCell: "A1", content,
  });
  assert.ok(planned.proposal);
  const result = await controller.execute(planned.proposal.id, "allow-once");
  assert.equal(result.status, "completed");
  assert.deepEqual(captured, { operation: "excel-write", startCell: "A1", content });
});
