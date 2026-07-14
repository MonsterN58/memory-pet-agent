import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  LocalSpeechAudio,
  LocalSpeechModelStatus,
  LocalSpeechRecognitionResult,
} from "../common/types";

export const LOCAL_ASR_MODEL_ID = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23";
export const LOCAL_ASR_CANCELLED_MESSAGE = "本地语音识别已取消";
const REQUIRED_FILES = [
  ["encoder-epoch-99-avg-1.int8.onnx", 21_621_684, "1c556ea57cec304e55ec4b72e52c1cc098bb01476ed7d90f3de939fe126487b1"],
  ["decoder-epoch-99-avg-1.onnx", 7_509_745, "5ee0f03a2768ff1d5c83ef3a493243c7935d316cd41280037b14783a3467cc78"],
  ["joiner-epoch-99-avg-1.int8.onnx", 1_795_562, "a7cf9d82757bdcf786059454495a9ca95e4bd7347f72473fc08d794475c36169"],
  ["tokens.txt", 48_697, "8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac"],
] as const;
const MAX_AUDIO_BYTES = 16_000 * 2 * 30;
const MIN_AUDIO_BYTES = 16_000 * 2 / 4;

interface PendingRequest {
  resolve: (value: LocalSpeechRecognitionResult) => void;
  reject: (error: Error) => void;
  durationMs: number;
  timeout: NodeJS.Timeout;
}

type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; requestId: number; text: string; processingMs: number }
  | { type: "failure"; requestId?: number; message: string };

export interface LocalAsrWorker {
  on(event: "message", listener: (message: WorkerResponse) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void;
  terminate(): Promise<number>;
}

export interface LocalAsrServiceOptions {
  createWorker?: (filename: string) => LocalAsrWorker;
  initializationTimeoutMs?: number;
  recognitionTimeoutMs?: number;
}

export class LocalAsrService {
  private worker?: LocalAsrWorker;
  private workerReady?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private initializationTimeout?: NodeJS.Timeout;
  private readyStatus?: LocalSpeechModelStatus;
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly createWorker: (filename: string) => LocalAsrWorker;
  private readonly initializationTimeoutMs: number;
  private readonly recognitionTimeoutMs: number;

  constructor(readonly modelDirectory: string, options: LocalAsrServiceOptions = {}) {
    this.createWorker = options.createWorker ?? ((filename) => new Worker(filename) as LocalAsrWorker);
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 30_000;
    this.recognitionTimeoutMs = options.recognitionTimeoutMs ?? 30_000;
  }

  async status(): Promise<LocalSpeechModelStatus> {
    if (this.readyStatus) return this.readyStatus;
    const sizes = await Promise.all(REQUIRED_FILES.map(([name]) => fileSize(join(this.modelDirectory, name))));
    const installedSize = sizes.reduce<number>((total, size) => total + (size ?? 0), 0);
    if (sizes.some((size) => size === undefined)) {
      return {
        state: "missing",
        modelId: LOCAL_ASR_MODEL_ID,
        directory: this.modelDirectory,
        sizeBytes: installedSize,
        message: "本地识别模型未安装，请在项目目录运行 npm run voice:model:download",
      };
    }
    if (sizes.some((size, index) => size !== REQUIRED_FILES[index]?.[1])) {
      return {
        state: "invalid",
        modelId: LOCAL_ASR_MODEL_ID,
        directory: this.modelDirectory,
        sizeBytes: installedSize,
        message: "本地识别模型大小异常，请运行 npm run voice:model:download 修复",
      };
    }
    const hashes = await Promise.all(REQUIRED_FILES.map(([name]) => sha256(join(this.modelDirectory, name))));
    if (hashes.some((hash, index) => hash !== REQUIRED_FILES[index]?.[2])) {
      return {
        state: "invalid",
        modelId: LOCAL_ASR_MODEL_ID,
        directory: this.modelDirectory,
        sizeBytes: installedSize,
        message: "本地识别模型 SHA-256 校验失败，请运行 npm run voice:model:download 修复",
      };
    }
    this.readyStatus = {
      state: "ready",
      modelId: LOCAL_ASR_MODEL_ID,
      directory: this.modelDirectory,
      sizeBytes: installedSize,
      message: "小型中文 Zipformer 离线识别模型已就绪，录音只在本机处理",
    };
    return this.readyStatus;
  }

