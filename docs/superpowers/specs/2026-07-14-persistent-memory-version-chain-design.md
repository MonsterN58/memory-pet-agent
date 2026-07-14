# 持久化记忆版本链设计

## 背景

聊天已经能用显式“现在 / 以前 / 变化”线索过滤事实和偏好，但 L3 修正仍会原位覆盖内容。历史因此不可审计；而没有时态词的旧值与新值如果同时存在，仍可能一起进入提示、`memoryRefs` 和访问强化。

近期一手资料把这类问题单独归为 memory-update / supersession failure。Supersede 说明增大模型或记忆容量并不会自然解决旧值泄漏；Engram 与 Zep 的双时态设计都选择让旧事实失效而非删除，并保留来源与替代关系；MemConflict 进一步要求分别检查检索证据和最终回答。本轮把这些原则映射到现有本地 JSON Repository，不引入图数据库、Embedding 或新的模型调用。

## 方案取舍

1. 在单条记录内保存 revision 数组：迁移简单，但历史版本不能直接复用现有评分、面板卡片与来源展示，查询还需要额外展开。
2. 为每个版本保留独立 L3 记录，并增加主题键、状态和前后链接：与现有 Repository、检索和 UI 结构相容，能先覆盖用户明确修正。本轮采用此方案。
3. 自动识别任意新旧记录的语义主题并进入冲突审核：能力最完整，但错误聚类会隐藏正确记忆，还需要审核 IPC、接受/拒绝并发语义和新的模型提炼契约，留作后续独立增量。

## 数据模型与迁移

`memory-store.json` 从版本 1 升到版本 2。L3 记录增加可选版本字段：

- `topicKey`：版本链稳定主题键。旧数据使用 `legacy:<record-id>`，不猜测两个旧记录是否同主题。
- `revision`：从 1 开始递增。
- `versionState`：`current / superseded / transition`。
- `supersedesId / supersededById`：双向前后版本链接。
- `validFrom / validTo`：当前版本生效区间。

L1/L2 不增加这些字段，保持三级记忆语义。成功读取 v1 后，Repository 为每条 L3 补齐独立主题、revision 1、`current` 和 `validFrom`，立即用现有串行临时文件替换机制写回 v2。缺字段的 v2 记录也按同样规则修复。

`transition` 是修正的落盘中间态：新版本先以 transition 写入，旧 current 仍然有效；第二个排队写入把旧记录标为 superseded、新记录标为 current。进程如果恰在两次原子写之间退出，下一次初始化会在主题和前序链接一致时完成该 transition。聊天始终排除 transition，因此半完成更新不会泄漏进回答。

## 修正与删除行为

- L2 继续原位修正；只变更 L3 重要度也原位保存。
- 修改 L3 current 的内容或类型时，旧记录内容、ID、来源和访问统计不变；追加新 ID，继承 `topicKey` 与 `sourceIds`，revision 加一。
- 修正 superseded 历史记录只校正该历史版本，不会把它重新激活。
- 删除仍只删除选中记录；Repository 修复相邻链接，但删除 current 不会自动复活旧值。
- L3 自动整理仅与 current 记录做相似合并，避免把新候选并回已失效版本。

## 检索与用户界面

面板搜索继续返回全部相关版本，便于审计。聊天上下文在原有词法时态判断之前增加版本状态门禁：

- current：排除 superseded 与 transition，再保留原有显式历史词过滤。
- historical：接受 superseded，仍能用旧数据的显式历史前缀；排除 transition。
- comparison：接受 current 与 superseded；排除未完成 transition。

过滤仍发生在截断和访问强化之前。控制面板在 L3 卡片显示当前版本、历史版本或待完成变更状态，并展示主题键、revision、前后版本 ID 与有效期。L3 修正提示明确说明旧值会保留为历史版本。

## 测试与完成标准

- 观察 v1→v2 迁移写回，重载后字段稳定。
- 观察 L3 A→B→C 链的三个独立记录、双向链接、revision、有效期和磁盘重载。
- 用 transition 中间态 fixture 验证初始化恢复；transition 不进入任何聊天视图。
- 用无“以前/现在”线索的修正测试证明 current 上下文只返回新值，旧值访问次数保持 0；历史/比较视图仍可读取旧值。
- 用真实 `AgentService.respond()` 与 127.0.0.1 回环端点证明旧值不进入提示或 `memoryRefs`，最终回答只使用 current。
- 完成类型检查、全部测试、构建、Electron smoke、390×700 UI 检查和差异安全扫描后才提交。

## 边界

本轮的 `topicKey` 只在人工修正时可靠继承。两个彼此独立写入、措辞不同且没有显式时态线索的冲突记录仍不会自动归为同一主题；后续应增加保守的主题候选、`needsReview` 冲突审核和接受/拒绝操作，再扩展多次变更压力与旧值泄漏指标。
