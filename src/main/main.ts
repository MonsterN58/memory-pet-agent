import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ControlPanelView,
  ModelImportResult,
  PetAction,
  PetFocus,
  PetMotionFrame,
  PersonalityProfile,
  PublicModelState,
  SettingsUpdate,
} from "../common/types";
import { AgentService } from "./agent-service";
import { DesktopMovementController } from "./desktop-movement-controller";
import { HeartbeatService } from "./heartbeat-service";
import {
  LocalAsrService,
  LOCAL_ASR_CANCELLED_MESSAGE,
  LOCAL_ASR_MODEL_ID,
} from "./local-asr-service";
import { MemoryEngine } from "./memory/memory-engine";
import { sanitizeMemoryTarget, sanitizeMemoryUpdate } from "./memory/memory-input";
import { MemoryRepository } from "./memory/memory-repository";
import { ModelStore } from "./model-store";
import { hidePetWindow } from "./pet-window-lifecycle";
import { OpenAICompatibleTtsClient } from "./provider/openai-compatible-tts";
import { PersonalityEngine } from "./personality/personality-engine";
import { PersonalityStore } from "./personality/personality-store";
import { SettingsStore } from "./settings-store";

let petWindow: BrowserWindow | undefined;
let controlPanelWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let settingsStore: SettingsStore;
let memoryRepository: MemoryRepository;
let memoryEngine: MemoryEngine;
let agentService: AgentService;
let heartbeatService: HeartbeatService;
let movementController: DesktopMovementController;
let modelStore: ModelStore;
let ttsClient: OpenAICompatibleTtsClient;
let localAsrService: LocalAsrService;
let personalityEngine: PersonalityEngine;
const PET_ACTIONS: PetAction[] = [
  "wave", "nod", "shake-head", "head-tilt", "jump", "cheer", "dance",
  "sit", "stretch", "shy", "comfort", "sleep", "surprised",
];
const smokeTest = process.argv.includes("--smoke-test");
const modelSwitchSmoke = process.argv.includes("--model-switch-smoke");
const voiceUiSmoke = process.argv.includes("--voice-ui-smoke");
const capturePetArgument = process.argv.find((argument) => argument.startsWith("--capture-pet="));
const capturePetPath = capturePetArgument ? resolve(capturePetArgument.slice("--capture-pet=".length)) : undefined;
const captureDialog = process.argv.includes("--capture-dialog");
const captureActionArgument = process.argv.find((argument) => argument.startsWith("--capture-action="));
const captureActionValue = captureActionArgument?.slice("--capture-action=".length);
const captureAction = PET_ACTIONS.includes(captureActionValue as PetAction) ? captureActionValue as PetAction : undefined;
const captureModelArgument = process.argv.find((argument) => argument.startsWith("--capture-model="));
const captureModelId = captureModelArgument?.slice("--capture-model=".length);
const smokeLogPath = join(process.cwd(), "output", "electron-smoke.log");

