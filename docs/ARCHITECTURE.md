# 架构与行为细节

## 运行时分层

```mermaid
flowchart LR
  UI[透明 PetWindow] -->|白名单 IPC| Main[Electron 主进程]
  Panel[设置/记忆 PanelWindow] -->|白名单 IPC| Main
  Main --> Agent[AgentService]
  Main --> TTS[OpenAI-compatible TTS]
  Main --> ASR[LocalAsrService / worker]
  ASR --> ASRModel[(项目内 Zipformer ONNX)]
  Main --> Heartbeat[HeartbeatService]
  Agent --> Provider[OpenAI 兼容服务]
  Agent --> Memory[MemoryEngine]
  Heartbeat --> Memory
  Main --> Personality[PersonalityEngine]
  Heartbeat --> Personality
  Personality --> PersonalityStore[(personality-profile.json)]
  Memory --> Repo[MemoryRepository]
  Repo --> Disk[(本地 JSON)]
  Main --> ModelStore[ModelStore]
  ModelStore --> ModelDisk[(本地模型副本)]
  ModelStore -->|受限 base64 资源包| Live2DModel[Live2DPetAdapter]
  Live2DModel --> Pixi[PixiJS 8 WebGL]
  Live2DModel --> Cubism[Cubism Framework / Core 5.1]
  UI --> Voice[麦克风 PCM/VAD / 本机与云端音频]
  Voice -->|voice:recognize-local 白名单 IPC| Main
  Voice -->|voice:synthesize 白名单 IPC| Main
  UI --> Live2DModel
  UI --> Fallback[DefaultPetAdapter]
  Main --> Move[DesktopMovementController]
  Move --> UI
```

- `main.ts`：纯宠物窗口、右键菜单、独立控制面板、托盘、进程生命周期和 IPC 边界。
- `DesktopMovementController`：管理焦点/指针暂停原因，在显示器工作区内处理自主漫游、全局鼠标拖拽、重力下落和动作信号。
- `AgentService`：检索记忆、注入结构化人格状态、生成回复、主动开场、L2 提炼和模型人格证据提取。
- `HeartbeatService`：定时器、迁移/整理触发、主动聊天约束和心跳审计。
- `MemoryEngine`：L1 缓冲、L2 事件化、L3 候选生成与上下文检索。
- `MemoryRepository`：版本化存储、L2/L3 原位修正与删除、可解释检索、串行写入、临时文件替换和损坏文件隔离。
- `PersonalityEngine`：从当前对话提取本地信号，在心跳中复盘新 L2，合并连续特质分数、冲突反馈、置信度与成长阶段。
- `PersonalityStore`：独立持久化人格状态和已复盘 L2 ID；使用临时文件替换，损坏时隔离并回到空白人格。
- `ModelStore`：在主进程校验并复制用户选择的 Cubism `.model3.json` 资源，持久化当前模型，并向宠物窗口返回不含本地路径的受限资源包。
- `OpenAICompatibleTtsClient`：可选云端模式的 `/audio/speech` 客户端；本机模式会在主进程边界直接拒绝云端生成，云端模式才读取独立 Base URL 和加密凭据。
- `VoiceService`：采集麦克风、执行轻量 VAD、下采样为 16 kHz PCM16；同时负责兼容 Web Speech、云端 TTS 请求、本机 `speechSynthesis` 回退、播放打断和过期结果丢弃。
- `LocalAsrService / local-asr-worker`：主进程校验宠物窗口提交的音频边界，按需在独立 worker 中加载 sherpa-onnx 与项目内 14M 中文 Zipformer，避免识别阻塞 Electron 主线程。模型缺失/大小异常、初始化超时和识别超时都有显式错误。
- `Live2DPetAdapter`：使用 PixiJS 8、Cubism Framework 与官方 Core 5.1 渲染内置和用户导入模型，处理 motion、自动取景、口型、视线、物理与模型资源释放。
- `DefaultPetAdapter`：Live2D 加载或 WebGL 初始化失败时使用的轻量程序化后备模型，保证聊天和桌面交互仍可用。
- `PetModelAdapter`：模型渲染边界，使 Agent、桌面移动和具体 2D Runtime 彼此解耦。

