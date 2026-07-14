import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/common/defaults";
import type { AgentSettings } from "../src/common/types";
import { resampleToPcm16, VoiceService } from "../src/renderer/voice-service";

test("本机 TTS 模式不会请求云端服务", () => {
  const environment = installSpeechSynthesisMock();
  let cloudCalls = 0;
  try {
    const voice = new VoiceService(
      () => settings({ ttsMode: "local" }),
      async () => {
        cloudCalls += 1;
        throw new Error("不应调用云端 TTS");
      },
    );
    voice.speak("本地朗读");
    assert.equal(cloudCalls, 0);
    assert.equal(environment.spoken.length, 1);
    assert.equal(environment.spoken[0]?.text, "本地朗读");
    assert.equal(environment.spoken[0]?.lang, "zh-CN");
    voice.cancelSpeech();
  } finally {
    environment.restore();
  }
});

test("云端 TTS 失败时自动回退本机语音", async () => {
  let resolveSpoken!: () => void;
  const spoken = new Promise<void>((resolve) => { resolveSpoken = resolve; });
  const environment = installSpeechSynthesisMock(resolveSpoken);
  const notices: string[] = [];
  try {
    const voice = new VoiceService(
      () => settings({ ttsMode: "cloud" }),
      async () => { throw new Error("cloud offline"); },
      (message) => notices.push(message),
    );
    voice.speak("回退朗读");
    await spoken;
    assert.equal(environment.spoken[0]?.text, "回退朗读");
    assert.match(notices[0] ?? "", /已回退本机语音.*cloud offline/);
    voice.cancelSpeech();
  } finally {
    environment.restore();
  }
});

test("Chromium 兼容识别不会启用故障的 processLocally 路径", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let recognition: LocalRecognitionMock | undefined;
  class RecognitionConstructor extends LocalRecognitionMock {
    constructor() {
      super();
      recognition = this;
    }
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { SpeechRecognition: RecognitionConstructor },
  });
  try {
    const started = new Promise<void>((resolve, reject) => {
      const voice = new VoiceService(() => settings({ recognitionMode: "browser" }), async () => {
        throw new Error("unused");
      });
      voice.start(
        () => undefined,
        () => undefined,
        (listening, error) => {
          if (error) reject(new Error(error));
          else if (listening) resolve();
        },
      );
    });
    await started;
    assert.equal(recognition?.lang, "zh-CN");
    assert.equal(recognition?.processLocally, false);
  } finally {
    restoreGlobal("window", previousWindow);
  }
});

test("麦克风音频会下采样为 16 kHz PCM16 并限制幅度", () => {
  const source = new Float32Array(48_000);
  source.fill(2, 0, 24_000);
  source.fill(-2, 24_000);
  const result = resampleToPcm16([source], source.length, 48_000);
  const pcm = new Int16Array(result.pcm16);
  assert.equal(result.sampleRate, 16_000);
  assert.equal(pcm.length, 16_000);
  assert.equal(pcm[0], 32_767);
  assert.equal(pcm.at(-1), -32_768);
});

test("30 秒录音会按采样数精确裁剪到主进程边界", async () => {
  const media = installLocalMediaMock();
  let submitted: ArrayBuffer | undefined;
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      async (audio) => {
        submitted = audio.pcm16;
        return { text: "长度正确", durationMs: 30_000 };
      },
    );
    voice.start(() => undefined, () => undefined, () => undefined);
    await media.ready();
    for (let index = 0; index < 352; index += 1) media.emitSpeech();
    await nextTask();

    assert.ok(submitted);
    assert.equal(submitted.byteLength, 16_000 * 30 * Int16Array.BYTES_PER_ELEMENT);
  } finally {
    media.restore();
  }
});

