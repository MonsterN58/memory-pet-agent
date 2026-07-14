# Temporal Memory Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent explicitly historical facts and preferences from leaking into current chat answers while preserving complete memory-panel search and history.

**Architecture:** Add deterministic temporal-view classifiers in the memory utility layer, then give `MemoryRepository` a chat-only retrieval path that filters before limiting and access reinforcement. `MemoryEngine.contextFor()` uses that path, so the existing `AgentService` prompt and `memoryRefs` automatically receive the same filtered evidence.

**Tech Stack:** TypeScript 5.9, Node.js test runner through `tsx`, versioned local JSON, Electron 43.

## Global Constraints

- Keep the JSON database at version 1; add no persisted fields or migration.
- Apply temporal filtering only to `fact` and `preference`; leave L1, `dialogue`, `episode`, and `reflection` behavior unchanged.
- Keep `retrieveWithScores()` as the complete control-panel/audit view.
- Filter before `.slice(0, limit)` and before updating `accessCount/accessedAt`.
- Use no external model, network service, embedding, database, or dependency upgrade.
- Make one final commit only after every required verification passes, as required by the automation workflow.

---

### Task 1: Temporal chat retrieval and reply-level contract

**Files:**
- Modify: `src/main/memory/memory-utils.ts`
- Modify: `src/main/memory/memory-repository.ts`
- Modify: `src/main/memory/memory-engine.ts`
- Modify: `tests/memory-quality.test.ts`
- Create: `tests/agent-memory-quality.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `type MemoryTemporalView = "current" | "historical" | "comparison"`.
- Produces: `temporalViewForQuery(query: string): MemoryTemporalView`.
- Produces: `memoryMatchesTemporalView(memory: MemoryRecord, view: MemoryTemporalView): boolean`.
- Produces: `MemoryRepository.retrieveForContext(query: string, limit?: number): Promise<MemoryRecord[]>`.
- Consumes: existing `scoreMemoryBreakdown()`, `MIN_RETRIEVAL_TEXT_RELEVANCE`, and `MemoryEngine.contextFor()`.

- [x] **Step 1: Add failing repository quality tests**

Append these imports and tests to `tests/memory-quality.test.ts` while keeping the five existing contracts intact:

```ts
test("聊天当前视图排除明确历史偏好和事实", async (context) => {
  for (const fixtureCase of [...preferenceUpdateCases, ...factConflictCases]) {
    const repository = await repositoryFor(context, fixtureCase.memories);
    const results = await repository.retrieveForContext(fixtureCase.query, fixtureCase.memories.length);
    assert.deepEqual(results.map((memory) => memory.content), [fixtureCase.expectedContents[0]], fixtureCase.name);
    const accessCounts = new Map(repository.getL3().map((memory) => [memory.content, memory.accessCount]));
    assert.equal(accessCounts.get(fixtureCase.expectedContents[0]!), 1, fixtureCase.name);
    assert.equal(accessCounts.get(fixtureCase.expectedContents[1]!), 0, fixtureCase.name);
  }
});

test("聊天历史视图只返回明确历史证据", async (context) => {
  const fixtureCase = preferenceUpdateCases[0]!;
  const repository = await repositoryFor(context, fixtureCase.memories);
  const results = await repository.retrieveForContext("以前喜欢喝什么", fixtureCase.memories.length);
  assert.deepEqual(results.map((memory) => memory.content), ["以前喜欢喝咖啡"]);
});

test("聊天比较视图同时保留当前和历史证据", async (context) => {
  const fixtureCase = preferenceUpdateCases[0]!;
  const repository = await repositoryFor(context, fixtureCase.memories);
  const results = await repository.retrieveForContext("以前和现在喜欢喝什么，有什么变化", fixtureCase.memories.length);
  assert.deepEqual(results.map((memory) => memory.content), fixtureCase.expectedContents);
});
```

- [x] **Step 2: Add a failing real `AgentService.respond()` integration test**

Create `tests/agent-memory-quality.test.ts` with a temporary version-1 repository, a loopback HTTP Chat Completions stub, a real `MemoryEngine`, and a real `AgentService`. The handler must answer with the current preference only when the system prompt includes `现在喜欢喝茉莉花茶` and excludes `以前喜欢喝咖啡`. Assert:

```ts
assert.equal(response.text, "你现在喜欢茉莉花茶。");
assert.equal(response.source, "provider");
assert.deepEqual(response.memoryRefs, [currentMemory.id]);
assert.match(capturedSystemPrompt, /现在喜欢喝茉莉花茶/);
assert.doesNotMatch(capturedSystemPrompt, /以前喜欢喝咖啡/);
assert.equal(repository.getL3().find((memory) => memory.id === historicalMemory.id)?.accessCount, 0);
```

Use a structural test double for `SettingsStore` with `get()`, `getApiKey()`, and `providerConfigured()`, and one for `PersonalityEngine` with `behaviorContext()` and `observeDialogue()`. Clear and restore `OPENAI_BASE_URL` and `OPENAI_MODEL` around the test so the loopback endpoint is deterministic. The stub is local-only and binds to `127.0.0.1` on an ephemeral port.

- [x] **Step 3: Run the focused suite and confirm RED**

Run:

```powershell
npx tsx --test --test-isolation=none tests/memory-quality.test.ts tests/agent-memory-quality.test.ts
```

Expected: failure because `MemoryRepository.retrieveForContext` does not exist, and the reply-level test still exposes the historical preference through the current context.

- [x] **Step 4: Implement deterministic temporal classification**

Add to `src/main/memory/memory-utils.ts`:

```ts
export type MemoryTemporalView = "current" | "historical" | "comparison";

