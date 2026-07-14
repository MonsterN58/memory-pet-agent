import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";
import { hidePetWindow } from "../src/main/pet-window-lifecycle";
import { PetUiLifecycle } from "../src/renderer/pet-ui-command";

test("隐藏桌宠会先通知 Renderer 收尾再隐藏窗口", () => {
  const events: string[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, command: string) => events.push(`${channel}:${command}`),
    },
    hide: () => events.push("hide"),
  } as unknown as BrowserWindow;

  hidePetWindow(window);

  assert.deepEqual(events, ["ui:command:suspend", "hide"]);
});

test("Renderer 通知失败时仍会隐藏桌宠", () => {
  const events: string[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: () => {
        events.push("send");
        throw new Error("renderer crashed");
      },
    },
    hide: () => events.push("hide"),
  } as unknown as BrowserWindow;

  assert.doesNotThrow(() => hidePetWindow(window));
  assert.deepEqual(events, ["send", "hide"]);
});

test("Renderer 暂停后会停止语音并阻止迟到回复重新朗读", () => {
  const events: string[] = [];
  const effects = {
    focusChat: () => events.push("focus"),
    stopVoiceInput: () => events.push("stop-input"),
    stopVoiceOutput: () => events.push("stop-output"),
  };
  const lifecycle = new PetUiLifecycle(effects);

  lifecycle.handle("suspend");
  assert.equal(lifecycle.presentResponse(() => events.push("speak-hidden")), false);
  lifecycle.handle("focus-chat");
  assert.equal(lifecycle.presentResponse(() => events.push("speak-visible")), true);

  assert.deepEqual(events, ["stop-input", "stop-output", "focus", "speak-visible"]);
});
