import type { AgentSettings, TtsAudio } from "../../common/types";

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const ACCEPTED_MP3_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mpeg3",
  "audio/x-mpeg-3",
  "application/octet-stream",
]);

interface ProviderErrorPayload {
  error?: { message?: string } | string;
  message?: string;
}

export class OpenAICompatibleTtsClient {
  constructor(
    private readonly getSettings: () => AgentSettings,
    private readonly getTtsApiKey: () => Promise<string>,
  ) {}

  async synthesize(input: string): Promise<TtsAudio> {
    const settings = this.getSettings();
    if (!settings.voice.outputEnabled) throw new Error("自动朗读已关闭");
    if (settings.voice.ttsMode !== "cloud") throw new Error("当前使用本机 TTS，未启用云端语音生成");
    const apiKey = await this.getTtsApiKey();
    if (!apiKey) throw new Error("TTS 尚未配置 API Key");

    const baseUrl = process.env.OPENAI_TTS_BASE_URL?.trim().replace(/\/$/, "")
      || settings.voice.ttsBaseUrl.replace(/\/$/, "");
    const model = process.env.OPENAI_TTS_MODEL?.trim() || settings.voice.ttsModel;
    const voice = process.env.OPENAI_TTS_VOICE?.trim() || settings.voice.ttsVoice;
    if (!model || !voice) throw new Error("TTS 模型或音色尚未配置");

    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        voice,
        input,
        response_format: "mp3",
        speed: settings.voice.ttsSpeed,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(await this.providerError(response));
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!ACCEPTED_MP3_TYPES.has(contentType)) {
      throw new Error(`TTS 服务返回了不支持的音频类型：${contentType || "未知"}`);
    }
    const bytes = await readLimitedBody(response, MAX_AUDIO_BYTES, "TTS 音频");
    if (bytes.byteLength === 0) throw new Error("TTS 服务返回了空音频");
    return { mimeType: "audio/mpeg", base64: bytes.toString("base64") };
  }

  private async providerError(response: Response): Promise<string> {
    try {
      const bytes = await readLimitedBody(response, MAX_ERROR_BYTES, "TTS 错误响应");
      const text = bytes.toString("utf8").trim();
      if (text) {
        try {
          const payload = JSON.parse(text) as ProviderErrorPayload;
          const error = typeof payload.error === "string" ? payload.error : payload.error?.message;
          if (error || payload.message) return error || payload.message || text;
        } catch {
          return text.slice(0, 500);
        }
      }
    } catch {
      // 异常或超长错误体不应掩盖 HTTP 状态。
    }
    return `TTS 服务返回 HTTP ${response.status}`;
  }
}

async function readLimitedBody(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label}超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 限制`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label}超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 限制`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
