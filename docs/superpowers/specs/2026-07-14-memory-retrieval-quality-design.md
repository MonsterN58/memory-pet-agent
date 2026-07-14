# 记忆检索精度与质量契约设计

> 日期：2026-07-14
> 状态：已批准实施（自动化维护任务授权按项目优先级选择边界清晰的改进）

## 背景

当前检索把文本相关度、重要度、时间衰减和访问频率相加后直接取前 N 条。即使一条记忆与查询没有任何文本交集，它仍会凭重要度和新鲜度获得正分，被加入普通聊天或主动聊天上下文；随后访问次数又会增加，使无关记录继续得到频率加成。

中文相关度还同时使用单字和双字 token。单字有助于短查询，但“我、你、的、了”等高频字会制造弱相关命中。项目下一步优先级要求先建立偏好更新、事实冲突、跨天跟进、提示注入和用户纠错的质量评测，再考虑 Embedding 或 SQLite，因此本轮先建立可重复的离线质量契约，并修复已确认的零相关召回问题。

## 调研依据

- [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813)，2024-10-14 首发，ICLR 2025。其五项核心能力包括信息提取、跨会话推理、时间推理、知识更新和拒答；本设计把“没有相关证据时返回空结果”作为检索层的拒答前置条件。
- [Evaluating Very Long-Term Conversational Memory of LLM Agents](https://arxiv.org/abs/2402.17753)，2024-02-27 首发，ACL 2024。LoCoMo 使用带时间戳的多 session 对话和证据标注；本设计加入跨天旧记忆仍可被主题线索召回的契约。
- [Do LLMs Recognize Your Preferences? Evaluating Personalized Preference Following in LLMs](https://arxiv.org/abs/2502.09597)，2025-02-13 首发，ICLR 2025 Oral。PrefEval 强调干扰轮次后的偏好遵循；本设计把新偏好压过旧偏好单独成类。
- [AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases](https://arxiv.org/abs/2407.12784)，2024-07-17 首发，NeurIPS 2024。该工作区分攻击成功率和正常能力保持率；本设计成对验证不相关注入记忆不被召回、正常相关记忆仍能保留。
- [LLM Prompt Injection Prevention - OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)，访问日期 2026-07-14。其 RAG poisoning 与结构化指令/数据分离建议支持继续保留现有提示隔离，并减少无关持久化内容进入模型上下文。
- [Electron v43.1.0](https://github.com/electron/electron/releases/tag/v43.1.0)，2026-07-07；[sherpa-onnx v1.13.4](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.4)，2026-07-07。项目已锁定这两个最新稳定版本；本轮不做依赖升级。TypeScript 7、PixiJS 8.19 和 Cubism Web Framework R5 均跨越当前兼容边界，也不进入本轮范围。

以上页面均于 2026-07-14 核验。

## 目标

1. 对普通聊天、主动聊天和记忆面板搜索，只返回具有最低文本证据的持久记忆。
2. 降低中文高频单字造成的弱相关命中，同时保留单字主题（例如“猫”“茶”）的可检索性。
3. 只强化实际返回的记录；零相关记录不增加 `accessCount`。
4. 建立 20 个手写中文 fixture，五类场景各 4 个，并可通过独立 npm 命令运行。
5. 保持离线、零新依赖、现有 JSON 数据结构、IPC 契约和三级记忆语义不变。

## 非目标

- 不自动删除或合并互相冲突的事实、偏好。
- 不引入 Embedding、分词模型、SQLite、在线评审模型或上游 benchmark 数据。
- 不修改人格成长、心跳策略、Provider、UI 或持久化 schema。
- 不声称解决同义词、代词指代或完整的时间推理；这些继续由质量集暴露并驱动后续改进。

## 方案比较

### 方案 A：仅增加评测集

最稳妥，但已确认的零相关召回仍会影响用户聊天，不能形成运行时收益。

### 方案 B：评测集 + 最低文本证据门槛（采用）

在现有词法检索边界内修复明确问题，不改变存储和跨进程接口。质量集同时锁定正常召回，避免精度修复造成明显召回退化。

### 方案 C：直接做冲突消解

需要定义“旧事实是否失效”“历史偏好是否保留”等产品语义，也需要修订历史或冲突标记配合；在基线评测前实施风险过高。

## 详细设计

### 查询 token

保留现有 `tokenize()` 给 Jaccard 去重使用，新增 `retrievalTokens()` 专用于检索评分：

- 拉丁字母和数字按连续串保留。
- 中文连续文本生成相邻双字 token。
- 中文单字同时保留，但移除有限的高频虚词集合。
- 单字主题不在虚词集合中，因此一字查询仍可匹配。
- 记忆类型增加本地化检索词，例如 `preference → 近期偏好`、`fact → 近期重要的事`、`episode → 近期计划待跟进话题`，保证主动聊天的通用关注点查询仍能找到合适候选，而不会放宽零相关门槛。

评分公式不变，`textRelevance` 仍是命中查询 token 比例乘以 5。这样控制面板已有评分拆解无需迁移。

### 最低文本证据

`MemoryRepository.retrieveWithScores()` 在排序前过滤 `textRelevance < 0.75` 的记录。0.75 对应查询 token 至少约 15% 的命中比例；它能排除长查询里单个偶然字符的弱匹配，同时允许短主题词和一个有意义双字词触发召回。

过滤发生在访问强化之前。因此：

1. 零相关查询返回空数组。
2. 被过滤记录不更新 `accessedAt` 或 `accessCount`。
3. 普通聊天、本地降级、主动聊天和面板搜索共享同一精度规则。
4. 主动聊天没有合适记忆时沿用现有轻松问候，不制造虚假跟进。

### 质量契约

新增 20 个手写 fixture，每类 4 个：

- 偏好更新：查询包含“现在”等更新线索时，新偏好必须排在旧偏好之前。
- 事实冲突：查询包含当前状态线索时，当前事实必须排在历史事实之前；暂不要求删除历史。
- 跨天跟进：旧但相关的计划/事件必须压过新但无关的记录。
- 提示注入：不相关的注入式持久记忆必须返回空结果；配对的正常主题仍能召回。
- 用户纠错：原位修正后只召回新内容，使用旧值查询时不得凭重要度返回已修正记录。

测试直接使用 `MemoryRepository` 和临时目录，不访问网络、真实用户数据或模型端点。

## 错误处理与兼容性

- 查询没有可用 token 时返回空结果，不抛出错误。
- 旧的 `memory-store.json` 无需迁移。
- 评分结构字段和权重不变，现有 UI 继续显示相同五项分值。
- 如果门槛过严，质量 fixture 会先暴露正常召回回退；后续可仅调整常量和测试依据，不改接口。

## 验收标准

- 新质量测试在生产改动前因零相关记录被返回而失败。
- 实现后 20 个 fixture 全部通过。
- 现有记忆、人格、语音、模型和设置测试全部通过。
- `npm run typecheck`、`npm test`、`npm run build`、`npm run smoke` 全部成功。
- `git diff --check` 与敏感信息/大文件扫描无异常。
