# Local Voice and Live2D Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local speech recognition always converge, make all bundled and compatible imported Live2D models visibly track the global cursor, add continuous drag/fall/landing feedback, and trigger restrained semantic actions from reply emotions.

**Architecture:** Keep Electron main as the owner of the ASR worker, desktop cursor, and window motion; carry cancellation and continuous motion through the typed preload bridge. Keep Live2D-specific capability discovery, parameter writes, motion selection, and spring transforms behind `PetModelAdapter`. Keep reaction classification and action selection deterministic and independently testable.

**Tech Stack:** Electron 43, TypeScript 5.8, Node test runner through `tsx`, PixiJS 8.13.1, `untitled-pixi-live2d-engine` 1.3.1, Cubism Core 5.1, sherpa-onnx 1.13.4.

## Global Constraints

- Do not add npm dependencies.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Keep local ASR, local TTS, text chat, memory, personality, and heartbeat usable without an external service.
- Keep chat and TTS endpoints and secrets separate.
- Use `PetModelAdapter` as the only renderer boundary; do not expose Live2D APIs to Agent, memory, heartbeat, or Electron main.
- Do not modify bundled `.moc3`, textures, expression files, or motion files.
- The global cursor from Electron is the only Live2D focus source; use 640 px horizontal and 480 px vertical focus radii.
- ASR initialization and interactive recognition each use a 30 second main-process limit; Renderer recovery uses a 35 second watchdog.
- `landing` lasts approximately 320 ms and must not be interrupted by automatic reaction actions.
- Keep all project files, generated diagnostics, npm cache, and voice model files in the D-drive workspace.
- Do not run `npm run package`, create an installer, or publish a release.

---

### Task 1: Typed interaction contracts and deterministic helpers

**Files:**
- Modify: `src/common/types.ts`
- Create: `src/main/pet-motion.ts`
- Create: `tests/pet-motion.test.ts`

**Interfaces:**
- Produces: `PetMotionFrame`, `normalizeFocus()`, `clampMotionFrame()`, and `PetLocomotion` with `landing`.
- Consumers: Tasks 3, 4, and 5.

- [ ] **Step 1: Write the failing contract and motion tests**

Add tests that import the not-yet-created helpers and assert exact focus geometry and frame clamping:

```ts
test("全局指针按 640×480 半径渐进映射", () => {
  assert.deepEqual(normalizeFocus({ x: 960, y: 300 }, { x: 320, y: 780 }), { x: 1, y: 1 });
  assert.deepEqual(normalizeFocus({ x: 640, y: 540 }, { x: 320, y: 780 }), { x: 0.5, y: 0.5 });
});

test("连续运动帧始终限制在安全范围", () => {
  assert.deepEqual(clampMotionFrame({
    state: "dragged", velocityX: 4, velocityY: -3, offsetX: 2, offsetY: -2,
  }), { state: "dragged", velocityX: 1, velocityY: -1, offsetX: 1, offsetY: -1 });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npx tsx --test --test-isolation=none tests/pet-motion.test.ts`

Expected: FAIL because `src/main/pet-motion.ts` and the expanded types do not exist.

- [ ] **Step 3: Add the exact public types**

```ts
export type PetLocomotion = "idle" | "walk-left" | "walk-right" | "dragged" | "falling" | "landing";
export interface PetMotionFrame {
  state: PetLocomotion;
  velocityX: number;
  velocityY: number;
  offsetX: number;
  offsetY: number;
}
```

Do not migrate bridge methods or expand emotion/action unions in this task; those changes happen atomically with their call sites in Tasks 2, 4, 5, and 6 so every commit remains type-safe.

- [ ] **Step 4: Implement the pure geometry helpers**

`normalizeFocus(cursor, modelCenter)` must calculate `x = clamp((cursor.x-modelCenter.x)/640)` and `y = clamp((modelCenter.y-cursor.y)/480)`. `clampMotionFrame(frame)` must preserve `state` and clamp all four numeric values to `[-1, 1]`, replacing non-finite values with zero.

- [ ] **Step 5: Run the focused test and typecheck**

Run: `npx tsx --test --test-isolation=none tests/pet-motion.test.ts && npm run typecheck`

Expected: the focused tests and typecheck pass with zero errors.

- [ ] **Step 6: Commit**

