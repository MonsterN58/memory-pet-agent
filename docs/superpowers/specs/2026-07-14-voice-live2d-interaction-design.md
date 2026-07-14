# 本地语音与 Live2D 交互增强设计

> 日期：2026-07-14｜状态：已确认，待实施计划｜目标分支：`codex/voice-live2d-interaction`

## 1. 目标

本轮在不增加运行依赖、不改变三级记忆和人格成长语义的前提下，完成四项彼此关联的交互增强：

1. 修复本地语音在“正在本地识别…”状态永久残留的问题，并让首次识别、取消、超时和 worker 故障都能恢复。
2. 让 Hiyori、Mao、Wanko 以及采用常见参数名的导入模型稳定跟随桌面全局鼠标；没有独立眼球参数的模型用头部、身体或耳朵提供可见反馈。
3. 让拖拽具有方向、速度、惯性、下落和落地阶段，而不是只有固定角度的画布摆动。
4. 根据每条 `ChatResponse.emotion` 情绪标签自动选择合理表情与语义动作，并扩充内置动作数量。

产品结果应是：语音状态始终收敛；鼠标追踪在三套内置模型上均肉眼可见；拖拽姿态连续；回复动作自然、克制且与情绪一致。

## 2. 已确认的现状与根因

### 2.1 本地语音

项目内 ASR 文件大小与 SHA-256 均通过，现有 `npm run smoke:voice` 能在真实 Electron 主进程和 sherpa-onnx worker 中识别 5.6 秒中文 WAV。使用同一 WAV 作为 Chromium 虚拟麦克风后，真实桌宠页面经 `VoiceService → preload → IPC → LocalAsrService → worker` 也能返回结果；首次进入识别阶段后约 2.5 秒完成。

永久残留来自一个确定的取消竞态：

1. `finishLocalCapture()` 清理录音对象并写入“正在本地识别…”，随后等待 IPC Promise。
2. 识别期间再次点击麦克风会进入 `stop()`，递增 `recognitionRequest`，但此时 `localCapture` 已被清理，保存于 session 的 `onInterim("")` 不再被调用。
3. worker 返回后，旧 session 因 request 不匹配提前返回，文本和识别结果都被丢弃。
4. UI 已不是 listening 状态，但输入框永久保留“正在本地识别…”，且没有错误提示。

真实 Electron 自动诊断已稳定复现最终状态：`listening=false`、`input="正在本地识别…"`、`toast=""`。

此外，当前 `LocalAsrService` 的请求超时只删除 pending Promise，不重建可能卡住的 worker；模型也只校验文件而不在启动后预热，因此低性能设备的首次等待缺少明确边界。

### 2.2 鼠标追踪

当前存在两个写入源：主进程每 33ms 根据桌面全局指针发送 `PetFocus`，Live2D Adapter 又监听 Renderer `pointermove` 并写同一目标。窗口启用 click-through forwarding 时两者会交替覆盖。

主进程用半个 320×460 窗口作为归一化半径，指针离开宠物约 160px 后即饱和到 ±1；用户在桌面大范围移动时看到的是长期固定在边缘，而不是连续跟随。

模型能力也不同：

- Hiyori 与 Mao 提供标准 `ParamEyeBallX/Y`、`ParamAngleX/Y/Z` 等参数；左右对照帧能观察到变化，但幅度和来源不稳定。
- Wanko 使用 Cubism 旧式 `PARAM_ANGLE_X/Y/Z`、`PARAM_BODY_ANGLE_X/Y/Z`、`PARAM_EAR_L/R`，并没有独立眼球 X/Y 参数。当前引擎的标准参数写入不会驱动这些旧参数，左右截图基本一致。

### 2.3 拖拽与动作

`DesktopMovementController` 目前只发出 `dragged`、`falling` 等离散状态。Adapter 对 dragged 固定旋转 -0.08，对 falling 固定旋转 0.1；没有速度、拖拽方向、身体滞后或落地阶段。

