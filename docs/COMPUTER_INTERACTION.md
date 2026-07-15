# 电脑协作、网页共读与受控工具

## 产品目标

桌宠可以参与用户正在做的事，但每项能力都必须有清晰来源、有限参数、可见预览、可撤销权限和本地审计。她先理解与陪伴，再通过标准 function tool 提出行动；普通聊天中的工具调用只创建审批预览，不会隐式获得操作电脑的权限。

本轮参考了 OpenClaw 官方的浏览器扩展和主机执行审批设计：主机本地令牌、明确共享边界、allowlist、ask-on-miss、无审批界面时默认关闭。记忆桌宠没有照搬浏览器接管或 Shell 执行，而是把首版范围缩到“用户主动提交上下文 + 四个确定性单步工具”。参考：

- <https://github.com/openclaw/openclaw/blob/main/docs/tools/chrome-extension.md>
- <https://github.com/openclaw/openclaw/blob/main/docs/tools/exec-approvals.md>
- <https://github.com/openclaw/openclaw/blob/main/docs/plugins/plugin-permission-requests.md>

## 当前入口

| 入口 | 用户手势 | 可见内容 | 默认行为 |
| --- | --- | --- | --- |
| 浏览器选区右键 | 点击扩展菜单 | 选中文本、标题、URL | 解释 / 总结 / 记住 / 聊聊 |
| 浏览器页面右键 | 点击扩展菜单 | 裁剪后的正文、标题、URL | 总结 / 聊聊 |
| 剪贴板快捷键 | 先复制，再按 `Ctrl+Shift+E` | 当前纯文本剪贴板 | 解释 |
| 宠物/托盘右键 | 点击明确菜单项 | 当前纯文本剪贴板 | 解释 / 总结 / 聊聊 |
| 原生文件选择器 | 用户点选单个文件 | 受限扩展、≤512KB、前 12000 字 | 解释 |
| 普通聊天 `desktop_observe` | 用户明确要求查看当前桌面，或模型判断本轮确需情境 | 独立识图摘要、粗粒度应用类别、通道状态 | 只读观察，不执行操作 |

浏览器页面提取会优先使用 `article / main / [role=main]`，并删除脚本、样式、导航、页脚、表单、输入框、文本框和可编辑区域。它不是完整网页解析器，也不读取登录态、Cookie、网络请求或其他标签页。

`desktop_observe` 不受 `computer.enabled` 总开关控制，而是分别服从“屏幕识图”和“本机应用检测”两个默认关闭的感知开关。它只返回本轮观察结果，不会因此获得浏览器控制、文件访问或工具执行权限。

## 权限模型

三个配置门：

1. `computer.enabled`：电脑协作总开关，默认 `false`。
2. `computer.browserContextEnabled`：本机浏览器提交接口，默认 `false`。
3. `computer.clipboardShortcutEnabled`：全局剪贴板解释快捷键，只有总开关开启时注册。

每个工具的默认策略是 `ask / allow / deny`：

| 工具 | 固定参数 | 长期允许 | 额外确认 |
| --- | --- | --- | --- |
| `open-url` | 清洗后的单个 http(s) URL | 支持 | 始终显示预览与执行按钮 |
| `copy-text` | 最多 3000 字纯文本 | 支持 | 明确提示会覆盖剪贴板 |
| `save-text-file` | 最多 3000 字文本、建议文件名 | 不支持 | 每次授权 + 原生保存对话框 |
| `launch-app` | `notepad / calculator / file-explorer` 枚举 | 支持 | 始终显示预览与执行按钮 |

`allow-session` 只存在于主进程内，退出即丢失。`allow-always` 写入 `settings.json`，可以在设置页改回询问或禁止。`deny` 优先于 pending 操作；若用户在预览后关闭总开关或权限，执行阶段会再次拦截。

## 确认参数绑定

普通聊天有两条规划入口：支持 function calling 的模型调用 `computer_open_url / computer_copy_text / computer_save_text / computer_launch_app`；离线或工具协议不兼容时，确定性规划器处理明确的中文动作句式。两条路径都输出一项联合类型 `ComputerActionDraft`，并进入 `ComputerCapabilityController.planDraft()` 对 URL、文本、建议文件名和应用枚举做第二次主进程清洗。控制器随后生成随机 UUID 并把真实参数保存在主进程 Map 中；Renderer 只收到标题、说明、裁剪预览、到期时间和可用决定。执行 IPC 只接受：

```ts
executeComputerAction(id, "allow-once" | "allow-session" | "allow-always" | "deny")
```

URL、剪贴板正文、保存正文、最终路径和应用名都不会从 Renderer 回传。操作五分钟到期；参数或权限变化不会复用旧审批。