```powershell
git add src/common/types.ts src/main/pet-motion.ts tests/pet-motion.test.ts
git commit -m "feat: define continuous pet interaction contracts"
```

### Task 2: Local ASR operation lifecycle, cancellation, warmup, and recovery

**Files:**
- Modify: `src/common/types.ts`
- Modify: `src/renderer/voice-service.ts`
- Modify: `src/renderer/renderer.ts`
- Modify: `src/renderer/browser-mock.ts`
- Modify: `src/main/local-asr-service.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `tests/voice-service.test.ts`
- Modify: `tests/local-asr-service.test.ts`
- Create: `scripts/local-asr-ui-smoke.cjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `VoiceService` operation phases, `LocalAsrService.warmup()`, `LocalAsrService.cancelCurrent()`, `PetAgentBridge.cancelLocalSpeechRecognition()`, IPC `voice:cancel-local`, and `npm run smoke:voice-ui`.

- [ ] **Step 1: Reproduce the Renderer cancellation race in a failing test**

Use fake media tracks, AudioContext nodes, and a deferred `recognizeLocal` Promise. Start local capture, feed a speech chunk, stop capture to enter recognition, call `start()` again, and assert immediately:

```ts
assert.equal(voice.isListening(), false);
assert.equal(interim.at(-1), "");
assert.equal(cancelCalls, 1);
recognition.resolve({ text: "迟到结果", durationMs: 900 });
await nextTask();
assert.deepEqual(finals, []);
assert.equal(states.filter((state) => state.listening === false).length, 1);
```

Also add separate cases for successful text, empty text, recognition rejection, and the 35 second Renderer watchdog; every operation must settle once.