现有动作只有 `wave / jump / dance / sit / sleep / surprised`。动作组和索引按三套内置模型硬编码，计时器又使用统一估算值，没有读取 motion3 的真实时长；动作可能被过早停止。`ChatResponse.emotion` 已存在，但分类范围较窄，Renderer 只切换表达状态，不会自动播放语义动作。

## 3. 方案选择

本轮采用“能力感知交互层”，介于临时补丁和完整动画状态机之间：

- 不只修补 UI 文案，而是补齐语音操作生命周期、取消和 worker 恢复。
- 不建立需要用户手工配置的动画图编辑器，而是在 Adapter 内识别常见参数并为三套内置模型提供明确映射。
- 不要求兼容模型拥有特定 motion；没有匹配资源时使用参数和画布变换组成的程序化动作。
- 不要求聊天供应商输出严格 JSON 情绪结构；保持 OpenAI 兼容端点宽容性，由本地确定性分类生成标签。

## 4. 架构与稳定接口

### 4.1 语音操作生命周期

`VoiceService` 保留一个贯穿录音和识别阶段的 operation，而不是在提交 PCM 时丢失回调。内部阶段为：

```text
idle → starting → recording → recognizing → idle
                         └→ cancelling → idle
任意阶段 ──错误/超时──→ idle + 用户可见错误
```

operation 保存 request、`onInterim`、`onState` 和 settled 标记。所有退出路径集中到一个幂等 `finishOperation()`：停止轨道、关闭 AudioContext、清空 interim、恢复按钮和 emotion，并且只通知一次最终状态。

点击语义明确区分：

- recording 时再次点击：立即结束录音并提交识别。
- recognizing 时再次点击：取消本轮识别、清空“正在本地识别…”，不自动开始下一轮。
- idle 时点击：开始新录音。

`PetAgentBridge` 增加 `cancelLocalSpeechRecognition(): Promise<void>`，main/preload 使用白名单 IPC `voice:cancel-local`。当前产品只有一个宠物窗口和单个本地识别操作，因此 `LocalAsrService.cancelCurrent()` 取消全部 pending 并终止当前 worker；取消后可以重新预热。

`LocalAsrService` 增加非阻塞 `warmup()`：应用初始化完成后验证模型并加载 worker，不阻塞文字聊天、窗口显示或本地记忆。后台 warmup 的初始化上限为 30 秒；交互识别从提交 PCM 起使用 30 秒总上限，这个上限同时包含等待尚未结束的 warmup 与 decode。请求超时不只 reject Promise，还会重建 worker，防止后续请求继承故障状态。

Renderer 在 recognizing 阶段显示经过秒数的状态，35 秒 UI watchdog 负责调用取消并恢复界面。主进程仍是资源释放与 worker 生命周期的最终事实来源。

### 4.2 单一鼠标焦点源

正式 Electron 页面只接受主进程 `screen.getCursorScreenPoint()` 生成的全局焦点；删除 Live2D Adapter 的 `window.pointermove` 写入。浏览器预览由 mock bridge 模拟同一 `onPetFocus` 事件，不在 Adapter 中建立第二条路径。

归一化以模型视觉中心为原点，默认水平关注半径为 640px、垂直关注半径为 480px：

```text
x = clamp((cursorX - modelCenterX) / 640, -1, 1)
y = clamp((modelCenterY - cursorY) / 480, -1, 1)
```

这让桌面范围内的移动保持渐进变化，同时继续限制跨进程值为 [-1, 1]。Adapter 自己使用阻尼插值，避免窗口移动、拖拽和显示器切换时跳变。

### 4.3 模型参数能力识别

`Live2DPetAdapter` 在 moc 加载后枚举真实参数 ID，并通过纯函数 `resolveFocusBindings(parameterIds)` 选择可用别名。只把索引小于真实 `getParameterCount()` 的参数视为存在，避免 Cubism Framework 为缺失 ID 建立虚拟参数而产生假阳性。

