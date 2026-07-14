# 记忆可控性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在控制面板查看 L1/L2/L3 详情与来源，安全地修正或删除 L2/L3，并看到搜索结果的召回评分依据。

**Architecture:** 在公共契约中声明持久记忆修改与评分类型；纯输入校验器隔离 IPC 边界；`MemoryRepository` 继续负责串行原子持久化，`MemoryEngine` 提供 UI 所需的快照接口；Renderer 只通过 preload 白名单显示和修改数据。

**Tech Stack:** Electron 43、TypeScript 5.8、Node test runner + tsx、原生 DOM/CSS、版本化 JSON Repository。

## Global Constraints

- 只允许修改或删除 L2/L3；L1 保持只读，禁止跨层移动和直接新建 L3。
- Renderer 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 写操作只接受当前控制面板 WebContents，主进程校验 UUID、层级、内容、类型和重要度。
- 编辑保留 ID、层级、创建时间、访问统计、来源 ID 和系统标签。
- Repository 继续使用现有串行写队列、临时文件和替换写入。
- 不增加数据库、网络服务或 npm 依赖；不运行 `npm run package`。
- 不提交生成物、本地模型、用户数据、密钥、缓存或 Spine 试验目录。

---

### Task 1: 公共契约与不可信输入校验

**Files:**
- Create: `src/main/memory/memory-input.ts`
- Modify: `src/common/types.ts`
- Test: `tests/memory-input.test.ts`

**Interfaces:**
- Produces: `PersistentMemoryTier`、`EditableMemoryKind`、`MemoryUpdateInput`、`MemoryDeleteInput`、`MemoryScoreBreakdown`、`MemorySearchResult`。
- Produces: `sanitizeMemoryUpdate(value: unknown): MemoryUpdateInput` 和 `sanitizeMemoryTarget(value: unknown): MemoryDeleteInput`。

- [ ] **Step 1: 写输入边界失败测试**

测试使用 `randomUUID()` 构造有效 ID，验证合法对象被清洗，并逐项拒绝 `L1`、非 UUID、空内容、2001 字内容、`dialogue` 和范围外重要度：

```ts
test("记忆修改只接受有效的 L2/L3 请求", () => {
  const id = randomUUID();
  assert.deepEqual(sanitizeMemoryUpdate({ id, tier: "L2", content: "  修正内容  ", kind: "fact", importance: 0.8 }), {
    id, tier: "L2", content: "修正内容", kind: "fact", importance: 0.8,
  });
  for (const value of [
    { id, tier: "L1", content: "内容", kind: "fact", importance: 0.8 },
    { id: "bad", tier: "L2", content: "内容", kind: "fact", importance: 0.8 },
    { id, tier: "L2", content: " ", kind: "fact", importance: 0.8 },
    { id, tier: "L2", content: "x".repeat(2001), kind: "fact", importance: 0.8 },
    { id, tier: "L2", content: "内容", kind: "dialogue", importance: 0.8 },
    { id, tier: "L2", content: "内容", kind: "fact", importance: 1.1 },
  ]) assert.throws(() => sanitizeMemoryUpdate(value));
});
```

- [ ] **Step 2: 运行测试并确认因模块缺失而失败**

Run: `npx tsx --test tests/memory-input.test.ts`

Expected: FAIL，错误指出 `src/main/memory/memory-input.ts` 尚不存在。

- [ ] **Step 3: 添加类型和最小校验实现**

在 `types.ts` 中加入上述类型，并用对象守卫、UUID 正则、允许层级/类型集合与有限数值检查实现两个清洗函数。每种失败使用明确中文错误；内容在校验前 `trim()`，最大 2000 字。

- [ ] **Step 4: 运行输入测试和类型检查**

Run: `npx tsx --test tests/memory-input.test.ts`

Expected: PASS，2 个输入边界测试、0 失败。

Run: `npm run typecheck`

Expected: 旧 bridge 因 `searchMemory` 类型尚未改变时保持通过；新增公共类型无错误。

---

### Task 2: 可解释检索分数

**Files:**
- Modify: `src/main/memory/memory-utils.ts`
- Modify: `src/main/memory/memory-repository.ts`
- Modify: `src/main/memory/memory-engine.ts`
- Test: `tests/memory-utils.test.ts`
- Test: `tests/memory-engine.test.ts`

**Interfaces:**
- Consumes: `MemoryScoreBreakdown`、`MemorySearchResult`。
- Produces: `scoreMemoryBreakdown(memory, query, now): MemoryScoreBreakdown`。
- Produces: `MemoryRepository.retrieveWithScores(query, limit): Promise<MemorySearchResult[]>`。
- Produces: `MemoryEngine.search(query, limit): Promise<MemorySearchResult[]>`。

- [ ] **Step 1: 写评分明细失败测试**

