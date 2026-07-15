# 记忆桌宠 Agent：AI 开发上下文

> 最后更新：2026-07-15｜项目版本：0.1.0｜阶段：MVP 已可运行，进入能力增强与生产化阶段

本文是其他 AI 编程助手进入项目时的首要上下文。开始改动前先读本文，再按任务需要阅读 `README.md`、`docs/ARCHITECTURE.md` 和对应源码。完成架构级或里程碑级改动后，同步更新本文的“当前进度”和“下一步优先级”。

## 0. AI 快速接手

公开仓库：`https://github.com/MonsterN58/memory-pet-agent`，默认分支为 `main`。项目可以克隆到任意磁盘；当前维护工作区位于 `D:\中软实习实训\Agent`，文档和代码不得依赖这个绝对路径。

开始开发前按以下顺序建立上下文：

1. 运行 `git status -sb`，确认当前分支和用户已有改动；不要覆盖或顺手提交任务外文件。
2. 完整阅读本文件，再按任务阅读 `README.md`、`docs/ARCHITECTURE.md`、`docs/LIVE2D_MODEL_GUIDE.md` 和直接相关源码。
3. 首次克隆运行 `npm install`；需要本地 ASR 时再运行 `npm run voice:model:download`。ONNX、词表和测试 WAV 不进入 Git。
4. 修改跨进程能力时按 `types.ts → main/preload → renderer → tests/docs` 的顺序保持契约一致。
5. 最少运行 `npm run typecheck` 与 `npm test`；入口、IPC、Electron、模型或语音改动还要运行对应 build/smoke。

版本控制中的事实来源只有 `src/`、`tests/`、`docs/`、`scripts/`、根配置、README/AGENTS 和明确内置的 Live2D 资源。以下内容不是源码，不得提交：

- `node_modules/`、`dist/`、`release/`、`output/`、`.cache/`、`.playwright-cli/`、`tmp/`。
- `resources/voice/` 下按需下载的 ONNX、`tokens.txt` 和测试 WAV；只提交 `MODEL_INFO.md` 与下载/校验脚本。
- Electron `userData` 中的记忆、人格、设置、`secrets.json` 和用户导入模型。
- 本地停用的 `A1/`、`ayan/`、`Pet1001/` Spine 试验模型；它们不属于当前 Live2D Runtime，授权来源也未纳入公开发布审计。
- 任何真实 API Key、访问令牌、私钥或填过值的 `.env`；`.env.example` 必须只保留空占位符。

仓库目前没有给项目自有源码声明统一开源许可证。公开可见不等于自动授予复制、修改或再分发权；不要擅自新增许可证。Live2D、Cubism Core、官方样例、sherpa-onnx 与语音模型继续受各自条款约束，详见 `THIRD_PARTY_NOTICES.md`。

## 1. 项目目标

构建一个 Windows 本地优先的桌宠 Agent，核心能力包括：

- 三级记忆：L1 瞬时记忆、L2 海马体待整理区、L3 长期记忆。
- 心跳机制：定期迁移、整理、回顾记忆，并在满足约束时主动发起聊天。
- 文字与语音交互。
- 可选 OpenAI Chat Completions 兼容模型，未配置或失败时可离线降级。
- 透明、置顶、托盘常驻的桌宠窗口。
- 以 Live2D Cubism 作为当前 2D Runtime，并为其他渲染方案保留稳定适配接口。
- 默认数据只保存在本机，API Key 通过系统安全存储加密。

产品原则：本地优先、可解释的记忆流、主动但不打扰、能力边界真实、渲染模型与 Agent 核心解耦。

## 2. 当前进度

当前结论：v0.1.0 MVP 已完成端到端闭环，可使用 `npm start` 运行；尚未达到正式发布质量。