test("麦克风权限等待不会占用无语音和录音时长", async () => {
  const permission = deferred<void>();
  const media = installLocalMediaMock(48_000, permission.promise);
  const timers = new ManualTimers();
  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let now = 100;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => now },
  });
  const states: Array<{ listening: boolean; error?: string }> = [];
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      async () => ({ text: "unused", durationMs: 1 }),
      async () => undefined,
      timers,
    );
    voice.start(() => undefined, () => undefined, (listening, error) => states.push({ listening, error }));
    now = 9_100;
    permission.resolve(undefined);
    await media.ready();
    media.emitSilence();

    assert.equal(voice.isListening(), true);
    assert.equal(states.filter((state) => state.listening === false).length, 0);
    voice.stop();
  } finally {
    restoreGlobal("performance", previousPerformance);
    media.restore();
  }
});

test("麦克风启动和录音静默即使没有音频回调也会按墙钟收尾", async () => {
  const permission = deferred<void>();
  const startingMedia = installLocalMediaMock(48_000, permission.promise);
  const startingTimers = new ManualTimers();
  const startingStates: Array<{ listening: boolean; error?: string }> = [];
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      async () => ({ text: "unused", durationMs: 1 }),
      async () => undefined,
      startingTimers,
    );
    voice.start(() => undefined, () => undefined, (listening, error) => startingStates.push({ listening, error }));
    startingTimers.runDelay(30_000);
    assert.equal(voice.isListening(), false);
    assert.match(startingStates.at(-1)?.error ?? "", /麦克风.*超时/);
  } finally {
    permission.resolve(undefined);
    await nextTask();
    startingMedia.restore();
  }

  const recordingMedia = installLocalMediaMock();
  const recordingTimers = new ManualTimers();
  const recordingStates: Array<{ listening: boolean; error?: string }> = [];
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      async () => ({ text: "unused", durationMs: 1 }),
      async () => undefined,
      recordingTimers,
    );
    voice.start(() => undefined, () => undefined, (listening, error) => recordingStates.push({ listening, error }));
    await recordingMedia.ready();
    recordingTimers.runDelay(8_000);
    assert.equal(voice.isListening(), false);
    assert.match(recordingStates.at(-1)?.error ?? "", /没有检测到语音/);
  } finally {
    recordingMedia.restore();
  }
});

test("麦克风轨道意外结束会立即收尾本地语音 operation", async () => {
  const media = installLocalMediaMock();
  const states: Array<{ listening: boolean; error?: string }> = [];
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
    );
    voice.start(() => undefined, () => undefined, (listening, error) => states.push({ listening, error }));
    await media.ready();
    media.endTrack();

    assert.equal(voice.isListening(), false);
    assert.match(states.at(-1)?.error ?? "", /麦克风.*断开/);
  } finally {
    media.restore();
  }
});

test("本地识别阶段再次点击会清空状态并忽略迟到结果", async () => {
  const media = installLocalMediaMock();
  const recognition = deferred<{ text: string; durationMs: number }>();
  const finals: string[] = [];
  const interim: string[] = [];
  const states: Array<{ listening: boolean; error?: string }> = [];
  let cancelCalls = 0;
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      () => recognition.promise,
      async () => { cancelCalls += 1; },
    );
    const onState = (listening: boolean, error?: string) => states.push({ listening, error });
    voice.start((text) => finals.push(text), (text) => interim.push(text), onState);
    await media.ready();
    media.emitSpeech();
    voice.start((text) => finals.push(text), (text) => interim.push(text), onState);
    assert.match(interim.at(-1) ?? "", /^正在本地识别/);

    voice.start((text) => finals.push(text), (text) => interim.push(text), onState);
    assert.equal(voice.isListening(), false);
    assert.equal(interim.at(-1), "");
    assert.equal(cancelCalls, 1);
    assert.equal(states.filter((state) => state.listening === false).length, 1);

    recognition.resolve({ text: "迟到结果", durationMs: 900 });
    await nextTask();
    assert.deepEqual(finals, []);
    assert.equal(interim.at(-1), "");
    assert.equal(states.filter((state) => state.listening === false).length, 1);
  } finally {
    media.restore();
  }
});

