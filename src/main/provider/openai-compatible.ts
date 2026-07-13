import type { AgentSettings } from "../../common/types";

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export class OpenAICompatibleClient {
  constructor(
    private readonly getSettings: () => AgentSettings,
    private readonly getApiKey: () => Promise<string>,
  ) {}

  async complete(messages: ProviderMessage[], temperature?: number): Promise<string> {
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
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = (await response.json()) as ChatCompletionResponse;
    if (!response.ok) throw new Error(payload.error?.message || `模型服务返回 HTTP ${response.status}`);
    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("模型服务返回了空内容");
    return text;
  }
}