| 模块 | 状态 | 已完成 | 仍需推进 |
| --- | --- | --- | --- |
| Electron 桌面壳 | 已完成增强版 | 纯宠物透明窗口、字幕式对话坞/按需命令条、连续方向/速度拖拽、垂直加速下落与水平速度姿态、320ms 落地回弹、失焦漫游、原生右键菜单、独立控制面板、托盘、单实例 | 安装包签名、自动更新、跨屏漫游策略 |
| L1 记忆 | 已完成 MVP | 进程内滚动上下文、数量/时间阈值、重要度估算 | 崩溃恢复、会话边界策略 |
| L2 记忆 | 已完成增强版 | 对话事件化、本地持久化、显式记忆入口、详情/来源、原位修正与删除 | 修订历史、冲突/撤销和人工审核机制 |
| L3 记忆 | 已完成增强版 | 事实/偏好/事件/反思、相似合并、来源追踪、详情/修正/删除 | 遗忘策略、修订历史、向量检索 |
| 检索 | 已完成增强版 | 中文单字/双字词法相关度、高频虚词抑制、最低文本证据门槛、重要度/时间/访问强化、召回评分拆解、显式当前/历史/比较时态门控、20 例五类 fixture 与真实回答链契约 | 持久化版本链、隐式冲突标记、用户审核、Embedding 与混合检索 |
| 心跳 | 已完成 MVP | startup/scheduled/manual、迁移、整理、反思、审计记录 | 自适应频率、策略可视化、长期评测 |
| 主动聊天 | 已完成 MVP | 空闲阈值、冷却、安静时段、每日上限 | 情境评分、用户反馈学习 |
| 人格成长 | 已完成基础版 | 初始空白、六维连续状态、逐轮本地证据、心跳模型/离线复盘、置信度与相反反馈、独立持久化、设置页展示与重置 | 更丰富的隐式反馈、人格版本历史、用户纠错单项证据 |
| 大模型 | 已完成基础版 | OpenAI 兼容端点、超时、离线降级、记忆提示隔离 | 流式输出、多供应商适配、重试/限流 |
| 语音 | 已完成稳定本地版 | sherpa-onnx 1.13.4 + 14M 中文 Zipformer、麦克风 PCM/VAD/16k 下采样、采集墙钟/精确 30 秒边界、非阻塞 warmup、文件/运行时状态分离与失败重试、识别中取消、隐藏收尾、worker 重建、虚拟麦克风 UI smoke、本机/云端 TTS | 部分识别结果、本地神经 TTS、真实音频驱动口型时序 |
| 2D 模型 | Live2D 交互增强已完成 | Hiyori/Mao/Wanko、Cubism 3/4/5 model3 导入、原子热切换/失败回退、640×480 单一全局视线、标准/旧式真实参数绑定、轻微待机、连续弹簧拖拽/下落/落地、11 种情绪、13 项动作、真实 motion3 时长、导入模型程序化兜底、可见网格自动取景、口型/眨眼/物理 | 用户缩放、expression 选择、历史模型切换/删除 UI、导入模型语义 motion 绑定 UI |
| 测试与安全 | 基础完成 | 106 个核心测试、20 例记忆质量 fixture、时态检索/真实回答链、Electron/本地语音/UI 语音/三模型 smoke、IPC 白名单、ASR 生命周期/运行状态/采集边界、隐藏语音收尾、TTS 隔离、全局视线/连续运动/动作导演、模型资源边界、npm 0 漏洞 | 多次记忆变更压力评测、麦克风硬件 E2E、更多数据迁移测试、安装包测试 |

最近一次已验证：

