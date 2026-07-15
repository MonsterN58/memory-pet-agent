import { DEFAULT_SETTINGS } from "../common/defaults";
import type {
  AgentSettings,
  ChatResponse,
  ComputerActionDecision,
  ComputerActionProposal,
  ComputerIntegrationState,
  ControlPanelView,
  EditableMemoryKind,
  MemoryRecord,
  MemoryScoreBreakdown,
  MemorySnapshot,
  LocalSpeechModelStatus,
  PublicSettingsState,
  PublicModelState,
  PetAction,
  PetEmotion,
  PetFocus,
  PetMotionFrame,
  PersonalityDimension,
  PersonalityProfile,
  SettingsUpdate,
} from "../common/types";
import type { PetModelAdapter } from "./model-adapter";
import { DefaultPetAdapter } from "./model-adapter";
import { Live2DPetAdapter } from "./live2d-pet-adapter";
import { localSpeechControlState, localSpeechStatusText } from "./local-speech-status";
import { PetReactionCoordinator, PetReactionDirector } from "./pet-reaction-director";
import { PetUiLifecycle } from "./pet-ui-command";
import { VoiceService } from "./voice-service";

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
}

const bridge = window.petAgent;
const params = new URLSearchParams(location.search);
const panelMode = params.get("mode") === "panel";
document.body.classList.toggle("panel-mode", panelMode);
must<HTMLElement>("#pet-app").hidden = panelMode;
must<HTMLElement>("#panel-app").hidden = !panelMode;

let settingsState: PublicSettingsState = {
  settings: structuredClone(DEFAULT_SETTINGS),
  hasApiKey: false,
  hasTtsApiKey: false,
  dataDirectory: "",
};

function input(selector: string): HTMLInputElement {
  return must<HTMLInputElement>(selector);
}

function kindLabel(kind: MemoryRecord["kind"]): string {
  return { dialogue: "对话", episode: "事件", fact: "事实", preference: "偏好", reflection: "反思" }[kind];
}

if (panelMode) void initializePanel((params.get("view") as ControlPanelView | null) ?? "settings");
else void initializePet();