## 桌面交互与移动

PetWindow 默认开启鼠标穿透，只在鼠标进入宠物本体或字幕式对话坞时临时接收事件。普通回复只短暂显示当前一句字幕；鼠标靠近或普通点击才展开输入命令条。按下左键并移动超过 5px 后，Renderer 通过白名单 IPC 启动拖拽，主进程使用全局鼠标坐标移动真实 Electron 窗口。松手后控制器以加速下落方式把窗口放回当前显示器工作区底部。

移动控制器的优先级为：拖拽 → 下落 → 焦点/指针交互暂停 → 自主漫游。拖拽和落地不受“允许自由移动”开关影响；该开关只控制自主漫游。宠物窗口获得焦点时保持原地，失焦且鼠标不再与宠物交互后恢复选点行走。Renderer 只收到 `idle / walk-left / walk-right / dragged / falling` 语义状态，Live2D 或其他 2D 适配器自行决定对应视觉反馈。

## 模型导入与动作

用户通过原生目录选择器选择 Live2D 文件夹。`ModelStore` 只接受一个 `Version: 3` 的 `.model3.json`，要求存在其引用的 `.moc3` 与贴图，并收集可选的 motion、expression、physics、pose、userdata、display info 和动作音频。它会拒绝路径穿越、绝对路径、符号链接、未知扩展名、缺失引用和超限资源。有效文件会复制到 `data/models/imported/<id>/`；manifest 保存公开模型元数据与资源白名单，`data/models/model-state.json` 只记录当前模型 ID。

Renderer 保持 `sandbox: true`、`contextIsolation: true` 和 `nodeIntegration: false`。宠物窗口通过白名单 IPC 获取已校验的 base64 资源包，再在渲染进程中转换为带 MIME 的 `data:` URL；它不接收任意文件路径，也不能直接访问文件系统。设置窗口只能触发导入、内置模型切换和动作事件，不能获取模型二进制资源。

模型语义分成三个动画轨道：

1. 基础移动状态：`idle / walk / dragged / falling`，由桌面移动控制器驱动；模型水平翻转和程序化变换只影响画面，不改变窗口坐标。
2. 情绪状态：`happy / thinking / curious / listening / speaking / sleepy`，由聊天和语音状态驱动，并可触发 `TapBody` motion。
3. 一次性动作：`wave / jump / dance / sit / sleep / surprised`，由 `PetAction` 白名单事件驱动，按 `TapBody` 索引选择 motion，并在结束后回到 `Idle`。

导入模型可以没有 motion、expression 或物理文件。适配器优先查找 `Idle` 与 `TapBody / Tap / Touch / Action` 动作组；缺失时继续提供 CSS 状态反馈，不让桌宠崩溃。模型切换时先销毁旧 Pixi Application、贴图和 WebGL 上下文，再挂载新模型；资源解析或 WebGL 初始化失败时 Renderer 自动恢复轻量后备模型。可见网格自动取景和关闭 2D 面剔除使早期 Cubism 3 模型也能稳定显示。

## 心跳流程

```mermaid
sequenceDiagram
  participant T as 定时器/用户
  participant H as HeartbeatService
  participant M as MemoryEngine
  participant A as AgentService
  participant R as MemoryRepository
  participant U as 桌宠窗口
  T->>H: scheduled / manual / startup
  H->>M: flushL1()
  M->>R: 写入 L2 事件
  H->>H: 复盘新 L2 并更新人格证据
  alt L2 达到阈值或手动心跳
    H->>M: consolidate()
    M->>A: 提炼长期候选（模型可选）
    M->>R: 合并写入 L3
  end
  H->>A: 生成内部反思
  H->>H: 检查安静时段、空闲、冷却、日限额
  opt 允许主动聊天
    H->>A: 生成自然开场
    H->>U: proactive IPC
  end
  H->>R: 记录完整心跳事件
```

手动心跳用于调试和用户明确触发，因此会立即整理全部 L1，并在“主动聊天”开关开启时绕过空闲、冷却和安静时段约束。定时心跳严格执行全部限制。

