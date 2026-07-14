# 记忆桌宠 Agent

一个面向 Windows 的本地优先桌宠 Agent。当前 MVP 已具备透明置顶窗口、三级记忆、心跳回顾、受约束的主动聊天、语音输入/输出、OpenAI 兼容模型接入，以及可替换的 2D 模型适配层。

## 已实现能力

- L1 瞬时记忆：保留当前会话最近消息，只存在于进程内。
- L2 海马体待整理区：心跳按容量或停留时间把 L1 对话组成事件并持久化。
- L3 长期记忆：从 L2 提炼事件、事实、偏好和反思；相似内容自动合并。
- 记忆检索：综合文本相关度、重要度、时间衰减和访问频率排序。
- 记忆可控性：控制面板可展开 L1/L2/L3 完整内容、标签、时间与来源链；L2/L3 可修正类型、内容和重要度，也可确认后删除。搜索结果会拆分显示“为何召回”的各项分值。
- 心跳机制：定期迁移、整理和回顾记忆，并记录每次心跳结果。
- 主动聊天：同时受空闲阈值、冷却时间、每日上限和安静时段控制。
- 人格成长：初始人格为空，通过重复对话证据和心跳复盘逐渐形成温暖、好奇、俏皮、直接、主动、表达六个连续倾向；支持相反反馈修正、置信度、证据门槛和一键重置。
- 语音交互：默认使用项目内 sherpa-onnx + 小型中文 Zipformer 模型离线识别，并使用本机已安装语音朗读；可选 OpenAI 兼容 `/audio/speech` 云端 TTS，失败时自动回退本机语音。
- 模型接入：支持 OpenAI Chat Completions 兼容端点；未配置或连接失败时自动退回本地模式。
- 桌宠窗口：默认只显示透明背景上的宠物本体；失去焦点后在当前桌面工作区自主行走，托盘常驻。
- 拖拽与落地：按住宠物移动即可把它拖到当前显示器任意位置，松手后播放下落动作并回到桌面底部。
- 字幕式对话坞：回复只显示当前一句悬浮字幕；鼠标靠近、点击宠物或托盘唤醒时才展开独立输入命令条，移开或按 `Esc` 后自动收起。
- 右键控制：自由移动、置顶、语音、心跳、记忆与高级设置全部从宠物右键菜单进入。
- Live2D 模型：内置 Hiyori、Mao、Wanko 三套 Live2D 官方样例，可在右键菜单或设置面板中原子热切换；加载失败时保留当前模型，连续选择以最后一次为准。
- 自定义模型：可导入 Cubism 3/4/5 的 `.model3.json + .moc3` 整个文件夹，自动收集贴图、motion、expression、physics、pose、userdata 和动作音频。
- 待机与视线：待机时有轻微呼吸/浮动；即使窗口处于鼠标穿透状态，眼睛和头部也会跟随桌面全局鼠标位置。
- 更多动作：右键菜单可触发挥手、跳跃、跳舞、坐下、睡觉和惊讶；三套内置模型使用独立 motion/表情映射，其他模型由交互 motion 与程序化动画共同补足。
- 2D 适配：通过 `PetModelAdapter` 隔离模型 Runtime 与 Agent、记忆、心跳和桌面移动。

## 本地运行

要求 Node.js 22 或更高版本。

Windows 下最简单的方式是双击项目根目录的 [`启动桌宠.cmd`](./启动桌宠.cmd)。脚本会自动定位项目目录、检查 Node.js、在缺少依赖时执行安装，并完成构建和启动。启动后关闭桌宠窗口会隐藏到系统托盘，需要从托盘菜单选择“退出”才能完全结束进程。

也可以在 PowerShell 中手动运行：

```powershell
npm install
npm run voice:model:download
npm start
```

离线识别 Runtime 随 npm 依赖安装，约 21 MB；中文模型约 29.5 MiB，固定保存到
`<项目目录>\resources\voice\sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`。
项目的 `.npmrc` 会把 npm 缓存固定到项目内 `.cache/npm`，因此模型和缓存都跟随项目所在磁盘；当前维护工作区在 D 盘时不会使用 C 盘用户 npm 缓存。
当前模型已下载时脚本只做 SHA-256 校验，不会重复下载；可用
`npm run voice:model:verify` 手动检查完整性。双击启动脚本发现模型缺失时会自动下载到该项目目录。

如果在国内网络下载 Electron 超时，可以使用镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
```

开发检查：

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
npm run smoke:voice
npm run smoke:model-switch
```

