import { parentPort } from "node:worker_threads";

interface SherpaStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { text: string };
  free(): void;
}

interface SherpaModule {
  createOnlineRecognizer(config: {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads: number;
      debug: boolean;
      modelType: string;
    };
    decodingMethod: string;
    maxActivePaths: number;
  }): SherpaRecognizer;
}

type WorkerRequest =
  | {
      type: "initialize";
      encoderPath: string;
      decoderPath: string;
      joinerPath: string;
      tokensPath: string;
    }
  | { type: "recognize"; requestId: number; sampleRate: number; pcm16: ArrayBuffer };

const port = parentPort;
if (!port) throw new Error("离线识别 worker 缺少父进程通道");

let recognizer: SherpaRecognizer | undefined;

port.on("message", (message: WorkerRequest) => {
  try {
    if (message.type === "initialize") {
      // CommonJS 主进程 worker 使用 require，避免把 21 MB WASM 打进渲染包。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sherpa = require("sherpa-onnx") as SherpaModule;
      recognizer = sherpa.createOnlineRecognizer({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: message.encoderPath,
            decoder: message.decoderPath,
            joiner: message.joinerPath,
          },
          tokens: message.tokensPath,
          numThreads: Math.max(1, Math.min(4, require("node:os").cpus().length - 1)),
          debug: false,
          modelType: "zipformer",
        },
        decodingMethod: "greedy_search",
        maxActivePaths: 4,
      });
      port.postMessage({ type: "ready" });
      return;
    }
    if (!recognizer) throw new Error("离线识别模型尚未初始化");
    const startedAt = Date.now();
    const pcm = new Int16Array(message.pcm16);
    const samples = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) {
      samples[index] = (pcm[index] ?? 0) / 32768;
    }
    const stream = recognizer.createStream();
    try {
      stream.acceptWaveform(message.sampleRate, samples);
      // 流式模型需要尾部静音才能提交最后几个字；整段 PCM 仍只在本机 worker 中处理。
      stream.acceptWaveform(message.sampleRate, new Float32Array(message.sampleRate / 2));
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.trim();
      port.postMessage({
        type: "result",
        requestId: message.requestId,
        text,
        processingMs: Date.now() - startedAt,
      });
    } finally {
      stream.free();
    }
  } catch (error) {
    port.postMessage({
      type: "failure",
      requestId: message.type === "recognize" ? message.requestId : undefined,
      message: error instanceof Error ? error.message : "离线识别 worker 发生未知错误",
    });
  }
});

process.once("exit", () => recognizer?.free());
