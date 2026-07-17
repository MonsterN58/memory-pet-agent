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

test("困难和困扰不会被误判为困倦", () => {
  assert.equal(inferReaction("这个问题很困难", "让我分析一下"), "thinking");
  assert.equal(inferReaction("这件事让我很困扰", "我们先梳理原因"), "idle");
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

test("Agent 工具请求的动作优先于文本猜测并继续服从强动作冷却", () => {
  let now = 15_000;
  const director = new PetReactionDirector({ now: () => now, random: () => 0 });

  assert.equal(director.choose({
    ...reactionInput("tool-action-1", "curious", "让我想想。"),
    requestedAction: "dance",
  }), "dance");
  now += 1_000;
  assert.equal(director.choose({
    ...reactionInput("tool-action-2", "happy", "再庆祝一下。"),
    requestedAction: "jump",
  }), undefined);
  now += 12_000;
  assert.equal(director.choose({
    ...reactionInput("tool-action-3", "idle", "轻轻点头。"),
    requestedAction: "nod",
  }), "nod");
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

test("协作语境会选择致谢、查看、展示、鼓掌和沉思动作", () => {
  const cases = [
    ["thanks", "happy", "谢谢你一直陪我一起处理。", "bow"],
    ["inspect", "curious", "让我看看当前网页的内容。", "peek"],
    ["result", "idle", "方案如下，我已经准备好给你展示。", "present"],
    ["success", "happy", "这部分已经完成，我们做到了。", "applaud"],
    ["reason", "thinking", "我在认真分析其中的关联。", "ponder"],
  ] as const;
  for (const [replyId, emotion, text, expected] of cases) {
    const director = new PetReactionDirector({ now: () => 35_000, random: () => 0 });
    assert.equal(director.choose(reactionInput(replyId, emotion, text)), expected);
  }
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

test("思考姿态延迟出现，快速回复会取消且回复动作随后取得优先级", () => {
  const events: string[] = [];
  const scheduler = new FakeScheduler();
  const coordinator = new PetReactionCoordinator(
    new PetReactionDirector({ now: () => scheduler.now, random: () => 0 }),
    {
      setEmotion: (emotion) => events.push(`emotion:${emotion}`),
      playAction: (action) => events.push(`action:${action}`),
      setThinking: (active) => events.push(`thinking:${active}`),
    },
    scheduler.options(),
  );

  coordinator.beginThinking();
  scheduler.advance(649);
  assert.deepEqual(events, ["emotion:thinking"]);
  coordinator.handleResponse({ emotion: "curious", text: "我想到一个切入点。" });
  scheduler.advance(1);
  assert.deepEqual(events, ["emotion:thinking", "emotion:curious", "action:head-tilt"]);

  coordinator.beginThinking();
  scheduler.advance(650);
  assert.equal(events.at(-1), "thinking:true");
  coordinator.handleResponse({ emotion: "comforting", text: "我们慢慢来。" });
  assert.deepEqual(events.slice(-3), ["thinking:false", "emotion:comforting", "action:comfort"]);
});

test("录音、拖拽和手动动作会撤下思考姿态，解除拖拽后才重新延迟出现", () => {
  const events: string[] = [];
  const scheduler = new FakeScheduler();
  const coordinator = new PetReactionCoordinator(
    new PetReactionDirector({ now: () => scheduler.now, random: () => 0 }),
    {
      setEmotion: (emotion) => events.push(`emotion:${emotion}`),
      playAction: (action) => events.push(`action:${action}`),
      setThinking: (active) => events.push(`thinking:${active}`),
    },
    scheduler.options(),
  );

  coordinator.beginThinking();
  scheduler.advance(650);
  coordinator.setMotion("dragged");
  assert.deepEqual(events.slice(-2), ["thinking:true", "thinking:false"]);
  coordinator.setMotion("falling");
  scheduler.advance(2_000);
  assert.equal(events.at(-1), "thinking:false");
  coordinator.setMotion("idle");
  scheduler.advance(649);
  assert.equal(events.at(-1), "thinking:false");
  scheduler.advance(1);
  assert.equal(events.at(-1), "thinking:true");

  coordinator.setVoiceActive(true);
  assert.deepEqual(events.slice(-2), ["thinking:false", "emotion:listening"]);
  coordinator.setVoiceActive(false);
  coordinator.playManualAction("wave");
  scheduler.advance(1_000);
  assert.equal(events.at(-1), "action:wave");
  assert.equal(events.filter((event) => event === "thinking:true").length, 2);
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

test("语音取消且没有新回复时恢复录音前的情绪", () => {
  const emotions: PetEmotion[] = [];
  const coordinator = new PetReactionCoordinator(
    new PetReactionDirector({ now: () => 55_000, random: () => 0 }),
    {
      setEmotion: (emotion) => emotions.push(emotion),
      playAction: () => {},
    },
  );

  coordinator.handleResponse({ emotion: "happy", text: "今天真好。" });
  coordinator.setVoiceActive(true);
  coordinator.setVoiceActive(false);

  assert.deepEqual(emotions, ["happy", "listening", "happy"]);
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

test("手动预览会清除待执行自动动作并在动作窗口内保持高优先级", () => {
  let now = 70_000;
  const actions: string[] = [];
  const coordinator = new PetReactionCoordinator(
    new PetReactionDirector({ now: () => now, random: () => 0 }),
    { setEmotion: () => {}, playAction: (action) => actions.push(action) },
  );

  coordinator.setMotion("landing");
  coordinator.handleResponse({ emotion: "curious", text: "这个机制是怎么工作的呢？" });
  coordinator.playManualAction("dance");
  coordinator.setMotion("idle");
  coordinator.handleResponse({ emotion: "excited", text: "太棒了，我们再庆祝一次！" });
  assert.deepEqual(actions, ["dance"]);

  now += 11_999;
  coordinator.handleResponse({ emotion: "curious", text: "动作窗口还没有结束。" });
  assert.deepEqual(actions, ["dance"]);

  now += 1;
  coordinator.handleResponse({ emotion: "curious", text: "现在可以继续看看吗？" });
  assert.deepEqual(actions, ["dance", "head-tilt"]);
});

test("重复手动预览会从最近一次动作重新计算优先级窗口", () => {
  let now = 80_000;
  const actions: string[] = [];
  const coordinator = new PetReactionCoordinator(
    new PetReactionDirector({ now: () => now, random: () => 0 }),
    { setEmotion: () => {}, playAction: (action) => actions.push(action) },
  );

  coordinator.playManualAction("dance");
  now += 11_000;
  coordinator.playManualAction("wave");
  now += 1_000;
  coordinator.handleResponse({ emotion: "curious", text: "第一次动作窗口已经结束。" });
  assert.deepEqual(actions, ["dance", "wave"]);

  now += 11_000;
  coordinator.handleResponse({ emotion: "curious", text: "续期窗口现在结束了。" });
  assert.deepEqual(actions, ["dance", "wave", "head-tilt"]);
});

function reactionInput(replyId: string, emotion: PetEmotion, replyText: string) {
  return { replyId, emotion, replyText, voiceActive: false, motion: "idle" as const };
}

class FakeScheduler {
  now = 0;
  private sequence = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  options() {
    return {
      thinkingDelayMs: 650,
      schedule: (callback: () => void, delayMs: number) => {
        const id = ++this.sequence;
        this.tasks.set(id, { at: this.now + delayMs, callback });
        return id;
      },
      cancelScheduled: (handle: unknown) => {
        if (typeof handle === "number") this.tasks.delete(handle);
      },
    };
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) return;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
  }
}