  async recognize(value: unknown): Promise<LocalSpeechRecognitionResult> {
    const audio = sanitizeLocalSpeechAudio(value);
    const requestId = ++this.nextRequestId;
    const durationMs = Math.round(audio.pcm16.byteLength / 2 / audio.sampleRate * 1000);
    return new Promise<LocalSpeechRecognitionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.resetWorker(new Error("本地语音识别超时"));
      }, this.recognitionTimeoutMs);
      this.pending.set(requestId, { resolve, reject, durationMs, timeout });
      void this.dispatchRecognition(requestId, audio);
    });
  }

  async warmup(): Promise<void> {
    const status = await this.status();
    if (status.state !== "ready") throw new Error(status.message);
    await this.ensureWorker();
  }

  async cancelCurrent(): Promise<void> {
    const worker = this.invalidateWorker(new Error(LOCAL_ASR_CANCELLED_MESSAGE));
    if (worker) await worker.terminate().catch(() => 0);
  }

  async close(): Promise<void> {
    const worker = this.invalidateWorker(new Error("应用正在退出"));
    if (worker) await worker.terminate().catch(() => 0);
  }

  private async dispatchRecognition(requestId: number, audio: LocalSpeechAudio): Promise<void> {
    try {
      const status = await this.status();
      if (status.state !== "ready") throw new Error(status.message);
      if (!this.pending.has(requestId)) return;
      await this.ensureWorker();
      if (!this.pending.has(requestId)) return;
      const worker = this.worker;
      if (!worker) throw new Error("本地识别 worker 未就绪");
      try {
        worker.postMessage(
          { type: "recognize", requestId, sampleRate: audio.sampleRate, pcm16: audio.pcm16 },
          [audio.pcm16],
        );
      } catch (error) {
        this.resetWorker(error instanceof Error ? error : new Error("无法提交本地语音识别任务"));
      }
    } catch (error) {
      if (!this.pending.has(requestId)) return;
      const failure = error instanceof Error ? error : new Error("本地语音识别失败");
      if (this.worker) this.resetWorker(failure);
      else this.finishPending(requestId, failure);
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady;
    const worker = this.createWorker(join(__dirname, "local-asr-worker.js"));
    this.worker = worker;
    worker.on("message", (message: WorkerResponse) => this.handleWorkerMessage(worker, message));
    worker.on("error", (error) => {
      if (this.worker === worker) this.resetWorker(error);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.resetWorker(new Error(`离线识别 worker 异常退出：${code}`));
    });
    const workerReady = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.workerReady = workerReady;
    this.initializationTimeout = setTimeout(() => {
      if (this.worker === worker) this.resetWorker(new Error("本地识别模型加载超时"));
    }, this.initializationTimeoutMs);
    try {
      worker.postMessage({
        type: "initialize",
        encoderPath: wasmPath(join(this.modelDirectory, "encoder-epoch-99-avg-1.int8.onnx")),
        decoderPath: wasmPath(join(this.modelDirectory, "decoder-epoch-99-avg-1.onnx")),
        joinerPath: wasmPath(join(this.modelDirectory, "joiner-epoch-99-avg-1.int8.onnx")),
        tokensPath: wasmPath(join(this.modelDirectory, "tokens.txt")),
      });
    } catch (error) {
      this.resetWorker(error instanceof Error ? error : new Error("无法初始化本地识别 worker"));
    }
    return workerReady;
  }

  private handleWorkerMessage(worker: LocalAsrWorker, message: WorkerResponse): void {
    if (this.worker !== worker) return;
    if (message.type === "ready") {
      if (this.initializationTimeout) clearTimeout(this.initializationTimeout);
      this.initializationTimeout = undefined;
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (message.type === "failure" && message.requestId === undefined) {
      this.resetWorker(new Error(`无法加载本地识别模型：${message.message}`));
      return;
    }
    if (message.type === "failure") {
      this.finishPending(message.requestId, new Error(`本地语音识别失败：${message.message}`));
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    pending.resolve({ text: message.text, durationMs: pending.durationMs });
  }

  private finishPending(requestId: number | undefined, error: Error): void {
    if (requestId === undefined) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private invalidateWorker(error: Error): LocalAsrWorker | undefined {
    const worker = this.worker;
    if (this.initializationTimeout) clearTimeout(this.initializationTimeout);
    this.initializationTimeout = undefined;
    this.readyReject?.(error);
    this.workerReady = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.worker = undefined;
    for (const [requestId] of this.pending) this.finishPending(requestId, error);
    return worker;
  }

  private resetWorker(error: Error): void {
    const worker = this.invalidateWorker(error);
    if (worker) void worker.terminate().catch(() => 0);
  }
}

function wasmPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function sanitizeLocalSpeechAudio(value: unknown): LocalSpeechAudio {
  if (!value || typeof value !== "object") throw new Error("语音数据格式无效");
  const candidate = value as Partial<LocalSpeechAudio>;
  if (candidate.sampleRate !== 16_000) throw new Error("本地识别只接受 16 kHz 音频");
  if (!(candidate.pcm16 instanceof ArrayBuffer)) throw new Error("语音 PCM 数据格式无效");
  if (candidate.pcm16.byteLength < MIN_AUDIO_BYTES) throw new Error("录音过短，请至少说话 0.25 秒");
  if (candidate.pcm16.byteLength > MAX_AUDIO_BYTES) throw new Error("单次录音不能超过 30 秒");
  if (candidate.pcm16.byteLength % 2 !== 0) throw new Error("语音 PCM 数据长度无效");
  return { sampleRate: 16_000, pcm16: candidate.pcm16.slice(0) };
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
