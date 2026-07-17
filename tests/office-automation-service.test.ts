import assert from "node:assert/strict";
import test from "node:test";
import {
  OfficeAutomationError,
  OfficeAutomationService,
  type OfficeCommandExecutor,
  type OfficeProcessInvocation,
} from "../src/main/computer/office-automation-service";

function successExecutor(
  onInvocation?: (invocation: OfficeProcessInvocation, payload: Record<string, unknown>) => void,
): OfficeCommandExecutor {
  return async (invocation) => {
    const payload = JSON.parse(
      Buffer.from(invocation.stdin, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    onInvocation?.(invocation, payload);
    const operation = String(payload.operation);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        code: "OK",
        operation,
        ...(operation === "powerpoint-add-slide" ? { slideNumber: 4 } : {}),
      }),
      stderr: "",
    };
  };
}

function assertOfficeError(error: unknown, code: OfficeAutomationError["code"]): boolean {
  assert.ok(error instanceof OfficeAutomationError);
  assert.equal(error.code, code);
  return true;
}

test("Office 服务严格校验文本、Excel A1 区域和二维表边界", async () => {
  let calls = 0;
  const service = new OfficeAutomationService({
    platform: "win32",
    executor: successExecutor(() => { calls += 1; }),
  });

  await assert.rejects(
    () => service.appendWordText("   "),
    (error) => assertOfficeError(error, "INVALID_REQUEST"),
  );
  await assert.rejects(
    () => service.appendWordText("x".repeat(20_001)),
    (error) => assertOfficeError(error, "INVALID_REQUEST"),
  );
  await assert.rejects(
    () => service.writeExcel("A0", "内容"),
    (error) => assertOfficeError(error, "INVALID_REQUEST"),
  );
  await assert.rejects(
    () => service.writeExcel("XFD1048576", "一\t二"),
    (error) => assertOfficeError(error, "INVALID_REQUEST"),
  );
  await assert.rejects(
    () => service.writeExcel("A1", Array.from({ length: 41 }, () => Array(50).fill("x"))),
    (error) => assertOfficeError(error, "INVALID_REQUEST"),
  );
  await assert.rejects(
    () => service.addPowerPointSlide("", "正文"),
    (error) => assertOfficeError(error, "INVALID_REQUEST"),
  );
  assert.equal(calls, 0);
});

test("PowerShell 命令和脚本固定，用户内容只通过 Base64 JSON 标准输入传递", async () => {
  const invocations: OfficeProcessInvocation[] = [];
  const service = new OfficeAutomationService({
    platform: "win32",
    executor: successExecutor((invocation) => { invocations.push(invocation); }),
  });
  const hostileText = "'; Start-Process calc.exe; Write-Output 'INJECTED' #";
  await service.appendWordText(hostileText);
  await service.addPowerPointSlide("第二个请求", "正文内容");

  assert.equal(invocations.length, 2);
  assert.equal(invocations[0]!.executable, invocations[1]!.executable);
  assert.deepEqual(invocations[0]!.args, invocations[1]!.args);
  const encodedScript = invocations[0]!.args.at(-1)!;
  const decodedScript = Buffer.from(encodedScript, "base64").toString("utf16le");
  assert.match(decodedScript, /GetActiveObject\(\$ProgId\)/);
  assert.match(decodedScript, /\$app\.EnableEvents = \$false/);
  assert.match(decodedScript, /\$app\.EnableEvents = \$previousEnableEvents/);
  assert.doesNotMatch(decodedScript, /Start-Process calc\.exe|INJECTED|第二个请求|正文内容/);
  assert.equal(invocations[0]!.args.some((argument) => argument.includes(hostileText)), false);

  const payload = JSON.parse(
    Buffer.from(invocations[0]!.stdin, "base64").toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(payload, { operation: "word-append", text: hostileText });
});

test("Word、Excel 和 PowerPoint 三类请求生成受限载荷并返回明确结果", async () => {
  const payloads: Record<string, unknown>[] = [];
  const service = new OfficeAutomationService({
    platform: "win32",
    executor: successExecutor((_invocation, payload) => { payloads.push(payload); }),
  });

  const word = await service.appendWordText("会议结论\n下一步");
  const excel = await service.writeExcel("b2", "姓名\t状态\n小明\t完成\n小红");
  const powerpoint = await service.addPowerPointSlide("周报", "本周完成三项任务");

  assert.deepEqual(word, {
    operation: "word-append",
    application: "word",
    message: "已向当前 Word 文档追加文本。",
    charactersWritten: 8,
  });
  assert.deepEqual(excel, {
    operation: "excel-write",
    application: "excel",
    message: "已从 B2 开始写入 3×2 的纯文本表格。",
    startCell: "B2",
    rowsWritten: 3,
    columnsWritten: 2,
    cellsWritten: 6,
  });
  assert.deepEqual(powerpoint, {
    operation: "powerpoint-add-slide",
    application: "powerpoint",
    message: "已在当前 PowerPoint 中添加第 4 页。",
    slideNumber: 4,
  });
  assert.deepEqual(payloads, [
    { operation: "word-append", text: "会议结论\n下一步" },
    {
      operation: "excel-write",
      startCell: "B2",
      rowCount: 3,
      columnCount: 2,
      values: ["姓名", "状态", "小明", "完成", "小红", ""],
    },
    { operation: "powerpoint-add-slide", title: "周报", body: "本周完成三项任务" },
  ]);
});

test("非 Windows、Office 状态、PowerShell 缺失和超时映射为稳定错误码", async (context) => {
  await context.test("非 Windows 不调用执行器", async () => {
    let called = false;
    const service = new OfficeAutomationService({
      platform: "darwin",
      executor: async () => {
        called = true;
        throw new Error("unexpected");
      },
    });
    await assert.rejects(
      () => service.appendWordText("内容"),
      (error) => assertOfficeError(error, "UNSUPPORTED_PLATFORM"),
    );
    assert.equal(called, false);
  });

  await context.test("Office 未安装与没有活动工作簿", async () => {
    for (const fixture of [
      { code: "OFFICE_NOT_INSTALLED", expected: "OFFICE_NOT_INSTALLED" as const, pattern: /未检测到.*Excel/ },
      { code: "NO_ACTIVE_WORKBOOK", expected: "NO_ACTIVE_WORKBOOK" as const, pattern: /没有打开的工作簿/ },
    ]) {
      const service = new OfficeAutomationService({
        platform: "win32",
        executor: async () => ({
          exitCode: 1,
          stdout: JSON.stringify({ ok: false, code: fixture.code, operation: "excel-write" }),
          stderr: "",
        }),
      });
      await assert.rejects(
        () => service.writeExcel("A1", "内容"),
        (error) => {
          assertOfficeError(error, fixture.expected);
          assert.match((error as Error).message, fixture.pattern);
          return true;
        },
      );
    }
  });

  await context.test("PowerShell 缺失", async () => {
    const service = new OfficeAutomationService({
      platform: "win32",
      executor: async () => {
        throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
      },
    });
    await assert.rejects(
      () => service.appendWordText("内容"),
      (error) => assertOfficeError(error, "POWERSHELL_UNAVAILABLE"),
    );
  });

  await context.test("Office 响应超时", async () => {
    const service = new OfficeAutomationService({
      platform: "win32",
      executor: async () => {
        throw Object.assign(new Error("operation timed out"), { killed: true, signal: "SIGTERM" });
      },
    });
    await assert.rejects(
      () => service.addPowerPointSlide("标题", "正文"),
      (error) => assertOfficeError(error, "EXECUTION_TIMEOUT"),
    );
  });
});
