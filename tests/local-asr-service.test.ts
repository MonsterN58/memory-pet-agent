import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalAsrService,
  sanitizeLocalSpeechAudio,
  type LocalAsrServiceOptions,
  type LocalAsrTimerFacade,
} from "../src/main/local-asr-service";

test("本地 ASR 清晰报告项目模型缺失", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-asr-missing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const status = await new LocalAsrService(directory).status();
  assert.equal(status.state, "missing");
  assert.equal(status.runtimeState, "not-started");
  assert.equal(status.directory, directory);
  assert.match(status.message, /voice:model:download/);
});

test("本地 ASR IPC 只接受 16 kHz、0.25 到 30 秒的 PCM16", () => {
  const valid = new ArrayBuffer(16_000);
  const sanitized = sanitizeLocalSpeechAudio({ sampleRate: 16_000, pcm16: valid });
  assert.equal(sanitized.sampleRate, 16_000);
  assert.notEqual(sanitized.pcm16, valid);
  assert.equal(sanitized.pcm16.byteLength, valid.byteLength);
  assert.throws(
    () => sanitizeLocalSpeechAudio({ sampleRate: 48_000, pcm16: valid }),
    /16 kHz/,
  );
  assert.throws(
    () => sanitizeLocalSpeechAudio({ sampleRate: 16_000, pcm16: new ArrayBuffer(100) }),
    /录音过短/,
  );
  assert.throws(
    () => sanitizeLocalSpeechAudio({ sampleRate: 16_000, pcm16: new ArrayBuffer(16_000 * 2 * 31) }),
    /不能超过 30 秒/,
  );
});

test("本地 ASR warmup 并发复用同一个 worker", async () => {
  const fixture = createServiceFixture();
  const first = fixture.service.warmup();
  const second = fixture.service.warmup();
  const worker = await waitForWorker(fixture.workers, 0);
  assert.equal(fixture.workers.length, 1);
  assert.equal(worker.messages.filter((message) => message.type === "initialize").length, 1);
  worker.emitMessage({ type: "ready" });
  await Promise.all([first, second]);
  await fixture.service.warmup();
  assert.equal(fixture.workers.length, 1);
  await fixture.service.close();
});

test("本地 ASR 公开预热失败并允许下一次重试恢复", async () => {
  const fixture = createServiceFixture();
  const firstWarmup = fixture.service.warmup();
  const firstWorker = await waitForWorker(fixture.workers, 0);
  assert.equal((await fixture.service.status()).runtimeState, "warming");
  firstWorker.emitMessage({ type: "failure", message: "fixture init failed" });
  await assert.rejects(firstWarmup, /fixture init failed/);
  const failed = await fixture.service.status();
  assert.equal(failed.state, "ready");
  assert.equal(failed.runtimeState, "failed");
  assert.match(failed.runtimeMessage ?? "", /fixture init failed/);

  const secondWarmup = fixture.service.warmup();
  const secondWorker = await waitForWorker(fixture.workers, 1);
  assert.equal((await fixture.service.status()).runtimeState, "warming");
  secondWorker.emitMessage({ type: "ready" });
  await secondWarmup;
  assert.equal((await fixture.service.status()).runtimeState, "ready");
  assert.deepEqual(
    fixture.statusEvents.map((status) => status.runtimeState),
    ["warming", "failed", "warming", "ready"],
  );
  await fixture.service.close();
});

test("本地 ASR worker 创建失败也会公开状态且可恢复", async () => {
  const workers: FakeWorker[] = [];
  let attempts = 0;
  const service = new ReadyLocalAsrService("D:/fixture/model", {
    createWorker: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture create failed");
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });

  await assert.rejects(service.warmup(), /fixture create failed/);
  assert.equal((await service.status()).runtimeState, "failed");
  const recovered = service.warmup();
  const worker = await waitForWorker(workers, 0);
  worker.emitMessage({ type: "ready" });
  await recovered;
  assert.equal((await service.status()).runtimeState, "ready");
  await service.close();
});

test("本地 ASR 状态观察者异常不会破坏 worker 生命周期", async () => {
  const worker = new FakeWorker();
  const service = new ReadyLocalAsrService("D:/fixture/model", {
    createWorker: () => worker,
    onStatusChanged: () => {
      throw new Error("fixture observer failed");
    },
  });

  const warmup = service.warmup();
  await waitForRecognitionMessage(worker, "initialize");
  worker.emitMessage({ type: "ready" });
  await warmup;
  assert.equal((await service.status()).runtimeState, "ready");
  await service.close();
});