## 人格成长

人格是独立于 L1/L2/L3 的行为状态，不等同于用户事实或长期记忆。初始 `traits` 为空；每个维度保存 `score / confidence / evidenceCount / lastEvidence`，不会从默认文案创建隐藏人设。

```mermaid
flowchart LR
  Dialogue[用户对话] --> Local[本地轻量信号]
  L2[新 L2 对话事件] --> Review[心跳去重复盘]
  Review -->|模型可用| JSON[受限 JSON 证据]
  Review -->|离线| Local
  Local --> Merge[分数与置信度合并]
  JSON --> Merge
  Merge --> Profile[(人格状态文件)]
  Profile --> Context[本轮结构化人格上下文]
  Context --> Reply[下一轮回复]
```

当前维度为 `warmth / curiosity / playfulness / directness / initiative / expressiveness`。变化采用设置中的成长率；同方向证据提高置信度，相反证据降低置信度并推动分数回摆。达到最少证据数前，状态只在设置页显示为观察结果，不影响回复。模型人格观察器只允许输出这些维度、方向、权重和短证据，且对话被标记为不可信数据。

## 本地语音与 TTS 输出流程

```mermaid
sequenceDiagram
  participant U as VoiceService
  participant P as preload
  participant M as Electron 主进程
  participant W as LocalAsrWorker
  participant T as OpenAI 兼容 TTS
  alt 项目内离线识别（默认）
    U->>U: getUserMedia + VAD + 16 kHz PCM16
    U->>P: recognizeLocalSpeech(PCM)
    P->>M: voice:recognize-local IPC
    M->>M: 校验窗口、模式、采样率、0.25～30 秒
    M->>W: 转移 ArrayBuffer
    W->>W: sherpa-onnx Zipformer 本机解码
    W-->>U: 识别文本
  else Chromium 兼容识别
    U->>U: Web Speech（可能联网）
  end
  alt 本机语音（默认）
    U->>U: speechSynthesis 使用已安装系统语音
  else 云端 TTS
    U->>P: synthesizeSpeech(助手回复)
    P->>M: voice:synthesize IPC
    M->>M: 校验来源、文本长度、云端模式和独立加密 Key
    M->>T: POST /audio/speech（MP3）
    T-->>M: 音频字节或失败
    M-->>U: 受限 MP3 或错误
    alt 云端可播放
      U->>U: Blob URL 播放，结束后释放
    else 配置、请求或播放失败
      U->>U: speechSynthesis 回退本机语音
    end
  end
```

`recognitionMode=local` 完全绕过 Chromium Web Speech，使用项目 `resources/voice/` 中经过固定 SHA-256 校验的 ONNX 模型；模型不打入安装包，可通过 `npm run voice:model:download` 按需下载。Electron 43 暴露的 `processLocally` 会因缺少 `media.mojom.OnDeviceSpeechRecognition` 服务终止渲染进程，因此代码中禁止本地模式调用该路径。`browser` 兼容模式可能联网。`ttsMode=local` 完全绕过 IPC 和外部端点；`cloud` 模式使用 `voice.ttsBaseUrl / ttsModel / ttsVoice / ttsSpeed` 和独立 TTS API Key，任一阶段失败都回退 `speechSynthesis`。聊天仍独立使用 `provider.baseUrl / model` 和聊天 API Key。渲染进程只获得两组凭据是否存在的布尔状态，不能读取明文 Key。每次新回复递增请求序号并停止当前音频，因此晚返回的旧请求会被忽略。

## 记忆设计

每条持久化记忆包含：

- `tier` 与 `kind`：层级以及对话、事件、事实、偏好、反思类型。
- `content` / `summary`：原始或提炼内容与短摘要。
- `importance`：0 到 1；用户明确要求记住时为高重要度。
- `tags`：来源、角色和提炼标签。
- `createdAt / updatedAt / accessedAt / accessCount`：用于时间衰减与强化。
- `sourceIds`：保持 L1/L2 到 L3 的来源追踪。

检索分数由以下部分组成：

