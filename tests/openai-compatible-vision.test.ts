import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import {
  OpenAICompatibleVisionClient,
  parseVisionAnalysis,
} from "../src/main/provider/openai-compatible-vision";

test("独立识图客户端只向视觉端点发送一次性图片并解析受限结果", async () => {
  let captured: Record<string, unknown> = {};
  let authorization = "";
  const server = createServer(async (request, response) => {
    authorization = String(request.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            sceneSummary: "画面像是在编辑代码",
            currentTask: "检查桌宠的心跳逻辑",
            busyState: "focused",
            helpOpportunity: "可以协助运行测试",
            confidence: 0.78,
          }),
        },
      }],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.vision = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "vision-only-model",
  };
  const previousBase = process.env.OPENAI_VISION_BASE_URL;
  const previousModel = process.env.OPENAI_VISION_MODEL;
  delete process.env.OPENAI_VISION_BASE_URL;
  delete process.env.OPENAI_VISION_MODEL;
  try {
    const client = new OpenAICompatibleVisionClient(() => settings, async () => "vision-key");
    const result = await client.analyzeDesktop("data:image/jpeg;base64,U0NSRUVO", "manual");
    assert.equal(result.currentTask, "检查桌宠的心跳逻辑");
    assert.equal(result.busyState, "focused");
    assert.equal(authorization, "Bearer vision-key");
    assert.equal(captured.model, "vision-only-model");
    const serialized = JSON.stringify(captured);
    assert.match(serialized, /data:image\/jpeg;base64,U0NSRUVO/);
    assert.doesNotMatch(serialized, /长期记忆|关系档案|tool_calls/);
  } finally {
    if (previousBase === undefined) delete process.env.OPENAI_VISION_BASE_URL;
    else process.env.OPENAI_VISION_BASE_URL = previousBase;
    if (previousModel === undefined) delete process.env.OPENAI_VISION_MODEL;
    else process.env.OPENAI_VISION_MODEL = previousModel;
    server.close();
    await once(server, "close");
  }
});

test("识图结果限制枚举、置信度和文本长度", () => {
  const parsed = parseVisionAnalysis(JSON.stringify({
    sceneSummary: "场景".repeat(200),
    currentTask: "任务",
    busyState: "secret-state",
    helpOpportunity: "帮助",
    confidence: 9,
  }));
  assert.equal(parsed.sceneSummary.length, 160);
  assert.equal(parsed.busyState, "unknown");
  assert.equal(parsed.confidence, 1);
  assert.throws(() => parseVisionAnalysis("not json"), /JSON/);
});