function smokeLog(message: string): void {
  if (!smokeTest) return;
  mkdirSync(join(process.cwd(), "output"), { recursive: true });
  appendFileSync(smokeLogPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

if (smokeTest) {
  app.disableHardwareAcceleration();
  mkdirSync(join(process.cwd(), "output"), { recursive: true });
  writeFileSync(smokeLogPath, `${new Date().toISOString()} MAIN_MODULE_LOADED\n`, "utf8");
  process.on("uncaughtException", (error) => smokeLog(`UNCAUGHT_EXCEPTION ${error.stack ?? error.message}`));
  process.on("unhandledRejection", (error) => smokeLog(`UNHANDLED_REJECTION ${String(error)}`));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function sanitizeText(value: unknown, maxLength = 4000): string {
  if (typeof value !== "string") throw new Error("输入内容必须是文本");
  const text = value.trim().slice(0, maxLength);
  if (!text) throw new Error("输入内容不能为空");
  return text;
}

function secureWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
}

function createPetWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 320;
  const height = 460;
  const window = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 30,
    y: workArea.y + workArea.height - height,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    show: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: settingsStore.get().window.alwaysOnTop,
    skipTaskbar: true,
    webPreferences: secureWebPreferences(),
  });
  hardenWindow(window);
  if (smokeTest || capturePetPath || modelSwitchSmoke || voiceUiSmoke) {
    window.webContents.on("console-message", (details) => {
      console.log(`RENDERER_${details.level.toUpperCase()} ${details.message}`);
    });
  }
  if (modelSwitchSmoke) {
    const sequence = ["hiyori", "mao", "wanko", "hiyori"];
    let sequenceIndex = 0;
    const timeout = setTimeout(() => {
      console.error(`ELECTRON_MODEL_SWITCH_TEST_TIMEOUT expected=${sequence[sequenceIndex] ?? "complete"}`);
      app.exit(1);
    }, 45_000);
    window.webContents.on("console-message", (details) => {
      const modelId = /^LIVE2D_MODEL_READY live2d:bundled:([a-z0-9-]+)$/.exec(details.message)?.[1];
      if (!modelId || modelId !== sequence[sequenceIndex]) return;
      sequenceIndex += 1;
      const nextId = sequence[sequenceIndex];
      if (!nextId) {
        clearTimeout(timeout);
        console.log("ELECTRON_MODEL_SWITCH_TEST_READY");
        setTimeout(() => app.quit(), 300);
        return;
      }
      setTimeout(() => {
        void selectBundledModel(nextId).catch((error: unknown) => {
          clearTimeout(timeout);
          console.error("ELECTRON_MODEL_SWITCH_TEST_FAILED", error);
          app.exit(1);
        });
      }, 250);
    });
  }
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void window.loadFile(join(__dirname, "../renderer/index.html"));
  window.webContents.on("context-menu", (event) => {
    event.preventDefault();
    showPetContextMenu();
  });
  window.once("ready-to-show", () => {
    if (smokeTest) {
      console.log("ELECTRON_SMOKE_TEST_READY");
      smokeLog("WINDOW_READY");
      setTimeout(() => app.quit(), 500);
    } else if (capturePetPath) {
      window.showInactive();
      if (captureAction) setTimeout(() => triggerPetAction(captureAction), 1800);
      if (captureDialog) setTimeout(() => window.webContents.send("ui:command", "focus-chat"), 1600);
      setTimeout(() => {
        void window.webContents.capturePage().then((image) => {
          writeFileSync(capturePetPath, image.toPNG());
          console.log(`PET_CAPTURE_READY ${capturePetPath}`);
          app.quit();
        }).catch((error) => {
          console.error("Pet capture failed", error);
          app.quit();
        });
      }, 3000);
    } else {
      window.showInactive();
      window.setIgnoreMouseEvents(true, { forward: true });
    }
  });
  window.on("focus", () => movementController.setInteracting(true, "focus"));
  window.on("blur", () => movementController.setInteracting(false, "focus"));
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      hidePetWindow(window);
    }
  });
  return window;
}

function openControlPanel(view: ControlPanelView): void {
  if (controlPanelWindow && !controlPanelWindow.isDestroyed()) {
    controlPanelWindow.show();
    controlPanelWindow.focus();
    controlPanelWindow.webContents.send("panel:view", view);
    return;
  }
  const window = new BrowserWindow({
    width: 430,
    height: 720,
    minWidth: 390,
    minHeight: 560,
    title: view === "settings" ? "记忆桌宠设置" : "桌宠记忆管理",
    backgroundColor: "#f8f7fd",
    show: false,
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(),
  });
  hardenWindow(window);
  controlPanelWindow = window;
  void window.loadFile(join(__dirname, "../renderer/index.html"), {
    query: { mode: "panel", view },
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    controlPanelWindow = undefined;
  });
}

function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M7 13L10 4l6 5 6-5 3 9v8c0 6-4 9-9 9S7 27 7 21z" fill="#8b7cf6"/><circle cx="12" cy="17" r="2" fill="white"/><circle cx="20" cy="17" r="2" fill="white"/><path d="M12 23c2.5 2 5.5 2 8 0" stroke="white" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip("记忆桌宠");
  refreshTrayMenu();
  tray.on("click", () => focusChat());
}

function refreshTrayMenu(): void {
  if (!tray || !settingsStore) return;
  const settings = settingsStore.get();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "和桌宠说话", click: focusChat },
      {
        label: "允许自由移动",
        type: "checkbox",
        checked: settings.window.roamingEnabled,
        click: (item) => void updateSettings({ window: { ...settings.window, roamingEnabled: item.checked } }),
      },
      { label: "三级记忆", click: () => openControlPanel("memory") },
      { label: "设置", click: () => openControlPanel("settings") },
      modelAndActionsMenu(),
      { label: "立即心跳", click: () => void heartbeatService.run("manual", true) },
      { type: "separator" },
      { label: "退出", click: quitApplication },
    ]),
  );
}