Add the end-to-end smoke harness before changing production behavior. Launch Electron with `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, and `--use-file-for-fake-audio-capture=<project WAV>`, enter recognizing state, click the microphone again, and require the interim text to clear within two seconds.

- [ ] **Step 2: Run `tests/voice-service.test.ts` and verify RED**

Run: `npx tsx --test --test-isolation=none tests/voice-service.test.ts`

Run: `npm run smoke:voice-ui`

Expected: the unit regression and `npm run smoke:voice-ui` both fail on the known stuck-state behavior.

- [ ] **Step 3: Replace capture-only state with one idempotent operation**

Define an internal `LocalVoiceOperation` before `getUserMedia()` with phase `starting | recording | recognizing | cancelling`, the session resources, callbacks, request number, watchdog, one-second elapsed-status timer, the recognition mode captured at start, and `settled`. Route success, error, cancel, startup failure, and timeout through `finishOperation(operation, result)`; that function must clear both timers, stop tracks, disconnect nodes, close AudioContext, emit `onInterim("")`, set listening false, and call at most one final/error callback. During `recognizing`, a microphone click must invoke the injected `cancelRecognize()` callback and settle locally before the IPC Promise resolves. Emit `正在本地识别… Ns` once per second, and perform state cleanup before `onFinal(text)` so `thinking` is not overwritten by a late idle callback.

Keep the current four constructor parameters source-compatible and append `cancelRecognize: () => Promise<void> = async () => undefined` plus an optional timer facade `{ setTimeout, clearTimeout }` for deterministic watchdog tests.

- [ ] **Step 4: Write failing main-process worker lifecycle tests**

Inject a fake worker factory and fake timers into `LocalAsrService`. Assert that two `warmup()` calls create one worker, `cancelCurrent()` rejects all pending requests and terminates it, decode timeout rejects with `本地语音识别超时` and terminates it, and the next recognition creates a fresh worker.

- [ ] **Step 5: Run `tests/local-asr-service.test.ts` and verify RED**

Run: `npx tsx --test --test-isolation=none tests/local-asr-service.test.ts`

Expected: FAIL because warmup/cancel and worker injection do not exist and the current timeout only drops one Promise.

- [ ] **Step 6: Implement worker lifecycle recovery**

Add `LocalAsrServiceOptions` with `createWorker(path)`, `initializationTimeoutMs`, and `recognitionTimeoutMs`, all defaulting to the real Worker and 30,000 ms. Type the injected worker as the `on/postMessage/terminate` subset used by the service. `warmup()` must validate status and await `ensureWorker()` without decoding. `recognize()` must start its 30 second total deadline before waiting on `status()`/`ensureWorker()`. `cancelCurrent()` and any request timeout must reject pending requests and call one worker-reset path that terminates the worker and clears initialization state. Pass the originating worker into message/error/exit handlers and ignore events unless `this.worker === worker`; reset even on unexpected exit code 0; catch synchronous `postMessage()` failures; and ensure `close()` terminates a worker only once.

- [ ] **Step 7: Wire cancellation and non-blocking warmup through Electron**

Expose `cancelLocalSpeechRecognition()` in preload and browser mock using `ipcRenderer.invoke("voice:cancel-local")`. In main, accept this IPC only from `petWindow`, call `localAsrService.cancelCurrent()`, call `void localAsrService.warmup().catch(console.warn)` after initialization without blocking window creation, and close the service during application shutdown. Pass the cancel bridge into the production `VoiceService` constructor. When input is disabled or recognition mode/language changes, Renderer must stop the current operation through the same cleanup path.

- [ ] **Step 8: Run focused tests and typecheck**

Run: `npx tsx --test --test-isolation=none tests/voice-service.test.ts tests/local-asr-service.test.ts && npm run typecheck && npm run smoke:voice-ui`

Expected: all voice tests pass, voice-related contract call sites typecheck, and the smoke prints `ELECTRON_LOCAL_ASR_UI_SMOKE_READY` after both success and cancellation paths.

- [ ] **Step 9: Commit**

```powershell
git add src/common/types.ts src/renderer/voice-service.ts src/renderer/renderer.ts src/renderer/browser-mock.ts src/main/local-asr-service.ts src/main/main.ts src/main/preload.ts tests/voice-service.test.ts tests/local-asr-service.test.ts scripts/local-asr-ui-smoke.cjs package.json
git commit -m "fix: make local speech lifecycle cancellable"
```

### Task 3: Global focus geometry and Live2D parameter capability binding

**Files:**
- Create: `src/renderer/live2d-interaction.ts`
- Create: `tests/live2d-interaction.test.ts`
- Modify: `src/main/desktop-movement-controller.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/browser-mock.ts`
- Modify: `src/renderer/renderer.ts`
- Modify: `src/renderer/live2d-pet-adapter.ts`

**Interfaces:**
- Consumes: `normalizeFocus()` from Task 1.
- Produces: `resolveFocusBindings(parameterIds)`, `advanceFocus(current,target,damping)`, and a single Electron global focus source.

- [ ] **Step 1: Write failing parameter-binding tests**

Cover standard Hiyori/Mao IDs, Wanko legacy IDs, partial parameters, and no parameters. The Wanko case must resolve `PARAM_ANGLE_X/Y/Z`, `PARAM_BODY_ANGLE_X/Y/Z`, `PARAM_EAR_L/R` and leave eye bindings empty. Damping must move toward the target without overshoot.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx --test --test-isolation=none tests/live2d-interaction.test.ts`

Expected: FAIL because the capability resolver does not exist.

- [ ] **Step 3: Implement pure binding resolution**

`resolveFocusBindings()` must consume the model's actual indexed parameter entries and return real parameter indices, selecting only present IDs from these alias families: `ParamEyeBallX/Y`, `ParamAngleX/Y/Z`, `ParamBodyAngleX`, `PARAM_ANGLE_X/Y/Z`, `PARAM_BODY_ANGLE_X/Y/Z`, `PARAM_EAR_L/R`. Enumerate with `getParameterCount()` and `getParameterId(index)`; write with `addParameterValueByIndex()` so absent names never pass through `getIdSafe()` and cannot create virtual-parameter false positives.

- [ ] **Step 4: Migrate main focus geometry and remove Renderer-local tracking**

Have `DesktopMovementController.emitFocus()` call `normalizeFocus(cursor, { x: bounds.x + bounds.width/2, y: bounds.y + bounds.height - Math.min(330,bounds.height)/2 })`. Remove `window.pointermove` registration and cleanup from `Live2DPetAdapter`. Keep browser preview focus events in `browser-mock.ts` via the bridge listener rather than direct adapter input.

- [ ] **Step 5: Apply bindings in `beforeModelUpdate`**

