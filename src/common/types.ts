export type MemoryTier = "L1" | "L2" | "L3";
export type MemoryKind = "dialogue" | "episode" | "fact" | "preference" | "reflection";
export type PersistentMemoryTier = Exclude<MemoryTier, "L1">;
export type EditableMemoryKind = Exclude<MemoryKind, "dialogue">;
export type SpeakerRole = "user" | "assistant";
export type PetEmotion =
  | "idle"
  | "happy"
  | "excited"
  | "thinking"
  | "curious"
  | "listening"
  | "speaking"
  | "comforting"
  | "shy"
  | "surprised"
  | "sleepy";
export type PetLocomotion = "idle" | "walk-left" | "walk-right" | "dragged" | "falling" | "landing";
export interface PetMotionFrame {
  state: PetLocomotion;
  velocityX: number;
  velocityY: number;
  offsetX: number;
  offsetY: number;
}
export type PetAction =
  | "wave"
  | "nod"
  | "shake-head"
  | "head-tilt"
  | "jump"
  | "cheer"
  | "dance"
  | "sit"
  | "stretch"
  | "shy"
  | "comfort"
  | "sleep"
  | "surprised";
export interface PetFocus {
  x: number;
  y: number;
}
export type PetUiCommand = "focus-chat" | "suspend";
export type ControlPanelView = "settings" | "memory";
export type VoiceRecognitionMode = "local" | "browser";
export type VoiceOutputMode = "local" | "cloud";
export type ComputerPermissionPolicy = "ask" | "allow" | "deny";
export type ComputerTool = "open-url" | "copy-text" | "save-text-file" | "launch-app";
export type ComputerActionDecision = "allow-once" | "allow-session" | "allow-always" | "deny";
export type ComputerActionStatus = "pending" | "completed" | "denied" | "cancelled" | "failed";
export type ComputerContextAction = "explain" | "summarize" | "chat" | "remember";
export type ComputerContextSource = "browser" | "clipboard" | "file";
export type AgentToolName =
  | "memory_search"
  | "memory_store"
  | "self_profile"
  | "relationship_profile"
  | "desktop_observe"
  | "computer_open_url"
  | "computer_copy_text"
  | "computer_save_text"
  | "computer_launch_app"
  | "pet_action";
export type AgentToolStatus = "completed" | "approval-required" | "blocked" | "failed";
export type PersonalityDimension = "warmth" | "curiosity" | "playfulness" | "directness" | "initiative" | "expressiveness";
export type PersonalityStage = "blank" | "forming" | "developing" | "established";
export type RelationshipStage = "new" | "acquainted" | "familiar" | "companion";
export type RelationshipInsightKind =
  | "identity"
  | "preference"
  | "goal"
  | "routine"
  | "interest"
  | "concern"
  | "work-style"
  | "support-style";
export type DesktopActivityKind =
  | "browsing"
  | "coding"
  | "writing"
  | "office"
  | "communication"
  | "terminal"
  | "design"
  | "media"
  | "gaming";
export type ProactiveTopicFeedback = "pending" | "welcomed" | "neutral" | "dismissed";
export type AwarenessChannelStatus =
  | "disabled"
  | "not-requested"
  | "startup-skipped"
  | "not-configured"
  | "not-supported"
  | "completed"
  | "completed-empty"
  | "failed";

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