- `npm run typecheck` 通过。
- `npm test`：106/106 通过；新增覆盖 ASR 预热 `warming/ready/failed` 可见状态、失败重试、观察者隔离、模型缺失按钮门控、采集墙钟/轨道断开/30 秒精确裁剪、隐藏窗口语音收尾与迟到回复抑制，其余三级记忆、人格、TTS、Live2D 与模型资源回归继续通过。
- `npm run test:memory-quality`：9/9 测试通过，覆盖 5 类、20 个 fixture 与真实 `AgentService.respond()`；使用临时本地 JSON 和仅监听 `127.0.0.1` 的受控兼容端点，不访问外部网络或模型。
- `npm run build` 通过。
- `npm run smoke` 在 Electron 43.1.0 下输出 `ELECTRON_SMOKE_TEST_READY`。
- `npm run smoke:voice` 在真实 Electron 主进程与 worker 下输出 `ELECTRON_LOCAL_ASR_SMOKE_READY 5612ms 对我做了介绍那么我想说的是大家如果对我的研究感兴趣`。
- `npm run smoke:voice-ui` 使用 Chromium 虚拟麦克风在真实 Renderer/IPC/worker 链路下输出 `ELECTRON_LOCAL_ASR_UI_SMOKE_READY`，覆盖成功识别、识别中立即取消、迟到结果隔离和下一次恢复；仅有 Chromium 已知的 `ScriptProcessorNode` 弃用提示。
- `npm run smoke:model-switch` 已在真实 Electron WebGL 下依次输出 Hiyori、Mao、Wanko、再次 Hiyori 的 `LIVE2D_MODEL_READY` 和最终 `ELECTRON_MODEL_SWITCH_TEST_READY`，无销毁警告或 Cubism 断言。
- `npm audit`：0 vulnerabilities。
- 390×700 视口下已检查聊天、三级记忆和设置面板。
- 390×700 生产 Renderer 下已检查 L1 只读、L2/L3 详情/来源/修正/删除入口和窄屏编辑表单，控制台 0 错误；验收图为 `output/playwright/memory-control-list.png` 与 `output/playwright/memory-control-edit.png`。
- 本地 ASR 模型已用固定 SHA-256 校验；独立 worker 在 Node 24 下用官方 5.6 秒中文 WAV 真实识别成功，模型目录为项目 `resources/voice/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/`，运行模型约 29.5 MiB。
- 新版设置页已在本地浏览器预览中验证空白人格卡片、项目内离线识别状态、本机朗读默认值、可选独立云端 TTS、移动设置和完整可访问结构，保存后控制台无错误。
- 320×460 视口下已检查纯宠物本体、鼠标拖起和松手下落状态；验收图在 `output/playwright/drag-ready.png`、`pet-dragged.png`、`pet-falling.png`。
- 本轮在真实 Electron 中检查了 Hiyori/Mao 的左中右上下视线、Wanko 的左右头耳反馈，以及 happy/excited/curious/comforting/surprised/sleepy 动作；12 张验收图位于 `output/acceptance-2026-07-14/`，日志无 Cubism 断言或销毁错误。
- 本轮拖拽验收图位于 `output/playwright/drag-acceptance/`：`dragged.png`、`falling.png`、`landing-compress.png`、`landing-rebound.png`，记录拖拽、下落、触地压缩和回弹四个阶段。
- 旧气泡对话框已替换为“当前字幕 + 按需输入命令条”；主动回复只显示字幕，靠近/点击时展开输入，`Esc` 收起。真实透明窗口验收图为 `output/dialog-dock-final.png`。
- 已从 `Live2D/CubismWebSamples` 的 `develop` 分支内置 Hiyori、Mao、Wanko，并在真实 Electron WebGL 中验证官方 Cubism Core 5.1、透明背景、动作帧和自动取景。验收图为 `output/live2d-final-hiyori-wave.png`、`live2d-final-mao-dance.png`、`live2d-final-wanko-jump.png`。
- 已处理 `untitled-pixi-live2d-engine 1.3.1` 对 PixiJS 8.13 过期私有纹理字段、Ticker/模型销毁顺序和 Moc 释放计数的兼容问题；修复都位于项目适配层而非 `node_modules`。旧 Wanko 的网格 culling 标记也已通过 Cubism override API 通用兼容。
- Cubism Core 必须使用官方兼容地址 `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`（当前 5.1.0）；`/sdk-web/core/` 返回的 Core 6.0.1 与当前第三方 Framework API 不兼容。
- 本轮按用户要求不执行发布打包；`npm run package` 和新安装包体积尚未重新验收，后续进入发布阶段再做。

## 3. 技术栈与运行命令

- Node.js 22+，当前开发环境为 Node.js 24。
- Electron 43、TypeScript、Vite。
- 离线 ASR 使用 `sherpa-onnx` 1.13.4 WASM Runtime 与 14M 中文流式 Zipformer；模型不打安装包，固定在当前项目目录并按需下载。
- 原生 TypeScript/DOM UI，无 React/Vue；2D 渲染使用 PixiJS 8.13.1、`untitled-pixi-live2d-engine` 1.3.1 和官方 Cubism Core 5.1。
- 测试使用 Node test runner + `tsx`。
- 持久化当前使用版本化 JSON，不依赖数据库或原生 Node 扩展。