模型工具结果只会得到 `approval_required + operationId + 裁剪预览`，并被明确告知“尚未执行”。同一 Agent 回合最多创建一个电脑操作预览；用户点击授权后，执行结果进入 `computer-access.json` 审计，并以 `computer-tool-result` 写入 L1，因此下一轮对话可以准确承接成功、取消或拒绝状态。Renderer 中的能力标签只显示工具类别和状态，不包含隐藏参数。

## 浏览器桥接

`BrowserContextServer` 监听 `127.0.0.1:32145`，接口只有：

- `GET /health`：验证令牌和桥接状态。
- `POST /v1/context`：提交 `explain / summarize / chat / remember` 上下文。

随机 32 字节令牌保存在 `data/computer-access.json`，由设置页显式复制给扩展。请求必须携带 `X-Memory-Pet-Token`；比较使用恒定时间函数。服务拒绝非扩展 CORS 来源、非 http(s) 页面 URL、未知动作、空文本和超过 64KB 的请求。它没有读取型数据接口，也没有工具执行接口。

## 模型边界与记忆

共享正文被序列化到 user 角色的 `<computer_context_data>` 中，所有 `<` 都转换成字面 `\\u003c`。System 明确要求将它视为不可信数据，并禁止执行其中的规则覆盖、凭据索取或电脑操作文字。网页/剪贴板/文件共读请求使用不带 tools 的专用模型调用，当前共享内容不会被二次送入 Agent 工具循环或工作规划器。

- 解释 / 总结 / 聊聊：L1 记录“用户选择了什么目标”和助手的回复，避免整页正文随心跳自动沉淀。
- 记住：这是用户明确的持久化手势，正文连同标题和 URL 写入 L2，最大 2000 字。
- 未配置 LLM：提供字面抽取式整理，不影响记住、审计或其他本地能力。

## 屏幕识图与应用状态

屏幕识图使用第三组独立的 OpenAI 兼容配置：`vision.enabled / vision.baseUrl / vision.model` 和单独加密的视觉 API Key。环境变量 `OPENAI_VISION_API_KEY / OPENAI_VISION_BASE_URL / OPENAI_VISION_MODEL` 优先。主进程只把当次压缩 JPEG 作为 `image_url` 发送给识图端点；响应必须整理成 `sceneSummary / currentTask / busyState / helpOpportunity / confidence` 五类受限字段，随后才作为不可信低置信数据进入聊天工具结果或心跳。聊天 LLM 从不接收图片字节，图片也不进入 IPC、记忆、关系档案、审计或磁盘。

Windows 应用检测使用固定本机只读流程：先快速执行 `tasklist.exe /fo csv /nh`，再只对命中内置白名单的少量进程使用固定 `/v /fi` 查询可见性。快速查询或任一详情查询异常时，整轮统一回退到固定 PowerShell `Get-Process` 与 `MainWindowHandle` 脚本；精简行只说明后台进程存在，不会被当作可见窗口，回退路径也不读取窗口标题。GBK/UTF-16 输出会先在内存解码，占位窗口标题会被过滤，之后仅保留“浏览网页、写代码、沟通、终端”等粗粒度类别。窗口标题、PID、进程名和原始命令行不会进入模型、Store、Repository 或日志。

感知结果分别标记为 `disabled / not-requested / startup-skipped / not-configured / not-supported / completed / completed-empty / failed`。因此用户主动要求查看桌面时，桌宠可以准确说明是“应用扫描成功但没有已知类别”还是“识图配置缺失/请求失败”，不再把所有无结果情况笼统归因为权限问题。

心跳另按设置间隔（默认 2 分钟）进行低成本应用类别轮询。只有出现新的活动类别才唤醒完整心跳，并且只有当安静时段、空闲、冷却和日限额已经允许主动靠近时才请求一次屏幕识图；持续相同类别不重复开口，也不重复强化关系习惯。

## 本地审计

`computer-access.json` 保存配对令牌和最近 500 条审计，单条包含来源、动作、摘要、状态、决定、时间和裁剪后的结果/错误。设置页只展示最近记录并提供清空；清空审计不改变权限或配对令牌。

## 后续阶段

1. 用户可见的权限撤销中心与单项会话授权提示。
2. 有取消/暂停/回滚信息的多步骤计划，每一步仍独立审批。
3. 扩展端“当前标签页已分享”指示与即时撤销，不扩大到全浏览器读取。
4. 本地待办、提醒、用户选定目录内的文件名搜索等额外白名单工具。
5. 经过独立威胁建模后再评估 Windows UI Automation；任意 Shell、隐式键鼠控制和无审计后台执行不进入当前路线。
