import assert from "node:assert/strict";
import test from "node:test";
import type { SharedComputerContext } from "../src/common/types";
import { BrowserContextServer, sanitizeBrowserContext } from "../src/main/computer/browser-context-server";

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