function modelAndActionsMenu(): MenuItemConstructorOptions {
  const modelState = modelStore?.getState();
  const actionLabels: Record<PetAction, string> = {
    wave: "挥手",
    nod: "点头",
    "shake-head": "摇头",
    "head-tilt": "歪头",
    jump: "跳跃",
    cheer: "庆祝",
    dance: "跳舞",
    sit: "坐下",
    stretch: "伸懒腰",
    shy: "害羞",
    comfort: "安慰",
    sleep: "睡觉",
    surprised: "惊讶",
  };
  return {
    label: "模型与动作",
    submenu: [
      {
        label: "导入 Live2D Cubism 3/4/5 模型…",
        click: () => void importLive2DModel(petWindow).catch((error: unknown) => {
          dialog.showErrorBox("模型导入失败", error instanceof Error ? error.message : "无法导入模型");
        }),
      },
      ...(modelState?.bundledModels ?? []).map<MenuItemConstructorOptions>((model) => ({
        label: model.name,
        type: "radio",
        checked: modelState?.kind === "bundled" && modelState.model.id === model.id,
        click: () => void selectBundledModel(model.id),
      })),
      { type: "separator" },
      ...PET_ACTIONS.map<MenuItemConstructorOptions>((action) => ({
        label: actionLabels[action],
        click: () => triggerPetAction(action),
      })),
    ],
  };
}

function showPetContextMenu(): void {
  const settings = settingsStore.get();
  const template: MenuItemConstructorOptions[] = [
    { label: "和我说话", click: focusChat },
    { type: "separator" },
    {
      label: "允许自由移动",
      type: "checkbox",
      checked: settings.window.roamingEnabled,
      click: (item) => void updateSettings({ window: { ...settings.window, roamingEnabled: item.checked } }),
    },
    {
      label: "始终置顶",
      type: "checkbox",
      checked: settings.window.alwaysOnTop,
      click: (item) => void updateSettings({ window: { ...settings.window, alwaysOnTop: item.checked } }),
    },
    {
      label: "自动朗读回复",
      type: "checkbox",
      checked: settings.voice.outputEnabled,
      click: (item) => void updateSettings({ voice: { ...settings.voice, outputEnabled: item.checked } }),
    },
    {
      label: "语音输入",
      type: "checkbox",
      checked: settings.voice.inputEnabled,
      click: (item) => void updateSettings({ voice: { ...settings.voice, inputEnabled: item.checked } }),
    },
    { label: "重置宠物位置", click: () => movementController.resetPosition() },
    modelAndActionsMenu(),
    { type: "separator" },
    { label: "三级记忆管理…", click: () => openControlPanel("memory") },
    { label: "桌宠设置…", click: () => openControlPanel("settings") },
    { label: "立即执行心跳", click: () => void heartbeatService.run("manual", true) },
    { label: "打开本地数据目录", click: () => void shell.openPath(app.getPath("userData")) },
    { type: "separator" },
    { label: "隐藏桌宠", click: () => hidePetWindow(petWindow) },
    { label: "退出", click: quitApplication },
  ];
  Menu.buildFromTemplate(template).popup({ window: petWindow });
}

function focusChat(): void {
  if (!petWindow) return;
  petWindow.show();
  petWindow.setIgnoreMouseEvents(false);
  petWindow.focus();
  petWindow.webContents.send("ui:command", "focus-chat");
}

function quitApplication(): void {
  quitting = true;
  app.quit();
}

function broadcastSettings(state: Awaited<ReturnType<SettingsStore["getPublicState"]>>): void {
  petWindow?.webContents.send("settings:changed", state);
  controlPanelWindow?.webContents.send("settings:changed", state);
}

async function updateSettings(update: SettingsUpdate) {
  const state = await settingsStore.update(update);
  heartbeatService.restartTimer();
  petWindow?.setAlwaysOnTop(state.settings.window.alwaysOnTop);
  movementController.wake();
  broadcastSettings(state);
  refreshTrayMenu();
  return state;
}

function sendPetMotion(frame: PetMotionFrame): void {
  petWindow?.webContents.send("pet:motion", frame);
}

function sendFocus(focus: PetFocus): void {
  petWindow?.webContents.send("pet:focus", focus);
}

function triggerPetAction(action: PetAction): void {
  petWindow?.webContents.send("pet:action", action);
}

function broadcastModelState(state: PublicModelState): void {
  petWindow?.webContents.send("model:changed", state);
  controlPanelWindow?.webContents.send("model:changed", state);
  refreshTrayMenu();
}

function broadcastPersonality(profile: PersonalityProfile = personalityEngine.getProfile()): void {
  petWindow?.webContents.send("personality:changed", profile);
  controlPanelWindow?.webContents.send("personality:changed", profile);
}

