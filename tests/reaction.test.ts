import assert from "node:assert/strict";
import test from "node:test";
import type { PetEmotion, PetLocomotion } from "../src/common/types";
import { inferReaction } from "../src/main/reaction-inference";
import { PetReactionCoordinator, PetReactionDirector } from "../src/renderer/pet-reaction-director";

test("情绪推断同时参考用户语境和助手回复", () => {
  const cases: Array<[PetEmotion, string, string]> = [
    ["happy", "今天进展不错", "真好，我也替你开心。"],
    ["excited", "项目终于跑起来了", "太棒了！我们成功啦！！"],
    ["curious", "我在研究一个新模型", "它的参数是怎么设计的呢？"],
    ["thinking", "帮我分析这个问题", "让我想一想，可以先拆成三步。"],
    ["comforting", "我最近很难过，压力很大", "别急！我会在这里陪你，我们慢慢来。"],
    ["shy", "你今天很可爱", "被你这么夸，我都有点不好意思了。"],
    ["surprised", "我一天修了 100 个 bug", "居然这么多，太意外了！"],
    ["sleepy", "我已经困了", "那就早点休息，晚安。"],
  ];
  for (const [expected, userText, responseText] of cases) {
    assert.equal(inferReaction(userText, responseText), expected, `${userText} / ${responseText}`);
  }
});

test("常见疲惫表达配合安慰回复会推断为 comforting", () => {
  const response = "我在。你不必一下子把一切都解决，我们慢慢来。";
  assert.equal(inferReaction("我累了", response), "comforting");
  assert.equal(inferReaction("我最近很疲惫", response), "comforting");
});

test("动作导演每条回复至多触发一次并限制连续强动作", () => {
  let now = 10_000;
  const director = new PetReactionDirector({ now: () => now, random: () => 0 });
  const input = reactionInput("reply-1", "excited", "太棒了，我们庆祝一下！");

  assert.equal(director.choose(input), "cheer");
  assert.equal(director.choose(input), undefined);
  now += 1_000;
  assert.equal(director.choose(reactionInput("reply-2", "excited", "又成功了！")), undefined);
  now += 12_000;
  assert.equal(director.choose(reactionInput("reply-3", "excited", "这次也很棒！")), "cheer");
});

test("录音、拖拽、下落和落地期间延后自动动作", () => {
  const blocked: Array<{ voiceActive: boolean; motion: PetLocomotion }> = [
    { voiceActive: true, motion: "idle" },
    { voiceActive: false, motion: "dragged" },
    { voiceActive: false, motion: "falling" },
    { voiceActive: false, motion: "landing" },
  ];
  for (const [index, priority] of blocked.entries()) {
    const director = new PetReactionDirector({ now: () => 20_000, random: () => 0 });
    assert.equal(director.choose({
      ...reactionInput(`blocked-${index}`, "curious", "这个机制是怎么工作的呢？"),
      ...priority,
    }), undefined);
    assert.equal(director.flush(priority), undefined);
    assert.equal(director.flush({ voiceActive: false, motion: "idle" }), "head-tilt");
    assert.equal(director.flush({ voiceActive: false, motion: "idle" }), undefined);
  }
});

test("阻塞期间只保留最新回复且文本语义优先轻动作", () => {
  const director = new PetReactionDirector({ now: () => 30_000, random: () => 0 });
  const blocked = { voiceActive: false, motion: "landing" as const };
  assert.equal(director.choose({
    ...reactionInput("old", "curious", "要不要继续看看？"), ...blocked,
  }), undefined);
  assert.equal(director.choose({
    ...reactionInput("new", "comforting", "没关系，我会陪着你。"), ...blocked,
  }), undefined);
  assert.equal(director.flush({ voiceActive: false, motion: "idle" }), "comfort");

  assert.equal(director.choose(reactionInput("hello", "happy", "你好呀，很高兴见到你。")), "wave");
  assert.equal(director.choose(reactionInput("yes", "curious", "对，可以这样做。")), "nod");
  assert.equal(director.choose(reactionInput("no", "thinking", "不，这次先不要继续。")), "shake-head");
});

test("Renderer 协调器先更新情绪并为连续回复生成独立动作", () => {
  const events: string[] = [];
  const coordinator = new PetReactionCoordinator(
    new PetReactionDirector({ now: () => 40_000, random: () => 0 }),
    {
      setEmotion: (emotion) => events.push(`emotion:${emotion}`),
      playAction: (action) => events.push(`action:${action}`),
    },
  );
  const response = { emotion: "curious" as const, text: "这个机制是怎么工作的呢？" };

  coordinator.handleResponse(response);
  coordinator.handleResponse(response);

  assert.deepEqual(events, [
    "emotion:curious", "action:head-tilt",
    "emotion:curious", "action:head-tilt",
  ]);
});

test("Renderer 协调器在语音结束时恢复最新回复情绪再释放动作", () => {
  const events: string[] = [];
  const coordinator = new PetReactionCoordinator(
    new PetReactionDirector({ now: () => 50_000, random: () => 0 }),
    {
      setEmotion: (emotion) => events.push(`emotion:${emotion}`),
      playAction: (action) => events.push(`action:${action}`),
    },
  );

  coordinator.setVoiceActive(true);
  coordinator.handleResponse({ emotion: "curious", text: "先听我说完好吗？" });
  assert.deepEqual(events, ["emotion:listening", "emotion:curious"]);
  coordinator.setVoiceActive(false);
  assert.deepEqual(events, [
    "emotion:listening",
    "emotion:curious",
    "emotion:curious",
    "action:head-tilt",
  ]);
});

test("Renderer 协调器只在阻塞运动结束后释放最新动作", () => {
  const actions: string[] = [];
  const coordinator = new PetReactionCoordinator(
    new PetReactionDirector({ now: () => 60_000, random: () => 0 }),
    { setEmotion: () => {}, playAction: (action) => actions.push(action) },
  );

  coordinator.setMotion("dragged");
  coordinator.handleResponse({ emotion: "comforting", text: "没关系，我会陪着你。" });
  coordinator.setMotion("falling");
  coordinator.setMotion("landing");
  assert.deepEqual(actions, []);
  coordinator.setMotion("walk-right");
  assert.deepEqual(actions, ["comfort"]);
});

function reactionInput(replyId: string, emotion: PetEmotion, replyText: string) {
  return { replyId, emotion, replyText, voiceActive: false, motion: "idle" as const };
}
