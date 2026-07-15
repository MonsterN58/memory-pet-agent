import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import { OpenAICompatibleClient } from "../src/main/provider/openai-compatible";

test("Chat Completions 客户端保留一次性屏幕的多模态消息结构", async () => {
  let captured: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "已完成心跳思考" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "vision-compatible-model",
    temperature: 0,
  };
  const oldBase = process.env.OPENAI_BASE_URL;
  const oldModel = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  try {
    const client = new OpenAICompatibleClient(() => settings, async () => "test-key");
    const result = await client.complete([
      { role: "system", content: "只做一次性情境理解" },
      {
        role: "user",
        content: [
          { type: "text", text: "<heartbeat_data>test</heartbeat_data>" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,SCREEN" } },
        ],
      },
    ]);
    assert.equal(result, "已完成心跳思考");
    const messages = captured.messages as Array<{ role: string; content: unknown }>;
    assert.deepEqual(messages[1]?.content, [
      { type: "text", text: "<heartbeat_data>test</heartbeat_data>" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,SCREEN" } },
    ]);
  } finally {
    if (oldBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = oldModel;
    server.close();
    await once(server, "close");
  }
});

test("Chat Completions 客户端发送标准 function tools 并解析 tool_calls", async () => {
  let captured: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-memory-1",
            type: "function",
            function: { name: "memory_search", arguments: '{"query":"以前的计划","limit":3}' },
          }],
        },
      }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "tool-compatible-model",
    temperature: 0,
  };
  const oldBase = process.env.OPENAI_BASE_URL;
  const oldModel = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  try {
    const client = new OpenAICompatibleClient(() => settings, async () => "test-key");
    const result = await client.completeWithTools(
      [
        { role: "system", content: "按需调用工具" },
        { role: "user", content: "你还记得我以前的计划吗？" },
      ],
      [{
        type: "function",
        function: {
          name: "memory_search",
          description: "搜索记忆",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      }],
    );
    assert.equal(result.content, undefined);
    assert.deepEqual(result.toolCalls, [{
      id: "call-memory-1",
      type: "function",
      function: { name: "memory_search", arguments: '{"query":"以前的计划","limit":3}' },
    }]);
    assert.equal(captured.tool_choice, "auto");
    const tools = captured.tools as Array<{ function: { name: string } }>;
    assert.equal(tools[0]?.function.name, "memory_search");
  } finally {
    if (oldBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = oldModel;
    server.close();
    await once(server, "close");
  }
});
