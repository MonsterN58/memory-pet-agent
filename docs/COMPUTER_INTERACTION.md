# 电脑协作、网页共读与受控工具

## 产品目标

桌宠可以参与用户正在做的事，但每项能力都必须有清晰来源、有限参数、可见预览、可撤销权限和本地审计。她先理解与陪伴，再通过标准 function tool 提出行动；普通聊天中的工具调用只创建审批预览，不会隐式获得操作电脑的权限。连续工作也只在现有白名单内编排 2～4 个固定步骤，不形成开放式自治循环。

本轮参考了 OpenClaw 官方的浏览器扩展和主机执行审批设计：主机本地令牌、明确共享边界、allowlist、ask-on-miss、无审批界面时默认关闭。记忆桌宠没有照搬浏览器接管或 Shell 执行，而是把范围限定为“用户主动提交上下文 + 已审批的固定动作 + 最多四步的顺序计划”。参考：

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
| 浏览器操作卡 | 用户在桌宠中确认，扩展开启操作接收 | 当前活动 http(s) 标签页 | 刷新 / 前进后退 / 上下滚动 / 顶部底部 / 页内查找 |
| Office 操作卡 | 用户在桌宠中确认 | 当前已打开且可编辑的 Office 文档 | Word 追加 / Excel 文本表格 / PowerPoint 新增文本页 |
| 协作计划卡 | 用户逐步确认 | 2～4 个已经固定参数的上述白名单动作 | 当前步完成后显示下一步；拒绝/取消/失败停止后续 |

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
| `browser-control` | `reload / go-back / go-forward / scroll-up / scroll-down / scroll-top / scroll-bottom / find-text` 枚举与最多 200 字查找词 | 不支持 | 每次授权；扩展侧还需显式开启接收 |
| `office-write` | Word 文本、Excel A1 + TSV、PowerPoint 标题 + 正文 | 不支持 | 每次授权；只连接当前已打开文档且不自动保存 |

`allow-session` 只存在于主进程内，退出即丢失。`allow-always` 写入 `settings.json`，可以在设置页改回询问或禁止。`deny` 优先于 pending 操作；若用户在预览后关闭总开关或权限，执行阶段会再次拦截。

## 确认参数绑定

普通聊天有两条规划入口：支持 function calling 的模型调用十五项稳定工具，其中单步能力使用对应 `computer_*`，连续工作使用 `computer_work_plan`；离线或工具协议不兼容时，确定性规划器处理明确的中文单句或复合句。当前工具除网页、剪贴板、保存和白名单应用外，还包括浏览器当前页控制、Word 追加、Excel TSV 写入与 PowerPoint 新增文本页。单步路径输出联合类型 `ComputerActionDraft` 并进入 `ComputerCapabilityController.planDraft()`；计划路径先解析 2～4 个同类草稿，再进入 `planDrafts()`。主进程会再次清洗 URL、文本、文件名、枚举、A1 单元格和 Office 内容，并在生成任何计划卡片前检查全部步骤的开关与权限。控制器随后生成随机 UUID 并把真实参数保存在主进程 Map 中；Renderer 只收到标题、说明、裁剪预览、到期时间、计划序号和可用决定。执行 IPC 只接受：

```ts
executeComputerAction(id, "allow-once" | "allow-session" | "allow-always" | "deny")
```

URL、正文、浏览器动作、Office 目标和最终路径都不会从 Renderer 回传。操作五分钟到期；参数或权限变化不会复用旧审批。

模型工具结果只会得到 `approval_required + operationId + 裁剪预览`；计划还会得到随机 `planId` 和 2～4 个步骤序号，并被明确告知“尚未执行”。同一 Agent 回合最多创建一个单步操作或一个协作计划；用户点击授权后，执行结果进入 `computer-access.json` 审计，并以 `computer-tool-result` 写入 L1，因此下一轮对话可以准确承接成功、取消或拒绝状态。Renderer 中的能力标签只显示工具类别和状态，不包含隐藏参数。

## 2～4 步顺序计划

`computer_work_plan` 只接受 `open-url / copy-text / save-text-file / launch-app`、八类浏览器动作和三类 Office 写入所组成的 2～4 个步骤。模型提交的 schema 与本机 `computer-work-plan.ts` 解析器使用相同枚举；参数仍逐项经过主进程清洗，不因放入计划而扩大能力。