```text
score = 文本相关度 × 5
      + 重要度 × 1.7
      + 30 天指数时间衰减 × 0.8
      + 访问频率 × 0.5
```

当前中文检索使用单字和相邻双字 token，无额外模型依赖。后续可增加嵌入向量索引，但仍建议保留该词法分数作为离线后备。

检索评分使用独立于 Jaccard 去重的 token 视图：保留中文相邻双字和有意义单字，移除有限的高频中文虚词；单字主题（例如“猫”“茶”）仍可命中。索引还给 kind 追加固定的本地化词，例如 `preference → 近期偏好`、`fact → 近期重要的事`、`episode → 近期计划待跟进话题`，让主动聊天的通用关注点查询保持可用。Repository 在排序前要求 `textRelevance >= 0.75`（即原始查询 token 命中比例至少约 15%），低于门槛的记录不会返回，也不会更新 `accessedAt / accessCount`。因此重要度、新鲜度和历史访问只能在已有文本或类型证据的候选之间调整顺序，不能把零相关记忆补进普通聊天、主动聊天或面板搜索。

`scoreMemoryBreakdown()` 把公式拆成 `textRelevance / importance / recency / frequency / total` 五项。普通 Agent 上下文仍通过 `retrieve()` 只获取 `MemoryRecord[]`；控制面板搜索使用 `retrieveWithScores()` 获取记录和评分明细，因此“为何召回”不会进入模型提示词，也不会改变检索排序。

`tests/fixtures/memory-quality-cases.ts` 提供 20 个手写中文质量 fixture，偏好更新、事实冲突、跨天跟进、持久化提示注入和用户纠错各 4 个。`npm run test:memory-quality` 使用临时版本 1 JSON 和真实 `MemoryRepository` 验证当前值排序、无关记录过滤、旧值不泄漏以及被过滤记录不获得访问强化；不依赖在线模型、上游数据集或真实用户数据。当前契约只建立检索层基线，自动冲突消解、失效历史标记、同义词与代词推理仍属于后续工作。

控制面板通过 `memory:update` 和 `memory:delete` 两个白名单 IPC 管理持久记忆。主进程只接受当前 PanelWindow 发起的请求，并校验 UUID、L2/L3 层级、1～2000 字内容、允许类型以及 0～1 重要度。修正保留 `id / tier / createdAt / accessedAt / accessCount / sourceIds / tags`，重算摘要并更新 `updatedAt`；删除只移除目标记录，不级联修改其他来源或派生记忆。L1 不提供写接口。若心跳正在等待模型提炼，写入前会再次比较来源版本；期间修正或删除任何来源都会丢弃整批旧候选，避免过期内容回写 L3。

## 主动聊天约束

定时心跳只有同时满足以下条件才会主动弹出消息：

1. 心跳与主动聊天均已启用。
2. 当前不在安静时段。
3. 距离最后一次用户交互达到空闲阈值。
4. 距离上次主动聊天超过冷却时间。
5. 当日主动消息未达到上限。

每次决定（包括不触发的原因）都进入 `heartbeatEvents`，便于后续调试策略。

## 后续演进接口

- 2D：在现有 Live2D 模型仓库上增加自定义缩放、expression 选择、历史导入模型切换和删除；继续通过 `PetModelAdapter` 保持 Agent 核心与渲染引擎解耦。
- 离线语音增强：当前 sherpa-onnx Zipformer 已提供稳定本地 ASR；后续可把整段识别改为增量传输与部分结果，并增加本地神经 TTS、真实音频口型时序和模型版本/删除 UI。
- 记忆质量：在现有 20 例检索契约上增加回复级偏好遵循、自动更新/冲突标记和过期值泄漏指标，再评估混合检索。
- 存储：数据量上升后把 `MemoryRepository` 替换成 SQLite + FTS/向量扩展，保持 `MemoryEngine` API 不变。
- 工具能力：在 `AgentService` 前增加显式授权的 Tool Router，不把工具执行权限隐含在普通聊天里。
- 多模态：只在用户授权时采集屏幕或摄像头，并把感知结果作为有时效的 L1 数据，而不是默认长期保存。
