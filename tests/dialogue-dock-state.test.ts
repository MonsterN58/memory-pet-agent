import assert from "node:assert/strict";
import test from "node:test";
import { DialogueDockState, dialogueActivityCopy } from "../src/renderer/dialogue-dock-state";

test("普通回复以轻字幕出现并允许定时收起", () => {
  const dock = new DialogueDockState();

  assert.equal(dock.showCaption(), "caption");
  assert.equal(dock.requestHide("auto"), true);
  assert.equal(dock.presentation(), "hidden");
});

test("输入焦点和忙碌状态会阻止自动收起", () => {
  const dock = new DialogueDockState();
  dock.expand();
  dock.setFocusWithin(true);
  assert.equal(dock.requestHide("auto"), false);

  dock.setFocusWithin(false);
  dock.setBusy(true);
  assert.equal(dock.requestHide("auto"), false);
  assert.equal(dock.presentation(), "expanded");
});

test("待确认电脑操作保持展开且不会被移开计时器藏起", () => {
  const dock = new DialogueDockState();
  dock.setPendingAction(true);

  assert.equal(dock.showCaption(), "expanded");
  assert.equal(dock.requestHide("auto"), false);
  assert.equal(dock.presentation(), "expanded");
});

test("Esc 和窗口失焦可以明确收起，之后仍能重新展开", () => {
  const dock = new DialogueDockState();
  dock.setPendingAction(true);
  dock.expand();

  assert.equal(dock.requestHide("escape"), true);
  assert.equal(dock.presentation(), "hidden");
  assert.equal(dock.expand(), "expanded");
  assert.equal(dock.requestHide("blur"), true);
});

test("录音期间不自动收起且状态文案清楚区分识别阶段", () => {
  const dock = new DialogueDockState();
  dock.setVoiceActive(true);
  dock.expand();

  assert.equal(dock.requestHide("auto"), false);
  assert.match(dialogueActivityCopy("listening").detail, /结束录音/);
  assert.match(dialogueActivityCopy("recognizing").detail, /本机/);
});