没有工具协议时，`planComputerActions()` 会把含“然后 / 接着 / 随后 / 再”或分号的明确复合句切成 2～4 段。只有每一段都能独立匹配白名单动作时才形成计划；包含未知段落时整句不生成部分计划。例如：

```text
打开 https://example.com，然后向下滚动网页，再在当前网页查找：安装
```

计划创建时先校验全部步骤，再用一次原子审计写入创建同组计划 ID 和各自不可变的操作 UUID；落盘失败不会留下 Renderer 不知道的孤立 pending。Renderer 一次只展示当前步骤，主进程也拒绝越序 ID，并在开始外部操作前消费当前 ID，保证重复点击或并发 IPC 不会执行两次；当前结果为 `completed` 才开放下一步。审批队列使用 revision ticket 隔离被新计划替换后的迟到异步结果，旧请求结束时不会清空或推进新计划。用户选择“不做”、取消原生保存窗口、浏览器/Office 返回失败、权限在执行前关闭、IPC 异常或预览过期时，主进程会撤销余下 pending 并写为自动取消，而不是伪装成逐项“用户拒绝”。已经完成的外部操作保持原结果，计划没有自动撤回或补偿执行；当前也没有暂停后后台继续、条件分支或循环。

## 浏览器桥接

`BrowserContextServer` 监听 `127.0.0.1:32145`，接口为：

- `GET /health`：验证令牌和桥接状态。
- `POST /v1/context`：提交 `explain / summarize / chat / remember` 上下文。
- `GET /v1/commands/poll`：扩展长轮询领取一项已经在桌宠中批准的固定命令。
- `POST /v1/commands/result`：一次性回传对应命令的成功或失败结果。

随机 32 字节令牌保存在 `data/computer-access.json`，由设置页显式复制给扩展。请求必须携带 `X-Memory-Pet-Token`；比较使用恒定时间函数。服务拒绝非扩展 CORS 来源、非 http(s) 页面 URL、未知动作、空文本和超过边界的请求。命令使用一次性 UUID，队列最多 8 项，45 秒过期，结果只能提交一次；长轮询在响应完整写出前断开时会把命令重新排回队首，桥接并发启动也只保留一个受控生命周期。扩展默认关闭命令接收，开启后只执行固定脚本中的刷新、前进/后退、向上/下滚动、滚到顶部/底部和页内查找，不接受脚本源码、CSS 选择器或通用点击。顺序计划中的浏览器步骤仍是一项一项投递。桥接没有记忆、设置、文件或网页数据读取接口。

## Office 桌面交互

`OfficeAutomationService` 仅在 Windows 上通过固定 PowerShell COM 脚本连接当前已运行的 Microsoft Word、Excel 或 PowerPoint。用户内容不拼接进命令行或脚本，而是作为 Base64(JSON) 从标准输入传入；服务不主动调用宏、不打开任意路径，也不自动保存。Excel 写入期间会临时关闭并恢复 `Application.EnableEvents`；Word/PowerPoint 的已有文档事件仍可能由 Office 自身响应，因此审批预览不会承诺“任何宏都不会触发”。

- Word：向当前活动文档末尾追加最多 20000 字纯文本。
- Excel：从经校验的 A1 单元格开始写入 TSV 或二维纯文本；最多 200 行、50 列、2000 个单元格，并把目标区域设为文本格式。
- PowerPoint：在当前演示文稿末尾添加一页标题与正文布局。

Office 未安装、未运行、没有活动文档、应用正忙或执行超时时，结果会以明确错误返回操作卡和本地审计。自动化只完成内存中的编辑，最终保存仍由用户在 Office 中决定。

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
2. 在现有 2～4 步顺序计划上增加整组显式取消、暂停和更完整的进度历史；已完成外部动作仍保持原结果。
3. 更明确的当前标签页临时授权指示与即时撤销，不扩大到全浏览器读取。
4. 本地待办、提醒、用户选定目录内的文件名搜索等额外白名单工具。
5. 经过独立威胁建模后再评估更多 Windows UI Automation；任意 Shell、隐式通用键鼠控制和无审计后台执行不进入当前路线。