Enumerate `coreModel.getParameterCount()` and `coreModel.getParameterId(index)` after model load. Each frame, damp current focus toward target, then add eye/head/body values with model-profile weights. When no eye XY exists, use larger head/body weights; for Wanko, offset left/right ears in opposite directions. Clamp all additions and skip absent bindings without unloading the model.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx tsx --test --test-isolation=none tests/pet-motion.test.ts tests/live2d-interaction.test.ts && npm run typecheck`

Expected: focused tests and typecheck pass.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/live2d-interaction.ts tests/live2d-interaction.test.ts src/main/desktop-movement-controller.ts src/main/main.ts src/main/preload.ts src/renderer/browser-mock.ts src/renderer/renderer.ts src/renderer/live2d-pet-adapter.ts
git commit -m "feat: add capability-aware Live2D focus tracking"
```

### Task 4: Continuous drag, fall, and landing motion frames

**Files:**
- Modify: `src/main/pet-motion.ts`
- Modify: `src/main/desktop-movement-controller.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/browser-mock.ts`
- Modify: `src/renderer/renderer.ts`
- Modify: `src/renderer/model-adapter.ts`
- Modify: `src/renderer/live2d-pet-adapter.ts`
- Modify: `tests/pet-motion.test.ts`

**Interfaces:**
- Consumes: `PetMotionFrame` and `clampMotionFrame()` from Task 1.
- Produces: per-tick `onPetMotion` frames and stable `falling → landing → idle` transitions.

- [ ] **Step 1: Add failing motion sequence tests**

Test the pure `deriveMotionFrame(previousBounds, nextBounds, elapsedMs, state)` and landing reducer: right and left drag deltas yield opposite `velocityX`; all velocity/offset values remain bounded; ground contact emits `landing`; and after 320 ms the state becomes `idle`. Use injected time and positions so the test has no real waits.

- [ ] **Step 2: Run the motion test and verify RED**

Run: `npx tsx --test --test-isolation=none tests/pet-motion.test.ts`

Expected: FAIL because the controller emits only deduplicated discrete states and has no landing state.

- [ ] **Step 3: Calculate and emit a frame on every movement tick**

Implement `deriveMotionFrame()` and the landing reducer in `pet-motion.ts` without importing Electron. In the controller, track previous window coordinates/time. Normalize `offsetX` by window width and `offsetY` by window height; normalize velocities against fixed exported pixels-per-second scales and clamp through `clampMotionFrame()`. Preserve the horizontal drag velocity when falling starts. At ground contact set `landingUntil = now + 320`, emit landing frames, then return to idle and schedule roaming after the landing interval. Emit a frame every 33 ms while moving or landing; do not deduplicate by state.

- [ ] **Step 4: Migrate bridge and adapters**

Replace `pet:locomotion` payloads/listeners with `pet:motion` and `PetMotionFrame`. Change `PetModelAdapter.setLocomotion()` to `setMotion(frame)`. Migrate `Live2DPetAdapter` in the same task by storing the latest frame and using its state in the existing transform path; Task 5 then adds springs. The default CSS adapter must still set `data-locomotion` and also publish CSS variables for velocity and offsets. Replace Renderer `currentLocomotion` with `currentMotion`, including model hot-switch state restoration.

In the same contract migration, replace `PetAgentBridge.onLocomotion(listener)` with `onPetMotion(listener: (frame: PetMotionFrame) => void)`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx tsx --test --test-isolation=none tests/pet-motion.test.ts && npm run typecheck`

Expected: the motion suite and all cross-process types pass.

- [ ] **Step 6: Commit**

```powershell
git add src/main/pet-motion.ts src/main/desktop-movement-controller.ts src/main/main.ts src/main/preload.ts src/renderer/browser-mock.ts src/renderer/renderer.ts src/renderer/model-adapter.ts src/renderer/live2d-pet-adapter.ts tests/pet-motion.test.ts
git commit -m "feat: stream drag fall and landing motion"
```

### Task 5: Live2D springs, real motion durations, and semantic action fallback

**Files:**
- Modify: `src/common/types.ts`
- Modify: `src/renderer/live2d-interaction.ts`
- Modify: `src/renderer/live2d-pet-adapter.ts`
- Modify: `src/renderer/styles.css`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/browser-mock.ts`
- Modify: `tests/live2d-interaction.test.ts`

