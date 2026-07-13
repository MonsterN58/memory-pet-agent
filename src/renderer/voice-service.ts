import type {
  AgentSettings,
  LocalSpeechAudio,
  LocalSpeechRecognitionResult,
  TtsAudio,
} from "../common/types";

interface LocalCaptureSession {
  request: number;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  mute: GainNode;
  chunks: Float32Array[];
  sampleCount: number;
  startedAt: number;
  lastSpeechAt: number;
  speechDetected: boolean;
  noiseFloor: number;
  finishing: boolean;
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onState: (listening: boolean, error?: string) => void;
}

const TARGET_SAMPLE_RATE = 16_000;
const NO_SPEECH_TIMEOUT_MS = 8_000;
const END_SILENCE_MS = 1_200;
const MIN_RECORDING_MS = 700;
const MAX_RECORDING_MS = 30_000;

export class VoiceService {
  private recognition?: SpeechRecognitionLike;
  private listening = false;
  private recognitionStarting = false;
  private recognitionRequest = 0;
  private localCapture?: LocalCaptureSession;
  private speechRequest = 0;
  private currentAudio?: HTMLAudioElement;
  private currentAudioUrl?: string;
  private currentUtterance?: SpeechSynthesisUtterance;

  constructor(
    private getSettings: () => AgentSettings,
    private synthesize: (text: string) => Promise<TtsAudio>,
    private onSpeechError: (message: string) => void = () => undefined,
    private recognizeLocal: (audio: LocalSpeechAudio) => Promise<LocalSpeechRecognitionResult> = async () => {
      throw new Error("本地语音识别服务未连接");
    },
  ) {}