test("本地识别成功先结束监听状态再提交最终文本", async () => {
  const media = installLocalMediaMock();
  const recognition = deferred<{ text: string; durationMs: number }>();
  const events: string[] = [];
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      () => recognition.promise,
    );
    voice.start(
      (text) => events.push(`final:${text}`),
      (text) => events.push(`interim:${text}`),
      (listening, error) => events.push(`state:${listening}:${error ?? ""}`),
    );
    await media.ready();
    media.emitSpeech();
    voice.start(() => undefined, () => undefined, () => undefined);
    recognition.resolve({ text: "识别成功", durationMs: 900 });
    await nextTask();
    assert.equal(events.filter((event) => event.startsWith("state:false")).length, 1);
    assert.ok(events.indexOf("state:false:") < events.indexOf("final:识别成功"));
    assert.equal(events.at(-2), "state:false:");
    assert.equal(events.at(-1), "final:识别成功");
  } finally {
    media.restore();
  }
});

test("本地识别空结果和错误都只结束一次", async () => {
  for (const outcome of ["empty", "error"] as const) {
    const media = installLocalMediaMock();
    const recognition = deferred<{ text: string; durationMs: number }>();
    const finals: string[] = [];
    const states: Array<{ listening: boolean; error?: string }> = [];
    try {
      const voice = new VoiceService(
        () => settings({ recognitionMode: "local" }),
        async () => { throw new Error("unused"); },
        () => undefined,
        () => recognition.promise,
      );
      voice.start(
        (text) => finals.push(text),
        () => undefined,
        (listening, error) => states.push({ listening, error }),
      );
      await media.ready();
      media.emitSpeech();
      voice.start(() => undefined, () => undefined, () => undefined);
      if (outcome === "empty") recognition.resolve({ text: "", durationMs: 900 });
      else recognition.reject(new Error("worker decode failed"));
      await nextTask();
      assert.deepEqual(finals, []);
      const finished = states.filter((state) => state.listening === false);
      assert.equal(finished.length, 1);
      assert.match(finished[0]?.error ?? "", outcome === "empty" ? /没有识别到清晰语音/ : /worker decode failed/);
    } finally {
      media.restore();
    }
  }
});

test("本地识别 Renderer 看门狗会取消并恢复界面", async () => {
  const media = installLocalMediaMock();
  const recognition = deferred<{ text: string; durationMs: number }>();
  const timers = new ManualTimers();
  const interim: string[] = [];
  const states: Array<{ listening: boolean; error?: string }> = [];
  let cancelCalls = 0;
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      () => recognition.promise,
      async () => { cancelCalls += 1; },
      timers,
    );
    voice.start(
      () => assert.fail("超时后不应提交最终文本"),
      (text) => interim.push(text),
      (listening, error) => states.push({ listening, error }),
    );
    await media.ready();
    media.emitSpeech();
    voice.start(() => undefined, () => undefined, () => undefined);
    timers.runDelay(35_000);
    await nextTask();
    assert.equal(cancelCalls, 1);
    assert.equal(interim.at(-1), "");
    assert.equal(voice.isListening(), false);
    assert.match(states.at(-1)?.error ?? "", /超时/);
    recognition.resolve({ text: "迟到结果", durationMs: 900 });
    await nextTask();
    assert.equal(states.filter((state) => state.listening === false).length, 1);
  } finally {
    media.restore();
  }
});

test("本地识别启动失败会停止已获取的麦克风轨道且只结束一次", async () => {
  const media = installFailingLocalMediaMock();
  const interim: string[] = [];
  const states: Array<{ listening: boolean; error?: string }> = [];
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
    );
    voice.start(
      () => assert.fail("启动失败后不应提交最终文本"),
      (text) => interim.push(text),
      (listening, error) => states.push({ listening, error }),
    );
    await media.contextAttempted();
    await nextTask();

    assert.equal(media.trackStopCalls(), 1);
    assert.equal(voice.isListening(), false);
    assert.equal(interim.at(-1), "");
    assert.equal(states.filter((state) => state.listening === false).length, 1);
    assert.match(states.at(-1)?.error ?? "", /AudioContext startup failed/);
  } finally {
    media.restore();
  }
});

