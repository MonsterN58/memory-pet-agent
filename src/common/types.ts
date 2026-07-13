export type MemoryTier = "L1" | "L2" | "L3";
export type MemoryKind = "dialogue" | "episode" | "fact" | "preference" | "reflection";
export type SpeakerRole = "user" | "assistant";
export type PetEmotion = "idle" | "happy" | "thinking" | "curious" | "listening" | "speaking" | "sleepy";
export type PetLocomotion = "idle" | "walk-left" | "walk-right" | "dragged" | "falling";
export type PetAction = "wave" | "jump" | "dance" | "sit" | "sleep" | "surprised";
export interface PetFocus {
  x: number;
  y: number;
}
export type PetUiCommand = "focus-chat";
export type ControlPanelView = "settings" | "memory";
export type VoiceRecognitionMode = "local" | "browser";
export type VoiceOutputMode = "local" | "cloud";
export type PersonalityDimension = "warmth" | "curiosity" | "playfulness" | "directness" | "initiative" | "expressiveness";
export type PersonalityStage = "blank" | "forming" | "developing" | "established";

export interface PersonalityTraitState {
  dimension: PersonalityDimension;
  score: number;
  confidence: number;
  evidenceCount: number;
  lastEvidence: string;
  updatedAt: string;
}

export interface PersonalityProfile {
  version: 1;
  stage: PersonalityStage;
  interactionCount: number;
  traits: PersonalityTraitState[];
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecord {
  id: string;
  tier: MemoryTier;
  kind: MemoryKind;
  content: string;
  summary: string;
  importance: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
  accessCount: number;
  sourceIds: string[];
}

export interface InstantMemory extends MemoryRecord {
  tier: "L1";
  role: SpeakerRole;
}

export interface LongTermCandidate {
  kind: Exclude<MemoryKind, "dialogue">;
  content: string;
  summary: string;
  importance: number;
  tags: string[];
  sourceIds?: string[];
}

export interface HeartbeatEvent {
  id: string;
  reason: "scheduled" | "manual" | "startup";
  createdAt: string;
  movedToL2: number;
  consolidatedToL3: number;
  reflection: string;
  personalityUpdates?: number;
  proactiveMessage?: string;
  skippedProactiveReason?: string;
}

export interface MemorySnapshot {
  l1: InstantMemory[];
  l2: MemoryRecord[];
  l3: MemoryRecord[];
  recentHeartbeats: HeartbeatEvent[];
}

export interface AgentSettings {
  agentName: string;
  userName: string;
  personality: {
    learningEnabled: boolean;
    adaptationRate: number;
    minimumEvidence: number;
  };
  provider: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    temperature: number;
  };
  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    l1MaxItems: number;
    l1MaxAgeMinutes: number;
    consolidateAfterItems: number;
    proactiveEnabled: boolean;
    idleMinutesBeforeChat: number;
    proactiveCooldownMinutes: number;
    proactiveDailyLimit: number;
    quietHoursStart: number;
    quietHoursEnd: number;
  };
  voice: {
    inputEnabled: boolean;
    outputEnabled: boolean;
    language: string;
    recognitionMode: VoiceRecognitionMode;
    ttsMode: VoiceOutputMode;
    ttsBaseUrl: string;
    ttsModel: string;
    ttsVoice: string;
    ttsSpeed: number;
  };
  window: {
    alwaysOnTop: boolean;
    roamingEnabled: boolean;
    roamingSpeed: number;
  };
}

export interface PublicSettingsState {
  settings: AgentSettings;
  hasApiKey: boolean;
  hasTtsApiKey: boolean;
  dataDirectory: string;
}

export interface SettingsUpdate extends Partial<AgentSettings> {
  apiKey?: string;
  clearApiKey?: boolean;
  ttsApiKey?: string;
  clearTtsApiKey?: boolean;
}

export interface ChatResponse {
  text: string;
  emotion: PetEmotion;
  source: "provider" | "local";
  memoryRefs: string[];
  warning?: string;
}

export interface TtsAudio {
  mimeType: "audio/mpeg";
  base64: string;
}

export interface LocalSpeechAudio {
  sampleRate: 16000;
  pcm16: ArrayBuffer;
}

export interface LocalSpeechRecognitionResult {
  text: string;
  durationMs: number;
}

export interface LocalSpeechModelStatus {
  state: "ready" | "missing" | "invalid";
  modelId: string;
  directory: string;
  sizeBytes: number;
  message: string;
}

export interface HeartbeatResult {
  event: HeartbeatEvent;
  snapshot: MemorySnapshot;
  personality: PersonalityProfile;
}

export interface BootstrapState {
  settings: PublicSettingsState;
  memory: MemorySnapshot;
  personality: PersonalityProfile;
  providerMode: "provider" | "local";
}

export interface Live2DModelInfo {
  id: string;
  name: string;
  source: "bundled" | "imported";
  settingsVersion: number;
  motionGroups: Record<string, number>;
  motionCount: number;
  expressionCount: number;
  lipSyncParameters: string[];
  textureCount: number;
  importedAt?: string;
}

export interface PublicModelState {
  kind: "bundled" | "imported";
  model: Live2DModelInfo;
  bundledModels: Live2DModelInfo[];
}

export interface Live2DModelAssetPackage {
  info: Live2DModelInfo;
  files: Array<{
    path: string;
    mimeType: string;
    base64: string;
  }>;
}

export interface ModelImportResult {
  cancelled: boolean;
  state: PublicModelState;
  message?: string;
}

export interface PetAgentBridge {
  bootstrap(): Promise<BootstrapState>;
  chat(text: string): Promise<ChatResponse>;
  remember(text: string): Promise<MemorySnapshot>;
  searchMemory(query: string): Promise<MemoryRecord[]>;
  getMemory(): Promise<MemorySnapshot>;
  getPersonality(): Promise<PersonalityProfile>;
  resetPersonality(): Promise<PersonalityProfile>;
  runHeartbeat(): Promise<HeartbeatResult>;
  saveSettings(update: SettingsUpdate): Promise<PublicSettingsState>;
  synthesizeSpeech(text: string): Promise<TtsAudio>;
  getLocalSpeechStatus(): Promise<LocalSpeechModelStatus>;
  recognizeLocalSpeech(audio: LocalSpeechAudio): Promise<LocalSpeechRecognitionResult>;
  showDataDirectory(): Promise<void>;
  minimize(): Promise<void>;
  close(): Promise<void>;
  setPetInteraction(active: boolean): Promise<void>;
  setPetClickThrough(ignore: boolean): Promise<void>;
  startPetDrag(): Promise<void>;
  endPetDrag(): Promise<void>;
  getModelState(): Promise<PublicModelState>;
  getActiveModel(): Promise<Live2DModelAssetPackage>;
  importLive2DModel(): Promise<ModelImportResult>;
  selectBundledModel(modelId: string): Promise<PublicModelState>;
  playPetAction(action: PetAction): Promise<void>;
  onProactiveMessage(listener: (message: ChatResponse) => void): () => void;
  onSettingsChanged(listener: (state: PublicSettingsState) => void): () => void;
  onLocomotion(listener: (state: PetLocomotion) => void): () => void;
  onPetFocus(listener: (focus: PetFocus) => void): () => void;
  onPetAction(listener: (action: PetAction) => void): () => void;
  onModelChanged(listener: (state: PublicModelState) => void): () => void;
  onUiCommand(listener: (command: PetUiCommand) => void): () => void;
  onPanelView(listener: (view: ControlPanelView) => void): () => void;
  onPersonalityChanged(listener: (profile: PersonalityProfile) => void): () => void;
}
