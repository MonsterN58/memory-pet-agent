# Live2D Cubism 模型导入指南

桌宠使用 PixiJS 8、`untitled-pixi-live2d-engine` 和官方 Cubism Core 5.1 渲染 Cubism 3/4/5 `.moc3` 模型。用户不需要修改源码：右键宠物选择“模型与动作 → 导入 Live2D 模型…”，或进入“桌宠设置 → Live2D 模型与动作”，选择模型所在的整个文件夹即可。导入成功后立即热切换；加载失败时保留当前模型，首次启动失败时保留轻量后备模型，三级记忆、心跳、语音和桌面移动不受影响。

## 1. 内置官方样例

项目从 [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples/tree/develop) 的 `develop` 分支内置以下模型：

| 模型 | 形态 | motion 数 | 特点 |
| --- | --- | ---: | --- |
| Hiyori | 全身人物 | 10 | 默认模型，标准 `ParamMouthOpenY` 口型 |
| Mao | 全身人物 | 8 | 魔法师造型，使用自定义 `ParamA` 口型 |
| Wanko | 宠物 | 12 | 矮小宠物轮廓，含 6 条 touch 与 2 条 shake |

右键菜单和设置面板都可切换这三套模型。它们随安装包分发，并保留仓库的 LICENSE、NOTICE 和模型条款提示。

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

`model3.json` 的 `Version: 3` 是设置文件格式版本，不等于 Cubism Editor 3。当前官方 Core 为 5.1，目标是兼容 Cubism 3、4、5 生成的 moc3；Cubism Core 6 新增的数据能力不在当前渲染引擎的保证范围内，遇到不兼容时应从原工程导出 Cubism 5 兼容 moc3，而不是手改 JSON。

## 3. motion、口型和动作组织

推荐至少提供循环待机组：

- `Idle`：一条或多条循环待机，桌宠会随机选择；
- `TapBody`、`Tap`、`Touch` 或 `Action`：可选交互资源；导入器会校验并复制，但当前通用导入模型不会猜测每条 motion 的语义。

桌宠公开 13 个稳定语义动作。三套内置模型使用明确的 group/index 映射；用户导入模型在没有经过明确语义映射时使用以下程序化反馈，因此 13 个手动按钮以及实际被导演选中的自动动作仍有可见结果。情绪本身是否改变表情，取决于模型的 expression 或参数映射：

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

内置一次性动作由适配器强制按非循环方式播放，并沿 `model3.json` 引用读取实际 `.motion3.json` 的 `Meta.Duration`，限制在 600～12,000ms 后恢复 `Idle`，不会再被统一短计时器提前截断。程序化兜底使用每项固定的 0.9～3.5 秒时长。桌面上的真实行走、拖动、下落和约 320ms 落地由 Electron 窗口与连续运动帧控制，不要在 motion 内持续平移整个模型。

口型参数必须在 `Groups` 中以 `Name: "LipSync"` 声明。适配器会驱动其中全部参数，因此可使用 `ParamMouthOpenY`，也可像 Mao 一样使用自定义 ID。`EyeBlink` 组和 Physics 由 Runtime 自动处理；主进程持续提供桌面全局鼠标位置，所以窗口失焦、启用鼠标穿透或自主移动时仍可驱动视线。

## 4. 全局视线与参数兼容

正式 Electron 页面只接受主进程发送的桌面全局鼠标位置，Live2D Adapter 不再监听窗口内 `pointermove`。焦点以模型视觉中心为原点，水平 640px、垂直 480px 映射到 `[-1,1]`，再使用阻尼避免窗口移动或跨屏时跳变。

模型加载后会枚举 moc 中真实存在的参数索引，只绑定以下别名：

- 标准眼球：`ParamEyeBallX`、`ParamEyeBallY`；
- 标准头身：`ParamAngleX/Y/Z`、`ParamBodyAngleX`；
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

**导入模型的动作按钮没有播放我制作的 motion**：当前通用导入流程不会根据文件名猜测 13 项语义，避免把不相关或破坏性 motion 当成动作。模型仍会显示对应程序化反馈；内置 Hiyori、Mao、Wanko 才使用经过验证的资源映射。后续可增加用户可编辑的语义绑定 UI。

**眼睛不动但头部会动**：模型可能没有 `ParamEyeBallX/Y`。适配器会自动回退到头身或旧式耳朵参数；如果需要独立眼球跟随，请在原工程中添加标准眼球参数后重新导出。

**说话时没有口型**：检查 `Groups` 是否包含 `LipSync`，以及 `Ids` 是否与模型参数 ID 完全一致。只在 motion 中写嘴部曲线不会自动成为实时口型参数。

**模型太大、太小或被裁切**：适配器按当前不透明网格自动取景。检查是否有始终不透明但远离本体的装饰网格，或动作是否把本体移出正常范围。

**如何换回官方模型**：在右键菜单直接选择 Hiyori、Mao 或 Wanko，或在设置面板选择后应用。切换不会删除已经导入的数据。

## 8. 开发接口与许可

- [`ModelStore`](../src/main/model-store.ts) 负责校验、复制、持久化当前选择和生成受限资源包。
- [`live2d-interaction`](../src/renderer/live2d-interaction.ts) 提供真实参数绑定、连续变形、语义映射、资源时长解析和程序化动作的纯逻辑。
- [`Live2DPetAdapter`](../src/renderer/live2d-pet-adapter.ts) 负责 Cubism Runtime、逐帧参数写入、弹簧状态、动作播放、自动取景、口型、物理、翻转和资源释放。
- [`PetModelAdapter`](../src/renderer/model-adapter.ts) 是稳定语义边界，Agent、记忆、心跳和桌面移动不依赖 Live2D 专有 API。

Cubism Core、Cubism SDK 组件和官方样例模型分别受 Live2D Proprietary Software License、Live2D Open Software License、Free Material License 与单模型条款约束。商业发行前必须根据主体收入和用途确认是否需要 Cubism SDK Release License。详情见项目根目录的 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) 及模型目录内的官方许可文件。