```powershell
npm install             # 安装依赖
npm run voice:model:download # 下载/修复项目内离线 ASR 模型
npm run voice:model:verify   # 只做大小和 SHA-256 校验
npm start               # 构建并启动桌宠
npm run typecheck       # 主进程和渲染进程严格类型检查
npm test                # 核心单元/集成测试
npm run build           # 清理并生成 dist
npm run smoke           # 真实 Electron 初始化后自动退出
npm run smoke:voice     # 真实 Electron worker 加载本地模型并识别官方 WAV
npm run smoke:voice-ui  # 虚拟麦克风覆盖 Renderer 成功、取消和恢复链路
npm run smoke:model-switch # 依次热切换三套内置模型后自动退出
npm run package         # 生成 Windows NSIS 安装包
```

`electron-builder` 复用锁定的 `node_modules/electron/dist`，避免重复下载 Electron。当前 MVP 的 `signAndEditExecutable` 为 `false`，生成的是未签名本地验收包；正式发布必须补应用图标、证书并恢复资源编辑/签名。

国内网络下载 Electron 超时时：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
```

## 4. 代码地图

```text
src/common/
  types.ts                 跨进程类型、记忆模型、设置、PetAgentBridge 契约
  defaults.ts              人格成长、心跳、语音和窗口默认策略（不含预设人格）

src/main/
  main.ts                  Electron 生命周期、窗口、托盘、IPC 注册和输入边界
  desktop-movement-controller.ts  失焦漫游、全局视线、连续拖拽、重力下落、320ms 落地和边界
  pet-motion.ts            640×480 焦点归一化、连续运动帧与落地纯逻辑
  preload.ts               contextBridge 白名单；渲染层唯一主进程入口
  agent-service.ts         结构化人格上下文、聊天、主动消息、情绪推断、反思、L2 与人格证据提炼
  reaction-inference.ts    同时参考用户/回复文本的确定性情绪分类
  heartbeat-service.ts     心跳调度、主动聊天限制与审计
  local-asr-service.ts     模型文件/运行时状态、PCM 边界、非阻塞预热、取消、可注入超时与 worker 重建
  pet-window-lifecycle.ts  隐藏前通知 Renderer 停止语音并保证窗口收尾
  local-asr-worker.ts      sherpa-onnx Zipformer 加载和本机解码
  settings-store.ts        设置清洗、持久化、safeStorage API Key
  model-store.ts           内置/用户 Live2D model3 校验、引用收集、复制、状态持久化和受限资源包
  provider/
    openai-compatible.ts   Chat Completions 兼容客户端
    openai-compatible-tts.ts  /audio/speech TTS 客户端、鉴权、超时与音频响应边界
  memory/
    memory-engine.ts       L1 缓冲、L1→L2、L2→L3、上下文检索
    memory-input.ts        L2/L3 修改与删除请求的 UUID、层级、内容、类型和重要度校验
    memory-repository.ts   JSON 数据库、串行写入、损坏隔离、L2/L3 管理、L3 合并、完整评分检索和聊天时态门控
    memory-utils.ts        分词、相似度、检索评分、显式查询时态分类、去重
  personality/
    personality-engine.ts  六维证据分析、冲突修正、成长阶段和模型行为上下文
    personality-store.ts   空白人格、独立 JSON 持久化、损坏隔离和复盘去重

src/renderer/
  index.html / styles.css  桌宠、聊天、记忆和设置 UI
  renderer.ts              UI 状态与 bridge 调用、记忆管理、语音/动作优先级和模型热切换
  voice-service.ts         单一语音 operation、PCM/VAD/下采样、取消/35s 看门狗、本机/云端 TTS
  local-speech-status.ts   麦克风可用性与本地 ASR 状态文案纯逻辑
  pet-ui-command.ts        界面暂停/恢复与隐藏后迟到回复抑制
  model-adapter.ts         2D 模型稳定接口
  live2d-interaction.ts    真实参数绑定、焦点阻尼、连续变形、动作映射/时长/程序化兜底
  pet-reaction-director.ts 回复动作选择、冷却、延后、情绪恢复和手动预览优先级
  live2d-pet-adapter.ts    Pixi/Cubism 渲染、真实索引写入、弹簧、motion、口型、物理和自动取景
  browser-mock.ts          仅 http(s) 本地 UI 预览使用的模拟 bridge