async function importLive2DModel(owner?: BrowserWindow): Promise<ModelImportResult> {
  const options: Electron.OpenDialogOptions = {
    title: "选择 Live2D Cubism 3/4/5 模型文件夹",
    buttonLabel: "导入模型",
    properties: ["openDirectory", "dontAddToRecent"],
    message: "文件夹中需包含一个 .model3.json、对应 .moc3、贴图和可选 motions/physics/expressions",
  };
  const selection = owner && !owner.isDestroyed()
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) {
    return { cancelled: true, state: modelStore.getState() };
  }
  const state = await modelStore.importFromDirectory(selection.filePaths[0]);
  broadcastModelState(state);
  return {
    cancelled: false,
    state,
    message: `已导入 ${state.model.name}`,
  };
}

async function selectBundledModel(modelId: string): Promise<PublicModelState> {
  const state = await modelStore.selectBundled(modelId);
  broadcastModelState(state);
  return state;
}

function sendProactive(response: Awaited<ReturnType<AgentService["createProactiveMessage"]>>): void {
  if (!petWindow) return;
  petWindow.showInactive();
  petWindow.webContents.send("agent:proactive", response);
}

function registerIpc(): void {
  ipcMain.handle("agent:bootstrap", async () => ({
    settings: await settingsStore.getPublicState(),
    memory: memoryEngine.snapshot(),
    personality: personalityEngine.getProfile(),
    providerMode: (await settingsStore.providerConfigured()) ? "provider" : "local",
  }));
  ipcMain.handle("agent:chat", async (_event, value: unknown) => {
    const text = sanitizeText(value);
    await heartbeatService.recordInteraction();
    const response = await agentService.respond(text);
    broadcastPersonality();
    return response;
  });
  ipcMain.handle("memory:remember", async (_event, value: unknown) => {
    await memoryEngine.rememberExplicit(sanitizeText(value, 2000));
    return memoryEngine.snapshot();
  });
  ipcMain.handle("memory:search", (_event, value: unknown) => memoryEngine.search(sanitizeText(value, 500), 20));
  ipcMain.handle("memory:get", () => memoryEngine.snapshot());
  ipcMain.handle("memory:update", (event, value: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== controlPanelWindow) {
      throw new Error("只能从记忆管理窗口修改记忆");
    }
    return memoryEngine.updateMemory(sanitizeMemoryUpdate(value));
  });
  ipcMain.handle("memory:delete", (event, value: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== controlPanelWindow) {
      throw new Error("只能从记忆管理窗口删除记忆");
    }
    return memoryEngine.deleteMemory(sanitizeMemoryTarget(value));
  });
  ipcMain.handle("personality:get", () => personalityEngine.getProfile());
  ipcMain.handle("personality:reset", async (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== controlPanelWindow) {
      throw new Error("只能从设置窗口重置人格");
    }
    const profile = await personalityEngine.reset();
    broadcastPersonality(profile);
    return profile;
  });
  ipcMain.handle("heartbeat:run", () => heartbeatService.run("manual", true));
  ipcMain.handle("settings:save", async (_event, update: SettingsUpdate) => {
    if (!update || typeof update !== "object") throw new Error("设置格式无效");
    return updateSettings(update);
  });
  ipcMain.handle("voice:synthesize", (event, value: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== petWindow) {
      throw new Error("不允许从该窗口生成语音");
    }
    return ttsClient.synthesize(sanitizeText(value, 2000));
  });
  ipcMain.handle("voice:local-status", (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow !== petWindow && sourceWindow !== controlPanelWindow) {
      throw new Error("不允许从该窗口读取本地语音模型状态");
    }
    return localAsrService.status();
  });
  ipcMain.handle("voice:recognize-local", (event, value: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== petWindow) {
      throw new Error("不允许从该窗口识别语音");
    }
    const voice = settingsStore.get().voice;
    if (!voice.inputEnabled) throw new Error("语音输入已关闭");
    if (voice.recognitionMode !== "local") throw new Error("当前未启用本地识别模式");
    return localAsrService.recognize(value).catch((error: unknown) => {
      if (error instanceof Error && error.message === LOCAL_ASR_CANCELLED_MESSAGE) {
        return { text: "", durationMs: 0 };
      }
      throw error;
    });
  });
  ipcMain.handle("voice:cancel-local", (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== petWindow) {
      throw new Error("不允许从该窗口取消本地语音识别");
    }
    return localAsrService.cancelCurrent();
  });
  ipcMain.handle("data:show", async () => {
    await shell.openPath(app.getPath("userData"));
  });
  ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle("window:close", (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow === petWindow) hidePetWindow(sourceWindow);
    else sourceWindow?.close();
  });
  ipcMain.handle("pet:interaction", (event, active: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== petWindow) return;
    movementController.setInteracting(Boolean(active), "pointer");
  });
  ipcMain.handle("pet:click-through", (event, ignore: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow === petWindow && !sourceWindow.isDestroyed()) {
      sourceWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    }
  });
  ipcMain.handle("pet:drag-start", (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== petWindow) return;
    movementController.beginDrag();
  });
  ipcMain.handle("pet:drag-end", (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== petWindow) return;
    movementController.endDrag();
  });
  ipcMain.handle("model:get-state", () => modelStore.getState());
  ipcMain.handle("model:get-active", (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow !== petWindow) return null;
    return modelStore.getActiveAssets();
  });
  ipcMain.handle("model:import", (event) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow !== petWindow && sourceWindow !== controlPanelWindow) throw new Error("不允许从该窗口导入模型");
    return importLive2DModel(sourceWindow);
  });
  ipcMain.handle("model:select-bundled", (event, modelId: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow !== petWindow && sourceWindow !== controlPanelWindow) throw new Error("不允许从该窗口切换模型");
    if (typeof modelId !== "string" || !/^[a-z0-9-]{1,40}$/.test(modelId)) throw new Error("模型 ID 无效");
    return selectBundledModel(modelId);
  });
  ipcMain.handle("pet:play-action", (event, action: unknown) => {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (sourceWindow !== petWindow && sourceWindow !== controlPanelWindow) throw new Error("不允许从该窗口播放动作");
    if (typeof action !== "string" || !PET_ACTIONS.includes(action as PetAction)) throw new Error("未知桌宠动作");
    triggerPetAction(action as PetAction);
  });
}

