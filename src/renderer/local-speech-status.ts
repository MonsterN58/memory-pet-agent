import type { LocalSpeechModelStatus, VoiceRecognitionMode } from "../common/types";

export interface LocalSpeechControlInput {
  inputEnabled: boolean;
  recognitionMode: VoiceRecognitionMode;
  supported: boolean;
  status?: LocalSpeechModelStatus;
}

export interface LocalSpeechControlState {
  disabled: boolean;
  title: string;
}

export function localSpeechControlState(input: LocalSpeechControlInput): LocalSpeechControlState {
  if (!input.inputEnabled) return { disabled: true, title: "语音输入已关闭" };
  if (!input.supported) return { disabled: true, title: "当前环境不支持所选语音识别模式" };
  if (input.recognitionMode === "browser") {
    return { disabled: false, title: "使用浏览器语音识别" };
  }
  if (!input.status) return { disabled: true, title: "正在检查本地识别模型…" };
  if (input.status.state !== "ready") return { disabled: true, title: input.status.message };
  return {
    disabled: false,
    title: input.status.runtimeMessage ?? input.status.message,
  };
}

export function localSpeechStatusText(status: LocalSpeechModelStatus): string {
  if (status.state !== "ready" || !status.runtimeMessage) return status.message;
  return `${status.message}；${status.runtimeMessage}`;
}
