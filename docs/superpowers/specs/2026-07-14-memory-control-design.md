# 记忆可控性设计

## 背景与目标

当前三级记忆已经能完成 `L1 → L2 → L3` 的迁移、整理和检索，但控制面板只能查看摘要和搜索，错误内容进入 L2/L3 后缺少修正入口。第一轮增强要让用户能在本机查看记忆详情与来源、修正持久记忆、删除错误记忆，并理解搜索结果为何出现。

本轮保持现有层级语义：L1 是只读的进程内上下文；用户只能修改或删除已经持久化的 L2/L3；界面不提供新建 L3、修改层级或把 L1 直接提升到 L3 的能力。

## 调研依据（2026-07-14）

- [LangChain Long-term memory](https://docs.langchain.com/oss/python/langchain/long-term-memory)：长期记忆使用应用定义的 JSON 文档、命名空间与稳定 key，跨会话持久化。
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) 与 [LangGraph Stores](https://docs.langchain.com/oss/python/langgraph/stores)：短期 thread state 与长期 store 分离；记录保留唯一 ID、创建/更新时间，并通过相同 key 更新。
- [Claude Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)：持久记忆存储由应用控制，提供 create/read/update/delete，并按需读取而不是把全部内容塞进上下文。

本项目据此继续分离 L1 与持久层，沿用稳定 UUID 和时间字段，在受控本地 Repository 内增加 read/update/delete；本轮不增加绕过 L2→L3 生命周期的直接 create 接口。

## 方案选择

评估过三种方案：

1. 原记录原位修订：保留 ID、层级、创建时间、访问统计和来源，只更新可编辑字段及 `updatedAt`。实现与现有 JSON Repository 一致，检索立即使用修正后的内容。
2. 追加纠错记录：原内容不变，另存修正与撤销事件。审计更完整，但检索、合并和 UI 都要解析有效版本链。
3. 从来源重建派生记忆：修改 L2 后重新运行提炼。适合未来的质量评测和版本化记忆，但依赖完整来源快照与冲突策略。

本轮采用方案 1。方案 2 的审计历史与方案 3 的重新提炼留到建立记忆质量评测集后再设计。

## 稳定契约

新增跨进程类型：

- `PersistentMemoryTier = "L2" | "L3"`。
- `EditableMemoryKind = "episode" | "fact" | "preference" | "reflection"`。
- `MemoryUpdateInput`：包含 `id`、固定的 `tier`、`content`、`kind` 和 `importance`。
- `MemoryScoreBreakdown`：包含文本相关度、重要度、时间衰减、访问频率和总分。
- `MemorySearchResult`：同时返回记忆记录与检索评分明细。

`PetAgentBridge` 增加 `updateMemory()` 和 `deleteMemory()`，两者返回最新 `MemorySnapshot`。`searchMemory()` 改为返回 `MemorySearchResult[]`，普通聊天的 `contextFor()` 仍只消费 `MemoryRecord[]`，避免检索解释类型进入 Agent prompt。

## Repository 行为

`MemoryRepository.updateMemory()` 只在指定的 L2 或 L3 集合中按 ID 查找记录。成功时：

- 保留 `id`、`tier`、`createdAt`、`accessedAt`、`accessCount`、`sourceIds` 和系统标签。
- 更新 `content`、自动生成的 `summary`、`kind`、`importance` 和 `updatedAt`。
- 继续通过现有写队列、临时文件与替换写入持久化 JSON。

`MemoryRepository.deleteMemory()` 只删除指定层级和 ID 的目标记录，不级联删除来源或派生记录。来源 ID 是溯源标识，即使上游 L1/L2 已按生命周期清理，也继续保留在其他记录中。

不存在的 ID 返回明确错误。并发修改仍按调用顺序进入现有串行持久化队列，重载文件后必须与内存最终状态一致。

心跳提炼可能等待外部模型返回。等待期间若任一来源 L2 被修正或删除，`MemoryEngine` 必须在写入 L3 前检测来源版本变化并丢弃整批过期候选，后续心跳再基于当前 L2 重新整理。

`retrieveWithScores()` 在增加访问次数前计算各项分值，按总分排序并返回解释；既有 `retrieve()` 复用同一实现但只返回记录，保证 Agent 调用方不变。

## 输入边界与 IPC

主进程使用独立纯函数清洗不可信修改请求：

- ID 必须是标准 UUID 字符串。
- 层级只接受 L2/L3。
- 内容去除首尾空白后为 1～2000 个字符。
- 类型只接受四种可编辑持久记忆类型。
- 重要度必须是 0～1 的有限数值。

写操作只接受当前控制面板窗口发起。宠物窗口和其他 WebContents 没有修改或删除记忆的权限。Renderer 继续保持 `sandbox: true`、`contextIsolation: true` 和 `nodeIntegration: false`。

## 控制面板体验

每张记忆卡显示层级、类型、摘要、更新时间、重要度、访问次数和标签。展开详情后显示：

- 完整内容。
- 创建、更新和最近访问时间。
- 完整标签。
- 上游 `sourceIds`；上游已迁移或清理时仍显示稳定标识并说明其生命周期状态。
- 搜索模式下的文本相关度、重要度、时间衰减、访问频率和综合分，作为“为何召回”。

L2/L3 卡片提供“修正”和“删除”。修正表单允许修改内容、类型和重要度，层级以只读标签显示；保存后刷新计数与列表。删除前使用明确确认框，完成后刷新列表。L1 卡片只展示详情，不显示写操作。

搜索为空时恢复完整列表；搜索结果不改变记忆层级或内容。所有状态反馈继续使用现有面板 toast。

## 错误与降级

- IPC 校验失败、记录已不存在或持久化失败时，界面显示主进程返回的明确错误，保留当前卡片和用户输入。
- 删除确认取消时不发起 IPC。
- 搜索评分解释仅用于 UI；即使解释渲染出现问题，基础记忆内容仍可展示。
- 本轮不增加外部服务、数据库或网络请求，离线行为不变。

## 测试与验收

自动化测试覆盖：

1. L2 与 L3 编辑后字段规则正确并能从磁盘重载。
2. L2 与 L3 删除后磁盘重载仍不存在。
3. ID 不存在时返回明确错误。
4. L1/非法层级、非法 UUID、空内容、越长内容、非法类型和越界重要度被拒绝。
5. 并发更新与删除经过写队列后最终文件有效且状态一致。
6. 心跳等待提炼期间修正或删除 L2，不会把旧内容写回 L3。
7. 检索评分总分等于各组成项之和，搜索结果包含可解释明细。

完整验收运行 `npm run typecheck`、`npm test`、`npm run build` 和 `npm run smoke`。控制面板在 390×700 视口检查完整列表、详情展开、编辑表单、删除确认布局和搜索解释；本轮不运行发布打包。

## 非目标

- L1 持久化、崩溃恢复或会话边界。
- 直接新建 L3、跨层移动、批量删除或清空全部记忆。
- 修订历史、撤销栈、重新执行 L2→L3 提炼。
- SQLite、向量检索或云同步。