```ts
test("检索评分公开每个加权组成项", () => {
  const score = scoreMemoryBreakdown(memory("用户喜欢茉莉花茶", 0.8), "喜欢什么茶", Date.now());
  assert(score.textRelevance > 0);
  assert.equal(score.importance, 0.8 * 1.7);
  assert.equal(score.total, score.textRelevance + score.importance + score.recency + score.frequency);
});
```

再在 MemoryEngine 测试中保存两条记忆并断言 `search()` 返回 `{ memory, score }`，且相关记忆排在前面。

- [ ] **Step 2: 运行两个测试文件并观察缺少评分 API 的失败**

Run: `npx tsx --test --test-isolation=none tests/memory-utils.test.ts tests/memory-engine.test.ts`

Expected: FAIL，缺少 `scoreMemoryBreakdown` 或搜索返回结构不符。

- [ ] **Step 3: 实现评分拆分并复用原算法**

`textRelevance = relevance * 5`、`importance = memory.importance * 1.7`、`recency = exp(-ageDays / 30) * 0.8`、`frequency = normalizedAccess * 0.5`，`total` 为四项精确相加。`scoreMemory()` 仅返回 `scoreMemoryBreakdown(...).total`。

Repository 先计算并排序 score，再更新访问时间/次数，最后克隆 `{ memory, score }`；原 `retrieve()` 映射出 memory，避免改变 Agent 上下文。

- [ ] **Step 4: 运行评分与记忆测试**

Run: `npx tsx --test --test-isolation=none tests/memory-utils.test.ts tests/memory-engine.test.ts`

Expected: PASS，旧检索排序与新评分解释都通过。

---

### Task 3: L2/L3 编辑、删除和持久化

**Files:**
- Modify: `src/main/memory/memory-repository.ts`
- Modify: `src/main/memory/memory-engine.ts`
- Test: `tests/memory-engine.test.ts`

**Interfaces:**
- Consumes: `MemoryUpdateInput`、`MemoryDeleteInput`。
- Produces: `MemoryRepository.updateMemory(input): Promise<MemoryRecord>`。
- Produces: `MemoryRepository.deleteMemory(input): Promise<void>`。
- Produces: `MemoryEngine.updateMemory(input): Promise<MemorySnapshot>` 和 `deleteMemory(input): Promise<MemorySnapshot>`。

- [ ] **Step 1: 写 Repository 行为失败测试**

新增四个测试：编辑 L2 保留不可变字段并重载成功；编辑 L3 重载成功；删除目标后重载仍不存在且不存在 ID 报错；并发编辑/删除后 `flush()` 与重载状态一致。

核心断言：

```ts
const updated = await repository.updateMemory({
  id: original.id, tier: "L2", content: "修正后的生日是十月四日", kind: "fact", importance: 0.99,
});
assert.equal(updated.createdAt, original.createdAt);
assert.deepEqual(updated.sourceIds, original.sourceIds);
assert.equal(updated.summary, "修正后的生日是十月四日");
assert.notEqual(updated.updatedAt, original.updatedAt);
```

- [ ] **Step 2: 运行记忆测试并确认方法缺失**

Run: `npx tsx --test --test-isolation=none tests/memory-engine.test.ts`

Expected: FAIL，`updateMemory`/`deleteMemory` 尚不存在。

- [ ] **Step 3: 添加最小 Repository 与 Engine 实现**

Repository 按 `tier` 选择 `database.l2` 或 `database.l3`，按 ID 原位更新或 `splice()` 删除；未找到时抛出 `没有找到要修改的记忆`/`没有找到要删除的记忆`。更新时间使用 ISO 字符串，摘要调用 `summarizeText(content)`，重要度调用 `clamp()`，随后 `await persist()`。

Engine 只转发 Repository 写操作并返回最新 `snapshot()`，不触碰 L1。

- [ ] **Step 4: 运行记忆测试和全部单元测试**

Run: `npx tsx --test --test-isolation=none tests/memory-engine.test.ts`

Expected: PASS，编辑、删除、重载、错误与并发测试均通过。

Run: `npm test`

Expected: 所有既有与新增测试通过。

---

### Task 4: IPC 白名单与浏览器预览桥接

**Files:**
- Modify: `src/common/types.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/browser-mock.ts`

**Interfaces:**
- Consumes: `sanitizeMemoryUpdate()`、`sanitizeMemoryTarget()` 和 MemoryEngine 写接口。
- Produces: `PetAgentBridge.updateMemory(input)`、`deleteMemory(input)` 以及 `searchMemory(): Promise<MemorySearchResult[]>`。

- [ ] **Step 1: 先修改 bridge 类型，运行类型检查观察实现缺口**

在 `PetAgentBridge` 中把搜索返回值改成 `MemorySearchResult[]`，增加两个写方法。运行：

Run: `npm run typecheck`

Expected: FAIL，preload 和 browser mock 缺少新方法，Renderer 仍把搜索结果当 `MemoryRecord[]`。