test("本地 ASR 取消会拒绝 pending、终止 worker 且下一次可恢复", async () => {
  const fixture = createServiceFixture();
  const firstWarmup = fixture.service.warmup();
  const firstWorker = await waitForWorker(fixture.workers, 0);
  firstWorker.emitMessage({ type: "ready" });
  await firstWarmup;
  const firstRecognition = fixture.service.recognize(validAudio());
  const firstRequest = await waitForRecognition(firstWorker);

  await fixture.service.cancelCurrent();
  await assert.rejects(firstRecognition, /已取消/);
  assert.equal(fixture.workers[0]?.terminateCalls, 1);
  assert.equal((await fixture.service.status()).runtimeState, "not-started");

  const secondRecognition = fixture.service.recognize(validAudio());
  const secondWorker = await waitForWorker(fixture.workers, 1);
  assert.equal(fixture.workers.length, 2);
  secondWorker.emitMessage({ type: "ready" });
  const secondRequest = await waitForRecognition(secondWorker);
  secondWorker.emitMessage({
    type: "result", requestId: secondRequest.requestId, text: "恢复成功", processingMs: 8,
  });
  assert.equal((await secondRecognition).text, "恢复成功");
  assert.notEqual(firstRequest.requestId, secondRequest.requestId);
  await fixture.service.close();
});

test("本地 ASR 在 status 等待期间取消不会复活 worker", async () => {
  const fixture = createServiceFixture();
  const recognition = fixture.service.recognize(validAudio());
  await fixture.service.cancelCurrent();
  await assert.rejects(recognition, /已取消/);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(fixture.workers.length, 0);
  await fixture.service.close();
});

test("本地 ASR 的 30 秒总时限包含尚未完成的 warmup", async () => {
  const fixture = createServiceFixture({ recognitionTimeoutMs: 30_000, initializationTimeoutMs: 30_000 });
  const recognition = fixture.service.recognize(validAudio());
  await waitForWorker(fixture.workers, 0);
  fixture.timers.advanceBy(30_000);
  await assert.rejects(recognition, /本地语音识别超时/);
  assert.equal(fixture.workers[0]?.terminateCalls, 1);
  await fixture.service.close();
});

test("本地 ASR decode 超时会重建 worker 并允许后续请求成功", async () => {
  const fixture = createServiceFixture({ recognitionTimeoutMs: 30_000 });
  const firstWarmup = fixture.service.warmup();
  const firstWorker = await waitForWorker(fixture.workers, 0);
  firstWorker.emitMessage({ type: "ready" });
  await firstWarmup;
  const timedOut = fixture.service.recognize(validAudio());
  await waitForRecognition(firstWorker);
  fixture.timers.advanceBy(30_000);
  await assert.rejects(timedOut, /本地语音识别超时/);
  assert.equal(fixture.workers[0]?.terminateCalls, 1);

  const recovered = fixture.service.recognize(validAudio());
  const secondWorker = await waitForWorker(fixture.workers, 1);
  secondWorker.emitMessage({ type: "ready" });
  const request = await waitForRecognition(secondWorker);
  secondWorker.emitMessage({ type: "result", requestId: request.requestId, text: "下一次正常", processingMs: 4 });
  assert.equal((await recovered).text, "下一次正常");
  await fixture.service.close();
});

test("本地 ASR 模型初始化超时由可注入时钟确定性重置 worker", async () => {
  const fixture = createServiceFixture({ initializationTimeoutMs: 30_000 });
  const warmup = fixture.service.warmup();
  await waitForWorker(fixture.workers, 0);

  fixture.timers.advanceBy(30_000);

  await assert.rejects(warmup, /本地识别模型加载超时/);
  assert.equal(fixture.workers[0]?.terminateCalls, 1);
  await fixture.service.close();
});

test("旧 worker 的迟到事件不会污染重建后的 worker", async () => {
  const fixture = createServiceFixture();
  const firstWarmup = fixture.service.warmup();
  const oldWorker = await waitForWorker(fixture.workers, 0);
  oldWorker.emitMessage({ type: "ready" });
  await firstWarmup;
  await fixture.service.cancelCurrent();

  const secondWarmup = fixture.service.warmup();
  const currentWorker = await waitForWorker(fixture.workers, 1);
  oldWorker.emitMessage({ type: "ready" });
  oldWorker.emit("error", new Error("迟到错误"));
  oldWorker.emit("exit", 0);
  assert.equal(currentWorker.terminateCalls, 0);
  currentWorker.emitMessage({ type: "ready" });
  await secondWarmup;
  assert.equal(fixture.workers.length, 2);
  await fixture.service.close();
});