`npm run smoke` 会启动真实 Electron 运行时，验证 preload、IPC、托盘和本地存储初始化，随后自动退出且不显示窗口。`npm run smoke:voice` 会在真实 Electron 主进程中加载项目内 ONNX 模型并识别官方中文测试音频，不访问麦克风或网络。`npm run smoke:model-switch` 会显示透明桌宠窗口，依次热切换 Hiyori、Mao、Wanko 并再次回到 Hiyori，全部就绪后自动退出。

构建 Windows 安装包：

```powershell
npm run package
```

当前本地打包直接复用 `node_modules/electron/dist`，不会再次下载 Electron；生成物位于 `release/`。MVP 安装包明确关闭了 EXE 资源编辑与代码签名，便于无证书环境稳定构建。正式发布时应配置应用图标和 Windows 代码签名，并恢复 `build.win.signAndEditExecutable`。第三方 Runtime 声明随包附带在 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 模型配置

桌宠默认以本地陪伴模式运行，不要求 API Key。聊天 LLM 和可选云端 TTS 在设置页中分成两组，互不依赖。

聊天 LLM 组填写聊天 Base URL、聊天模型和聊天 API Key，并开启“启用模型服务”。也可以使用 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 环境变量，环境变量优先。

朗读默认选择“本机语音”，不需要 API Key，也不会把回复文本发送到外部服务。需要更自然的声音时，可切换到“云端 TTS”，单独填写 TTS Base URL、模型、音色、语速和 TTS API Key；云端默认请求 `POST {TTS Base URL}/audio/speech`，也可以使用 `OPENAI_TTS_API_KEY`、`OPENAI_TTS_BASE_URL`、`OPENAI_TTS_MODEL` 和 `OPENAI_TTS_VOICE` 环境变量。云端配置缺失、请求失败或音频无法播放时会自动使用本机语音继续朗读。

聊天和可选云端 TTS 的两份 API Key 都使用 Electron `safeStorage` 绑定当前系统用户加密保存。旧版本升级时，原共享 Key 会一次性复制为 TTS Key，之后两份凭据可以分别修改或清除；清除 TTS Key 不会恢复或影响聊天 Key。

## 人格成长

桌宠不再使用可手填的“性格设定”字符串。首次启动时 `personality-profile.json` 中没有任何特质，第一轮回复采用中性表达；之后系统按以下过程成长：

1. 每次用户对话只提取交流方式信号，例如希望更直接、更主动、不要卖萌或需要详细解释，不把用户身份和普通事实当成桌宠人格。
2. 特质以连续分数保存，同时记录证据次数、置信度和最近证据。单次对话只能造成小幅变化，达到设置中的证据门槛后才参与回复。
3. 心跳对尚未处理的新 L2 对话做一次去重复盘。有模型时要求模型只返回受限 JSON 证据，无模型时使用本地规则。
4. 相反反馈会降低原方向置信度并推动分数回摆，不会永久锁定第一次判断。
5. 当前成长阶段、六项倾向和证据可以在“桌宠设置 → 身份与人格成长”查看，也可以单独清空人格而保留三级记忆。

最终仍需把结构化人格状态作为本轮模型上下文的一部分，这是语言模型执行行为的必要接口；区别在于该上下文来自持久化状态、累计证据和置信度计算，而不是一段预先写死的角色提示词。

## 记忆生命周期

| 层级 | 定位 | 保存位置 | 进入下一层的条件 |
| --- | --- | --- | --- |
| L1 | 当前会话的逐条消息 | 进程内存 | 超过数量/时间阈值，或手动心跳 |
| L2 | 尚未抽象的对话事件 | 本地 JSON | 达到整理阈值，或手动心跳 |
| L3 | 事实、偏好、事件、反思 | 本地 JSON | 长期保留，相似记忆合并更新 |

从宠物右键菜单进入“三级记忆管理”，展开任意卡片即可查看完整内容和上游来源标识。L1 是当前会话上下文，只读且退出后丢失；L2/L3 的修正会保留原 ID、层级、创建时间、访问统计和来源链，只更新内容、类型、重要度、摘要与更新时间。删除只移除选中的持久记忆，不会跨层级联删除。

应用数据通过设置里的“打开数据目录”查看。记忆在 `data/memory-store.json`，人格状态在 `data/personality-profile.json`，公开设置在 `data/settings.json`，加密凭据在 `data/secrets.json`，用户导入模型在 `data/models/`。

## 语音说明