export interface RelationshipInsight {
  id: string;
  kind: RelationshipInsightKind;
  topic: string;
  summary: string;
  confidence: number;
  evidenceCount: number;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipActivityPattern {
  activity: DesktopActivityKind;
  label: string;
  observations: number;
  confidence: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RelationshipSharedMoment {
  id: string;
  summary: string;
  importance: number;
  sourceIds: string[];
  happenedAt: string;
  createdAt: string;
}

export interface RelationshipCareStyle {
  initiativeAffinity: number;
  practicalHelpAffinity: number;
  quietCompanionshipAffinity: number;
  evidenceCount: number;
  updatedAt: string;
}

export interface RelationshipProactiveTopic {
  id: string;
  topic: string;
  offeredAt: string;
  feedback: ProactiveTopicFeedback;
  feedbackAt?: string;
}

export interface RelationshipProfile {
  version: 1;
  stage: RelationshipStage;
  interactionCount: number;
  insights: RelationshipInsight[];
  activityPatterns: RelationshipActivityPattern[];
  sharedMoments: RelationshipSharedMoment[];
  careStyle: RelationshipCareStyle;
  recentProactiveTopics: RelationshipProactiveTopic[];
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

export interface MemoryUpdateInput {
  id: string;
  tier: PersistentMemoryTier;
  content: string;
  kind: EditableMemoryKind;
  importance: number;
}

export interface MemoryDeleteInput {
  id: string;
  tier: PersistentMemoryTier;
}

export interface MemoryScoreBreakdown {
  textRelevance: number;
  importance: number;
  recency: number;
  frequency: number;
  total: number;
}

export interface MemorySearchResult {
  memory: MemoryRecord;
  score: MemoryScoreBreakdown;
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
  relationshipUpdates?: number;
  thought?: HeartbeatThought;
  awareness?: HeartbeatAwarenessSummary;
  proactiveMessage?: string;
  skippedProactiveReason?: string;
}

export interface HeartbeatThought {
  selfReflection: string;
  userUnderstanding: string;
  relationshipFocus: string;
  shouldReachOut: boolean;
  proactiveTopic?: string;
  reason: string;
}

export interface HeartbeatAwarenessSummary {
  /** 兼容既有持久化字段；现在表示图片已发送到独立识图端点。 */
  screenSharedWithProvider: boolean;
  processScanCompleted: boolean;
  visibleApplicationCount: number;
  newApplicationCount: number;
  activityLabels: string[];
  screenStatus?: AwarenessChannelStatus;
  processStatus?: AwarenessChannelStatus;
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
  vision: {
    enabled: boolean;
    baseUrl: string;
    model: string;
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
  awareness: {
    screenCaptureEnabled: boolean;
    processDetectionEnabled: boolean;
    processPollMinutes: number;
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
  computer: {
    enabled: boolean;
    browserContextEnabled: boolean;
    clipboardShortcutEnabled: boolean;
    permissions: Record<ComputerTool, ComputerPermissionPolicy>;
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
  hasVisionApiKey: boolean;
  hasTtsApiKey: boolean;
  dataDirectory: string;
}

export interface SettingsUpdate extends Partial<AgentSettings> {
  apiKey?: string;
  clearApiKey?: boolean;
  visionApiKey?: string;
  clearVisionApiKey?: boolean;
  ttsApiKey?: string;
  clearTtsApiKey?: boolean;
}

export interface ChatResponse {
  text: string;
  emotion: PetEmotion;
  source: "provider" | "local";
  memoryRefs: string[];
  warning?: string;
  computerActions?: ComputerActionProposal[];
  toolCalls?: AgentToolTrace[];
  requestedAction?: PetAction;
}

export interface AgentToolTrace {
  callId: string;
  name: AgentToolName;
  label: string;
  status: AgentToolStatus;
  summary: string;
}

export interface SharedComputerContext {
  action: ComputerContextAction;
  source: ComputerContextSource;
  text: string;
  title?: string;
  url?: string;
  capturedAt: string;
}

export interface ComputerActionProposal {
  id: string;
  tool: ComputerTool;
  title: string;
  description: string;
  preview: string;
  severity: "info" | "warning";
  requiresApproval: boolean;
  allowedDecisions: ComputerActionDecision[];
  expiresAt: string;
}

export interface ComputerActionResult {
  id: string;
  status: Exclude<ComputerActionStatus, "pending">;
  message: string;
}

export interface ComputerAuditEntry {
  id: string;
  source: "chat" | ComputerContextSource | "settings";
  kind: "context" | "tool";
  action: ComputerTool | ComputerContextAction | "pairing-token";
  summary: string;
  status: ComputerActionStatus;
  createdAt: string;
  updatedAt: string;
  decision?: ComputerActionDecision;
  detail?: string;
}

export interface ComputerIntegrationState {
  enabled: boolean;
  browserContextEnabled: boolean;
  browserBridgeRunning: boolean;
  browserBridgeMessage: string;
  endpoint: string;
  pairingToken: string;
  extensionDirectory: string;
  clipboardShortcutEnabled: boolean;
  clipboardShortcutRegistered: boolean;
  clipboardShortcut: string;
  sessionAllowedTools: ComputerTool[];
  recentAudit: ComputerAuditEntry[];
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

export type LocalSpeechRuntimeState = "not-started" | "warming" | "ready" | "failed";

export interface LocalSpeechModelStatus {
  state: "ready" | "missing" | "invalid";
  modelId: string;
  directory: string;
  sizeBytes: number;
  message: string;
  runtimeState: LocalSpeechRuntimeState;
  runtimeMessage?: string;
}

export interface HeartbeatResult {
  event: HeartbeatEvent;
  snapshot: MemorySnapshot;
  personality: PersonalityProfile;
  relationship: RelationshipProfile;
}

export interface BootstrapState {
  settings: PublicSettingsState;
  memory: MemorySnapshot;
  personality: PersonalityProfile;
  relationship: RelationshipProfile;
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
  searchMemory(query: string): Promise<MemorySearchResult[]>;
  getMemory(): Promise<MemorySnapshot>;
  updateMemory(input: MemoryUpdateInput): Promise<MemorySnapshot>;
  deleteMemory(input: MemoryDeleteInput): Promise<MemorySnapshot>;
  getPersonality(): Promise<PersonalityProfile>;
  resetPersonality(): Promise<PersonalityProfile>;
  getRelationship(): Promise<RelationshipProfile>;
  resetRelationship(): Promise<RelationshipProfile>;
  runHeartbeat(): Promise<HeartbeatResult>;
  saveSettings(update: SettingsUpdate): Promise<PublicSettingsState>;
  synthesizeSpeech(text: string): Promise<TtsAudio>;
  getLocalSpeechStatus(): Promise<LocalSpeechModelStatus>;
  recognizeLocalSpeech(audio: LocalSpeechAudio): Promise<LocalSpeechRecognitionResult>;
  cancelLocalSpeechRecognition(): Promise<void>;
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
  getComputerIntegrationState(): Promise<ComputerIntegrationState>;
  rotateComputerPairingToken(): Promise<ComputerIntegrationState>;
  copyComputerPairingInfo(): Promise<void>;
  openBrowserExtensionDirectory(): Promise<void>;
  clearComputerAudit(): Promise<ComputerIntegrationState>;
  executeComputerAction(id: string, decision: ComputerActionDecision): Promise<ComputerActionResult>;
  onProactiveMessage(listener: (message: ChatResponse) => void): () => void;
  onSettingsChanged(listener: (state: PublicSettingsState) => void): () => void;
  onLocalSpeechStatusChanged(listener: (status: LocalSpeechModelStatus) => void): () => void;
  onPetMotion(listener: (frame: PetMotionFrame) => void): () => void;
  onPetFocus(listener: (focus: PetFocus) => void): () => void;
  onPetAction(listener: (action: PetAction) => void): () => void;
  onModelChanged(listener: (state: PublicModelState) => void): () => void;
  onUiCommand(listener: (command: PetUiCommand) => void): () => void;
  onPanelView(listener: (view: ControlPanelView) => void): () => void;
  onPersonalityChanged(listener: (profile: PersonalityProfile) => void): () => void;
  onRelationshipChanged(listener: (profile: RelationshipProfile) => void): () => void;
}