const HISTORICAL_TIME_CUES = /以前|过去|之前|曾经|原来|原先|当时|此前|最初|原计划/;
const CURRENT_TIME_CUES = /现在|目前|如今|当前|现阶段|最新|改为|改成|更正/;
const COMPARISON_TIME_CUES = /变化|变更|改变|前后|对比|历程|从.+(?:改到|改为|改成|变到|变为|变成|换到|换为|换成|搬到|转到).+/;
const HISTORICAL_MEMORY_PREFIX = /^(?:用户[:：]?\s*)?(?:我(?:的)?\s*)?(?:以前|过去|之前|曾经|原来|原先|当时|此前|最初|原计划)/;

export function temporalViewForQuery(query: string): MemoryTemporalView {
  const value = normalizeText(query);
  const historical = HISTORICAL_TIME_CUES.test(value);
  const current = CURRENT_TIME_CUES.test(value);
  if (COMPARISON_TIME_CUES.test(value) || (historical && current)) return "comparison";
  return historical ? "historical" : "current";
}

export function memoryMatchesTemporalView(memory: MemoryRecord, view: MemoryTemporalView): boolean {
  if (view === "comparison" || (memory.kind !== "fact" && memory.kind !== "preference")) return true;
  const value = normalizeText(`${memory.summary} ${memory.content}`);
  const historical = HISTORICAL_MEMORY_PREFIX.test(value) && !CURRENT_TIME_CUES.test(value);
  return view === "historical" ? historical : !historical;
}
```

- [x] **Step 5: Add chat-only repository retrieval before access reinforcement**

Refactor `MemoryRepository` so a private ranking helper performs scoring, minimum-evidence filtering, and sorting without mutation. Keep `retrieveWithScores()` on the full ranked list. Implement:

```ts
async retrieveForContext(query: string, limit = 6): Promise<MemoryRecord[]> {
  const now = Date.now();
  const view = temporalViewForQuery(query);
  const ranked = this.rank(query, now)
    .filter(({ memory }) => memoryMatchesTemporalView(memory, view))
    .slice(0, limit);
  await this.markAccessed(ranked, now);
  return clone(ranked.map(({ memory }) => memory));
}
```

`markAccessed()` must update only its received results, persist once when non-empty, and preserve the current timestamp/access-count behavior. `retrieveWithScores()` calls the same helper without temporal filtering, then slices and marks access. `retrieve()` remains an alias of the complete view for compatibility.

- [x] **Step 6: Route chat context through the new path**

Change `MemoryEngine.contextFor()` to:

```ts
const persistent = await this.repository.retrieveForContext(query, limit);
```

Keep its L1 concatenation and result limit unchanged.

- [x] **Step 7: Include reply-level tests in the quality command**

Set the package script to:

```json
"test:memory-quality": "tsx --test --test-isolation=none tests/memory-quality.test.ts tests/agent-memory-quality.test.ts"
```

- [x] **Step 8: Run the focused suite and confirm GREEN**

Run `npm run test:memory-quality`.

Expected: all retrieval-view and reply-level tests pass; the loopback request contains only current evidence for a current query.

### Task 2: User and architecture documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Keep: `docs/superpowers/specs/2026-07-14-temporal-memory-context-design.md`
- Keep: `docs/superpowers/plans/2026-07-14-temporal-memory-context.md`

**Interfaces:**
- Consumes: the exact `current/historical/comparison` behavior delivered by Task 1.
- Produces: accurate public documentation and next-run project context.

- [x] **Step 1: Update README behavior and test coverage**

Document that chat defaults to the current view, explicit historical questions select historical evidence, comparison questions keep both, and panel search remains a full audit view. Update the quality-test paragraph to include context gating, stale-value access isolation, and the real provider-loopback reply contract.

- [x] **Step 2: Update architecture details**

In the memory design section, describe the two retrieval consumers separately: full scored search for the panel and query-conditioned temporal retrieval for chat. State that filtering precedes truncation and access reinforcement, affects only facts/preferences, and uses deterministic explicit Chinese cues.

- [x] **Step 3: Update AGENTS project state**

Update the retrieval and test rows, verified test counts, known limitations, and priority wording. Preserve the next priority of persistent version chains, conflict markers, and review/undo; do not claim that implicit conflicts are solved.

- [x] **Step 4: Review documentation against the implementation**

Run:

```powershell
rg -n "时态|历史|旧值|memory-quality|冲突" README.md docs/ARCHITECTURE.md AGENTS.md
```

Expected: every user-visible claim matches a tested code path and explicitly retains the implicit-conflict limitation.

### Task 3: Verification, review, commit, and push

**Files:** All files changed in Tasks 1–2.

**Interfaces:** Produces a verified main-branch commit on `origin/main`.

- [x] **Step 1: Run required verification in order**

Run `npm run typecheck`, `npm test`, `npm run build`, then `npm run smoke`. The repository persistence and Electron-integrated memory startup path changed, so smoke is required. Do not run `npm run package`.

- [x] **Step 2: Review all differences**

Run `git diff --check`, `git diff --stat`, `git diff`, and `git status -sb`. Confirm only the temporal-memory task files are present.

- [x] **Step 3: Scan prohibited content**

Scan tracked additions for API-key/token/private-key patterns, user-data filenames, ignored runtime/model paths, and files larger than 1 MiB. Confirm no ignored file is force-added.

- [x] **Step 4: Recheck remote and push safely**

Run `git fetch origin main`. If `origin/main` advanced, rebase only when conflict-free, rerun affected verification, and stop on any conflict. Commit with `feat: gate chat memory by temporal intent`, push `main` to `origin/main`, and verify local HEAD equals `origin/main`.