  supported(): boolean {
    const mode = this.getSettings().voice.recognitionMode;
    return mode === "local"
      ? Reflect.has(navigator, "mediaDevices") && Reflect.has(window, "AudioContext")
      : Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  isListening(): boolean {
    return this.listening;
  }

  start(
    onFinal: (text: string) => void,
    onInterim: (text: string) => void,
    onState: (listening: boolean, error?: string) => void,
  ): void {
    const settings = this.getSettings().voice;
    if (!settings.inputEnabled) return onState(false, "语音输入已关闭");
    if (this.localCapture && this.listening) {
      void this.finishLocalCapture(this.localCapture);
      return;
    }
    if (this.listening || this.recognitionStarting) {
      this.stop();
      onState(false);
      return;
    }
    const request = ++this.recognitionRequest;
    this.recognitionStarting = true;
    const task = settings.recognitionMode === "local"
      ? this.startLocalCapture(request, onFinal, onInterim, onState)
      : this.startBrowserRecognition(settings.language, request, onFinal, onInterim, onState);
    void task.catch((error: unknown) => {
      if (request !== this.recognitionRequest) return;
      this.recognitionStarting = false;
      this.recognition = undefined;
      this.cleanupLocalCapture(this.localCapture);
      onState(false, error instanceof Error ? error.message : "无法启动语音识别");
    });
  }

  stop(): void {
    this.recognitionRequest += 1;
    this.recognitionStarting = false;
    this.listening = false;
    this.cleanupLocalCapture(this.localCapture);
    const recognition = this.recognition;
    this.recognition = undefined;
    if (!recognition) return;
    try {
      recognition.abort();
    } catch {
      // 已结束的识别器可能抛出 InvalidStateError，不影响停止语义。
    }
  }

  private async startBrowserRecognition(
    language: string,
    request: number,
    onFinal: (text: string) => void,
    onInterim: (text: string) => void,
    onState: (listening: boolean, error?: string) => void,
  ): Promise<void> {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) throw new Error("当前 Chromium 环境不支持兼容语音识别");
    const recognition = new Recognition();
    this.recognition = recognition;
    if (request !== this.recognitionRequest) return;
    recognition.lang = language;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (this.recognition !== recognition) return;
      this.recognitionStarting = false;
      this.listening = true;
      onState(true);
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognitionStarting = false;
      this.listening = false;
      this.recognition = undefined;
      onState(false);
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition) return;
      this.recognitionStarting = false;
      this.listening = false;
      this.recognition = undefined;
      onState(false, this.errorMessage(event.error));
    };
    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) onInterim(interim.trim());
      if (final.trim()) onFinal(final.trim());
    };
    try {
      recognition.start();
    } catch (error) {
      if (this.recognition === recognition) this.recognition = undefined;
      this.recognitionStarting = false;
      onState(false, error instanceof Error ? error.message : "无法启动语音识别");
    }
  }

  private async startLocalCapture(
    request: number,
    onFinal: (text: string) => void,
    onInterim: (text: string) => void,
    onState: (listening: boolean, error?: string) => void,
  ): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      throw new Error("当前 Electron 环境无法采集麦克风音频");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (request !== this.recognitionRequest) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    const now = performance.now();
    const session: LocalCaptureSession = {
      request,
      stream,
      context,
      source,
      processor,
      mute,
      chunks: [],
      sampleCount: 0,
      startedAt: now,
      lastSpeechAt: now,
      speechDetected: false,
      noiseFloor: 0.004,
      finishing: false,
      onFinal,
      onInterim,
      onState,
    };
    this.localCapture = session;
    processor.onaudioprocess = (event) => this.handleAudioChunk(session, event.inputBuffer.getChannelData(0));
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    await context.resume();
    if (request !== this.recognitionRequest) {
      this.cleanupLocalCapture(session);
      return;
    }
    this.recognitionStarting = false;
    this.listening = true;
    onState(true);
  }

  private handleAudioChunk(session: LocalCaptureSession, input: Float32Array): void {
    if (this.localCapture !== session || session.finishing) return;
    const chunk = new Float32Array(input);
    session.chunks.push(chunk);
    session.sampleCount += chunk.length;
    let energy = 0;
    for (const value of chunk) energy += value * value;
    const rms = Math.sqrt(energy / Math.max(1, chunk.length));
    const now = performance.now();
    const threshold = Math.max(0.012, session.noiseFloor * 2.8);
    if (rms >= threshold) {
      session.speechDetected = true;
      session.lastSpeechAt = now;
    } else if (!session.speechDetected) {
      session.noiseFloor = Math.min(0.03, session.noiseFloor * 0.94 + rms * 0.06);
    }
    const elapsed = now - session.startedAt;
    if (session.speechDetected && elapsed >= MIN_RECORDING_MS && now - session.lastSpeechAt >= END_SILENCE_MS) {
      void this.finishLocalCapture(session);
    } else if (!session.speechDetected && elapsed >= NO_SPEECH_TIMEOUT_MS) {
      this.failLocalCapture(session, "没有检测到语音，请靠近麦克风后重试");
    } else if (elapsed >= MAX_RECORDING_MS) {
      void this.finishLocalCapture(session);
    }
  }

  private async finishLocalCapture(session: LocalCaptureSession): Promise<void> {
    if (this.localCapture !== session || session.finishing) return;
    session.finishing = true;
    this.recognitionStarting = true;
    this.cleanupLocalCapture(session, false);
    try {
      if (!session.speechDetected) throw new Error("没有检测到语音");
      session.onInterim("正在本地识别…");
      const audio = resampleToPcm16(session.chunks, session.sampleCount, session.context.sampleRate);
      const result = await this.recognizeLocal(audio);
      if (session.request !== this.recognitionRequest) return;
      if (!result.text) throw new Error("没有识别到清晰语音，请重试");
      session.onFinal(result.text);
      session.onInterim("");
      session.onState(false);
    } catch (error) {
      if (session.request === this.recognitionRequest) {
        session.onInterim("");
        session.onState(false, error instanceof Error ? error.message : "本地语音识别失败");
      }
    } finally {
      if (session.request === this.recognitionRequest) {
        this.recognitionStarting = false;
        this.listening = false;
      }
    }
  }

  private failLocalCapture(session: LocalCaptureSession, message: string): void {
    if (this.localCapture !== session) return;
    this.cleanupLocalCapture(session);
    this.recognitionStarting = false;
    this.listening = false;
    session.onState(false, message);
  }

  private cleanupLocalCapture(session: LocalCaptureSession | undefined, resetState = true): void {
    if (!session) return;
    if (this.localCapture === session) this.localCapture = undefined;
    session.processor.onaudioprocess = null;
    session.source.disconnect();
    session.processor.disconnect();
    session.mute.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    void session.context.close();
    if (resetState) {
      this.recognitionStarting = false;
      this.listening = false;
    }
  }

  speak(text: string): void {
    const settings = this.getSettings().voice;
    this.releaseAudio();
    this.cancelLocalSpeech();
    const request = ++this.speechRequest;
    if (!settings.outputEnabled || !text.trim()) return;
    const content = text.trim();
    if (settings.ttsMode === "local") {
      if (!this.speakLocal(content, request)) this.onSpeechError("当前环境不支持本机语音合成");
      return;
    }
    void this.synthesizeAndPlay(content, request);
  }

  cancelSpeech(): void {
    this.speechRequest += 1;
    this.releaseAudio();
    this.cancelLocalSpeech();
  }

  private async synthesizeAndPlay(text: string, request: number): Promise<void> {
    try {
      const result = await this.synthesize(text);
      if (request !== this.speechRequest) return;
      if (result.mimeType !== "audio/mpeg" || result.base64.length > 17_000_000) {
        throw new Error("TTS 返回了无效音频");
      }
      const blob = base64AudioBlob(result);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.currentAudio = audio;
      this.currentAudioUrl = url;
      audio.addEventListener("ended", () => {
        if (this.currentAudio === audio) this.releaseAudio();
      }, { once: true });
      audio.addEventListener("error", () => {
        if (this.currentAudio !== audio) return;
        this.fallbackToLocal(text, request, "TTS 音频无法播放");
      }, { once: true });
      await audio.play();
    } catch (error) {
      if (request !== this.speechRequest) return;
      const message = error instanceof Error ? error.message : "语音生成失败";
      this.fallbackToLocal(text, request, message);
    }
  }

  private fallbackToLocal(text: string, request: number, reason: string): void {
    if (request !== this.speechRequest) return;
    if (this.currentUtterance) return;
    this.releaseAudio();
    if (this.speakLocal(text, request)) {
      this.onSpeechError(`云端 TTS 不可用，已回退本机语音：${reason}`);
    } else {
      this.onSpeechError(`云端 TTS 失败且本机语音不可用：${reason}`);
    }
  }

  private speakLocal(text: string, request: number): boolean {
    const synthesis = window.speechSynthesis;
    if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") return false;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      const settings = this.getSettings().voice;
      utterance.lang = settings.language;
      utterance.rate = Math.min(4, Math.max(0.25, settings.ttsSpeed));
      utterance.voice = matchingVoice(synthesis.getVoices(), settings.language) ?? null;
      utterance.onend = () => {
        if (request === this.speechRequest && this.currentUtterance === utterance) {
          this.currentUtterance = undefined;
        }
      };
      utterance.onerror = (event) => {
        if (request !== this.speechRequest || this.currentUtterance !== utterance) return;
        this.currentUtterance = undefined;
        if (event.error !== "canceled" && event.error !== "interrupted") {
          this.onSpeechError(`本机语音播放失败：${event.error}`);
        }
      };
      this.currentUtterance = utterance;
      synthesis.speak(utterance);
      return true;
    } catch {
      this.currentUtterance = undefined;
      return false;
    }
  }

  private cancelLocalSpeech(): void {
    this.currentUtterance = undefined;
    window.speechSynthesis?.cancel();
  }

  private releaseAudio(): void {
    const audio = this.currentAudio;
    this.currentAudio = undefined;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    const url = this.currentAudioUrl;
    this.currentAudioUrl = undefined;
    if (url) URL.revokeObjectURL(url);
  }

  private errorMessage(error: string): string {
    const messages: Record<string, string> = {
      "not-allowed": "没有麦克风权限",
      "audio-capture": "找不到可用麦克风",
      network: "语音识别网络不可用",
      "language-not-supported": "本地语音识别语言包不可用",
      "no-speech": "没有识别到语音",
      aborted: "语音识别已取消",
    };
    return messages[error] ?? `语音识别失败：${error}`;
  }
}