- 语音识别默认使用项目内的 sherpa-onnx 1.13.4 和 14M 中文流式 Zipformer。Renderer 采集单声道麦克风 PCM、做简单语音活动检测并下采样到 16 kHz；主进程只接受来源为宠物窗口、0.25～30 秒的 PCM16，再交给独立 worker 本机识别。录音不会发送到聊天模型或 TTS 服务。
- 说完保持约 1.2 秒安静会自动结束录音，也可再次点击麦克风手动结束；8 秒内没有检测到语音会给出明确提示。首次识别加载模型通常需要数秒，之后复用同一 worker。
- Electron 43 的 Chromium 设备端 `processLocally` 在当前环境缺少底层 Mojo 服务，不能作为可靠本地实现，因此本地模式不再调用它。“Chromium 兼容模式”仅作为可选后备，可能联网且稳定性取决于 Chromium 后端。
- 自动朗读默认使用操作系统已安装的本机语音，不需要 TTS Key，也不会发送回复文本。语速和识别语言同时用于选择合适的本机声音。
- 选择云端 TTS 后，主进程才会使用独立端点与凭据调用 `/audio/speech`。单次文本最多 2000 字，响应限制为 12MB MP3，超时为 60 秒；失败时自动回退本机语音。
- 新回复会停止正在播放的旧回复，晚到的旧云端结果不会覆盖当前语音。麦克风、本地模型或所有朗读方式均不可用时，文字聊天和三级记忆仍可使用。

## Live2D 模型与动作

[`Live2DPetAdapter`](./src/renderer/live2d-pet-adapter.ts) 使用 PixiJS 8、Cubism Framework 和官方 Cubism Core 5.1 渲染 `.moc3`，并负责自动取景、眨眼、物理、视线跟随、口型和 motion。`DesktopMovementController` 只负责 Electron 窗口在桌面的真实位移，因此模型切换不会影响三级记忆、心跳、拖拽和自主漫游。

项目内置三套来自 [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples/tree/develop) `develop` 分支的官方样例，后续构建安装包时也会一并包含：

| 模型 | 形态 | motion | 适用场景 |
| --- | --- | ---: | --- |
| Hiyori | 全身人物 | 10 | 默认桌宠，标准口型参数 |
| Mao | 全身人物 | 8 | 魔法师造型，自定义 `ParamA` 口型 |
| Wanko | 宠物 | 12 | 更接近传统桌宠的矮小轮廓，含 touch/shake 动作 |

导入自己的模型：

1. 准备一个 Cubism 3/4/5 模型文件夹，其中必须且只能有一个 `.model3.json`，并包含它引用的 `.moc3` 和全部贴图。
2. 右键宠物选择“模型与动作 → 导入 Live2D 模型…”，或打开“桌宠设置 → Live2D 模型与动作”。
3. 选择整个模型文件夹。校验成功后，所需资源会复制到 `data/models/imported/` 并立即切换；原目录之后可以移动。

适配器把 `Idle` 作为循环待机，把 `TapBody`（也兼容 `Tap`、`Touch`、`Action`）依次映射到六个手动动作；motion 数量不足时循环取用，模型没有对应 motion 时仍保留程序化动作反馈。内置模型另有逐模型语义映射：Hiyori 从完整动作集中挑选，Mao 使用六条交互 motion 和八个表情，Wanko 使用六条 touch、两条 shake 与四条 idle。一次性动作会覆盖资源中的循环标记，并按动作语义在 0.9–3.5 秒后恢复待机。`Groups/LipSync` 中声明的参数会在说话时驱动，因此非标准口型 ID 也能使用。

详细目录约定、限制、动作组织和授权要求见 [`docs/LIVE2D_MODEL_GUIDE.md`](./docs/LIVE2D_MODEL_GUIDE.md)。本地 UI 和 Electron 验收图生成在 `output/`，该目录包含测试运行数据且不纳入版本控制。

Cubism Core、SDK 组件和样例模型各有独立许可；尤其商业发行前应检查 Cubism SDK Release License 与 Free Material License 条款，并保留 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

本仓库目前没有为项目自有源码声明统一开源许可证。公开可见不代表自动获得复制、修改或再分发授权；第三方 Runtime、Live2D 模型和语音模型始终按 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 中列出的各自条款处理。

## 隐私与安全边界

- 默认所有记忆、人格证据和设置只写入本机应用数据目录。
- 启用聊天模型时，当前输入、检索到的少量相关记忆和已达到门槛的人格状态会发送到聊天端点；只有主动选择云端 TTS 时，助手回复文本才会发送到独立配置的 TTS 端点。聊天 LLM 与 TTS 的 Base URL、模型和 API Key 互不共用。
- 渲染进程启用了上下文隔离、沙箱、CSP，并通过白名单 IPC 与主进程通信。
- 记忆内容和人格复盘对话在模型提示中被明确标记为数据而不是指令，降低提示注入风险。

更细的模块职责和心跳流程见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。
