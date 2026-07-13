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