export function resampleToPcm16(
  chunks: Float32Array[],
  sampleCount: number,
  inputSampleRate: number,
): LocalSpeechAudio {
  if (!Number.isFinite(inputSampleRate) || inputSampleRate < 8_000 || inputSampleRate > 192_000) {
    throw new Error("麦克风采样率无效");
  }
  const source = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    source.set(chunk.subarray(0, Math.min(chunk.length, sampleCount - offset)), offset);
    offset += chunk.length;
    if (offset >= sampleCount) break;
  }
  const outputLength = Math.max(1, Math.floor(sampleCount * TARGET_SAMPLE_RATE / inputSampleRate));
  const pcm = new Int16Array(outputLength);
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = outputIndex * ratio;
    const end = Math.min(sampleCount, (outputIndex + 1) * ratio);
    let sample = 0;
    if (ratio >= 1) {
      const first = Math.floor(start);
      const last = Math.max(first + 1, Math.ceil(end));
      let total = 0;
      for (let inputIndex = first; inputIndex < last && inputIndex < sampleCount; inputIndex += 1) {
        sample += source[inputIndex] ?? 0;
        total += 1;
      }
      sample /= Math.max(1, total);
    } else {
      const first = Math.floor(start);
      const fraction = start - first;
      const left = source[Math.min(first, sampleCount - 1)] ?? 0;
      const right = source[Math.min(first + 1, sampleCount - 1)] ?? left;
      sample = left + (right - left) * fraction;
    }
    const clipped = Math.max(-1, Math.min(1, sample));
    pcm[outputIndex] = clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
  }
  return { sampleRate: TARGET_SAMPLE_RATE, pcm16: pcm.buffer as ArrayBuffer };
}

function matchingVoice(voices: SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice | undefined {
  const wanted = language.toLowerCase();
  return voices.find((voice) => voice.lang.toLowerCase() === wanted)
    ?? voices.find((voice) => voice.lang.toLowerCase().split("-")[0] === wanted.split("-")[0]);
}

function base64AudioBlob(result: TtsAudio): Blob {
  let binary: string;
  try {
    binary = window.atob(result.base64);
  } catch {
    throw new Error("TTS 返回的音频编码无效");
  }
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < binary.length; offset += 64 * 1024) {
    const part = binary.slice(offset, offset + 64 * 1024);
    const bytes = new Uint8Array(new ArrayBuffer(part.length));
    for (let index = 0; index < part.length; index += 1) bytes[index] = part.charCodeAt(index);
    chunks.push(bytes.buffer);
  }
  return new Blob(chunks, { type: result.mimeType });
}