别名族至少覆盖：

- 标准眼球：`ParamEyeBallX/Y`。
- 标准头部与身体：`ParamAngleX/Y/Z`、`ParamBodyAngleX`。
- 旧式头部与身体：`PARAM_ANGLE_X/Y/Z`、`PARAM_BODY_ANGLE_X/Y/Z`。
- 旧式辅助反馈：`PARAM_EAR_L/R`。

Adapter 不再依赖 engine 内建 `model.focus()` 写固定标准 ID，而是在 `beforeModelUpdate` 阶段按真实绑定追加参数：

- 有眼球 XY：眼球为主，头部和身体使用较小权重。
- 没有眼球 XY：头部和身体承担方向反馈；Wanko 的两只耳朵加入轻微反向偏移。
- 只存在部分参数：使用已发现的子集，不中断渲染。

Hiyori、Mao 和 Wanko 保留内置 profile 调整幅度；用户导入模型优先使用参数能力自动识别，不写入模型源文件。

### 4.4 连续运动帧与拖拽姿态

离散 `PetLocomotion` 增加 `landing`，并以连续帧补充速度：

```ts
interface PetMotionFrame {
  state: PetLocomotion;
  velocityX: number; // 归一化到 [-1, 1]
  velocityY: number; // 归一化到 [-1, 1]
  offsetX: number;   // 相对上一帧窗口位移，归一化到 [-1, 1]
  offsetY: number;
}
```

Bridge 事件升级为 `onPetMotion(listener)`，main、preload、renderer 和 browser mock 同步更新。`DesktopMovementController` 在现有 33ms tick 中根据窗口位移生成 frame，不额外增加计时器。

Adapter 使用短时弹簧状态组合：

- grabbed：身体相对拖拽方向轻微滞后，旋转随 `velocityX` 连续变化，快速上提时略微拉伸。
- falling：保留水平惯性方向，随向下速度增加倾角和纵向拉伸。
- landing：持续约 320ms 的压缩、回弹和阴影变化，之后回到 idle。
- idle/walk：归零弹簧偏移并继续现有待机或行走 motion。

拖拽期间不强制播放会争夺全身参数的长 motion；抓起和落地反馈优先使用程序化参数与 canvas transform，确保所有导入模型至少具有一致反馈。

### 4.5 情绪与语义动作调度

`PetEmotion` 扩展为：

```text
idle, happy, excited, thinking, curious, listening, speaking,
comforting, shy, surprised, sleepy
```

`AgentService` 使用纯函数 `inferReaction(userText, responseText)` 生成 `ChatResponse.emotion`。它同时参考用户语境和助手回复，因此安慰性回复得到 `comforting`，而不是因正文没有“难过”等词退回 idle。供应商仍可返回普通文本，不引入严格 JSON 或额外模型调用。

`PetAction` 扩展为：

```text
wave, nod, shake-head, head-tilt, jump, cheer, dance,
sit, stretch, shy, comfort, sleep, surprised
```

Renderer 新增纯逻辑 `PetReactionDirector`：接收 emotion、回复文本、当前时间和可注入随机源，选择 0 或 1 个动作。规则为：

- 每次回复都立即更新表情。
- curious/thinking/comforting 优先使用点头、歪头、坐下等轻动作。
- excited/surprised 可使用庆祝、跳跃或惊讶等强动作。
- happy 偶尔挥手或庆祝；sleepy 使用伸懒腰或睡觉。
- 同类强动作设冷却，避免连续回复反复跳舞；拖拽、下落和录音阶段延后非必要动作。

三套内置模型使用明确的 semantic-action → motion group/index 映射。Adapter 从实际 `.motion3.json` 的 `Meta.Duration` 读取播放时长并设置合理上下限，不再用统一硬编码计时。缺少对应 motion 或用户导入模型使用程序化点头、歪头、摇头、伸展、害羞和惊讶变换；因此动作 API 总有可见结果，但不会虚构模型资源。