test("当前 worker 即使以 code 0 意外退出也会重建", async () => {
  const fixture = createServiceFixture();
  const firstWarmup = fixture.service.warmup();
  const firstWorker = await waitForWorker(fixture.workers, 0);
  firstWorker.emitMessage({ type: "ready" });
  await firstWarmup;
  firstWorker.emit("exit", 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const secondWarmup = fixture.service.warmup();
  const secondWorker = await waitForWorker(fixture.workers, 1);
  secondWorker.emitMessage({ type: "ready" });
  await secondWarmup;
  assert.equal(fixture.workers.length, 2);
  await fixture.service.close();
});

test("worker initialize postMessage 同步失败会让 warmup 明确失败", async () => {
  const worker = new FakeWorker();
  worker.postMessageError = new Error("initialize post failed");
  const service = new ReadyLocalAsrService("D:/fixture/model", {
    createWorker: () => worker,
    initializationTimeoutMs: 500,
    recognitionTimeoutMs: 500,
  });
  await assert.rejects(service.warmup(), /initialize post failed/);
  assert.equal(worker.terminateCalls, 1);
  await service.close();
});

test("close 后不会让仍在等待 status 的 warmup 复活 worker", async () => {
  const workers: FakeWorker[] = [];
  const status = deferred<{
    state: "ready";
    modelId: string;
    directory: string;
    sizeBytes: number;
    message: string;
  }>();
  const service = new DeferredStatusLocalAsrService("D:/fixture/model", status.promise, {
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    initializationTimeoutMs: 500,
    recognitionTimeoutMs: 500,
  });
  const warmup = service.warmup();
  await service.statusStarted;
  await service.close();
  const rejected = assert.rejects(warmup, /已关闭/);
  status.resolve({
    state: "ready",
    modelId: "test-model",
    directory: service.modelDirectory,
    sizeBytes: 1,
    message: "ready",
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  workers[0]?.emitMessage({ type: "ready" });

  await rejected;
  assert.equal(workers.length, 0);
});

class ReadyLocalAsrService extends LocalAsrService {
  protected override async readModelFileStatus() {
    return {
      state: "ready" as const,
      modelId: "test-model",
      directory: this.modelDirectory,
      sizeBytes: 1,
      message: "ready",
    };
  }
}

class DeferredStatusLocalAsrService extends LocalAsrService {
  readonly statusStarted: Promise<void>;
  private markStatusStarted!: () => void;

  constructor(
    modelDirectory: string,
    private readonly statusResult: Promise<{
      state: "ready";
      modelId: string;
      directory: string;
      sizeBytes: number;
      message: string;
    }>,
    options: LocalAsrServiceOptions,
  ) {
    super(modelDirectory, options);
    this.statusStarted = new Promise<void>((resolve) => { this.markStatusStarted = resolve; });
  }

  protected override async readModelFileStatus() {
    this.markStatusStarted();
    return this.statusResult;
  }
}

class FakeWorker extends EventEmitter {
  readonly messages: Array<Record<string, unknown>> = [];
  terminateCalls = 0;
  postMessageError?: Error;

  postMessage(message: Record<string, unknown>): void {
    if (this.postMessageError) throw this.postMessageError;
    this.messages.push(message);
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 0;
  }

  emitMessage(message: Record<string, unknown>): void {
    this.emit("message", message);
  }
}

function createServiceFixture(overrides: Partial<LocalAsrServiceOptions> = {}): {
  service: ReadyLocalAsrService;
  workers: FakeWorker[];
  timers: ManualTimers;
  statusEvents: Awaited<ReturnType<LocalAsrService["status"]>>[];
} {
  const workers: FakeWorker[] = [];
  const timers = new ManualTimers();
  const statusEvents: Awaited<ReturnType<LocalAsrService["status"]>>[] = [];
  const service = new ReadyLocalAsrService("D:/fixture/model", {
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    initializationTimeoutMs: 500,
    recognitionTimeoutMs: 500,
    timers,
    onStatusChanged: (status) => statusEvents.push(status),
    ...overrides,
  });
  return { service, workers, timers, statusEvents };
}

function validAudio() {
  return { sampleRate: 16_000 as const, pcm16: new ArrayBuffer(16_000) };
}

async function waitForRecognition(worker: FakeWorker): Promise<{ requestId: number }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const message = worker.messages.find((candidate) => candidate.type === "recognize");
    if (message && typeof message.requestId === "number") return { requestId: message.requestId };
    await Promise.resolve();
  }
  throw new Error("worker did not receive recognize message");
}

async function waitForWorker(workers: FakeWorker[], index: number): Promise<FakeWorker> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const worker = workers[index];
    if (worker) return worker;
    await Promise.resolve();
  }
  throw new Error(`worker ${index} was not created`);
}

async function waitForRecognitionMessage(worker: FakeWorker, type: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (worker.messages.some((message) => message.type === type)) return;
    await Promise.resolve();
  }
  throw new Error(`worker did not receive ${type} message`);
}

class ManualTimers implements LocalAsrTimerFacade {
  private now = 0;
  private nextId = 0;
  private readonly tasks = new Map<object, { callback: () => void; dueAt: number; id: number }>();

  setTimeout(callback: () => void, delayMs: number): object {
    const handle = { id: ++this.nextId };
    this.tasks.set(handle, { callback, dueAt: this.now + delayMs, id: handle.id });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "object" && handle !== null) this.tasks.delete(handle);
  }

  advanceBy(elapsedMs: number): void {
    this.now += elapsedMs;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= this.now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[1].id - right[1].id)[0];
      if (!due) return;
      const [handle, task] = due;
      this.tasks.delete(handle);
      task.callback();
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}