async function initialize(): Promise<void> {
  smokeLog("APP_READY");
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    const onlyMicrophone = mediaTypes?.length === 1 && mediaTypes[0] === "audio";
    callback(webContents === petWindow?.webContents && permission === "media" && details.isMainFrame && onlyMicrophone);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    webContents === petWindow?.webContents
    && permission === "media"
    && details.isMainFrame
    && details.mediaType === "audio"
  ));
  const dataDirectory = join(app.getPath("userData"), "data");
  settingsStore = new SettingsStore(dataDirectory);
  await settingsStore.initialize();
  ttsClient = new OpenAICompatibleTtsClient(() => settingsStore.get(), () => settingsStore.getTtsApiKey());
  localAsrService = new LocalAsrService(join(app.getAppPath(), "resources", "voice", LOCAL_ASR_MODEL_ID));
  if ((!smokeTest && !modelSwitchSmoke && !capturePetPath) || voiceUiSmoke) {
    void localAsrService.warmup().catch((error: unknown) => {
      console.warn("Local ASR warmup failed", error);
    });
  }
  smokeLog("SETTINGS_READY");
  memoryRepository = new MemoryRepository(dataDirectory);
  await memoryRepository.initialize();
  personalityEngine = new PersonalityEngine(new PersonalityStore(dataDirectory), () => settingsStore.get());
  await personalityEngine.initialize();
  smokeLog("MEMORY_READY");
  modelStore = new ModelStore(dataDirectory, join(__dirname, "../renderer/live2d"));
  await modelStore.initialize();
  if (captureModelId) await modelStore.selectBundled(captureModelId);
  if (modelSwitchSmoke) await modelStore.selectBundled("hiyori");
  smokeLog("MODEL_STORE_READY");
  memoryEngine = new MemoryEngine(memoryRepository, () => settingsStore.get());
  agentService = new AgentService(memoryEngine, settingsStore, personalityEngine);
  heartbeatService = new HeartbeatService(
    memoryEngine,
    memoryRepository,
    agentService,
    settingsStore,
    personalityEngine,
  );
  movementController = new DesktopMovementController(
    () => petWindow,
    () => settingsStore.get(),
    sendPetMotion,
    sendFocus,
  );
  registerIpc();
  petWindow = createPetWindow();
  createTray();
  movementController.start();
  smokeLog("WINDOW_AND_TRAY_CREATED");
  heartbeatService.start(sendProactive, () => broadcastPersonality());
}

app.whenReady().then(initialize).catch((error) => {
  smokeLog(`INITIALIZATION_FAILED ${error instanceof Error ? error.stack : String(error)}`);
  console.error("Application initialization failed", error);
  app.quit();
});

app.on("second-instance", focusChat);
app.on("window-all-closed", () => {
  // 桌宠隐藏后仍需在托盘保持心跳和主动聊天。
});
app.on("before-quit", () => {
  quitting = true;
  movementController?.stop();
  heartbeatService?.stop();
  void localAsrService?.close();
});
