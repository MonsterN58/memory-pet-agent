import type { AgentSettings } from "../../common/types";

export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: ProviderMessageContent | null;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type ProviderMessageContent = string | Array<ProviderTextContent | ProviderImageContent>;

export interface ProviderTextContent {
  type: "text";
  text: string;
}

export interface ProviderImageContent {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface ProviderToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ProviderToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderCompletion {
  content?: string;
  toolCalls: ProviderToolCall[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: unknown;
    };
  }>;
  error?: { message?: string };
}

export class OpenAICompatibleClient {
  constructor(
    private readonly getSettings: () => AgentSettings,
    private readonly getApiKey: () => Promise<string>,
  ) {}

  async complete(messages: ProviderMessage[], temperature?: number): Promise<string> {
    const result = await this.request(messages, [], temperature);
    if (!result.content) throw new Error("模型服务返回了空内容");
    return result.content;
  }

  async completeWithTools(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    temperature?: number,
  ): Promise<ProviderCompletion> {
    if (!tools.length) return { content: await this.complete(messages, temperature), toolCalls: [] };
    const result = await this.request(messages, tools, temperature);
    if (!result.content && !result.toolCalls.length) throw new Error("模型服务返回了空内容");
    return result;
  }

  private async request(
    messages: ProviderMessage[],
    tools: ProviderToolDefinition[],
    temperature?: number,
  ): Promise<ProviderCompletion> {
    const settings = this.getSettings().provider;
    const apiKey = await this.getApiKey();
    if (!settings.enabled || !settings.model || !apiKey) throw new Error("大模型服务尚未配置完整");
    const baseUrl = process.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "") || settings.baseUrl.replace(/\/$/, "");
    const model = process.env.OPENAI_MODEL?.trim() || settings.model;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature ?? settings.temperature,
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = (await response.json()) as ChatCompletionResponse;
    if (!response.ok) throw new Error(payload.error?.message || `模型服务返回 HTTP ${response.status}`);
    const message = payload.choices?.[0]?.message;
    return {
      content: responseText(message?.content),
      toolCalls: parseToolCalls(message?.tool_calls),
    };
  }
}

function responseText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const part = item as Record<string, unknown>;
      return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("")
    .trim();
  return text || undefined;
}

function parseToolCalls(value: unknown): ProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ProviderToolCall[] = [];
  for (const [index, raw] of value.slice(0, 8).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (!item.function || typeof item.function !== "object") continue;
    const fn = item.function as Record<string, unknown>;
    if (typeof fn.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name)) continue;
    const serializedArguments = typeof fn.arguments === "string"
      ? fn.arguments
      : JSON.stringify(fn.arguments ?? {});
    calls.push({
      id: typeof item.id === "string" && item.id.length <= 200 ? item.id : `tool-call-${index + 1}`,
      type: "function",
      function: {
        name: fn.name,
        arguments: serializedArguments.slice(0, 12_000),
      },
    });
  }
  return calls;
}