设置面板的动作预览扩展到全部语义动作，并沿用 main 的动作白名单输入校验。

## 5. 错误处理与并发规则

- 语音 operation 只能 settle 一次；迟到的 worker 结果不进入输入框，但取消路径必须先清空状态。
- 超时、worker failure、窗口关闭和设置切换都走同一清理函数。
- worker 预热失败只影响语音入口，通过状态/Toast 呈现；文字聊天、记忆、人格、心跳和 Live2D 继续运行。
- 模型不存在某个参数、expression 或 motion 时跳过该资源并使用程序化反馈，不抛出导致模型卸载的错误。
- 模型热切换时销毁旧 reaction timer、spring frame 和 motion timer，继续保留现有 Pixi ticker、纹理和 Moc 释放顺序。
- emotion action 不打断 dragging、falling、landing；用户在控制面板主动预览动作时使用更高优先级。

## 6. 测试与验收

### 6.1 自动化合同

先写失败测试，再写实现：

- VoiceService：识别阶段取消会立即清空 interim、停止 listening，迟到结果不触发 `onFinal`；普通结果、空结果、超时和错误均只结束一次。
- LocalAsrService：warmup 复用 worker；取消和 decode 超时 reject pending 并重置 worker；下一次请求可重新初始化。
- 新增真实 Electron `smoke:voice-ui`：使用项目官方 WAV 虚拟麦克风覆盖完整 Renderer/IPC/worker 成功链，并覆盖“进入正在识别后再次点击”的竞态。
- Focus：640×480 映射不过早饱和；参数绑定分别覆盖 Hiyori/Mao 标准 ID、Wanko 旧 ID、部分能力和空能力。
- Motion：拖拽左右速度产生相反倾角；falling → landing → idle 顺序稳定；数值始终在边界内。
- Reaction：各 emotion 映射到合理动作，强动作冷却生效，拖拽/录音时延后，随机源可重复。
- Model adapter：三套内置映射引用存在的组和索引，motion 时长来自资源元数据；导入模型程序化兜底。

### 6.2 集成与视觉验收

完成后运行：

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
npm run smoke:voice
npm run smoke:voice-ui
npm run smoke:model-switch
npm audit
```

真实 Electron 中再检查：

- Hiyori、Mao 左/中/右和上/下视线帧；Wanko 左右头部/耳朵反馈。
- 慢拖、快速左右拖、向上抛起、下落和落地回弹。
- happy、excited、curious、comforting、surprised、sleepy 回复对应动作。
- 三模型热切换后 focus、动作和口型仍工作，控制台没有 Cubism 断言或销毁警告。
- 设置、聊天、L1/L2/L3、记忆修正/删除、心跳、人格展示和模型导入不回归。

## 7. 文档与项目状态

实现完成后同步更新：

- `README.md`：本地语音取消/预热行为、全局焦点、拖拽和情绪动作说明。
- `docs/ARCHITECTURE.md`：语音生命周期、连续运动帧和 reaction 数据流。
- `docs/LIVE2D_MODEL_GUIDE.md`：标准/旧式参数别名、无眼球参数回退和导入模型动作兜底。
- `AGENTS.md`：测试数量、最近验证、代码地图、完成状态与剩余限制。

## 8. 非目标与边界

- 本轮不引入本地神经 TTS、流式部分识别、真实音频能量口型或摄像头输入。
- 不建立用户可编辑的动作图、参数绑定 UI 或任意 motion 语义自动推断。
- 不修改内置模型的 moc3、贴图或官方 motion 文件。
- 不增加 npm 依赖，不执行安装包构建或发布。
- 不改变记忆持久化格式、人格证据格式、聊天/TTS 密钥隔离和 Renderer 沙箱边界。
