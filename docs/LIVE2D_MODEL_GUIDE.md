# Live2D Cubism 模型导入指南

桌宠使用 PixiJS 8、`untitled-pixi-live2d-engine` 和官方 Cubism Core 5.1 渲染 Cubism 3/4/5 `.moc3` 模型。用户不需要修改源码：右键宠物选择“模型与动作 → 导入 Live2D 模型…”，或进入“桌宠设置 → Live2D 模型与动作”，选择模型所在的整个文件夹即可。导入成功后立即热切换；加载失败时保留当前模型，首次启动失败时保留轻量后备模型，三级记忆、心跳、语音和桌面移动不受影响。

## 1. 内置模型

项目当前内置 9 套模型。官方样例来自
[Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples/tree/develop)，
第三方模型保留完整来源、署名、许可证和本地修改说明：

| 模型 | 来源 | motion / 表情 | 口型 | 低置信初始气质 |
| --- | --- | ---: | --- | --- |
| Hiyori | Live2D 官方样例 | 10 / 0 | `ParamMouthOpenY` | 温柔好奇 |
| Mao | Live2D 官方样例 | 8 / 8 | 自定义 `ParamA` | 活泼爱玩 |
| Wanko | Live2D 官方宠物样例 | 12 / 0 | 旧式嘴部参数 | 热情直率 |
| Haru | Live2D 官方样例 | 6 / 8 | `ParamMouthOpenY` | 开朗细腻 |
| Mark | Live2D 官方卡通样例 | 6 / 0 | 本地补全标准口型组 | 安静稳重 |
| Nana | 第三方 CC BY-SA 4.0 | 0 / 0 | 运行时按真实参数探测 | 清醒温和 |
| Rice | Live2D 官方样例 | 4 / 0 | 原模型无嘴部参数 | 认真慢热 |
| Cyannyan | 第三方 CC BY-SA 4.0，2048px Web 版 | 0 / 16 | `ParamMouthOpenY` | 俏皮机敏 |
| 小云 | 第三方 CC BY-NC-SA 4.0 | 0 / 18 | 本地补全标准口型组 | 软萌主动 |

右键菜单和设置面板都从同一注册表动态列出这 9 套模型。切换身体只改变渲染模型和“证据不足时”的表达起点，不清空三级记忆、关系档案或已形成的人格；真实互动证据达到门槛后会逐维覆盖初始气质。

本轮官方资源固定审计提交为
`b1de66b0b1f1cb881d95fb6158622aeb6a2827bd`。Natori 因逐模型协作角色条款未内置；其他候选若为 moc3 v6 也不纳入当前 Core 5.1 的兼容模型集。Haru 的样例声音没有复制，避免授权歧义和动作音频覆盖 TTS。Nana、Cyannyan 与小云的固定来源、修改说明和许可证见各自模型目录及根目录 `THIRD_PARTY_NOTICES.md`。

## 2. 准备模型文件夹

所选目录必须且只能包含一个 `.model3.json`。该设置文件必须是 `Version: 3`，并至少引用：

- 一个 `.moc3`；
- 一至八张 PNG、JPEG 或 WebP 贴图。

以下引用是可选的，导入器会在存在时一起校验和复制：

- `Physics`：`.physics3.json`；
- `Pose`：`.pose3.json`；
- `UserData`：`.userdata3.json`；
- `DisplayInfo`：`.cdi3.json`；
- `Motions`：`.motion3.json` 及其 WAV、MP3、OGG 音频；
- `Expressions`：`.exp3.json`。

示例：

```text
StarCat/
  StarCat.model3.json
  StarCat.moc3
  StarCat.physics3.json
  textures/
    texture_00.png
  motions/
    idle.motion3.json
    wave.motion3.json
```

请选择最外层的 `StarCat` 文件夹，不要只选 `.model3.json`。模型名默认取文件夹名。导入后所需文件复制到 `data/models/imported/<模型 ID>/`，之后移动或删除原始目录不会影响桌宠。

`model3.json` 的 `Version: 3` 是设置文件格式版本，不等于 Cubism Editor 3。当前官方 Core 为 5.1，目标是兼容 Cubism 3、4、5 生成的 moc3；内置资源回归会检查二进制文件头为 `MOC3` 且版本字节不高于 5。Cubism Core 6/v6 新增的数据能力不在当前渲染引擎的保证范围内，遇到不兼容时应从原工程导出 Cubism 5 兼容 moc3，而不是手改 JSON。

## 3. motion、口型和动作组织

推荐至少提供循环待机组：

