import type {
  AgentSettings,
  LocalSpeechAudio,
  LocalSpeechRecognitionResult,
  TtsAudio,
} from "../common/types";

interface LocalCaptureResources {
  stream: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  mute?: GainNode;
  trackEndedListeners?: Array<{ track: MediaStreamTrack; listener: () => void }>;
}

interface LocalVoiceOperation {
  request: number;
  phase: "starting" | "recording" | "recognizing" | "cancelling";
  settled: boolean;
  resources?: LocalCaptureResources;
  chunks: Float32Array[];
  sampleCount: number;
  inputSampleRate: number;
  startedAt: number;
  lastSpeechAt: number;
  speechDetected: boolean;
  noiseFloor: number;
  recognitionStartedAt: number;
  captureWatchdog?: number;
  noSpeechWatchdog?: number;
  watchdog?: number;
  statusTimer?: number;
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onState: (listening: boolean, error?: string) => void;
}

export interface VoiceTimerFacade {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

const TARGET_SAMPLE_RATE = 16_000;
const NO_SPEECH_TIMEOUT_MS = 8_000;
const END_SILENCE_MS = 1_200;
const MIN_RECORDING_MS = 700;
const MAX_RECORDING_MS = 30_000;
const LOCAL_RECOGNITION_WATCHDOG_MS = 35_000;

const DEFAULT_VOICE_TIMERS: VoiceTimerFacade = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export class VoiceService {
  private recognition?: SpeechRecognitionLike;
  private browserOnInterim?: (text: string) => void;
  private browserOnState?: (listening: boolean, error?: string) => void;
  private listening = false;
  private recognitionStarting = false;
  private recognitionRequest = 0;
  private localOperation?: LocalVoiceOperation;
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
    private cancelRecognize: () => Promise<void> = async () => undefined,
    private timers: VoiceTimerFacade = DEFAULT_VOICE_TIMERS,
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
    const localOperation = this.localOperation;
    if (localOperation && !localOperation.settled) {
      if (localOperation.phase === "recording") void this.finishLocalCapture(localOperation);
      else this.cancelLocalOperation(localOperation);
      return;
    }
    if (this.listening || this.recognitionStarting) {
      this.stop();
      return;
    }
    const request = ++this.recognitionRequest;
    this.recognitionStarting = true;
    if (settings.recognitionMode === "local") {
      const now = performance.now();
      const operation: LocalVoiceOperation = {
        request,
        phase: "starting",
        settled: false,
        chunks: [],
        sampleCount: 0,
        inputSampleRate: TARGET_SAMPLE_RATE,
        startedAt: now,
        lastSpeechAt: now,
        speechDetected: false,
        noiseFloor: 0.004,
        recognitionStartedAt: 0,
        onFinal,
        onInterim,
        onState,
      };
      this.localOperation = operation;
      operation.captureWatchdog = this.timers.setTimeout(() => {
        if (this.localOperation === operation && !operation.settled && operation.phase === "starting") {
          this.finishLocalOperation(operation, { error: "麦克风启动超时，请重试" });
        }
      }, MAX_RECORDING_MS);
      this.listening = true;
      void this.startLocalCapture(operation).catch((error: unknown) => {
        this.finishLocalOperation(operation, {
          error: error instanceof Error ? error.message : "无法启动语音识别",
        });
      });
      return;
    }
    const task = this.startBrowserRecognition(settings.language, request, onFinal, onInterim, onState);
    void task.catch((error: unknown) => {
      if (request !== this.recognitionRequest) return;
      this.recognitionStarting = false;
      this.recognition = undefined;
      onState(false, error instanceof Error ? error.message : "无法启动语音识别");
    });
  }