test("本地识别重采样失败也会通过统一路径结束 operation", async () => {
  const media = installLocalMediaMock(1_000);
  const interim: string[] = [];
  const states: Array<{ listening: boolean; error?: string }> = [];
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
    );
    voice.start(
      () => assert.fail("重采样失败后不应提交最终文本"),
      (text) => interim.push(text),
      (listening, error) => states.push({ listening, error }),
    );
    await media.ready();
    media.emitSpeech();
    voice.start(() => undefined, () => undefined, () => undefined);
    await nextTask();

    assert.equal(voice.isListening(), false);
    assert.equal(interim.at(-1), "");
    assert.equal(states.filter((state) => state.listening === false).length, 1);
    assert.match(states.at(-1)?.error ?? "", /麦克风采样率无效/);
  } finally {
    media.restore();
  }
});

test("interim 清理回调抛错不会阻断本地取消和状态收尾", async () => {
  const media = installLocalMediaMock();
  const recognition = deferred<{ text: string; durationMs: number }>();
  const states: Array<{ listening: boolean; error?: string }> = [];
  let cancelCalls = 0;
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      () => recognition.promise,
      async () => { cancelCalls += 1; },
    );
    const onState = (listening: boolean, error?: string) => states.push({ listening, error });
    voice.start(
      () => assert.fail("取消后不应提交最终文本"),
      (text) => { if (!text) throw new Error("interim cleanup failed"); },
      onState,
    );
    await media.ready();
    media.emitSpeech();
    voice.start(() => undefined, () => undefined, () => undefined);

    assert.doesNotThrow(() => voice.start(() => undefined, () => undefined, onState));
    await nextTask();
    assert.equal(cancelCalls, 1);
    assert.equal(voice.isListening(), false);
    assert.equal(states.filter((state) => state.listening === false).length, 1);
  } finally {
    recognition.resolve({ text: "迟到结果", durationMs: 900 });
    media.restore();
  }
});

test("识别进度回调抛错不会把成功结果改成失败", async () => {
  const media = installLocalMediaMock();
  const recognition = deferred<{ text: string; durationMs: number }>();
  const finals: string[] = [];
  const states: Array<{ listening: boolean; error?: string }> = [];
  try {
    const voice = new VoiceService(
      () => settings({ recognitionMode: "local" }),
      async () => { throw new Error("unused"); },
      () => undefined,
      () => recognition.promise,
    );
    voice.start(
      (text) => finals.push(text),
      (text) => { if (text) throw new Error("interim progress failed"); },
      (listening, error) => states.push({ listening, error }),
    );
    await media.ready();
    media.emitSpeech();
    voice.start(() => undefined, () => undefined, () => undefined);
    recognition.resolve({ text: "识别仍成功", durationMs: 900 });
    await nextTask();

    assert.deepEqual(finals, ["识别仍成功"]);
    const finished = states.filter((state) => state.listening === false);
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.error, undefined);
  } finally {
    media.restore();
  }
});

function settings(overrides: Partial<AgentSettings["voice"]>): AgentSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    voice: { ...DEFAULT_SETTINGS.voice, ...overrides },
  };
}

class LocalRecognitionMock {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  processLocally = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;

  start(): void { this.onstart?.(); }
  stop(): void { this.onend?.(); }
  abort(): void { this.onend?.(); }
}

interface SpeechMockEnvironment {
  spoken: MockUtterance[];
  restore(): void;
}

function installSpeechSynthesisMock(onSpeak?: () => void): SpeechMockEnvironment {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousUtterance = Object.getOwnPropertyDescriptor(globalThis, "SpeechSynthesisUtterance");
  const spoken: MockUtterance[] = [];
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: MockUtterance,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      speechSynthesis: {
        cancel() {},
        getVoices: () => [{ lang: "zh-CN" }],
        speak: (utterance: MockUtterance) => {
          spoken.push(utterance);
          onSpeak?.();
        },
      },
    },
  });
  return {
    spoken,
    restore() {
      restoreGlobal("window", previousWindow);
      restoreGlobal("SpeechSynthesisUtterance", previousUtterance);
    },
  };
}

