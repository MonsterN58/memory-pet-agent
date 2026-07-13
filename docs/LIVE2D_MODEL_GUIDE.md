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

推荐至少提供两个动作组：

- `Idle`：一条或多条循环待机，桌宠会随机选择；
- `TapBody`：交互动作，桌宠按索引映射到挥手、跳跃、跳舞、坐下、睡觉、惊讶。

`TapBody` 也可命名为 `Tap`、`Touch` 或 `Action`，匹配时不区分大小写。推荐顺序如下：

| 索引 | 桌宠语义 | 推荐内容 |
| ---: | --- | --- |
| 0 | `wave` | 挥手或打招呼 |
| 1 | `jump` | 跳跃或兴奋动作 |
| 2 | `dance` | 跳舞或较长动作 |
| 3 | `sit` | 坐下或安静动作 |
| 4 | `sleep` | 睡觉或闭眼动作 |
| 5 | `surprised` | 惊讶或受击反应 |

动作数少于六个时会循环取用已有 motion；完全没有交互 motion 时仍会播放程序化位移、旋转或缩放反馈。一次性动作由适配器强制按非循环方式播放，并在语义时长结束后恢复 `Idle`，因此导出的交互 motion 即使误带 `Loop: true` 也不会永久占用待机。桌面上的真实行走、拖动和下落由 Electron 窗口控制，不要在 motion 内持续平移整个模型。

口型参数必须在 `Groups` 中以 `Name: "LipSync"` 声明。适配器会驱动其中全部参数，因此可使用 `ParamMouthOpenY`，也可像 Mao 一样使用自定义 ID。`EyeBlink` 组和 Physics 由 Runtime 自动处理；主进程持续提供桌面全局鼠标位置，所以窗口失焦、启用鼠标穿透或自主移动时仍可驱动视线。

## 4. 自动取景与美术建议

- 模型会按当前不透明网格的真实可见边界自动居中并贴近窗口底部，隐藏在远处的辅助网格不会把本体缩得过小。
- 左右漫游时模型会水平翻转；美术默认朝向不受限制，但动作最好能接受镜像。
- 建议使用透明背景、轮廓清晰的全身或宠物模型，动作范围尽量稳定。
- 320×460 桌宠窗口中，Q 版人物或矮小宠物通常比写实长身人物更醒目。
- 2D 网格统一关闭背面剔除，以兼容早期 moc3 的 winding/culling 标记。
- 当前没有用户缩放、expression 选择、历史导入模型库和删除 UI；重新导入会切换到新模型，旧副本仍保留在数据目录。

## 5. 导入安全限制

模型只能由主进程通过原生目录选择器读取：

- 目录最多 240 个普通文件、8 层子目录；
- `.model3.json` 最大 2MB，其他 JSON 最大 4MB；
- `.moc3` 最大 24MB；
- 每张贴图和每个音频最大 16MB；
- 最多 8 张贴图，所有引用资源合计最大 64MB；
- 拒绝绝对路径、盘符、`..`、目录外资源、缺失引用和符号链接；
- Renderer 只获得已校验资源的 base64 包，不获得任意本地路径或 Node 文件系统权限。

## 6. 常见问题

**导入器提示必须且只能有一个 model3.json**：把模型自身资源放在独立目录，不要一次选择包含多套模型的上级目录。

**导入成功但提示加载失败并保留当前模型**：通常是 moc3 超出 Core 5.1 支持范围、贴图无法被 Chromium 解码，或 JSON 内容由新版本工具生成但没有向后兼容。先在 Cubism Viewer for OW 中验证，再从原工程导出 Cubism 5 兼容资源。

**动作按钮看起来重复**：`TapBody` 数量少于六个时会循环映射。按上表补足六条 motion 即可获得各不相同的动作。

**说话时没有口型**：检查 `Groups` 是否包含 `LipSync`，以及 `Ids` 是否与模型参数 ID 完全一致。只在 motion 中写嘴部曲线不会自动成为实时口型参数。

**模型太大、太小或被裁切**：适配器按当前不透明网格自动取景。检查是否有始终不透明但远离本体的装饰网格，或动作是否把本体移出正常范围。

**如何换回官方模型**：在右键菜单直接选择 Hiyori、Mao 或 Wanko，或在设置面板选择后应用。切换不会删除已经导入的数据。

## 7. 开发接口与许可

- [`ModelStore`](../src/main/model-store.ts) 负责校验、复制、持久化当前选择和生成受限资源包。
- [`Live2DPetAdapter`](../src/renderer/live2d-pet-adapter.ts) 负责 Cubism Runtime、动作映射、自动取景、口型、物理、翻转和资源释放。
- [`PetModelAdapter`](../src/renderer/model-adapter.ts) 是稳定语义边界，Agent、记忆、心跳和桌面移动不依赖 Live2D 专有 API。

Cubism Core、Cubism SDK 组件和官方样例模型分别受 Live2D Proprietary Software License、Live2D Open Software License、Free Material License 与单模型条款约束。商业发行前必须根据主体收入和用途确认是否需要 Cubism SDK Release License。详情见项目根目录的 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) 及模型目录内的官方许可文件。
