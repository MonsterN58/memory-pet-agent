# Persistent Memory Version Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every user-corrected L3 value as a persistent version while preventing superseded or half-written values from entering current chat answers.

**Architecture:** Upgrade the JSON store to version 2 and keep each L3 revision as a normal `MemoryRecord` linked by a stable `topicKey`. `MemoryRepository.updateMemory()` stages a `transition` snapshot, then finalizes old/current states through the existing queued atomic writer; initialization recovers a coherent staged transition. Context retrieval filters version state before limiting and access reinforcement, while panel search remains a complete audit view.

**Tech Stack:** TypeScript, Node.js test runner through `tsx`, versioned local JSON, Electron 43, native DOM UI.

## Global Constraints

- Keep L1 in memory and L2 as the existing pending-event store; only L3 receives version metadata.
- Do not infer semantic topic identity for unrelated legacy records; migrate each with `legacy:<id>`.
- Do not add dependencies, model calls, SQLite, Embedding, or new IPC channels.
- Keep transition records out of every chat view until recovery finalizes them.
- Keep panel search complete, including superseded records.
- Preserve serial writes, temporary-file replacement, corruption isolation, source IDs, sandbox, context isolation, and secret separation.
- Make one final commit only after all automation verification and review gates pass.

---

### Task 1: RED contracts for migration and version behavior

**Files:**
- Modify: `tests/memory-engine.test.ts`
- Modify: `tests/memory-utils.test.ts`
- Modify: `tests/memory-quality.test.ts`
- Modify: `tests/agent-memory-quality.test.ts`

**Interfaces:**
- Expects: `MemoryRecord.topicKey`, `revision`, `versionState`, `supersedesId`, `supersededById`, `validFrom`, and `validTo`.
- Expects: version-aware `memoryMatchesTemporalView()` and `MemoryRepository.updateMemory()`.

- [ ] **Step 1: Write a v1 migration test**

Write a version-1 JSON fixture, initialize the repository, and assert that its L3 item becomes revision 1/current with `topicKey === "legacy:<id>"`; read the disk file and assert database version 2. Reinitialize and assert the metadata remains unchanged.

- [ ] **Step 2: Rewrite the L3 correction test as an append-only contract**

After correcting a current L3 record, assert two records exist. The original is superseded with `supersededById`, the new record is current with `supersedesId`, both share the topic key, and the new record is revision 2. Keep the existing L2 in-place assertion.

- [ ] **Step 3: Add A→B→C and transition recovery tests**

Perform two corrections using each returned current ID and assert revisions 1/2/3 and complete links after disk reload. Separately write a coherent v2 fixture containing current A and transition B; initialization must finalize A→B and persist the repaired state.

- [ ] **Step 4: Add version-state retrieval tests**

Construct current, superseded, and transition records without lexical time cues. Assert current returns current only, historical returns superseded only, comparison returns current plus superseded, and transition access count stays zero.

- [ ] **Step 5: Update user-correction quality and reply contracts**

Panel search for an obsolete value must return its superseded record for audit. `retrieveForContext()` for the same ordinary/current query must return none. Add a loopback `AgentService.respond()` case that corrects `用户住在南京` to `用户住在杭州`, asks `用户住哪里`, and asserts the prompt, response, references, and access counts contain only the new ID/value.

- [ ] **Step 6: Run focused tests and confirm RED**

Run:

```powershell
npx tsx --test --test-isolation=none tests/memory-utils.test.ts tests/memory-engine.test.ts tests/memory-quality.test.ts tests/agent-memory-quality.test.ts
```

Expected: compile/test failures because the v2 metadata, migration, append-only update, and state-aware retrieval do not exist.

### Task 2: GREEN repository and retrieval implementation

**Files:**
- Modify: `src/common/types.ts`
- Modify: `src/main/memory/memory-utils.ts`
- Modify: `src/main/memory/memory-repository.ts`
- Modify: `src/main/memory/memory-engine.ts`

**Interfaces:**
- Produces: `type MemoryVersionState = "current" | "superseded" | "transition"`.
- Extends: `MemoryRecord` with optional L3 version fields.
- Preserves: `MemoryUpdateInput`, bridge methods, and all IPC names.

- [ ] **Step 1: Add shared version fields**

Extend `MemoryRecord` with optional `topicKey`, `revision`, `versionState`, `supersedesId`, `supersededById`, `validFrom`, and `validTo`. Keep them optional because L1/L2 share the interface.

- [ ] **Step 2: Make temporal matching state-aware**