class MockUtterance {
  lang = "";
  rate = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(readonly text: string) {}
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

interface LocalMediaEnvironment {
  ready(): Promise<void>;
  emitSpeech(): void;
  emitSilence(): void;
  endTrack(): void;
  restore(): void;
}

function installLocalMediaMock(sampleRate = 48_000, permissionGate?: Promise<void>): LocalMediaEnvironment {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  let processor: FakeProcessor | undefined;
  let contextCreated!: () => void;
  const created = new Promise<void>((resolve) => { contextCreated = resolve; });
  const endedListeners = new Set<() => void>();
  const track = {
    stop() {},
    addEventListener(type: string, listener: () => void) {
      if (type === "ended") endedListeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "ended") endedListeners.delete(listener);
    },
  };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  class TestAudioContext extends FakeAudioContext {
    constructor() {
      super(sampleRate);
      processor = this.processor;
      contextCreated();
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => { await permissionGate; return stream; } } },
  });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: TestAudioContext });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { AudioContext: TestAudioContext, speechSynthesis: { cancel() {} } },
  });
  return {
    ready: async () => { await created; await nextTask(); },
    emitSpeech() {
      const chunk = new Float32Array(4096);
      chunk.fill(0.2);
      processor?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => chunk },
      } as unknown as AudioProcessingEvent);
    },
    emitSilence() {
      const chunk = new Float32Array(4096);
      processor?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => chunk },
      } as unknown as AudioProcessingEvent);
    },
    endTrack() {
      for (const listener of [...endedListeners]) listener();
    },
    restore() {
      restoreGlobal("window", previousWindow);
      restoreGlobal("navigator", previousNavigator);
      restoreGlobal("AudioContext", previousAudioContext);
    },
  };
}

function installFailingLocalMediaMock(): {
  contextAttempted(): Promise<void>;
  trackStopCalls(): number;
  restore(): void;
} {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  let stopCalls = 0;
  let markContextAttempted!: () => void;
  const contextAttempted = new Promise<void>((resolve) => { markContextAttempted = resolve; });
  const stream = {
    getTracks: () => [{ stop: () => { stopCalls += 1; } }],
  } as unknown as MediaStream;
  class FailingAudioContext {
    constructor() {
      markContextAttempted();
      throw new Error("AudioContext startup failed");
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FailingAudioContext });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { AudioContext: FailingAudioContext, speechSynthesis: { cancel() {} } },
  });
  return {
    contextAttempted: () => contextAttempted,
    trackStopCalls: () => stopCalls,
    restore() {
      restoreGlobal("window", previousWindow);
      restoreGlobal("navigator", previousNavigator);
      restoreGlobal("AudioContext", previousAudioContext);
    },
  };
}

class FakeNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeProcessor extends FakeNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;
}

class FakeAudioContext {
  readonly sampleRate: number;
  readonly destination = {} as AudioDestinationNode;
  readonly processor = new FakeProcessor();
  constructor(sampleRate = 48_000) { this.sampleRate = sampleRate; }
  createMediaStreamSource(): MediaStreamAudioSourceNode { return new FakeNode() as unknown as MediaStreamAudioSourceNode; }
  createScriptProcessor(): ScriptProcessorNode { return this.processor as unknown as ScriptProcessorNode; }
  createGain(): GainNode {
    return Object.assign(new FakeNode(), { gain: { value: 1 } }) as unknown as GainNode;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class ManualTimers {
  private nextId = 0;
  private readonly tasks = new Map<number, { callback: () => void; delay: number }>();

  setTimeout = (callback: () => void, delay: number): number => {
    const id = ++this.nextId;
    this.tasks.set(id, { callback, delay });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.tasks.delete(id);
  };

  runDelay(delay: number): void {
    const entries = [...this.tasks.entries()].filter(([, task]) => task.delay === delay);
    for (const [id, task] of entries) {
      this.tasks.delete(id);
      task.callback();
    }
  }
}