- `Idle`：一条或多条循环待机，桌宠会随机选择；
- `TapBody`、`Tap`、`Touch` 或 `Action`：可选交互资源；导入器会校验并复制，但当前通用导入模型不会猜测每条 motion 的语义。

桌宠公开 18 个稳定语义动作。Hiyori、Mao、Wanko 继续使用完整的已验证映射；Haru、Mark、Rice 只把视觉语义合理的动作绑定到真实 motion，其余动作走程序化反馈，避免拿同一条素材冒充所有动作。Nana、Cyannyan、小云和没有 motion 的用户模型全部走程序化动作。18 个手动按钮以及导演或 `pet_action` 选中的动作因此始终有可见结果。程序化动作统一使用平滑进入/退出的全身变形，并只向 moc 中真实存在的标准/旧式眼睛、头身与耳朵参数叠加姿态：

| 桌宠语义 | 程序化兜底 |
| --- | --- |
| `wave` | 左右轻摆 |
| `nod` | 纵向点头 |
| `shake-head` | 左右摇头 |
| `head-tilt` | 歪头停留 |
| `jump` | 向上跳起 |
| `cheer` | 弹跳并放大 |
| `dance` | 左右位移和旋转 |
| `sit` | 下沉并压低身体 |
| `stretch` | 纵向伸展 |
| `shy` | 轻微缩小和侧倾 |
| `comfort` | 缓慢轻摆 |
| `sleep` | 下沉、收拢并停留 |
| `surprised` | 快速上移和放大 |
| `bow` | 身体下沉压缩，头身向前俯下 |
| `applaud` | 多次轻弹、左右节奏摆动 |
| `peek` | 向一侧探身并把视线、头部转向目标 |
| `ponder` | 轻微下沉歪头，视线偏向一侧上方 |
| `present` | 向一侧让出空间并转头展示结果 |

内置一次性动作由适配器强制按非循环方式播放，并沿 `model3.json` 引用读取实际 `.motion3.json` 的 `Meta.Duration`，限制在 600～12,000ms 后恢复 `Idle`，不会再被统一短计时器提前截断。程序化兜底使用每项固定的 0.9～3.5 秒时长，起点和终点都精确回到中性姿态，避免坐下、睡觉、歪头等保持型动作结束时跳变。桌面上的真实行走、拖动、下落和约 320ms 落地由 Electron 窗口与连续运动帧控制，不要在 motion 内持续平移整个模型。

口型优先使用 `Groups` 中 `Name: "LipSync"` 声明的全部真实参数；声明缺失时，适配器只会在 moc 中确实存在 `ParamMouthOpenY` 或旧式 `PARAM_MOUTH_OPEN_Y` 时安全兜底，不会虚构参数。Rice 原模型没有嘴部参数，因此发言时使用光效和轻微身体脉冲。`EyeBlink` 组和 Physics 由 Runtime 自动处理；主进程持续提供桌面全局鼠标位置，所以窗口失焦、启用鼠标穿透或自主移动时仍可驱动视线。

Haru、Mao、Cyannyan 和小云还使用按模型校验的情绪到 expression 映射；没有 expression 的模型继续通过眼球、头身姿态、程序动作和光效表达情绪。Cyannyan 的本地适配只新增一个空参数的 Neutral expression，用于让上一个表情平滑恢复。

## 4. 全局视线与参数兼容

正式 Electron 页面只接受主进程发送的桌面全局鼠标位置，Live2D Adapter 不再监听窗口内 `pointermove`。焦点以模型视觉中心为原点，水平 640px、垂直 480px 映射到 `[-1,1]`，再使用阻尼避免窗口移动或跨屏时跳变。

模型加载后会枚举 moc 中真实存在的参数索引，只绑定以下别名：

- 标准眼球：`ParamEyeBallX`、`ParamEyeBallY`；
- 标准头身：`ParamAngleX/Y/Z`、`ParamBodyAngleX/Y/Z`；
- 旧式头身：`PARAM_ANGLE_X/Y/Z`、`PARAM_BODY_ANGLE_X/Y/Z`；
- 旧式辅助：`PARAM_EAR_L`、`PARAM_EAR_R`。

写入使用真实索引和模型参数上下界，不会为缺失名称创建虚拟参数。只有部分参数也可正常工作；没有眼球 XY 时会提高头部与身体幅度，Wanko 一类模型还会让左右耳朵产生轻微反向偏移。自定义模型若希望获得最自然的视线，优先提供标准眼球和头部参数；这不是导入成功的硬性要求。

## 5. 自动取景与美术建议