async function initializePet(): Promise<void> {
  const petApp = must<HTMLElement>("#pet-app");
  const hitArea = must<HTMLElement>("#pet-hit-area");
  const dialog = must<HTMLElement>("#pet-dialog");
  const dialogueLog = must<HTMLElement>("#pet-dialogue-log");
  const messageInput = must<HTMLInputElement>("#pet-message-input");
  const sendButton = must<HTMLButtonElement>("#pet-send-button");
  const micButton = must<HTMLButtonElement>("#pet-mic-button");
  const computerActionCard = must<HTMLElement>("#computer-action-card");
  const toast = must<HTMLElement>("#pet-toast");
  let model: PetModelAdapter = new DefaultPetAdapter();
  const mount = must<HTMLElement>("#pet-mount");
  model.mount(mount);
  model.resize(mount.clientWidth, mount.clientHeight);
  let busy = false;
  let hideTimer: number | undefined;
  let toastTimer: number | undefined;
  let clickThrough = true;
  let pointerDown = false;
  let dragActive = false;
  let dragPointerId: number | undefined;
  let dragStartX = 0;
  let dragStartY = 0;
  let suppressClick = false;
  let dragStartRequest: Promise<void> | undefined;
  let currentEmotion: PetEmotion = "idle";
  let currentMotion: PetMotionFrame = {
    state: "idle", velocityX: 0, velocityY: 0, offsetX: 0, offsetY: 0,
  };
  let currentFocus: PetFocus = { x: 0, y: 0 };
  let modelLoadPending = false;
  let modelLoadAnnounce = false;
  let modelSwitchTask: Promise<void> | undefined;
  let localSpeechStatus: LocalSpeechModelStatus | undefined;
  let localSpeechStatusRevision = 0;

  function setClickThrough(ignore: boolean): void {
    if (ignore === clickThrough) return;
    clickThrough = ignore;
    void bridge.setPetClickThrough(ignore);
  }

  function showDialog(
    focusInput = false,
    autoHideMs?: number,
    presentation: "interactive" | "caption" = "interactive",
  ): void {
    if (pointerDown) return;
    if (hideTimer) window.clearTimeout(hideTimer);
    petApp.classList.add("dialog-visible");
    const showComposer = presentation === "interactive" || busy || dialog.contains(document.activeElement);
    petApp.classList.toggle("composer-visible", showComposer);
    void bridge.setPetInteraction(true);
    setClickThrough(false);
    if (focusInput) window.setTimeout(() => messageInput.focus(), 30);
    if (autoHideMs) hideTimer = window.setTimeout(() => {
      if (hideDialog()) setClickThrough(true);
    }, autoHideMs);
  }

  function hideDialog(): boolean {
    if (dialog.contains(document.activeElement)) return false;
    petApp.classList.remove("dialog-visible");
    petApp.classList.remove("composer-visible");
    void bridge.setPetInteraction(false);
    return true;
  }

  function scheduleHide(): void {
    if (pointerDown) return;
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (hideDialog()) setClickThrough(true);
    }, 850);
  }

  function showToast(text: string): void {
    toast.textContent = text;
    toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3000);
  }

  const voice = new VoiceService(
    () => settingsState.settings,
    (text) => bridge.synthesizeSpeech(text),
    showToast,
    (audio) => bridge.recognizeLocalSpeech(audio),
    () => bridge.cancelLocalSpeechRecognition(),
  );

  function updateMicControl(): void {
    const state = localSpeechControlState({
      inputEnabled: settingsState.settings.voice.inputEnabled,
      recognitionMode: settingsState.settings.voice.recognitionMode,
      supported: voice.supported(),
      status: localSpeechStatus,
    });
    micButton.disabled = state.disabled;
    micButton.title = state.title;
  }

  function applyLocalSpeechStatus(status: LocalSpeechModelStatus): void {
    localSpeechStatusRevision += 1;
    localSpeechStatus = status;
    updateMicControl();
  }

  function appendLine(role: "user" | "assistant", text: string): void {
    const line = document.createElement("p");
    line.className = role === "user" ? "user-line" : "assistant-line";
    line.textContent = text;
    dialogueLog.replaceChildren(line);
    dialogueLog.scrollTop = dialogueLog.scrollHeight;
  }

  function setModelEmotion(state: PetEmotion): void {
    currentEmotion = state;
    model.setState(state);
  }

  function playModelAction(action: PetAction): void {
    if (!model.playAction(action)) showToast(`当前模型暂时无法播放“${action}”动作。`);
  }

  const reactions = new PetReactionCoordinator(new PetReactionDirector(), {
    setEmotion: setModelEmotion,
    playAction: playModelAction,
  });
  const uiLifecycle = new PetUiLifecycle({
    focusChat: () => showDialog(true),
    stopVoiceInput: () => voice.stop(),
    stopVoiceOutput: () => voice.cancelSpeech(),
  });

  function setModelMotion(frame: PetMotionFrame): void {
    currentMotion = frame;
    model.setMotion(frame);
    reactions.setMotion(frame.state);
  }

  async function switchModel(next: PetModelAdapter): Promise<void> {
    const previous = model;
    const staging = document.createElement("div");
    staging.className = "model-staging";
    mount.append(staging);
    try {
      await next.mount(staging);
      next.resize(mount.clientWidth, mount.clientHeight);
      next.setMotion(currentMotion);
      next.setState(currentEmotion);
      next.setFocus(currentFocus);
      const nextRoot = staging.firstElementChild;
      if (!nextRoot) throw new Error("模型没有生成可显示的画面");
      mount.replaceChildren(nextRoot);
      model = next;
      try {
        previous.destroy();
      } catch (error) {
        console.warn("Previous model cleanup failed", error instanceof Error ? error.stack : error);
      }
      console.info(`LIVE2D_MODEL_READY ${next.id}`);
    } catch (error) {
      next.destroy();
      staging.remove();
      throw error;
    }
  }

  async function loadConfiguredModel(announce = false): Promise<void> {
    modelLoadPending = true;
    modelLoadAnnounce ||= announce;
    if (!modelSwitchTask) {
      modelSwitchTask = (async () => {
        while (modelLoadPending) {
          modelLoadPending = false;
          const shouldAnnounce = modelLoadAnnounce;
          modelLoadAnnounce = false;
          try {
            const assets = await bridge.getActiveModel();
            const next: PetModelAdapter = new Live2DPetAdapter(assets);
            if (next.id === model.id) continue;
            await switchModel(next);
            if (shouldAnnounce) showToast(`已切换 Live2D 模型：${assets.info.name}`);
          } catch (error) {
            console.error("Live2D model loading failed", error);
            showToast(`Live2D 加载失败，已保留当前模型：${error instanceof Error ? error.message : "资源无效"}`);
          }
        }
      })().finally(() => {
        modelSwitchTask = undefined;
      });
    }
    return modelSwitchTask;
  }

  function beginPointerDrag(event: PointerEvent): void {
    if (event.button !== 0 || pointerDown) return;
    pointerDown = true;
    dragActive = false;
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    suppressClick = false;
    hitArea.classList.add("dragging");
    hitArea.setPointerCapture(event.pointerId);
    if (hideTimer) window.clearTimeout(hideTimer);
    if (dialog.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    petApp.classList.remove("dialog-visible");
    petApp.classList.remove("composer-visible");
    void bridge.setPetInteraction(false);
    setClickThrough(false);
  }

  function updatePointerDrag(event: PointerEvent): void {
    if (!pointerDown) return;
    event.preventDefault();
    if (dragActive || Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) < 5) return;
    dragActive = true;
    suppressClick = true;
    dragStartRequest = bridge.startPetDrag().catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : "暂时无法拖动桌宠");
    });
  }

  function finishPointerDrag(event: PointerEvent): void {
    if (!pointerDown) return;
    pointerDown = false;
    hitArea.classList.remove("dragging");
    if (hitArea.hasPointerCapture(event.pointerId)) hitArea.releasePointerCapture(event.pointerId);
    if (dragActive) {
      const startRequest = dragStartRequest;
      void (async () => {
        if (startRequest) await startRequest;
        await bridge.endPetDrag();
      })().catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "桌宠落地失败");
      });
    }
    dragActive = false;
    dragPointerId = undefined;
    dragStartRequest = undefined;
    void bridge.setPetInteraction(false);
    scheduleHide();
    if (suppressClick) window.setTimeout(() => {
      suppressClick = false;
    }, 0);
  }

  function applyPetSettings(state: PublicSettingsState): void {
    const previousVoice = settingsState.settings.voice;
    settingsState = state;
    must<HTMLElement>("#pet-agent-name").textContent = state.settings.agentName;
    updateMicControl();
    if (
      !state.settings.voice.inputEnabled
      || previousVoice.recognitionMode !== state.settings.voice.recognitionMode
      || previousVoice.language !== state.settings.voice.language
    ) voice.stop();
    if (
      !state.settings.voice.outputEnabled
      || previousVoice.ttsMode !== state.settings.voice.ttsMode
      || previousVoice.language !== state.settings.voice.language
      || previousVoice.ttsBaseUrl !== state.settings.voice.ttsBaseUrl
      || previousVoice.ttsModel !== state.settings.voice.ttsModel
      || previousVoice.ttsVoice !== state.settings.voice.ttsVoice
      || previousVoice.ttsSpeed !== state.settings.voice.ttsSpeed
    ) voice.cancelSpeech();
  }

  function handleResponse(response: ChatResponse): void {
    appendLine("assistant", response.text);
    must<HTMLElement>("#pet-mode-badge").textContent = response.source === "provider" ? "模型在线" : "本地陪伴";
    reactions.handleResponse(response);
    const hasComputerAction = renderComputerActions(response.computerActions ?? []);
    uiLifecycle.presentResponse(() => {
      void model.speak(response.text);
      voice.speak(response.text);
      showDialog(false, hasComputerAction ? undefined : 12_000, hasComputerAction ? "interactive" : "caption");
      if (response.warning) showToast(response.warning);
    });
  }

  function renderComputerActions(actions: ComputerActionProposal[]): boolean {
    const proposal = actions[0];
    if (!proposal) {
      computerActionCard.hidden = true;
      return false;
    }
    computerActionCard.hidden = false;
    must<HTMLElement>("#computer-action-title").textContent = proposal.title;
    must<HTMLElement>("#computer-action-description").textContent = proposal.description;
    must<HTMLElement>("#computer-action-preview").textContent = proposal.preview;
    const buttons = must<HTMLElement>("#computer-action-buttons");
    buttons.replaceChildren();
    const labels: Record<ComputerActionDecision, string> = {
      "allow-once": proposal.requiresApproval ? "仅本次" : "执行",
      "allow-session": "本次会话",
      "allow-always": "始终允许",
      deny: "不做",
    };
    for (const decision of [...proposal.allowedDecisions].reverse()) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = labels[decision];
      if (decision === "allow-once") button.classList.add("primary");
      if (decision === "deny") button.classList.add("danger");
      button.addEventListener("click", async () => {
        buttons.querySelectorAll("button").forEach((item) => { item.disabled = true; });
        try {
          const result = await bridge.executeComputerAction(proposal.id, decision);
          computerActionCard.hidden = true;
          appendLine("assistant", result.message);
          showToast(result.message);
          if (result.status === "completed") setModelEmotion("happy");
          showDialog(false, 6000, "caption");
        } catch (error) {
          showToast(error instanceof Error ? error.message : "电脑操作失败");
          buttons.querySelectorAll("button").forEach((item) => { item.disabled = false; });
        }
      });
      buttons.append(button);
    }
    return true;
  }

  async function sendMessage(raw?: string): Promise<void> {
    const text = (raw ?? messageInput.value).trim();
    if (!text || busy) return;
    busy = true;
    sendButton.disabled = true;
    messageInput.disabled = true;
    messageInput.value = "";
    appendLine("user", text);
    setModelEmotion("thinking");
    try {
      handleResponse(await bridge.chat(text));
    } catch (error) {
      const message = error instanceof Error ? error.message : "发送失败";
      appendLine("assistant", `刚才没有顺利处理：${message}`);
      showToast(message);
      setModelEmotion("idle");
    } finally {
      busy = false;
      sendButton.disabled = false;
      messageInput.disabled = false;
      messageInput.focus();
    }
  }

  must<HTMLFormElement>("#pet-composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });
  messageInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    messageInput.blur();
    if (hideDialog()) setClickThrough(true);
  });
  micButton.addEventListener("click", () => {
    voice.start(
      (text) => void sendMessage(text),
      (text) => {
        messageInput.value = text;
      },
      (listening, error) => {
        micButton.classList.toggle("listening", listening);
        reactions.setVoiceActive(listening);
        if (error) showToast(error);
      },
    );
  });

  document.addEventListener("pointermove", (event) => {
    if (pointerDown) {
      updatePointerDrag(event);
      setClickThrough(false);
      return;
    }
    const target = event.target as Element | null;
    const interactive = Boolean(target?.closest("[data-interactive]"));
    setClickThrough(!interactive);
    if (interactive) showDialog();
    else scheduleHide();
  });
  petApp.addEventListener("pointerleave", scheduleHide);
  dialog.addEventListener("pointerenter", () => showDialog());
  hitArea.addEventListener("pointerenter", () => showDialog());
  hitArea.addEventListener("pointerdown", beginPointerDrag);
  hitArea.addEventListener("pointermove", updatePointerDrag);
  hitArea.addEventListener("pointerup", finishPointerDrag);
  hitArea.addEventListener("pointercancel", finishPointerDrag);
  hitArea.addEventListener("click", () => {
    if (suppressClick) return;
    showDialog(true);
  });
  dialog.addEventListener("focusin", () => showDialog());
  dialog.addEventListener("focusout", () => window.setTimeout(scheduleHide, 0));
  window.addEventListener("blur", () => {
    if (pointerDown) return;
    if (hideTimer) window.clearTimeout(hideTimer);
    petApp.classList.remove("dialog-visible");
    petApp.classList.remove("composer-visible");
    void bridge.setPetInteraction(false);
    setClickThrough(true);
  });
  window.addEventListener("resize", () => model.resize(mount.clientWidth, mount.clientHeight));

  bridge.onPetMotion(setModelMotion);
  bridge.onPetFocus((focus) => {
    currentFocus = focus;
    model.setFocus(focus);
  });
  bridge.onPetAction((action) => reactions.playManualAction(action));
  bridge.onModelChanged(() => void loadConfiguredModel(true));
  bridge.onUiCommand((command) => uiLifecycle.handle(command));
  bridge.onProactiveMessage((response) => {
    uiLifecycle.resume();
    handleResponse(response);
  });
  bridge.onSettingsChanged(applyPetSettings);
  bridge.onLocalSpeechStatusChanged(applyLocalSpeechStatus);

  try {
    const state = await bridge.bootstrap();
    applyPetSettings(state.settings);
    must<HTMLElement>("#pet-mode-badge").textContent = state.providerMode === "provider" ? "模型在线" : "本地陪伴";
    dialogueLog.replaceChildren();
    appendLine("assistant", `嗨，${state.settings.settings.userName}。鼠标靠近我就能聊天，右键可以打开全部设置。`);
    const statusRevision = localSpeechStatusRevision;
    const initialLocalStatus = await bridge.getLocalSpeechStatus();
    if (localSpeechStatusRevision === statusRevision) applyLocalSpeechStatus(initialLocalStatus);
    await loadConfiguredModel();
    setClickThrough(true);
  } catch (error) {
    appendLine("assistant", `初始化失败：${error instanceof Error ? error.message : "未知错误"}`);
    showDialog(false, 10_000, "caption");
  }
}

