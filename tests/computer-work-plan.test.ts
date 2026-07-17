import assert from "node:assert/strict";
import test from "node:test";
import { parseComputerWorkPlan } from "../src/main/computer/computer-work-plan";

test("协作计划只解析 2～4 个白名单步骤并固定参数", () => {
  assert.deepEqual(parseComputerWorkPlan({
    title: "整理资料",
    steps: [
      { kind: "open-url", url: "https://example.com/docs", label: "文档" },
      { kind: "browser-find-text", text: "安装" },
      { kind: "word-append", text: "已经找到安装说明" },
    ],
  }), {
    title: "整理资料",
    drafts: [
      { tool: "open-url", url: "https://example.com/docs", label: "文档" },
      { tool: "browser-control", action: "find-text", text: "安装", label: "查找“安装”" },
      { tool: "office-write", operation: "word-append", text: "已经找到安装说明" },
    ],
  });
});

test("协作计划拒绝脚本地址、未知应用和越界步骤数量", () => {
  assert.throws(() => parseComputerWorkPlan({ steps: [{ kind: "open-url", url: "https://example.com" }] }), /2～4/);
  assert.throws(() => parseComputerWorkPlan({
    steps: [
      { kind: "open-url", url: "javascript:alert(1)" },
      { kind: "browser-reload" },
    ],
  }), /http\(s\)/);
  assert.throws(() => parseComputerWorkPlan({
    steps: [
      { kind: "launch-app", app: "powershell" },
      { kind: "browser-reload" },
    ],
  }), /白名单/);
});

test("协作计划保留 Excel TSV 的首尾空单元格", () => {
  const content = "\tB\nA\t";
  const parsed = parseComputerWorkPlan({
    steps: [
      { kind: "excel-write", start_cell: "A1", text: content },
      { kind: "browser-scroll-bottom" },
    ],
  });
  assert.deepEqual(parsed.drafts[0], {
    tool: "office-write",
    operation: "excel-write",
    startCell: "A1",
    content,
  });
});
