import assert from "node:assert/strict";
import test from "node:test";
import type { SharedComputerContext } from "../src/common/types";
import {
  BrowserContextServer,
  sanitizeBrowserCommand,
  sanitizeBrowserContext,
} from "../src/main/computer/browser-context-server";

test("浏览器上下文清洗只接受明确动作、文本和 http(s) 来源", () => {
  const context = sanitizeBrowserContext({
    action: "explain",
    text: `  ${"内容".repeat(7000)}  `,
    title: "标题".repeat(200),
    url: "https://example.com/article",
    source: "spoofed",
    capturedAt: "2000-01-01",
  });
  assert.equal(context.source, "browser");
  assert.equal(context.text.length, 12_000);
  assert.equal(context.title?.length, 300);
  assert.equal(context.url, "https://example.com/article");
  assert.notEqual(context.capturedAt, "2000-01-01");
  assert.throws(() => sanitizeBrowserContext({ action: "execute", text: "hi" }), /未知/);
  assert.throws(() => sanitizeBrowserContext({ action: "chat", text: "  " }), /为空/);
  assert.equal(sanitizeBrowserContext({ action: "chat", text: "hi", url: "file:///secret" }).url, undefined);
});

test("浏览器桥接仅在令牌和扩展来源都匹配时接受上下文", async (context) => {
  const pairingToken = "x".repeat(43);
  let resolveReceived: ((value: SharedComputerContext) => void) | undefined;
  const received = new Promise<SharedComputerContext>((resolve) => { resolveReceived = resolve; });
  const server = new BrowserContextServer({
    port: 0,
    getPairingToken: () => pairingToken,
    onContext: (value) => resolveReceived?.(value),
  });
  context.after(() => server.stop());
  const status = await server.start();
  assert.equal(status.running, true);

  const unauthorized = await fetch(`${status.endpoint}/health`, {
    headers: { "X-Memory-Pet-Token": "wrong" },
  });
  assert.equal(unauthorized.status, 401);

  const preflight = await fetch(`${status.endpoint}/v1/context`, {
    method: "OPTIONS",
    headers: {
      "Origin": "chrome-extension://abcdefghijklmnop",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-memory-pet-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /X-Memory-Pet-Token/i);

  const hostileOrigin = await fetch(`${status.endpoint}/v1/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://example.com",
      "X-Memory-Pet-Token": pairingToken,
    },
    body: JSON.stringify({ action: "explain", text: "hello" }),
  });
  assert.equal(hostileOrigin.status, 403);

  const accepted = await fetch(`${status.endpoint}/v1/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "chrome-extension://abcdefghijklmnop",
      "X-Memory-Pet-Token": pairingToken,
    },
    body: JSON.stringify({
      action: "summarize",
      text: "这是用户明确选择的网页文本。",
      title: "测试页面",
      url: "https://example.com/test",
    }),
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
  assert.deepEqual(await received, {
    action: "summarize",
    source: "browser",
    text: "这是用户明确选择的网页文本。",
    title: "测试页面",
    url: "https://example.com/test",
    capturedAt: (await received).capturedAt,
  });
});

test("浏览器操作只接受固定动作和有界查找文字", () => {
  assert.deepEqual(sanitizeBrowserCommand({ action: "reload", text: "ignored" }), { action: "reload" });
  assert.deepEqual(sanitizeBrowserCommand({ action: "go-back" }), { action: "go-back" });
  assert.deepEqual(sanitizeBrowserCommand({ action: "go-forward" }), { action: "go-forward" });
  assert.deepEqual(sanitizeBrowserCommand({ action: "scroll-up" }), { action: "scroll-up" });
  assert.deepEqual(sanitizeBrowserCommand({ action: "scroll-top" }), { action: "scroll-top" });
  assert.deepEqual(sanitizeBrowserCommand({ action: "scroll-bottom" }), { action: "scroll-bottom" });
  assert.deepEqual(sanitizeBrowserCommand({ action: "find-text", text: "  关键字\u0000  " }), {
    action: "find-text",
    text: "关键字",
  });
  assert.throws(() => sanitizeBrowserCommand({ action: "execute-script", text: "alert(1)" }), /未知/);
  assert.throws(() => sanitizeBrowserCommand({ action: "find-text", text: " " }), /为空/);
  assert.throws(() => sanitizeBrowserCommand({ action: "find-text", text: "字".repeat(201) }), /长度/);
});

test("浏览器操作队列要求扩展来源和令牌并且命令与结果都只消费一次", async (context) => {
  const pairingToken = "c".repeat(43);
  const extensionOrigin = "chrome-extension://abcdefghijklmnop";
  const server = new BrowserContextServer({
    port: 0,
    getPairingToken: () => pairingToken,
    onContext: () => undefined,
  });
  context.after(() => server.stop());
  const status = await server.start();

  const resultPromise = server.enqueueCommand({ action: "find-text", text: "桌宠记忆" });

  const noOrigin = await fetch(`${status.endpoint}/v1/commands/poll?waitMs=0`, {
    headers: { "X-Memory-Pet-Token": pairingToken },
  });
  assert.equal(noOrigin.status, 403);

  const wrongToken = await fetch(`${status.endpoint}/v1/commands/poll?waitMs=0`, {
    headers: { Origin: extensionOrigin, "X-Memory-Pet-Token": "wrong" },
  });
  assert.equal(wrongToken.status, 401);

  const excessiveWait = await fetch(`${status.endpoint}/v1/commands/poll?waitMs=20001`, {
    headers: { Origin: extensionOrigin, "X-Memory-Pet-Token": pairingToken },
  });
  assert.equal(excessiveWait.status, 400);

  const poll = await fetch(`${status.endpoint}/v1/commands/poll?waitMs=0`, {
    headers: { Origin: extensionOrigin, "X-Memory-Pet-Token": pairingToken },
  });
  assert.equal(poll.status, 200);
  const body = await poll.json() as {
    command: { id: string; action: string; text: string; expiresAt: number };
  };
  assert.match(body.command.id, /^[0-9a-f-]{36}$/i);
  assert.equal(body.command.action, "find-text");
  assert.equal(body.command.text, "桌宠记忆");
  assert.ok(body.command.expiresAt > Date.now());

  const secondPoll = await fetch(`${status.endpoint}/v1/commands/poll?waitMs=0`, {
    headers: { Origin: extensionOrigin, "X-Memory-Pet-Token": pairingToken },
  });
  assert.equal(secondPoll.status, 204);

  const oversizedResult = await fetch(`${status.endpoint}/v1/commands/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: extensionOrigin,
      "X-Memory-Pet-Token": pairingToken,
    },
    body: JSON.stringify({ id: body.command.id, ok: true, message: "长".repeat(501) }),
  });
  assert.equal(oversizedResult.status, 400);

  const submitted = await fetch(`${status.endpoint}/v1/commands/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: extensionOrigin,
      "X-Memory-Pet-Token": pairingToken,
    },
    body: JSON.stringify({ id: body.command.id, ok: true, message: "已定位文字" }),
  });
  assert.equal(submitted.status, 202);
  assert.deepEqual(await resultPromise, {
    id: body.command.id,
    action: "find-text",
    ok: true,
    message: "已定位文字",
    completedAt: (await resultPromise).completedAt,
  });

  const replay = await fetch(`${status.endpoint}/v1/commands/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: extensionOrigin,
      "X-Memory-Pet-Token": pairingToken,
    },
    body: JSON.stringify({ id: body.command.id, ok: true, message: "重复结果" }),
  });
  assert.equal(replay.status, 409);
});

test("浏览器长轮询会被新命令唤醒且待执行队列有上限", async (context) => {
  const pairingToken = "q".repeat(43);
  const extensionOrigin = "moz-extension://abcdef12-3456";
  const server = new BrowserContextServer({
    port: 0,
    maxPendingCommands: 1,
    getPairingToken: () => pairingToken,
    onContext: () => undefined,
  });
  context.after(() => server.stop());
  const status = await server.start();

  const pollPromise = fetch(`${status.endpoint}/v1/commands/poll?waitMs=1000`, {
    headers: { Origin: extensionOrigin, "X-Memory-Pet-Token": pairingToken },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const firstResult = server.enqueueCommand({ action: "scroll-down" });
  const poll = await pollPromise;
  assert.equal(poll.status, 200);
  const { command } = await poll.json() as { command: { id: string; action: string } };
  assert.equal(command.action, "scroll-down");

  const overflow = await server.enqueueCommand({ action: "reload" });
  assert.equal(overflow.ok, false);
  assert.match(overflow.message, /过多/);

  const submitted = await fetch(`${status.endpoint}/v1/commands/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: extensionOrigin,
      "X-Memory-Pet-Token": pairingToken,
    },
    body: JSON.stringify({ id: command.id, ok: true }),
  });
  assert.equal(submitted.status, 202);
  assert.equal((await firstResult).ok, true);
});