**Interfaces:**
- Consumes: `PetMotionFrame` and focus bindings.
- Produces: the expanded `PetAction` union, `computePetTransform()`, `resolveActionMotion()`, `motionDurationMs()`, and a procedural fallback transform for every action.

- [ ] **Step 1: Write failing transform, mapping, and duration tests**

Assert opposite drag velocity creates opposite rotation; falling increases stretch; landing at 0, 160, and 320 ms produces compression, rebound, and neutral values. Parse one real Hiyori, Mao, and Wanko motion JSON and assert returned duration equals clamped `Meta.Duration * 1000`. Assert every action has a valid bundled group/index or a procedural fallback.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx --test --test-isolation=none tests/live2d-interaction.test.ts`

Expected: FAIL because transforms are fixed and action duration is hard-coded.

- [ ] **Step 3: Implement damped motion transforms**

Use an internal spring updated from the latest frame in `beforeModelUpdate`. Grabbed uses opposite body lag, continuous `velocityX` rotation, and upward stretch; falling keeps horizontal lean and increases vertical stretch; landing uses a 320 ms damped compression/rebound curve. Apply translation, rotation, and non-uniform scale on top of `baseScale` while preserving walk mirroring.

Expand `PetAction` in `src/common/types.ts` to `wave | nod | shake-head | head-tilt | jump | cheer | dance | sit | stretch | shy | comfort | sleep | surprised` before defining the complete action maps.

- [ ] **Step 4: Expand action mapping and parse resource duration**

Provide explicit Hiyori/Mao/Wanko entries for all 13 actions. Validate the selected group/index instead of silently repairing an invalid bundled map with modulo. When a selected asset exists, follow the model3 motion reference, decode its `.motion3.json`, read finite positive `Meta.Duration`, and clamp to 600–12,000 ms so the existing 8.57–10.367 second bundled actions are not cut short. If the semantic motion is absent, retain the action CSS class and apply a procedural nod, shake, head tilt, jump, cheer, stretch, shy, comfort, sleep, or surprised transform for a deterministic fallback duration.

Update the main whitelist and exhaustive native-menu label record, the settings action grid, and browser mock in the same task as the `PetAction` union so the commit remains type-safe and all 13 actions are manually previewable.

- [ ] **Step 5: Update CSS states without competing with model transforms**

Keep canvas effects for shadow/glow and lightweight fallback motion, add `.locomotion-landing`, and add classes for the seven new actions. Remove fixed drag/fall keyframes that fight the adapter's continuous transform.

On model hot-switch and destroy, clear action/motion timers and spring state while preserving the existing Pixi ticker, texture, and Moc destruction order.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npx tsx --test --test-isolation=none tests/live2d-interaction.test.ts && npm run typecheck`

Expected: all interaction tests pass and the adapter typechecks.

- [ ] **Step 7: Commit**

```powershell
git add src/common/types.ts src/renderer/live2d-interaction.ts src/renderer/live2d-pet-adapter.ts src/renderer/styles.css src/main/main.ts src/renderer/index.html src/renderer/browser-mock.ts tests/live2d-interaction.test.ts
git commit -m "feat: add natural Live2D motion and action fallback"
```

### Task 6: Emotion inference, reaction director, and action controls

**Files:**
- Modify: `src/common/types.ts`
- Create: `src/main/reaction-inference.ts`
- Create: `src/renderer/pet-reaction-director.ts`
- Create: `tests/reaction.test.ts`
- Modify: `src/main/agent-service.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/renderer.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/browser-mock.ts`

**Interfaces:**
- Produces: the expanded `PetEmotion` union, `inferReaction(userText, responseText): PetEmotion`, `PetReactionDirector.choose(input): PetAction | undefined`, and `PetReactionDirector.flush(input): PetAction | undefined`.
- Consumers: `AgentService.respond()` and Renderer `handleResponse()`.

- [ ] **Step 1: Write failing inference and scheduling tests**

Use table tests for happy, excited, curious, thinking, comforting, shy, surprised, and sleepy. Verify the classifier uses both user and response text, including a distressed user plus reassuring response returning `comforting`. With a deterministic random source, assert strong-action cooldown, one action maximum per reply, and no automatic action during listening, dragged, falling, or landing.