tests/                     记忆、人格、语音、桌面运动、Live2D 交互与安全边界测试
docs/ARCHITECTURE.md       详细数据流、心跳时序和演进说明
docs/LIVE2D_MODEL_GUIDE.md Cubism 目录规格、动作组织、安全限制、授权和替换流程
scripts/clean.mjs          仅清理可再生成的 dist
scripts/download-asr-model.mjs 固定版本、项目目录下载与 SHA-256 校验
scripts/local-asr-smoke.cjs 真实 Electron/worker/模型识别 smoke
scripts/local-asr-ui-smoke.cjs 虚拟麦克风 Renderer/IPC/worker 成功、取消和恢复 smoke
resources/voice/           按需下载的本地 ASR 模型；ONNX 不进入安装包
启动桌宠.cmd               Windows 双击启动入口，检查环境、补齐依赖并执行 npm start
```

构建输出必须保持：主入口 `dist/main/main.js`，preload 为 `dist/main/preload.js`，渲染页为 `dist/renderer/index.html`。曾发生过 TypeScript `outDir` 导致入口多嵌套一层的问题，改动构建配置后必须运行 `npm run smoke`。

## 5. 核心运行链路

### 普通聊天

1. `renderer.ts` 通过 `window.petAgent.chat()` 发起请求。
2. `preload.ts` 将调用限制到 `agent:chat` IPC。
3. `main.ts` 清洗文本并记录最后交互时间。
4. `AgentService.respond()` 把用户消息写入 L1，并按当前、历史或比较查询视图检索相关记忆后生成回复。
5. 模型配置完整时，把已达到证据门槛的人格连续状态与时态门控后的相关记忆放入本轮系统上下文；失败或未配置时使用本地回复。
6. 助手回复写入 L1，`PersonalityEngine` 从本轮用户表达中小幅更新证据，变化从下一轮回复开始生效。
7. `inferReaction(userText,responseText)` 为普通与主动回复生成本地情绪标签；渲染层立即更新字幕/情绪，`PetReactionDirector` 在录音与移动优先级允许时选择至多一个动作。
8. 自动朗读默认直接使用本机 `speechSynthesis`，不经过 IPC 或外部服务；只有 `ttsMode=cloud` 时才通过 `voice:synthesize` 使用独立 TTS 配置，失败后回退本机语音。

### 记忆与心跳

```text
L1 逐条对话（仅内存）
  └─ 超过数量/时间阈值，或手动心跳
      ↓
L2 对话事件（本地 JSON，待整理）
  └─ 达到整理阈值，或手动心跳
      ↓