- 模型会按当前不透明网格的真实可见边界自动居中并贴近窗口底部，隐藏在远处的辅助网格不会把本体缩得过小。
- 左右漫游时模型会水平翻转；美术默认朝向不受限制，但动作最好能接受镜像。
- 建议使用透明背景、轮廓清晰的全身或宠物模型，动作范围尽量稳定。
- 320×460 桌宠窗口中，Q 版人物或矮小宠物通常比写实长身人物更醒目。
- 2D 网格统一关闭背面剔除，以兼容早期 moc3 的 winding/culling 标记。
- 当前没有用户缩放、expression 选择、历史导入模型库和删除 UI；重新导入会切换到新模型，旧副本仍保留在数据目录。
- 小云上游使用 8192px 贴图，单文件仍低于 16MB 导入边界，但激活时显存占用会高于 2048px 模型；加载失败仍保持当前模型，不影响 Agent、记忆或语音。

## 6. 导入安全限制

模型只能由主进程通过原生目录选择器读取：

- 目录最多 240 个普通文件、8 层子目录；
- `.model3.json` 最大 2MB，其他 JSON 最大 4MB；
- `.moc3` 最大 24MB；
- 每张贴图和每个音频最大 16MB；
- 最多 8 张贴图，所有引用资源合计最大 64MB；
- 拒绝绝对路径、盘符、`..`、目录外资源、缺失引用和符号链接；
- Renderer 只获得已校验资源的 base64 包，不获得任意本地路径或 Node 文件系统权限。

## 7. 常见问题

**导入器提示必须且只能有一个 model3.json**：把模型自身资源放在独立目录，不要一次选择包含多套模型的上级目录。

**导入成功但提示加载失败并保留当前模型**：通常是 moc3 超出 Core 5.1 支持范围、贴图无法被 Chromium 解码，或 JSON 内容由新版本工具生成但没有向后兼容。先在 Cubism Viewer for OW 中验证，再从原工程导出 Cubism 5 兼容资源。

**导入模型的动作按钮没有播放我制作的 motion**：当前通用导入流程不会根据文件名猜测 18 项语义，避免把不相关或破坏性 motion 当成动作。模型仍会显示对应的平滑全身/参数程序化反馈；内置模型只使用经过逐条校验的资源映射。后续可增加用户可编辑的语义绑定 UI。

**眼睛不动但头部会动**：模型可能没有 `ParamEyeBallX/Y`。适配器会自动回退到头身或旧式耳朵参数；如果需要独立眼球跟随，请在原工程中添加标准眼球参数后重新导出。

**说话时没有口型**：检查 `Groups` 是否包含 `LipSync`，以及 `Ids` 是否与模型参数 ID 完全一致。只在 motion 中写嘴部曲线不会自动成为实时口型参数。

**模型太大、太小或被裁切**：适配器按当前不透明网格自动取景。检查是否有始终不透明但远离本体的装饰网格，或动作是否把本体移出正常范围。

**如何换回其他内置模型**：在右键菜单直接选择任一内置身体，或在设置面板选择后应用。切换不会删除已经导入的数据，也不会重置人格和关系。

## 8. 开发接口与许可

- [`ModelStore`](../src/main/model-store.ts) 负责校验、复制、持久化当前选择和生成受限资源包。
- [`live2d-interaction`](../src/renderer/live2d-interaction.ts) 提供真实参数绑定、连续变形、语义映射、资源时长解析和程序化动作的纯逻辑。
- [`Live2DPetAdapter`](../src/renderer/live2d-pet-adapter.ts) 负责 Cubism Runtime、逐帧参数写入、弹簧状态、动作播放、自动取景、口型、物理、翻转和资源释放。
- [`PetModelAdapter`](../src/renderer/model-adapter.ts) 是稳定语义边界，Agent、记忆、心跳和桌面移动不依赖 Live2D 专有 API。

Cubism Core、Cubism SDK 组件和官方样例模型分别受 Live2D Proprietary Software License、Live2D Open Software License、Free Material License 与逐模型条款约束。Nana 与 Cyannyan 的适配模型资源继续使用 CC BY-SA 4.0；小云的适配模型资源继续使用 CC BY-NC-SA 4.0，禁止商用。商业发行前必须根据主体收入、用途、可扩展模型导入能力和第三方模型条款重新审计发布许可。详情见项目根目录的 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)、[`BUNDLED_MODEL_SOURCES.md`](../src/renderer/public/live2d/BUNDLED_MODEL_SOURCES.md) 及模型目录内许可文件。
