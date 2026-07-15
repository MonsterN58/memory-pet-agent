import assert from "node:assert/strict";
import test from "node:test";
import type { LocalSpeechModelStatus } from "../src/common/types";
import { localSpeechControlState, localSpeechStatusText } from "../src/renderer/local-speech-status";

const READY_FAILED: LocalSpeechModelStatus = {
  state: "ready",
  modelId: "fixture",
  directory: "D:/fixture",
  sizeBytes: 1,
  message: "模型文件已就绪",
  runtimeState: "failed",
  runtimeMessage: "运行时加载失败；点击麦克风将重试",
};

test("本地模型文件缺失时设置刷新不会重新启用麦克风", () => {
  const missing: LocalSpeechModelStatus = {
    ...READY_FAILED,
    state: "missing",
    runtimeState: "not-started",
    message: "模型文件缺失",
    runtimeMessage: "尚未启动",
  };

  assert.deepEqual(localSpeechControlState({
    inputEnabled: true,
    recognitionMode: "local",
    supported: true,
    status: missing,
  }), { disabled: true, title: "模型文件缺失" });
});

test("本地运行时预热失败会提示重试但保持麦克风可用", () => {
  assert.deepEqual(localSpeechControlState({
    inputEnabled: true,
    recognitionMode: "local",
    supported: true,
    status: READY_FAILED,
  }), { disabled: false, title: READY_FAILED.runtimeMessage });
  assert.match(localSpeechStatusText(READY_FAILED), /模型文件已就绪.*运行时加载失败/);
});

test("浏览器识别模式不受本地模型状态影响", () => {
  assert.equal(localSpeechControlState({
    inputEnabled: true,
    recognitionMode: "browser",
    supported: true,
  }).disabled, false);
});