test("浏览器桥接并发启动只创建一个监听服务且 stop 能完整关闭", async (context) => {
  const pairingToken = "s".repeat(43);
  const server = new BrowserContextServer({
    port: 0,
    getPairingToken: () => pairingToken,
    onContext: () => undefined,
  });
  context.after(() => server.stop());

  const [first, second] = await Promise.all([server.start(), server.start()]);
  assert.equal(first.running, true);
  assert.deepEqual(second, first);
  const healthy = await fetch(`${first.endpoint}/health`, {
    headers: { "X-Memory-Pet-Token": pairingToken },
  });
  assert.equal(healthy.status, 200);

  await server.stop();
  assert.equal(server.status().running, false);
  await assert.rejects(() => fetch(`${first.endpoint}/health`, {
    headers: { "X-Memory-Pet-Token": pairingToken },
  }));
});

test("浏览器桥接在 stop 进行中立即 start 后只保留一个可用服务", async (context) => {
  const pairingToken = "r".repeat(43);
  const server = new BrowserContextServer({
    port: 0,
    getPairingToken: () => pairingToken,
    onContext: () => undefined,
  });
  context.after(() => server.stop());
  await server.start();

  const stopping = server.stop();
  const [restarted, duplicateRestart] = await Promise.all([server.start(), server.start()]);
  await stopping;

  assert.equal(restarted.running, true);
  assert.deepEqual(duplicateRestart, restarted);
  assert.deepEqual(server.status(), restarted);
  const healthy = await fetch(`${restarted.endpoint}/health`, {
    headers: { "X-Memory-Pet-Token": pairingToken },
  });
  assert.equal(healthy.status, 200);

  await server.stop();
  assert.equal(server.status().running, false);
  await assert.rejects(() => fetch(`${restarted.endpoint}/health`, {
    headers: { "X-Memory-Pet-Token": pairingToken },
  }));
});