- [ ] **Step 2: 接通 preload 与主进程受限 handler**

preload 只映射 `memory:update` 和 `memory:delete`。主进程 handler 先确认 `BrowserWindow.fromWebContents(event.sender) === controlPanelWindow`，再调用纯校验器和 MemoryEngine。其他窗口请求抛出 `只能从记忆管理窗口修改记忆`。

- [ ] **Step 3: 更新 browser mock**

预览桥接按 ID/tier 修改或删除内存数组；搜索使用评分工具无法直接跨 renderer 引用时，返回固定但结构完整的五项分数，确保 UI 预览可覆盖“为何召回”。

- [ ] **Step 4: 运行类型检查，保留 Renderer 类型失败作为下一任务红灯**

Run: `npm run typecheck`

Expected: FAIL 仅位于 `renderer.ts` 的搜索渲染类型，IPC/bridge 实现本身无缺项。

---

### Task 5: 记忆详情、来源、修正、删除和召回解释 UI

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/renderer.ts`

**Interfaces:**
- Consumes: `MemoryRecord`、`MemorySearchResult`、bridge 写方法。
- Produces: 可展开记忆卡、L2/L3 内联修正表单、删除确认和搜索评分说明。

- [ ] **Step 1: 用本地浏览器记录 UI 红灯**

启动 Vite 预览后打开 `http://127.0.0.1:4173/?mode=panel&view=memory`，确认当前页面没有“查看详情”“修正”“删除”“为何召回”，作为 UI 行为缺失证据。

- [ ] **Step 2: 实现统一显示模型**

在 `initializePanel()` 内使用：

```ts
interface DisplayMemory {
  memory: MemoryRecord;
  score?: MemoryScoreBreakdown;
}
```

普通快照映射为 `{ memory }`，搜索结果直接渲染。卡片用原生 `<details>` 展示完整内容、三类时间、所有标签与来源 ID；无来源时显示“无上游来源标识”。搜索结果额外显示四项加权分和综合分。

- [ ] **Step 3: 实现内联修正和删除**

L2/L3 卡片加入修正表单：只读层级、四种 kind 选择、2000 字 textarea、0～1 step 0.01 的 importance。保存调用 `bridge.updateMemory()`，成功刷新完整列表；失败保留表单并 toast。删除使用包含摘要的 `window.confirm()`，确认后调用 `bridge.deleteMemory()`。L1 不创建操作按钮。

- [ ] **Step 4: 添加 390px 友好样式和可访问状态**

为 details、来源 code、评分网格、按钮组、编辑表单和危险按钮增加样式；交互按钮有 `type="button"`，表单字段有 label，展开摘要可键盘聚焦，窄窗口按钮自动换行。

- [ ] **Step 5: 运行类型检查和浏览器绿灯验收**

Run: `npm run typecheck`

Expected: PASS。

浏览器在 390×700 视口确认：详情可展开；L1 无写按钮；L2/L3 可打开和取消修正；保存后内容更新；删除确认后计数减少；搜索结果显示评分解释；控制台无错误。

---

### Task 6: 文档、完整验证、自审、提交与推送

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: 面向用户的使用说明、更新后的架构数据流、准确测试数量和下一步优先级。

- [ ] **Step 1: 更新项目事实来源**

README 增加记忆详情/修正/删除/来源/召回解释说明；ARCHITECTURE 记录 CRUD 边界、字段保留和评分结构；AGENTS 更新 L2/L3 状态、测试数量、最近验证和优先级，将下一项推进为记忆质量评测。

- [ ] **Step 2: 运行完整验证**

Run: `npm run typecheck`

Expected: exit 0。

Run: `npm test`

Expected: 所有测试通过、0 fail。

Run: `npm run build`

Expected: exit 0，入口保持 `dist/main/main.js` 与 `dist/renderer/index.html`。

Run: `npm run smoke`

Expected: exit 0，日志包含 `ELECTRON_SMOKE_TEST_READY`。

- [ ] **Step 3: 检查改动范围与敏感内容**

Run: `git diff --check`

Expected: 无空白错误。

检查 `git status --short` 只包含计划内源码/测试/文档；扫描新增大文件和常见密钥格式，确认生成物、模型、用户数据、缓存和 `.env` 未进入暂存区。

- [ ] **Step 4: 自审规格逐项覆盖**

逐条对照 `docs/superpowers/specs/2026-07-14-memory-control-design.md`，确认 L1 只读、L2/L3 可控、来源保留、搜索可解释、IPC 来源受限、离线行为不变；修复所有高/中优先级问题后重新执行完整验证。

- [ ] **Step 5: 提交并推送 main**

```powershell
git add -- src tests README.md AGENTS.md docs/ARCHITECTURE.md docs/superpowers/plans/2026-07-14-memory-control.md
git commit -m "feat: add controllable memory management"
git push origin main
```

Expected: push 成功，`origin/main` 指向本轮最终提交，工作区干净。
