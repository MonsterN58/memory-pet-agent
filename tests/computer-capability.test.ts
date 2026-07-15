import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { AgentSettings, ComputerPermissionPolicy, ComputerTool } from "../src/common/types";
import { ComputerCapabilityController } from "../src/main/computer/computer-capability-controller";
import { planComputerAction, safeHttpUrl } from "../src/main/computer/computer-action-planner";

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
  assert.equal(planComputerAction("你觉得计算器好用吗"), undefined);
  assert.equal(safeHttpUrl("javascript:alert(1)"), undefined);
  assert.equal(safeHttpUrl("file:///C:/secret.txt"), undefined);
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
  settings.computer.permissions["open-url"] = "deny";
  const denied = await controller.planFromChat("打开 https://example.com");
  assert.match(denied.warning ?? "", /权限.*禁止/);
  assert.equal(denied.proposal, undefined);
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