- [ ] **Step 2: Run the reaction test and verify RED**

Run: `npx tsx --test --test-isolation=none tests/reaction.test.ts`

Expected: FAIL because the classifier only inspects response text and there is no director.

- [ ] **Step 3: Implement deterministic emotion inference**

Order high-signal rules so distress/support wins before generic punctuation, surprise before excitement, and sleep before neutral. Keep the function local and pure; do not add a model call or require JSON from the chat provider. Use it for normal and proactive `ChatResponse` creation.

Expand `PetEmotion` in `src/common/types.ts` to `idle | happy | excited | thinking | curious | listening | speaking | comforting | shy | surprised | sleepy`, and update every exhaustive expression/state mapping in the same change.

- [ ] **Step 4: Implement the reaction director**

Map emotions to restrained action pools: curious/thinking to `nod/head-tilt/sit`, comforting to `comfort/nod`, shy to `shy/head-tilt`, excited to `cheer/jump/dance`, surprised to `surprised`, happy occasionally to `wave/cheer`, sleepy to `stretch/sleep`. Use reply text to prefer greeting/affirmation/negative gestures such as wave/nod/shake-head. Accept injected `now` and `random`; enforce a cooldown for jump/cheer/dance/surprised. Store at most one pending automatic reaction while voice or locomotion has priority, then release it when voice and motion return idle. Manual `onPetAction` previews bypass this queue and remain higher priority.

- [ ] **Step 5: Integrate Renderer and all action entry points**

In `handleResponse()`, update emotion immediately, ask the director for at most one action, and play it only when allowed. Resume a deferred low-priority reaction after listening/landing if it remains current. The main whitelist, native menu labels, browser mock, and settings action grid were expanded atomically with `PetAction` in Task 5; verify those entry points here without duplicating the lists.

- [ ] **Step 6: Run focused and full tests**

Run: `npx tsx --test --test-isolation=none tests/reaction.test.ts tests/voice-service.test.ts tests/live2d-interaction.test.ts && npm test`

Expected: the focused suites pass and the full suite has zero failures.

- [ ] **Step 7: Commit**

```powershell
git add src/common/types.ts src/main/reaction-inference.ts src/renderer/pet-reaction-director.ts tests/reaction.test.ts src/main/agent-service.ts src/main/main.ts src/renderer/renderer.ts src/renderer/index.html src/renderer/browser-mock.ts
git commit -m "feat: direct semantic actions from reply emotion"
```

### Task 7: Documentation, regression, and visual acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/LIVE2D_MODEL_GUIDE.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: all completed runtime behavior and exact fresh verification evidence.
- Produces: updated AI handoff context and user documentation.

- [ ] **Step 1: Update user and architecture documentation**

Document cancel-during-recognition semantics, non-blocking ASR warmup, 30/35 second limits, the new `smoke:voice-ui`, single global focus source, standard/legacy parameter aliases, continuous `PetMotionFrame`, landing behavior, expanded emotions/actions, real motion durations, and procedural imported-model fallback. Update known limitations without claiming partial ASR or local neural TTS.

- [ ] **Step 2: Run the complete automated verification matrix**

Run each separately and retain exit status/output:

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
npm run smoke:voice
npm run smoke:voice-ui
npm run smoke:model-switch
npm audit
```

Expected: every command exits 0; both voice smoke markers and the model-switch marker appear; audit reports zero vulnerabilities.

- [ ] **Step 3: Perform three-model visual acceptance**

Capture Hiyori and Mao at left/center/right and up/down focus positions, Wanko at left/right with visible head/ear changes, and drag/fall/landing frames. Trigger happy, excited, curious, comforting, surprised, and sleepy reactions. Confirm hot switching keeps focus, action, lip sync, and console free of Cubism assertions or destruction warnings. Save evidence only under ignored `output/`.

- [ ] **Step 4: Re-read the design and inspect the final diff**

Compare every requirement in `docs/superpowers/specs/2026-07-14-voice-live2d-interaction-design.md` with the implementation, run `git diff --check`, and confirm no generated files, voice models, secrets, or diagnostic data are tracked.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md docs/ARCHITECTURE.md docs/LIVE2D_MODEL_GUIDE.md AGENTS.md
git commit -m "docs: describe voice and Live2D interaction upgrades"
```