L3 事实 / 偏好 / 事件 / 反思（本地 JSON，去重合并）
```

定时心跳严格检查安静时段、用户空闲时长、主动聊天冷却和每日上限。手动心跳是用户明确操作，会立即整理全部 L1；主动聊天开关开启时，它会绕过定时策略的时间限制。不要在未讨论产品语义前改变这一差异。

心跳在消费 L2 前还会把未复盘的对话交给人格系统；有模型时提取受限 JSON 证据，无模型时使用本地规则。已复盘 L2 ID 最多保留 1000 个，避免定时心跳重复强化同一段对话。

### 本地数据

正式运行时使用 `app.getPath("userData")/data`：

- `memory-store.json`：L2、L3、心跳事件和运行元数据。
- `personality-profile.json`：人格六维状态、成长阶段和已复盘 L2 ID；首次创建时为空白人格。
- `settings.json`：不含明文密钥的公开设置。
- `secrets.json`：`safeStorage` 分别加密的聊天与 TTS API Key，以及一次性迁移标记。
- `models/model-state.json`：当前使用的模型 ID。
- `models/imported/<id>/`：校验后复制的 model3、moc3、贴图、可选资源和 manifest。

离线 ASR 模型不写入 `userData`，而固定在项目
`resources/voice/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/`；npm 下载缓存由项目 `.npmrc`
固定在 `.cache/npm`。缓存和模型始终跟随当前项目磁盘；当前维护工作区位于 D 盘，因此不会写入 C 盘用户缓存。

聊天环境变量 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 和 TTS 环境变量 `OPENAI_TTS_API_KEY`、`OPENAI_TTS_BASE_URL`、`OPENAI_TTS_MODEL`、`OPENAI_TTS_VOICE` 分别优先于各自 UI 配置。L1 不持久化是当前明确设计，不是存储遗漏。

## 6. 不可轻易破坏的约束

1. 渲染进程保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；不要在渲染层直接访问文件系统、密钥或 Node API。
2. 新的跨进程能力先更新 `PetAgentBridge` 类型，再更新 preload 白名单、主进程 IPC 和渲染调用；主进程必须校验不可信输入。
3. 聊天与 TTS API Key 可以从渲染层分别提交，但绝不能从主进程回传明文；公开状态只返回 `hasApiKey` 和 `hasTtsApiKey`。
4. 记忆内容对模型而言是数据而非指令。修改 prompt 时继续保留提示注入隔离语义。
5. 人格必须从证据状态成长，不能恢复为一个可直接覆盖的 `persona` 文本字段；普通用户事实不得被当成桌宠人格。
6. 默认离线可启动。大模型、语音识别或外部服务失败不能让文字聊天、本地人格和记忆不可用。
7. 保持三级语义：L1 是瞬时逐条上下文，L2 是待整理事件，L3 是长期抽象；不要让 UI 直接绕过流程写入 L3，除非产品明确新增“确认后直存”能力。
8. 所有用户记忆、人格证据和设置默认写本机；增加摄像头、屏幕、云同步或工具执行前必须设计显式授权。
9. 2D 引擎通过 `PetModelAdapter` 接入。不要把 Live2D 专有 API 泄漏进 Agent、记忆或心跳服务。
10. `browser-mock.ts` 只能在 `http(s)` 且真实 bridge 不存在时启用；Electron 的 `file:` 正式页面必须始终使用 preload bridge。
11. 文件存储写入当前通过队列串行化和临时文件替换完成；修改 Repository 时保留并发写安全和损坏文件恢复。
12. Git 只跟踪项目源文件和经过许可审计的内置资源。不要强制加入被 `.gitignore` 排除的模型、运行数据、密钥、缓存或生成物。

## 7. 开发工作流

实现新功能时建议按以下顺序：

1. 确认需求影响主进程、渲染进程、跨进程契约还是持久化格式。
2. 先修改 `src/common/types.ts` 中的稳定契约。
3. 在核心服务中实现逻辑，避免把业务规则写进 IPC handler 或 DOM 事件。
4. 添加 IPC 时同时更新 main、preload 和 bridge 类型，并做长度/类型/URL 等边界校验。
5. 增加或更新测试；持久化结构变化需要版本迁移与旧数据测试。
6. 依次运行 `npm run typecheck`、`npm test`、`npm run build`。
7. 涉及入口、preload、Electron 配置、托盘或存储初始化时必须再运行 `npm run smoke`。
8. 涉及 UI 时使用 390×700 尺寸检查聊天、抽屉滚动和透明窗口布局。
9. 依赖升级后运行 `npm audit`；不要使用未经评估的 `npm audit fix --force`。

不要手工编辑 `dist/`、`release/`、`node_modules/` 或运行时数据文件；它们是生成物或用户数据。源码修改应落在 `src/`、`tests/`、`docs/`、配置或脚本中。

## 8. 下一步优先级

建议按价值和风险排序：

1. **持久化记忆版本与冲突质量**：在已建立的 20 例检索、显式时态门控和回复级契约上增加 `current / superseded / transition` 版本链、主题键、过期值泄漏指标和用户可见冲突审核；完成前不直接引入 Embedding/SQLite。
2. **记忆审计增强**：在现有原位修正与删除之上增加修订历史、撤销和人工审核策略，并与冲突标记共用来源链。
3. **流式对话**：扩展 provider 与 IPC 为增量事件，同时保留本地降级和取消能力。
4. **模型管理体验**：增加导入模型缩放、皮肤选择、历史模型切换与删除，同时保留内置模型回退和本地资源边界。
5. **离线语音增强**：在已落地的 sherpa-onnx worker 上增加流式 IPC 与部分识别结果，并评估本地神经 TTS、真实音频口型时序和模型版本/删除 UI。
6. **发布工程**：验证 `npm run package`、应用图标、NSIS 安装/卸载、代码签名、自动更新和多屏行为。

若没有新的产品指令，优先做第 1 项，而不是直接引入向量数据库或复杂 Agent 工具系统。

## 9. 已知限制与注意事项

- 当前 L1 在应用退出后丢失；L2/L3 才持久化。
- 当前 L2/L3 修正是保留来源字段的原位覆盖，不保存历史版本；删除也没有撤销入口。
- JSON Repository 适合 MVP 数据量，不适合超大记忆库和复杂并发查询。
- 中文检索是带最低文本证据门槛的轻量词法算法，没有语义向量；聊天能依据“现在 / 以前 / 变化”等显式线索门控事实和偏好，但没有时态词的隐式冲突、同义表达、代词指代和持久化版本关系仍未解决。控制面板搜索会有意保留全部相关历史供审计。
- 本地回复是保障可用性的规则模板，不等同于离线大模型。
- Electron 43 的 `processLocally` 会因缺少 `media.mojom.OnDeviceSpeechRecognition` 终止渲染进程，禁止恢复该路径。本地模式必须走项目 sherpa-onnx worker；只有用户主动选择 `browser` 模式时才调用可能联网的 Chromium Web Speech。
- 当前 VAD 在 Renderer 中判断结束后一次性提交整段 PCM，尚未显示部分识别文本；启动后的后台 warmup 通常会提前加载模型，失败或超时则在下次请求重建。真实麦克风仍需在目标设备进行硬件 E2E。
- 自动朗读默认使用系统已安装语音且不发送文本；只有选择云端 TTS 才会把助手回复发送到独立端点，失败时回退本机。云端单次限制 2000 字、12MB MP3 和 60 秒。
- 模型客户端当前只支持非流式 Chat Completions 形态。
- 内置 Hiyori、Mao、Wanko 来自 Live2D 官方样例并会收入安装包；商业分发前必须检查 Cubism SDK Release License、Free Material License 和单模型条款。
- 当前 Runtime 目标是 Cubism 3/4/5 `.moc3`；Core 6 新数据特性不保证兼容，应从原工程导出 Cubism 5 兼容资源，不能通过修改 model3 版本号转换。
- 用户模型还没有自定义缩放、皮肤选择、历史模型切换和删除 UI。
- 通用导入模型当前不会根据 motion 文件名猜测 13 项语义；缺少显式内置映射时使用程序化兜底，后续需要用户可编辑的语义绑定 UI。
- 手动动作优先级采用 12 秒最长资源动作窗口；`PetModelAdapter` 目前没有跨 Runtime 的“动作结束/取消”回调，因此自动动作不会精确到每个手动资源结束帧恢复。
- 恢复内置模型不会删除 `data/models/imported/` 中的历史副本，长期使用时需要用户手动管理磁盘空间。
- 拖拽允许在当前显示器工作区内放置宠物；松手后窗口垂直加速落到该显示器底部，模型姿态保留松手瞬间的水平速度倾斜并在触地后回弹。自主漫游仍是当前工作区内的水平移动。
- Cubism Core、SDK 组件和样例模型有不同许可，正式分发前需逐项确认并保留上游文件。
- `THIRD_PARTY_NOTICES.md` 会随安装包收入 `app.asar`，包含 Cubism、官方样例、Live2D 引擎、PixiJS、sherpa-onnx 与 Zipformer 模型声明；不要从打包列表移除。
- 心跳事件最多保留最近 200 条；改动前评估审计与数据增长需求。
- Windows 是当前目标平台；macOS/Linux 行为尚未验证。

## 10. 完成定义

一个任务只有在以下条件满足时才算完成：

- 需求在源码中实现，而不是只修改生成产物。
- 本地优先、安全边界和离线降级没有被破坏。
- 相关测试已增加或说明为什么现有测试足够。
- 类型检查、测试和构建通过；涉及 Electron 集成时 smoke 通过。
- 用户可见行为或配置变化已同步更新 `README.md` 或架构文档。
- 如果项目阶段、模块状态或优先级改变，已同步更新本文。