async function initializePanel(initialView: ControlPanelView): Promise<void> {
  const panelToast = must<HTMLElement>("#panel-toast");
  let toastTimer: number | undefined;

  function showToast(text: string, duration = 3200): void {
    panelToast.textContent = text;
    panelToast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      panelToast.hidden = true;
    }, duration);
  }

  function renderComputerState(state: ComputerIntegrationState): void {
    const bridgeState = must<HTMLElement>("#computer-bridge-state");
    bridgeState.textContent = state.browserBridgeRunning
      ? "浏览器桥接已就绪"
      : state.enabled ? "浏览器桥接未开启" : "电脑协作未开启";
    bridgeState.dataset.state = state.browserBridgeRunning ? "ready" : "off";
    must<HTMLElement>("#computer-shortcut-state").textContent = state.clipboardShortcutRegistered
      ? `${state.clipboardShortcut} 已注册`
      : "快捷键未注册";
    must<HTMLElement>("#computer-bridge-endpoint").textContent = state.endpoint;
    const message = must<HTMLElement>("#computer-bridge-message");
    message.textContent = state.browserBridgeMessage;
    message.title = `扩展目录：${state.extensionDirectory}`;

    const list = must<HTMLElement>("#computer-audit-list");
    list.replaceChildren();
    if (state.recentAudit.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "暂无电脑协作记录";
      list.append(empty);
      return;
    }
    const statusLabel = {
      pending: "待确认", completed: "完成", denied: "拒绝", cancelled: "取消", failed: "失败",
    } as const;
    for (const entry of state.recentAudit) {
      const item = document.createElement("article");
      item.className = "computer-audit-item";
      item.dataset.status = entry.status;
      const badge = document.createElement("b");
      badge.textContent = statusLabel[entry.status];
      const summary = document.createElement("p");
      summary.textContent = entry.summary;
      const time = document.createElement("time");
      time.dateTime = entry.updatedAt;
      time.textContent = new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).format(new Date(entry.updatedAt));
      item.append(badge, summary, time);
      if (entry.detail) {
        const detail = document.createElement("small");
        detail.textContent = entry.detail;
        item.append(detail);
      }
      list.append(item);
    }
  }

  async function refreshComputerState(): Promise<void> {
    try {
      renderComputerState(await bridge.getComputerIntegrationState());
    } catch (error) {
      showToast(error instanceof Error ? error.message : "电脑协作状态读取失败", 5000);
    }
  }

  function renderCounts(snapshot: MemorySnapshot): void {
    must<HTMLElement>("#l1-count").textContent = String(snapshot.l1.length);
    must<HTMLElement>("#l2-count").textContent = String(snapshot.l2.length);
    must<HTMLElement>("#l3-count").textContent = String(snapshot.l3.length);
  }

  function renderPersonality(profile: PersonalityProfile): void {
    const stageLabels: Record<PersonalityProfile["stage"], string> = {
      blank: "空白期",
      forming: "萌芽期",
      developing: "成长期",
      established: "稳定期",
    };
    const traitLabels: Record<PersonalityDimension, string> = {
      warmth: "温暖度",
      curiosity: "好奇度",
      playfulness: "俏皮度",
      directness: "直接度",
      initiative: "主动度",
      expressiveness: "表达度",
    };
    must<HTMLElement>("#personality-stage").textContent = stageLabels[profile.stage];
    must<HTMLElement>("#personality-interactions").textContent = `${profile.interactionCount} 次互动`;
    must<HTMLElement>("#personality-summary").textContent = profile.summary;
    const list = must<HTMLElement>("#personality-traits");
    list.replaceChildren();
    if (!profile.traits.length) {
      const empty = document.createElement("div");
      empty.className = "personality-empty";
      empty.textContent = "目前没有已观察到的特质证据。";
      list.append(empty);
      return;
    }
    for (const trait of profile.traits) {
      const row = document.createElement("div");
      row.className = "personality-trait";
      const header = document.createElement("div");
      const label = document.createElement("strong");
      label.textContent = traitLabels[trait.dimension];
      const value = document.createElement("span");
      value.textContent = `${Math.round(trait.score * 100)} · 置信 ${Math.round(trait.confidence * 100)}%`;
      header.append(label, value);
      const track = document.createElement("div");
      track.className = "personality-track";
      const fill = document.createElement("span");
      fill.style.width = `${Math.round(trait.score * 100)}%`;
      track.append(fill);
      const evidence = document.createElement("small");
      evidence.textContent = `证据 ${trait.evidenceCount} 次 · 最近：${trait.lastEvidence || "等待更多互动"}`;
      row.append(header, track, evidence);
      list.append(row);
    }
  }

  function renderModelState(state: PublicModelState): void {
    const name = must<HTMLElement>("#model-state-name");
    const details = must<HTMLElement>("#model-state-details");
    const select = must<HTMLSelectElement>("#model-bundled-select");
    name.textContent = state.model.name;
    details.textContent = `Cubism model3 v${state.model.settingsVersion} · ${state.model.textureCount} 张贴图 · ${state.model.motionCount} 个 motion · ${state.model.expressionCount} 个表情${state.model.lipSyncParameters.length ? " · 支持口型" : ""}${state.kind === "imported" ? " · 用户导入" : " · 官方样例"}`;
    select.replaceChildren(...state.bundledModels.map((model) => new Option(model.name, model.id)));
    select.value = state.kind === "bundled" ? state.model.id : state.bundledModels[0]?.id ?? "";
  }

  interface DisplayMemory {
    memory: MemoryRecord;
    score?: MemoryScoreBreakdown;
  }

  const editableKinds: EditableMemoryKind[] = ["episode", "fact", "preference", "reflection"];

  function formatDateTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
  }

  function snapshotItems(snapshot: MemorySnapshot): DisplayMemory[] {
    return [...snapshot.l3, ...snapshot.l2, ...snapshot.l1]
      .reverse()
      .map((memory) => ({ memory }));
  }

  function renderSnapshot(snapshot: MemorySnapshot): void {
    renderCounts(snapshot);
    renderMemory(snapshotItems(snapshot));
  }

  function renderMemory(items: DisplayMemory[]): void {
    const list = must<HTMLElement>("#memory-list");
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "还没有可展示的记忆。和桌宠聊一会儿，或明确保存一件事吧。";
      list.append(empty);
      return;
    }
    for (const item of items) {
      const { memory: record, score } = item;
      const card = document.createElement("article");
      card.className = "memory-card";
      card.dataset.tier = record.tier;
      card.dataset.memoryId = record.id;
      const header = document.createElement("header");
      const tier = document.createElement("b");
      tier.textContent = `${record.tier} · ${kindLabel(record.kind)}`;
      const time = document.createElement("time");
      time.textContent = new Date(record.updatedAt).toLocaleDateString("zh-CN");
      time.dateTime = record.updatedAt;
      header.append(tier, time);
      const content = document.createElement("p");
      content.textContent = record.summary || record.content;
      const footer = document.createElement("footer");
      footer.textContent = `重要度 ${Math.round(record.importance * 100)}% · 访问 ${record.accessCount} 次${record.tags.length ? ` · ${record.tags.slice(0, 3).join(" / ")}` : ""}`;

      const details = document.createElement("details");
      details.className = "memory-details";
      const detailsSummary = document.createElement("summary");
      detailsSummary.textContent = "查看详情与来源";
      const fullContent = document.createElement("p");
      fullContent.className = "memory-full-content";
      fullContent.textContent = record.content;
      const metadata = document.createElement("dl");
      metadata.className = "memory-metadata";
      const metadataRows: Array<[string, string]> = [
        ["创建时间", formatDateTime(record.createdAt)],
        ["更新时间", formatDateTime(record.updatedAt)],
        ["最近访问", formatDateTime(record.accessedAt)],
        ["标签", record.tags.length ? record.tags.join(" / ") : "无标签"],
      ];
      for (const [label, value] of metadataRows) {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        const description = document.createElement("dd");
        term.textContent = label;
        description.textContent = value;
        row.append(term, description);
        metadata.append(row);
      }

      const sourceBlock = document.createElement("section");
      sourceBlock.className = "memory-sources";
      const sourceTitle = document.createElement("strong");
      sourceTitle.textContent = "来源链";
      const sourceHint = document.createElement("p");
      if (record.sourceIds.length === 0) {
        sourceHint.textContent = record.tags.includes("explicit")
          ? "由你明确保存，没有上游记忆标识。"
          : "没有上游来源标识。";
        sourceBlock.append(sourceTitle, sourceHint);
      } else {
        sourceHint.textContent = `${record.sourceIds.length} 个上游标识；上游 L1/L2 可能已按记忆生命周期迁移或清理。`;
        const sourceList = document.createElement("div");
        sourceList.className = "memory-source-list";
        for (const sourceId of record.sourceIds) {
          const source = document.createElement("code");
          source.textContent = sourceId;
          source.title = sourceId;
          sourceList.append(source);
        }
        sourceBlock.append(sourceTitle, sourceHint, sourceList);
      }

      details.append(detailsSummary, fullContent, metadata, sourceBlock);
      if (score) {
        const recall = document.createElement("section");
        recall.className = "memory-recall-score";
        const recallTitle = document.createElement("strong");
        recallTitle.textContent = "为何召回";
        const scoreGrid = document.createElement("div");
        for (const [label, value] of [
          ["文本匹配", score.textRelevance],
          ["重要度", score.importance],
          ["新近程度", score.recency],
          ["访问强化", score.frequency],
        ] as Array<[string, number]>) {
          const scoreItem = document.createElement("span");
          scoreItem.textContent = `${label} +${value.toFixed(2)}`;
          scoreGrid.append(scoreItem);
        }
        const total = document.createElement("p");
        total.textContent = `综合分 ${score.total.toFixed(2)}，按当前本地词法检索规则排序。`;
        recall.append(recallTitle, scoreGrid, total);
        details.append(recall);
      }

      card.append(header, content, footer, details);

      if (record.tier === "L2" || record.tier === "L3") {
        const persistentTier = record.tier;
        const actions = document.createElement("div");
        actions.className = "memory-card-actions";
        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "memory-edit-button";
        editButton.textContent = "修正";
        editButton.setAttribute("aria-expanded", "false");
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "memory-delete-button";
        deleteButton.textContent = "删除";
        actions.append(editButton, deleteButton);

        const editForm = document.createElement("form");
        editForm.className = "memory-edit-form";
        editForm.hidden = true;
        const tierNote = document.createElement("p");
        tierNote.className = "memory-tier-lock";
        tierNote.textContent = `${persistentTier} 层级保持不变`;

        const kindField = document.createElement("label");
        kindField.textContent = "记忆类型";
        const kindSelect = document.createElement("select");
        kindSelect.name = "kind";
        for (const kind of editableKinds) kindSelect.append(new Option(kindLabel(kind), kind));
        kindSelect.value = record.kind === "dialogue" ? "episode" : record.kind;
        kindField.append(kindSelect);

        const contentField = document.createElement("label");
        contentField.textContent = "记忆内容";
        const contentInput = document.createElement("textarea");
        contentInput.name = "content";
        contentInput.maxLength = 2000;
        contentInput.required = true;
        contentInput.value = record.content;
        contentField.append(contentInput);

        const importanceField = document.createElement("label");
        importanceField.textContent = "重要度（0 到 1）";
        const importanceInput = document.createElement("input");
        importanceInput.name = "importance";
        importanceInput.type = "number";
        importanceInput.min = "0";
        importanceInput.max = "1";
        importanceInput.step = "0.01";
        importanceInput.required = true;
        importanceInput.value = String(record.importance);
        importanceField.append(importanceInput);

        const formActions = document.createElement("div");
        formActions.className = "memory-edit-actions";
        const saveButton = document.createElement("button");
        saveButton.type = "submit";
        saveButton.className = "primary-button";
        saveButton.textContent = "保存修正";
        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "secondary-button";
        cancelButton.textContent = "取消";
        formActions.append(saveButton, cancelButton);
        editForm.append(tierNote, kindField, contentField, importanceField, formActions);

        editButton.addEventListener("click", () => {
          editForm.hidden = false;
          editButton.hidden = true;
          editButton.setAttribute("aria-expanded", "true");
          contentInput.focus();
        });
        cancelButton.addEventListener("click", () => {
          kindSelect.value = record.kind === "dialogue" ? "episode" : record.kind;
          contentInput.value = record.content;
          importanceInput.value = String(record.importance);
          editForm.hidden = true;
          editButton.hidden = false;
          editButton.setAttribute("aria-expanded", "false");
        });
        editForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          saveButton.disabled = true;
          try {
            const snapshot = await bridge.updateMemory({
              id: record.id,
              tier: persistentTier,
              content: contentInput.value,
              kind: kindSelect.value as EditableMemoryKind,
              importance: Number(importanceInput.value),
            });
            input("#memory-search-input").value = "";
            renderSnapshot(snapshot);
            showToast(`已修正 ${persistentTier} 记忆，来源和历史标识保持不变`);
          } catch (error) {
            showToast(error instanceof Error ? error.message : "记忆修正失败", 5000);
            saveButton.disabled = false;
          }
        });
        deleteButton.addEventListener("click", async () => {
          const preview = (record.summary || record.content).slice(0, 40);
          if (!window.confirm(`确定删除 ${persistentTier} 记忆“${preview}”吗？此操作会立即写入本地记忆库。`)) return;
          deleteButton.disabled = true;
          try {
            const snapshot = await bridge.deleteMemory({ id: record.id, tier: persistentTier });
            input("#memory-search-input").value = "";
            renderSnapshot(snapshot);
            showToast(`已删除 ${persistentTier} 记忆`);
          } catch (error) {
            showToast(error instanceof Error ? error.message : "记忆删除失败", 5000);
            deleteButton.disabled = false;
          }
        });

        card.append(actions, editForm);
      }
      list.append(card);
    }
  }

  async function refreshMemory(): Promise<void> {
    const snapshot = await bridge.getMemory();
    renderSnapshot(snapshot);
  }

  function openView(view: ControlPanelView): void {
    const memory = view === "memory";
    must<HTMLElement>("#memory-view").hidden = !memory;
    must<HTMLElement>("#settings-view").hidden = memory;
    must<HTMLElement>("#panel-title").textContent = memory ? "三级记忆" : "桌宠设置";
    must<HTMLButtonElement>("#memory-tab").classList.toggle("active", memory);
    must<HTMLButtonElement>("#settings-tab").classList.toggle("active", !memory);
    if (memory) void refreshMemory();
  }

  function populateSettings(state: PublicSettingsState): void {
    settingsState = state;
    const value = state.settings;
    input("#setting-agent-name").value = value.agentName;
    input("#setting-user-name").value = value.userName;
    input("#setting-personality-learning").checked = value.personality.learningEnabled;
    input("#setting-personality-rate").value = String(value.personality.adaptationRate);
    input("#setting-personality-evidence").value = String(value.personality.minimumEvidence);
    input("#setting-provider-enabled").checked = value.provider.enabled;
    input("#setting-base-url").value = value.provider.baseUrl;
    input("#setting-model").value = value.provider.model;
    input("#setting-api-key").value = "";
    input("#setting-clear-key").checked = false;
    must<HTMLElement>("#key-state").textContent = state.hasApiKey ? "已安全保存" : "未设置";
    input("#setting-computer-enabled").checked = value.computer.enabled;
    input("#setting-browser-context").checked = value.computer.browserContextEnabled;
    input("#setting-clipboard-shortcut").checked = value.computer.clipboardShortcutEnabled;
    must<HTMLSelectElement>("#setting-permission-open-url").value = value.computer.permissions["open-url"];
    must<HTMLSelectElement>("#setting-permission-copy-text").value = value.computer.permissions["copy-text"];
    must<HTMLSelectElement>("#setting-permission-save-text-file").value = value.computer.permissions["save-text-file"];
    must<HTMLSelectElement>("#setting-permission-launch-app").value = value.computer.permissions["launch-app"];
    input("#setting-heartbeat-enabled").checked = value.heartbeat.enabled;
    input("#setting-heartbeat-interval").value = String(value.heartbeat.intervalMinutes);
    input("#setting-l1-max").value = String(value.heartbeat.l1MaxItems);
    input("#setting-l1-age").value = String(value.heartbeat.l1MaxAgeMinutes);
    input("#setting-consolidate-after").value = String(value.heartbeat.consolidateAfterItems);
    input("#setting-proactive-enabled").checked = value.heartbeat.proactiveEnabled;
    input("#setting-idle-minutes").value = String(value.heartbeat.idleMinutesBeforeChat);
    input("#setting-cooldown").value = String(value.heartbeat.proactiveCooldownMinutes);
    input("#setting-daily-limit").value = String(value.heartbeat.proactiveDailyLimit);
    input("#setting-quiet-hours").value = `${value.heartbeat.quietHoursStart}-${value.heartbeat.quietHoursEnd}`;
    input("#setting-voice-input").checked = value.voice.inputEnabled;
    input("#setting-voice-output").checked = value.voice.outputEnabled;
    input("#setting-language").value = value.voice.language;
    must<HTMLSelectElement>("#setting-recognition-mode").value = value.voice.recognitionMode;
    must<HTMLSelectElement>("#setting-tts-mode").value = value.voice.ttsMode;
    input("#setting-tts-base-url").value = value.voice.ttsBaseUrl;
    input("#setting-tts-model").value = value.voice.ttsModel;
    input("#setting-tts-voice").value = value.voice.ttsVoice;
    input("#setting-tts-speed").value = String(value.voice.ttsSpeed);
    input("#setting-tts-api-key").value = "";
    input("#setting-clear-tts-key").checked = false;
    must<HTMLElement>("#tts-key-state").textContent = state.hasTtsApiKey ? "已安全保存" : "未设置";
    input("#setting-roaming-enabled").checked = value.window.roamingEnabled;
    input("#setting-roaming-speed").value = String(value.window.roamingSpeed);
    input("#setting-always-on-top").checked = value.window.alwaysOnTop;
  }

  let localSpeechStatusRevision = 0;

  function renderLocalSpeechStatus(status: LocalSpeechModelStatus): void {
    localSpeechStatusRevision += 1;
    const element = must<HTMLElement>("#local-asr-state");
    element.dataset.state = status.state === "ready" ? status.runtimeState : status.state;
    element.textContent = localSpeechStatusText(status);
    element.title = status.directory;
  }

  function numberFrom(selector: string, fallback: number): number {
    const value = Number(input(selector).value);
    return Number.isFinite(value) ? value : fallback;
  }

  function collectSettings(): SettingsUpdate {
    const current = settingsState.settings;
    const quietMatch = input("#setting-quiet-hours").value.match(/^\s*(\d{1,2})\s*[-~至]\s*(\d{1,2})\s*$/);
    const apiKey = input("#setting-api-key").value.trim();
    const ttsApiKey = input("#setting-tts-api-key").value.trim();
    return {
      agentName: input("#setting-agent-name").value,
      userName: input("#setting-user-name").value,
      personality: {
        learningEnabled: input("#setting-personality-learning").checked,
        adaptationRate: numberFrom("#setting-personality-rate", current.personality.adaptationRate),
        minimumEvidence: numberFrom("#setting-personality-evidence", current.personality.minimumEvidence),
      },
      provider: {
        enabled: input("#setting-provider-enabled").checked,
        baseUrl: input("#setting-base-url").value,
        model: input("#setting-model").value,
        temperature: current.provider.temperature,
      },
      heartbeat: {
        enabled: input("#setting-heartbeat-enabled").checked,
        intervalMinutes: numberFrom("#setting-heartbeat-interval", current.heartbeat.intervalMinutes),
        l1MaxItems: numberFrom("#setting-l1-max", current.heartbeat.l1MaxItems),
        l1MaxAgeMinutes: numberFrom("#setting-l1-age", current.heartbeat.l1MaxAgeMinutes),
        consolidateAfterItems: numberFrom("#setting-consolidate-after", current.heartbeat.consolidateAfterItems),
        proactiveEnabled: input("#setting-proactive-enabled").checked,
        idleMinutesBeforeChat: numberFrom("#setting-idle-minutes", current.heartbeat.idleMinutesBeforeChat),
        proactiveCooldownMinutes: numberFrom("#setting-cooldown", current.heartbeat.proactiveCooldownMinutes),
        proactiveDailyLimit: numberFrom("#setting-daily-limit", current.heartbeat.proactiveDailyLimit),
        quietHoursStart: quietMatch ? Number(quietMatch[1]) : current.heartbeat.quietHoursStart,
        quietHoursEnd: quietMatch ? Number(quietMatch[2]) : current.heartbeat.quietHoursEnd,
      },
      voice: {
        inputEnabled: input("#setting-voice-input").checked,
        outputEnabled: input("#setting-voice-output").checked,
        language: input("#setting-language").value,
        recognitionMode: must<HTMLSelectElement>("#setting-recognition-mode").value as AgentSettings["voice"]["recognitionMode"],
        ttsMode: must<HTMLSelectElement>("#setting-tts-mode").value as AgentSettings["voice"]["ttsMode"],
        ttsBaseUrl: input("#setting-tts-base-url").value,
        ttsModel: input("#setting-tts-model").value,
        ttsVoice: input("#setting-tts-voice").value,
        ttsSpeed: numberFrom("#setting-tts-speed", current.voice.ttsSpeed),
      },
      computer: {
        enabled: input("#setting-computer-enabled").checked,
        browserContextEnabled: input("#setting-browser-context").checked,
        clipboardShortcutEnabled: input("#setting-clipboard-shortcut").checked,
        permissions: {
          "open-url": must<HTMLSelectElement>("#setting-permission-open-url").value as AgentSettings["computer"]["permissions"]["open-url"],
          "copy-text": must<HTMLSelectElement>("#setting-permission-copy-text").value as AgentSettings["computer"]["permissions"]["copy-text"],
          "save-text-file": must<HTMLSelectElement>("#setting-permission-save-text-file").value as AgentSettings["computer"]["permissions"]["save-text-file"],
          "launch-app": must<HTMLSelectElement>("#setting-permission-launch-app").value as AgentSettings["computer"]["permissions"]["launch-app"],
        },
      },
      window: {
        alwaysOnTop: input("#setting-always-on-top").checked,
        roamingEnabled: input("#setting-roaming-enabled").checked,
        roamingSpeed: numberFrom("#setting-roaming-speed", current.window.roamingSpeed),
      },
      apiKey: apiKey || undefined,
      clearApiKey: input("#setting-clear-key").checked,
      ttsApiKey: ttsApiKey || undefined,
      clearTtsApiKey: input("#setting-clear-tts-key").checked,
    };
  }

  document.querySelectorAll<HTMLButtonElement>(".panel-tabs button").forEach((button) => {
    button.addEventListener("click", () => openView(button.dataset.view as ControlPanelView));
  });
  must<HTMLButtonElement>("#panel-close-button").addEventListener("click", () => void bridge.close());
  must<HTMLButtonElement>("#open-data-button").addEventListener("click", () => void bridge.showDataDirectory());
  must<HTMLButtonElement>("#open-data-button-memory").addEventListener("click", () => void bridge.showDataDirectory());
  must<HTMLButtonElement>("#computer-open-extension").addEventListener("click", async () => {
    try {
      await bridge.openBrowserExtensionDirectory();
      showToast("已打开浏览器扩展目录");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "扩展目录打开失败", 5000);
    }
  });
  must<HTMLButtonElement>("#computer-copy-pairing").addEventListener("click", async () => {
    try {
      await bridge.copyComputerPairingInfo();
      showToast("配对信息已复制，粘贴到浏览器扩展即可");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "配对信息复制失败", 5000);
    }
  });
  must<HTMLButtonElement>("#computer-rotate-pairing").addEventListener("click", async () => {
    if (!window.confirm("重新生成后，已经配对的浏览器扩展需要粘贴新令牌。继续吗？")) return;
    try {
      renderComputerState(await bridge.rotateComputerPairingToken());
      showToast("已生成新配对令牌，旧令牌已失效");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "配对令牌更新失败", 5000);
    }
  });
  must<HTMLButtonElement>("#computer-clear-audit").addEventListener("click", async () => {
    if (!window.confirm("清空本机电脑协作审计记录吗？权限设置不会改变。")) return;
    try {
      renderComputerState(await bridge.clearComputerAudit());
      showToast("电脑协作审计已清空");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "审计清理失败", 5000);
    }
  });
  must<HTMLButtonElement>("#personality-reset-button").addEventListener("click", async () => {
    if (!window.confirm("确定清空已经形成的人格证据吗？三级记忆不会被删除。")) return;
    try {
      renderPersonality(await bridge.resetPersonality());
      showToast("人格状态已清空，将从之后的对话重新成长");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "人格重置失败");
    }
  });
  must<HTMLButtonElement>("#model-import-button").addEventListener("click", async () => {
    const button = must<HTMLButtonElement>("#model-import-button");
    button.disabled = true;
    try {
      const result = await bridge.importLive2DModel();
      renderModelState(result.state);
      if (result.message) showToast(result.message, 5000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "模型导入失败", 7000);
    } finally {
      button.disabled = false;
    }
  });
  must<HTMLButtonElement>("#model-apply-button").addEventListener("click", async () => {
    try {
      const selected = must<HTMLSelectElement>("#model-bundled-select").value;
      renderModelState(await bridge.selectBundledModel(selected));
      showToast("已切换内置 Live2D 模型");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "模型切换失败");
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-pet-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await bridge.playPetAction(button.dataset.petAction as PetAction);
        showToast(`已播放动作：${button.textContent?.trim() ?? ""}`);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "动作播放失败");
      }
    });
  });
  must<HTMLButtonElement>("#heartbeat-button").addEventListener("click", async () => {
    try {
      const result = await bridge.runHeartbeat();
      renderSnapshot(result.snapshot);
      renderPersonality(result.personality);
      showToast(`心跳完成：L2 +${result.event.movedToL2}，L3 +${result.event.consolidatedToL3}，人格证据 +${result.event.personalityUpdates ?? 0}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "心跳执行失败");
    }
  });
  must<HTMLFormElement>("#remember-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = input("#remember-input");
    const text = field.value.trim();
    if (!text) return;
    try {
      const snapshot = await bridge.remember(text);
      field.value = "";
      renderSnapshot(snapshot);
      showToast("已放入 L2 海马体待整理区");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败");
    }
  });
  must<HTMLFormElement>("#memory-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input("#memory-search-input").value.trim();
    if (!query) return refreshMemory();
    try {
      const results = await bridge.searchMemory(query);
      renderMemory(results);
      showToast(`找到 ${results.length} 条记忆，已显示召回依据`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "搜索失败");
    }
  });
  must<HTMLFormElement>("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = must<HTMLButtonElement>("#settings-form button[type=submit]");
    submit.disabled = true;
    try {
      populateSettings(await bridge.saveSettings(collectSettings()));
      await refreshComputerState();
      showToast("设置已保存，电脑权限、人格、TTS、漫游和心跳策略已更新");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "设置保存失败", 5000);
    } finally {
      submit.disabled = false;
    }
  });

  bridge.onPanelView(openView);
  bridge.onSettingsChanged((state) => {
    populateSettings(state);
    void refreshComputerState();
  });
  bridge.onLocalSpeechStatusChanged(renderLocalSpeechStatus);
  bridge.onModelChanged(renderModelState);
  bridge.onPersonalityChanged(renderPersonality);
  try {
    const state = await bridge.bootstrap();
    populateSettings(state.settings);
    await refreshComputerState();
    const statusRevision = localSpeechStatusRevision;
    const initialLocalStatus = await bridge.getLocalSpeechStatus();
    if (localSpeechStatusRevision === statusRevision) renderLocalSpeechStatus(initialLocalStatus);
    renderPersonality(state.personality);
    renderModelState(await bridge.getModelState());
    renderCounts(state.memory);
    openView(initialView);
  } catch (error) {
    showToast(`初始化失败：${error instanceof Error ? error.message : "未知错误"}`, 8000);
  }
}