In `memoryMatchesTemporalView()`, reject transition first. Treat superseded as historical-only, current as current/comparison subject to the existing lexical fallback, and unversioned L1/L2 exactly as before.

- [ ] **Step 3: Upgrade and migrate the JSON store**

Change `MemoryDatabase.version` and `EMPTY_DATABASE.version` to 2. During initialize, normalize every L3 record to a stable legacy topic/revision/current/validFrom, detect whether a write-back is needed, recover coherent transitions, and persist once when changed. Preserve v1 arrays, heartbeat events, meta, and corruption isolation.

- [ ] **Step 4: Stage and finalize L3 corrections**

For content/type changes to a current L3 record: append a transition revision and capture an intermediate `persist()` promise; synchronously mark the previous record superseded and the new record current; queue the final snapshot; await both writes. For L2, importance-only edits, and historical corrections, retain in-place behavior.

- [ ] **Step 5: Maintain links on deletion and consolidation**

When deleting an L3 revision, reconnect surviving adjacent IDs without reactivating old content. Restrict Jaccard consolidation matches to current L3 records and keep content/summary paired when choosing which text survives.

- [ ] **Step 6: Exclude old values from review summaries**

Use the same current-view predicate when selecting L3 focus for heartbeat review, so superseded values cannot leak through the reflection path.

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run the same focused command. Expected: all migration, chain, recovery, retrieval, and reply-level tests pass.

### Task 3: User-visible audit UI

**Files:**
- Modify: `src/renderer/renderer.ts`
- Modify: `src/renderer/browser-mock.ts`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/index.html`

**Interfaces:**
- Consumes: optional L3 version fields already returned in `MemorySnapshot` and `MemorySearchResult`.
- Produces: version badges and detail rows without new bridge methods.

- [ ] **Step 1: Render version state and links**

Add current/history/transition labels to L3 card headers. In details, show topic key, revision, valid interval, previous ID and next ID when present. Do not display version controls for L1/L2.

- [ ] **Step 2: Clarify correction behavior**

Change the L3 edit note and success toast to say a new current revision is created and the old value remains historical. Keep L2 copy unchanged.

- [ ] **Step 3: Keep browser preview representative**

Give mock L3 records v2 metadata and make mock L3 correction append/supersede versions. Keep mock L2 correction in place.

- [ ] **Step 4: Style and inspect narrow layout**

Add compact state badges and wrapping metadata styles. At 390×700, inspect the list and expanded version details; confirm no horizontal overflow and no console errors.

### Task 4: Public and maintainer documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Keep: `docs/superpowers/specs/2026-07-14-persistent-memory-version-chain-design.md`
- Keep: `docs/superpowers/plans/2026-07-14-persistent-memory-version-chain.md`

**Interfaces:**
- Documents: v2 migration, explicit-correction scope, version-state retrieval, transition recovery, UI audit, and remaining automatic topic-conflict limitation.

- [ ] **Step 1: Update README and architecture**

Describe append-only L3 correction, complete panel history, current/historical/comparison state filtering, and migration/recovery. Replace the statement that correction preserves the original ID.

- [ ] **Step 2: Update AGENTS facts**

Adjust current progress, test count after the suite runs, verified commands, code map, local data version facts, priority text, and known limitations. Do not claim automatic semantic conflict detection or undo.

- [ ] **Step 3: Record adopted research**

In architecture references, record title, URL, publication date, and 2026-07-14 access date for Supersede, Engram/bi-temporal memory, and MemConflict. State the exact design principle adopted from each.

### Task 5: Verification, review, commit, and push

**Files:** All files changed above.

**Interfaces:** Produces one verified `main` commit on `origin/main`.

- [ ] **Step 1: Run required commands in order**

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke`. Persistence and renderer UI changed, so smoke is mandatory. Do not run `npm run package`.

- [ ] **Step 2: Review and scan**

Run `git diff --check`, inspect the full diff, and scan tracked additions for secrets, private keys, user data, ignored runtime/model paths, files over 1 MiB, and prohibited generated assets.

- [ ] **Step 3: Request independent code review**

Give a reviewer the base SHA, complete requirement summary, and current diff. Resolve every Critical/Important issue, then rerun affected tests.

- [ ] **Step 4: Synchronize and push safely**

Fetch `origin/main`. If it advanced, rebase only when conflict-free and rerun affected verification. Commit with `feat: preserve corrected memory versions`, push without force, and verify HEAD equals `origin/main`.
