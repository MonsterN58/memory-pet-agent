import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { AgentSettings, MemoryRecord } from "../src/common/types";
import { AgentService } from "../src/main/agent-service";
import { MemoryEngine } from "../src/main/memory/memory-engine";
import { MemoryRepository } from "../src/main/memory/memory-repository";
import type { PersonalityEngine } from "../src/main/personality/personality-engine";
import type { SettingsStore } from "../src/main/settings-store";

interface ChatCompletionRequest {
  messages?: Array<{ role?: string; content?: string }>;
}

function preferenceMemory(content: string, ageDays: number): MemoryRecord {
  const timestamp = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  return {
    id: randomUUID(),
    tier: "L3",
    kind: "preference",
    content,
    summary: content,
    importance: 0.8,
    tags: ["preference", "quality-test"],
    createdAt: timestamp,
    updatedAt: timestamp,
    accessedAt: timestamp,
    accessCount: 0,
    sourceIds: [],
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function withChatServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
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

async function repositoryWithPreferences(
  context: TestContext,
  memories: MemoryRecord[],
): Promise<MemoryRepository> {
  const directory = await mkdtemp(join(tmpdir(), "agent-memory-quality-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "memory-store.json"), JSON.stringify({
    version: 1,
    l2: [],
    l3: memories,
    heartbeatEvents: [],
    meta: {},
  }), "utf8");
  const repository = new MemoryRepository(directory);
  await repository.initialize();
  return repository;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("真实回答链只把当前偏好发送给模型并返回当前记忆引用", async (context) => {
  const historicalMemory = preferenceMemory("以前喜欢喝咖啡", 30);
  const currentMemory = preferenceMemory("现在喜欢喝茉莉花茶", 1);
  const repository = await repositoryWithPreferences(context, [historicalMemory, currentMemory]);
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousModel = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;

  let capturedSystemPrompt = "";
  let capturedMessages: Array<{ role?: string; content?: string }> = [];
  try {
    await withChatServer(async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const payload = JSON.parse(await readRequestBody(request)) as ChatCompletionRequest;
      capturedMessages = payload.messages ?? [];
      capturedSystemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      const usesOnlyCurrentPreference = capturedSystemPrompt.includes(currentMemory.content)
        && !capturedSystemPrompt.includes(historicalMemory.content);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: usesOnlyCurrentPreference ? "你现在喜欢茉莉花茶。" : "记忆存在冲突。",
          },
        }],
      }));
    }, async (baseUrl) => {
      const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
      settings.provider = {
        enabled: true,
        baseUrl,
        model: "memory-quality-model",
        temperature: 0,
      };
      const settingsStore = {
        get: () => structuredClone(settings),
        getApiKey: async () => "memory-quality-key",
        providerConfigured: async () => true,
      } as unknown as SettingsStore;
      const personality = {
        behaviorContext: () => "人格成长状态：测试中不注入额外人格证据。",
        observeDialogue: async () => 0,
      } as unknown as PersonalityEngine;
      const memory = new MemoryEngine(repository, () => structuredClone(settings));
      const agent = new AgentService(memory, settingsStore, personality);
      memory.recordTurn("user", "我今天加班到很晚");
      memory.recordTurn("assistant", "难怪你听起来这么累。先缓一会儿吧。");

      const response = await agent.respond("现在喜欢喝什么");

      assert.equal(response.text, "你现在喜欢茉莉花茶。");
      assert.equal(response.source, "provider");
      assert.deepEqual(response.memoryRefs, [currentMemory.id]);
      assert.match(capturedSystemPrompt, /现在喜欢喝茉莉花茶/);
      assert.doesNotMatch(capturedSystemPrompt, /以前喜欢喝咖啡/);
      assert.doesNotMatch(capturedSystemPrompt, /我今天加班到很晚/);
      assert.deepEqual(capturedMessages.map((message) => message.role), ["system", "user", "assistant", "user"]);
      assert.equal(capturedMessages.filter((message) => message.content === "现在喜欢喝什么").length, 1);
      assert.equal(repository.getL3().find((item) => item.id === currentMemory.id)?.accessCount, 1);
      assert.equal(repository.getL3().find((item) => item.id === historicalMemory.id)?.accessCount, 0);
    });
  } finally {
    restoreEnvironment("OPENAI_BASE_URL", previousBaseUrl);
    restoreEnvironment("OPENAI_MODEL", previousModel);
  }
});

test("聊天中的明确记忆请求会立即持久化到 L2", async (context) => {
  const repository = await repositoryWithPreferences(context, []);
  const settings: AgentSettings = structuredClone(DEFAULT_SETTINGS);
  const settingsStore = {
    get: () => structuredClone(settings),
    getApiKey: async () => "",
    providerConfigured: async () => false,
  } as unknown as SettingsStore;
  const personality = {
    behaviorContext: () => "人格成长状态：仍在观察。",
    observeDialogue: async () => 0,
  } as unknown as PersonalityEngine;
  const memory = new MemoryEngine(repository, () => structuredClone(settings));
  const agent = new AgentService(memory, settingsStore, personality);

  const response = await agent.respond("请记住，我最近喜欢在晚上散步");

  assert.match(response.text, /记下了/);
  assert.deepEqual(response.memoryRefs, []);
  assert.equal(repository.getL2().length, 1);
  assert.equal(repository.getL2()[0]?.content, "我最近喜欢在晚上散步");
  assert(repository.getL2()[0]?.tags.includes("user-confirmed"));
});
