import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { AgentSettings } from "../src/common/types";
import { OpenAICompatibleTtsClient } from "../src/main/provider/openai-compatible-tts";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function settings(baseUrl: string): AgentSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    provider: { ...DEFAULT_SETTINGS.provider, baseUrl: "http://127.0.0.1:1/v1" },
    voice: {
      ...DEFAULT_SETTINGS.voice,
      outputEnabled: true,
      ttsMode: "cloud",
      ttsBaseUrl: baseUrl,
      ttsModel: "test-tts-model",
      ttsVoice: "nova",
      ttsSpeed: 1.25,
    },
  };
}

test("本机模式拒绝主进程云端 TTS 请求", async () => {
  let keyReads = 0;
  const localSettings = structuredClone(DEFAULT_SETTINGS);
  localSettings.voice.outputEnabled = true;
  localSettings.voice.ttsMode = "local";
  const client = new OpenAICompatibleTtsClient(
    () => localSettings,
    async () => {
      keyReads += 1;
      return "unused";
    },
  );
  await assert.rejects(() => client.synthesize("只在本机朗读"), /本机 TTS/);
  assert.equal(keyReads, 0);
});

test("TTS 客户端向 OpenAI 兼容端点发送鉴权和语音参数", async () => {
  const previousChatBaseUrl = process.env.OPENAI_BASE_URL;
  const previousTtsBaseUrl = process.env.OPENAI_TTS_BASE_URL;
  const previousModel = process.env.OPENAI_TTS_MODEL;
  const previousVoice = process.env.OPENAI_TTS_VOICE;
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1";
  delete process.env.OPENAI_TTS_BASE_URL;
  delete process.env.OPENAI_TTS_MODEL;
  delete process.env.OPENAI_TTS_VOICE;
  try {
    await withServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/audio/speech");
      assert.equal(request.headers.authorization, "Bearer test-secret");
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
        model: "test-tts-model",
        voice: "nova",
        input: "你好，桌宠",
        response_format: "mp3",
        speed: 1.25,
      });
      response.writeHead(200, { "Content-Type": "audio/mpeg" });
      response.end(Buffer.from("ID3-test-audio"));
    }, async (baseUrl) => {
      const client = new OpenAICompatibleTtsClient(() => settings(baseUrl), async () => "test-secret");
      const audio = await client.synthesize("你好，桌宠");
      assert.equal(audio.mimeType, "audio/mpeg");
      assert.equal(Buffer.from(audio.base64, "base64").toString(), "ID3-test-audio");
    });
  } finally {
    restoreEnvironment("OPENAI_BASE_URL", previousChatBaseUrl);
    restoreEnvironment("OPENAI_TTS_BASE_URL", previousTtsBaseUrl);
    restoreEnvironment("OPENAI_TTS_MODEL", previousModel);
    restoreEnvironment("OPENAI_TTS_VOICE", previousVoice);
  }
});

test("TTS 客户端会显示兼容服务返回的错误信息", async () => {
  await withoutTtsOverrides(async () => {
    await withServer((_request, response) => {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unknown voice" } }));
    }, async (baseUrl) => {
      const client = new OpenAICompatibleTtsClient(() => settings(baseUrl), async () => "test-secret");
      await assert.rejects(() => client.synthesize("test"), /unknown voice/);
    });
  });
});

test("TTS 客户端拒绝超过 12MB 的响应", async () => {
  await withoutTtsOverrides(async () => {
    await withServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(12 * 1024 * 1024 + 1),
      });
      response.end("oversized");
    }, async (baseUrl) => {
      const client = new OpenAICompatibleTtsClient(() => settings(baseUrl), async () => "test-secret");
      await assert.rejects(() => client.synthesize("test"), /12MB/);
    });
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withoutTtsOverrides(run: () => Promise<void>): Promise<void> {
  const previousBaseUrl = process.env.OPENAI_TTS_BASE_URL;
  const previousModel = process.env.OPENAI_TTS_MODEL;
  const previousVoice = process.env.OPENAI_TTS_VOICE;
  delete process.env.OPENAI_TTS_BASE_URL;
  delete process.env.OPENAI_TTS_MODEL;
  delete process.env.OPENAI_TTS_VOICE;
  try {
    await run();
  } finally {
    restoreEnvironment("OPENAI_TTS_BASE_URL", previousBaseUrl);
    restoreEnvironment("OPENAI_TTS_MODEL", previousModel);
    restoreEnvironment("OPENAI_TTS_VOICE", previousVoice);
  }
}