  stop(): void {
    const operation = this.localOperation;
    if (operation && !operation.settled) {
      this.cancelLocalOperation(operation);
      return;
    }
    this.recognitionRequest += 1;
    this.recognitionStarting = false;
    this.listening = false;
    const recognition = this.recognition;
    const onInterim = this.browserOnInterim;
    const onState = this.browserOnState;
    this.recognition = undefined;
    this.browserOnInterim = undefined;
    this.browserOnState = undefined;
    onInterim?.("");
    onState?.(false);
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
    this.browserOnInterim = onInterim;
    this.browserOnState = onState;
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
      this.browserOnInterim = undefined;
      this.browserOnState = undefined;
      onState(false);
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition) return;
      this.recognitionStarting = false;
      this.listening = false;
      this.recognition = undefined;
      this.browserOnInterim = undefined;
      this.browserOnState = undefined;
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
      this.browserOnInterim = undefined;
      this.browserOnState = undefined;
      this.recognitionStarting = false;
      onState(false, error instanceof Error ? error.message : "无法启动语音识别");
    }
  }

  private async startLocalCapture(operation: LocalVoiceOperation): Promise<void> {
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
    if (this.localOperation !== operation || operation.settled) {
      stopMediaStream(stream);
      return;
    }
    const resources: LocalCaptureResources = { stream };
    operation.resources = resources;
    const trackEnded = () => {
      if (
        this.localOperation === operation
        && !operation.settled
        && (operation.phase === "starting" || operation.phase === "recording")
      ) {
        this.finishLocalOperation(operation, { error: "麦克风已断开，请重新连接后重试" });
      }
    };
    resources.trackEndedListeners = [];
    for (const track of stream.getTracks()) {
      if (typeof track.addEventListener !== "function") continue;
      track.addEventListener("ended", trackEnded, { once: true });
      resources.trackEndedListeners.push({ track, listener: trackEnded });
    }
    if (this.localOperation !== operation || operation.settled) return;
    const context = new AudioContext({ latencyHint: "interactive" });
    resources.context = context;
    const source = context.createMediaStreamSource(stream);
    resources.source = source;
    const processor = context.createScriptProcessor(4096, 1, 1);
    resources.processor = processor;
    const mute = context.createGain();
    resources.mute = mute;
    mute.gain.value = 0;
    operation.inputSampleRate = context.sampleRate;
    processor.onaudioprocess = (event) => this.handleAudioChunk(operation, event.inputBuffer.getChannelData(0));
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    await context.resume();
    if (this.localOperation !== operation || operation.settled) {
      this.cleanupLocalResources(operation);
      return;
    }
    operation.phase = "recording";
    const recordingStartedAt = performance.now();
    operation.startedAt = recordingStartedAt;
    operation.lastSpeechAt = recordingStartedAt;
    this.clearCaptureTimers(operation);
    operation.captureWatchdog = this.timers.setTimeout(() => {
      if (this.localOperation !== operation || operation.settled || operation.phase !== "recording") return;
      if (operation.speechDetected) void this.finishLocalCapture(operation);
      else this.finishLocalOperation(operation, { error: "没有检测到语音，请靠近麦克风后重试" });
    }, MAX_RECORDING_MS);
    operation.noSpeechWatchdog = this.timers.setTimeout(() => {
      if (
        this.localOperation === operation
        && !operation.settled
        && operation.phase === "recording"
        && !operation.speechDetected
      ) {
        this.finishLocalOperation(operation, { error: "没有检测到语音，请靠近麦克风后重试" });
      }
    }, NO_SPEECH_TIMEOUT_MS);
    this.recognitionStarting = false;
    this.listening = true;
    invokeVoiceCallback(() => operation.onState(true));
  }

  private handleAudioChunk(operation: LocalVoiceOperation, input: Float32Array): void {
    if (this.localOperation !== operation || operation.phase !== "recording" || operation.settled) return;
    const maxSampleCount = Math.max(1, Math.floor(operation.inputSampleRate * MAX_RECORDING_MS / 1000));
    const remainingSamples = maxSampleCount - operation.sampleCount;
    if (remainingSamples <= 0) {
      void this.finishLocalCapture(operation);
      return;
    }
    const chunk = new Float32Array(input.subarray(0, Math.min(input.length, remainingSamples)));
    operation.chunks.push(chunk);
    operation.sampleCount += chunk.length;
    let energy = 0;
    for (const value of chunk) energy += value * value;
    const rms = Math.sqrt(energy / Math.max(1, chunk.length));
    const now = performance.now();
    const threshold = Math.max(0.012, operation.noiseFloor * 2.8);
    if (rms >= threshold) {
      if (!operation.speechDetected && operation.noSpeechWatchdog !== undefined) {
        this.timers.clearTimeout(operation.noSpeechWatchdog);
        operation.noSpeechWatchdog = undefined;
      }
      operation.speechDetected = true;
      operation.lastSpeechAt = now;
    } else if (!operation.speechDetected) {
      operation.noiseFloor = Math.min(0.03, operation.noiseFloor * 0.94 + rms * 0.06);
    }
    if (operation.sampleCount >= maxSampleCount) {
      void this.finishLocalCapture(operation);
      return;
    }
    const elapsed = now - operation.startedAt;
    if (operation.speechDetected && elapsed >= MIN_RECORDING_MS && now - operation.lastSpeechAt >= END_SILENCE_MS) {
      void this.finishLocalCapture(operation);
    } else if (!operation.speechDetected && elapsed >= NO_SPEECH_TIMEOUT_MS) {
      this.finishLocalOperation(operation, { error: "没有检测到语音，请靠近麦克风后重试" });
    } else if (elapsed >= MAX_RECORDING_MS) {
      void this.finishLocalCapture(operation);
    }
  }

  private async finishLocalCapture(operation: LocalVoiceOperation): Promise<void> {
    if (this.localOperation !== operation || operation.phase !== "recording" || operation.settled) return;
    operation.phase = "recognizing";
    this.clearCaptureTimers(operation);
    this.recognitionStarting = true;
    try {
      const audio = operation.speechDetected
        ? resampleToPcm16(operation.chunks, operation.sampleCount, operation.inputSampleRate)
        : undefined;
      this.cleanupLocalResources(operation);
      if (!audio) {
        this.finishLocalOperation(operation, { error: "没有检测到语音" });
        return;
      }
      operation.recognitionStartedAt = performance.now();
      invokeVoiceCallback(() => operation.onInterim("正在本地识别… 0s"));
      if (this.localOperation !== operation || operation.settled || operation.phase !== "recognizing") return;
      const updateElapsed = () => {
        if (this.localOperation !== operation || operation.settled || operation.phase !== "recognizing") return;
        const seconds = Math.max(1, Math.floor((performance.now() - operation.recognitionStartedAt) / 1000));
        invokeVoiceCallback(() => operation.onInterim(`正在本地识别… ${seconds}s`));
        if (this.localOperation !== operation || operation.settled || operation.phase !== "recognizing") return;
        operation.statusTimer = this.timers.setTimeout(updateElapsed, 1000);
      };
      operation.statusTimer = this.timers.setTimeout(updateElapsed, 1000);
      operation.watchdog = this.timers.setTimeout(() => {
        this.cancelLocalOperation(operation, "本地语音识别超时，请重试");
      }, LOCAL_RECOGNITION_WATCHDOG_MS);
      const result = await this.recognizeLocal(audio);
      if (this.localOperation !== operation || operation.settled) return;
      if (!result.text) throw new Error("没有识别到清晰语音，请重试");
      this.finishLocalOperation(operation, { text: result.text });
    } catch (error) {
      this.finishLocalOperation(operation, {
        error: error instanceof Error ? error.message : "本地语音识别失败",
      });
    }
  }

  private cancelLocalOperation(operation: LocalVoiceOperation, error?: string): void {
    if (this.localOperation !== operation || operation.settled) return;
    const cancelWorker = operation.phase === "recognizing";
    operation.phase = "cancelling";
    try {
      this.finishLocalOperation(operation, error ? { error } : {});
    } finally {
      if (cancelWorker) {
        try {
          void Promise.resolve(this.cancelRecognize()).catch((cancelError: unknown) => {
            console.warn("Unable to cancel local speech recognition", cancelError);
          });
        } catch (cancelError) {
          console.warn("Unable to cancel local speech recognition", cancelError);
        }
      }
    }
  }

  private finishLocalOperation(
    operation: LocalVoiceOperation,
    outcome: { text?: string; error?: string },
  ): void {
    if (operation.settled || this.localOperation !== operation) return;
    operation.settled = true;
    if (operation.watchdog !== undefined) this.timers.clearTimeout(operation.watchdog);
    if (operation.statusTimer !== undefined) this.timers.clearTimeout(operation.statusTimer);
    operation.watchdog = undefined;
    operation.statusTimer = undefined;
    this.clearCaptureTimers(operation);
    this.localOperation = undefined;
    this.cleanupLocalResources(operation);
    this.recognitionStarting = false;
    this.listening = false;
    invokeVoiceCallback(() => operation.onInterim(""));
    invokeVoiceCallback(() => operation.onState(false, outcome.error));
    if (outcome.text) invokeVoiceCallback(() => operation.onFinal(outcome.text!));
  }

  private cleanupLocalResources(operation: LocalVoiceOperation): void {
    const resources = operation.resources;
    operation.resources = undefined;
    if (!resources) return;
    for (const { track, listener } of resources.trackEndedListeners ?? []) {
      try { track.removeEventListener("ended", listener); } catch { /* 继续释放其余音频资源。 */ }
    }
    try {
      if (resources.processor) resources.processor.onaudioprocess = null;
    } catch {
      // 资源已由浏览器释放时继续完成其余清理。
    }
    for (const node of [resources.source, resources.processor, resources.mute]) {
      if (!node) continue;
      try { node.disconnect(); } catch { /* The node was already disconnected. */ }
    }
    stopMediaStream(resources.stream);
    try {
      void resources.context?.close().catch(() => undefined);
    } catch {
      // close() 也可能在上下文已关闭时同步抛错。
    }
  }

  private clearCaptureTimers(operation: LocalVoiceOperation): void {
    if (operation.captureWatchdog !== undefined) this.timers.clearTimeout(operation.captureWatchdog);
    if (operation.noSpeechWatchdog !== undefined) this.timers.clearTimeout(operation.noSpeechWatchdog);
    operation.captureWatchdog = undefined;
    operation.noSpeechWatchdog = undefined;
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

function invokeVoiceCallback(callback: () => void): void {
  try { callback(); } catch { /* UI 回调异常不能破坏语音 operation 收尾。 */ }
}

function stopMediaStream(stream: MediaStream): void {
  let tracks: MediaStreamTrack[];
  try { tracks = stream.getTracks(); } catch { return; }
  for (const track of tracks) {
    try { track.stop(); } catch { /* 继续停止其余轨道。 */ }
  }
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
