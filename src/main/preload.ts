import { contextBridge, ipcRenderer } from "electron";
import type {
  BootstrapState,
  ChatResponse,
  ComputerActionDecision,
  ComputerActionResult,
  ComputerIntegrationState,
  ControlPanelView,
  HeartbeatResult,
  MemoryDeleteInput,
  MemorySearchResult,
  MemorySnapshot,
  MemoryUpdateInput,
  ModelImportResult,
  Live2DModelAssetPackage,
  LocalSpeechAudio,
  LocalSpeechModelStatus,
  LocalSpeechRecognitionResult,
  PetAgentBridge,
  PetAction,
  PetFocus,
  PetMotionFrame,
  PetUiCommand,
  PersonalityProfile,
  RelationshipProfile,
  PublicSettingsState,
  PublicModelState,
  SettingsUpdate,
  TtsAudio,
} from "../common/types";

const bridge: PetAgentBridge = {
  bootstrap: () => ipcRenderer.invoke("agent:bootstrap") as Promise<BootstrapState>,
  chat: (text: string) => ipcRenderer.invoke("agent:chat", text) as Promise<ChatResponse>,
  remember: (text: string) => ipcRenderer.invoke("memory:remember", text) as Promise<MemorySnapshot>,
  searchMemory: (query: string) => ipcRenderer.invoke("memory:search", query) as Promise<MemorySearchResult[]>,
  getMemory: () => ipcRenderer.invoke("memory:get") as Promise<MemorySnapshot>,
  updateMemory: (input: MemoryUpdateInput) =>
    ipcRenderer.invoke("memory:update", input) as Promise<MemorySnapshot>,
  deleteMemory: (input: MemoryDeleteInput) =>
    ipcRenderer.invoke("memory:delete", input) as Promise<MemorySnapshot>,
  getPersonality: () => ipcRenderer.invoke("personality:get") as Promise<PersonalityProfile>,
  resetPersonality: () => ipcRenderer.invoke("personality:reset") as Promise<PersonalityProfile>,
  getRelationship: () => ipcRenderer.invoke("relationship:get") as Promise<RelationshipProfile>,
  resetRelationship: () => ipcRenderer.invoke("relationship:reset") as Promise<RelationshipProfile>,
  runHeartbeat: () => ipcRenderer.invoke("heartbeat:run") as Promise<HeartbeatResult>,
  saveSettings: (update: SettingsUpdate) =>
    ipcRenderer.invoke("settings:save", update) as Promise<PublicSettingsState>,
  synthesizeSpeech: (text: string) => ipcRenderer.invoke("voice:synthesize", text) as Promise<TtsAudio>,
  getLocalSpeechStatus: () => ipcRenderer.invoke("voice:local-status") as Promise<LocalSpeechModelStatus>,
  recognizeLocalSpeech: (audio: LocalSpeechAudio) =>
    ipcRenderer.invoke("voice:recognize-local", audio) as Promise<LocalSpeechRecognitionResult>,
  cancelLocalSpeechRecognition: () => ipcRenderer.invoke("voice:cancel-local") as Promise<void>,
  showDataDirectory: () => ipcRenderer.invoke("data:show") as Promise<void>,
  minimize: () => ipcRenderer.invoke("window:minimize") as Promise<void>,
  close: () => ipcRenderer.invoke("window:close") as Promise<void>,
  setPetInteraction: (active: boolean) => ipcRenderer.invoke("pet:interaction", active) as Promise<void>,
  setPetClickThrough: (ignore: boolean) => ipcRenderer.invoke("pet:click-through", ignore) as Promise<void>,
  startPetDrag: () => ipcRenderer.invoke("pet:drag-start") as Promise<void>,
  endPetDrag: () => ipcRenderer.invoke("pet:drag-end") as Promise<void>,
  getModelState: () => ipcRenderer.invoke("model:get-state") as Promise<PublicModelState>,
  getActiveModel: () => ipcRenderer.invoke("model:get-active") as Promise<Live2DModelAssetPackage>,
  importLive2DModel: () => ipcRenderer.invoke("model:import") as Promise<ModelImportResult>,
  selectBundledModel: (modelId: string) => ipcRenderer.invoke("model:select-bundled", modelId) as Promise<PublicModelState>,
  playPetAction: (action: PetAction) => ipcRenderer.invoke("pet:play-action", action) as Promise<void>,
  getComputerIntegrationState: () =>
    ipcRenderer.invoke("computer:get-state") as Promise<ComputerIntegrationState>,
  rotateComputerPairingToken: () =>
    ipcRenderer.invoke("computer:rotate-pairing") as Promise<ComputerIntegrationState>,
  copyComputerPairingInfo: () => ipcRenderer.invoke("computer:copy-pairing") as Promise<void>,
  openBrowserExtensionDirectory: () => ipcRenderer.invoke("computer:open-extension") as Promise<void>,
  clearComputerAudit: () => ipcRenderer.invoke("computer:clear-audit") as Promise<ComputerIntegrationState>,
  executeComputerAction: (id: string, decision: ComputerActionDecision) =>
    ipcRenderer.invoke("computer:execute", id, decision) as Promise<ComputerActionResult>,
  onProactiveMessage: (listener: (message: ChatResponse) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, message: ChatResponse) => listener(message);
    ipcRenderer.on("agent:proactive", callback);
    return () => ipcRenderer.removeListener("agent:proactive", callback);
  },
  onSettingsChanged: (listener: (state: PublicSettingsState) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, state: PublicSettingsState) => listener(state);
    ipcRenderer.on("settings:changed", callback);
    return () => ipcRenderer.removeListener("settings:changed", callback);
  },
  onLocalSpeechStatusChanged: (listener: (status: LocalSpeechModelStatus) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, status: LocalSpeechModelStatus) => listener(status);
    ipcRenderer.on("voice:local-status-changed", callback);
    return () => ipcRenderer.removeListener("voice:local-status-changed", callback);
  },
  onPetMotion: (listener: (frame: PetMotionFrame) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, frame: PetMotionFrame) => listener(frame);
    ipcRenderer.on("pet:motion", callback);
    return () => ipcRenderer.removeListener("pet:motion", callback);
  },
  onPetFocus: (listener: (focus: PetFocus) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, focus: PetFocus) => listener(focus);
    ipcRenderer.on("pet:focus", callback);
    return () => ipcRenderer.removeListener("pet:focus", callback);
  },
  onPetAction: (listener: (action: PetAction) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, action: PetAction) => listener(action);
    ipcRenderer.on("pet:action", callback);
    return () => ipcRenderer.removeListener("pet:action", callback);
  },
  onModelChanged: (listener: (state: PublicModelState) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, state: PublicModelState) => listener(state);
    ipcRenderer.on("model:changed", callback);
    return () => ipcRenderer.removeListener("model:changed", callback);
  },
  onUiCommand: (listener: (command: PetUiCommand) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, command: PetUiCommand) => listener(command);
    ipcRenderer.on("ui:command", callback);
    return () => ipcRenderer.removeListener("ui:command", callback);
  },
  onPanelView: (listener: (view: ControlPanelView) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, view: ControlPanelView) => listener(view);
    ipcRenderer.on("panel:view", callback);
    return () => ipcRenderer.removeListener("panel:view", callback);
  },
  onPersonalityChanged: (listener: (profile: PersonalityProfile) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, profile: PersonalityProfile) => listener(profile);
    ipcRenderer.on("personality:changed", callback);
    return () => ipcRenderer.removeListener("personality:changed", callback);
  },
  onRelationshipChanged: (listener: (profile: RelationshipProfile) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, profile: RelationshipProfile) => listener(profile);
    ipcRenderer.on("relationship:changed", callback);
    return () => ipcRenderer.removeListener("relationship:changed", callback);
  },
};

contextBridge.exposeInMainWorld("petAgent", bridge);