test("浏览器长轮询断开后命令会交给下一次有效轮询", async (context) => {
  const pairingToken = "d".repeat(43);
  const extensionOrigin = "chrome-extension://abcdefghijklmnop";
  const server = new BrowserContextServer({
    port: 0,
    getPairingToken: () => pairingToken,
    onContext: () => undefined,
  });
  context.after(() => server.stop());
  const status = await server.start();
  const abort = new AbortController();
  const abandoned = fetch(`${status.endpoint}/v1/commands/poll?waitMs=1000`, {
    headers: { Origin: extensionOrigin, "X-Memory-Pet-Token": pairingToken },
    signal: abort.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  abort.abort();
  await assert.rejects(() => abandoned);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const resultPromise = server.enqueueCommand({ action: "scroll-top" });
  const poll = await fetch(`${status.endpoint}/v1/commands/poll?waitMs=100`, {
    headers: { Origin: extensionOrigin, "X-Memory-Pet-Token": pairingToken },
  });
  assert.equal(poll.status, 200);
  const { command } = await poll.json() as { command: { id: string; action: string } };
  assert.equal(command.action, "scroll-top");
  const submitted = await fetch(`${status.endpoint}/v1/commands/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: extensionOrigin,
      "X-Memory-Pet-Token": pairingToken,
    },
    body: JSON.stringify({ id: command.id, ok: true, message: "已回到顶部" }),
  });
  assert.equal(submitted.status, 202);
  assert.equal((await resultPromise).ok, true);
});
