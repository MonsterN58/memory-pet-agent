import "pixi.js/unsafe-eval";
import { Application, extensions, WebGLRenderer } from "pixi.js";
import {
  configureCubismSDK,
  CubismModelSettings,
  Live2DModel,
  Live2DPlugin,
  MotionPriority,
  type CubismInternalModel,
} from "untitled-pixi-live2d-engine/cubism";
import type { Live2DModelAssetPackage, PetAction, PetEmotion, PetFocus, PetMotionFrame } from "../common/types";
import {
  advanceFocus,
  computePetTransform,
  motionDurationMs,
  proceduralActionDurationMs,
  resolveFocusBindings,
  resolveActionMotion,
  type FocusBindings,
  type PetTransform,
} from "./live2d-interaction";
import type { PetModelAdapter } from "./model-adapter";

let runtimeConfigured = false;

function configureRuntime(): void {
  if (runtimeConfigured) return;
  if (!("Live2DCubismCore" in window)) throw new Error("Live2D Cubism Core 未加载");
  extensions.add(Live2DPlugin);
  configureCubismSDK({ memorySizeMB: 32 });
  runtimeConfigured = true;
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function createModelSettings(assets: Live2DModelAssetPackage): CubismModelSettings {
  const settingsAsset = assets.files.find((asset) => asset.path.toLowerCase().endsWith(".model3.json"));
  if (!settingsAsset) throw new Error("Live2D 资源包缺少 model3.json");
  const json = JSON.parse(new TextDecoder().decode(decodeBase64(settingsAsset.base64))) as Record<string, unknown>;
  json.url = settingsAsset.path;
  const settings = new CubismModelSettings(json as ConstructorParameters<typeof CubismModelSettings>[0]);
  const files = new Map(assets.files.map((asset) => [asset.path, asset]));
  settings.resolveURL = (path: string) => {
    const base = new URL(settingsAsset.path, "https://memory-pet.invalid/");
    const resolved = decodeURIComponent(new URL(path, base).pathname.replace(/^\/+/, ""));
    const asset = files.get(resolved);
    if (!asset) throw new Error(`Live2D 资源包缺少 ${resolved}`);
    return `data:${asset.mimeType};base64,${asset.base64}`;
  };
  return settings;
}

const MAO_EXPRESSIONS: Record<PetEmotion, number> = {
  idle: 0,
  happy: 1,
  thinking: 4,
  curious: 3,
  listening: 6,
  speaking: 0,
  sleepy: 2,
};

interface FocusProfile {
  eye: number;
  headX: number;
  headY: number;
  headZ: number;
  body: number;
  ear: number;
}

const DEFAULT_FOCUS_PROFILE: FocusProfile = {
  eye: 0.85,
  headX: 12,
  headY: 8,
  headZ: 3,
  body: 3.5,
  ear: 0.25,
};

const BUNDLED_FOCUS_PROFILES: Record<string, FocusProfile> = {
  hiyori: { eye: 0.9, headX: 10, headY: 7, headZ: 2.5, body: 3, ear: 0 },
  mao: { eye: 0.82, headX: 9, headY: 6, headZ: 2, body: 2.5, ear: 0 },
  wanko: { eye: 0, headX: 18, headY: 12, headZ: 4, body: 6, ear: 0.4 },
};

const TRANSFORM_KEYS: Array<keyof PetTransform> = [
  "translateX", "translateY", "rotation", "scaleX", "scaleY",
];

function neutralTransform(): PetTransform {
  return { translateX: 0, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1 };
}

function zeroTransform(): PetTransform {
  return { translateX: 0, translateY: 0, rotation: 0, scaleX: 0, scaleY: 0 };
}

/** Cubism 3/4/5 renderer backed by PixiJS 8. Desktop position remains owned by Electron. */
export class Live2DPetAdapter implements PetModelAdapter {
  readonly id: string;
  private readonly assets: Live2DModelAssetPackage;
  private app?: Application;
  private model?: Live2DModel<CubismInternalModel>;
  private root?: HTMLDivElement;
  private width = 270;
  private height = 330;
  private baseScale = 1;
  private emotion: PetEmotion = "idle";
  private motion: PetMotionFrame = {
    state: "idle", velocityX: 0, velocityY: 0, offsetX: 0, offsetY: 0,
  };
  private action?: PetAction;
  private actionUsesMotion = false;
  private actionStartedAt = 0;
  private actionTimer?: number;
  private speakTimer?: number;
  private speechUntil = 0;
  private focus: PetFocus = { x: 0, y: 0 };
  private appliedFocus: PetFocus = { x: 0, y: 0 };
  private focusBindings: FocusBindings = {};
  private landingStartedAt?: number;
  private spring = neutralTransform();
  private springVelocity = zeroTransform();
  private lastTransformAt = 0;

  constructor(assets: Live2DModelAssetPackage) {
    this.assets = assets;
    this.id = `live2d:${assets.info.source}:${assets.info.id}`;
  }

  async mount(container: HTMLElement): Promise<void> {
    configureRuntime();
    const root = document.createElement("div");
    root.className = "live2d-pet state-idle locomotion-idle";
    root.dataset.model = this.assets.info.id;
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", `Live2D 桌宠 ${this.assets.info.name}`);
    container.replaceChildren(root);
    this.root = root;
    this.width = Math.max(1, container.clientWidth || this.width);
    this.height = Math.max(1, container.clientHeight || this.height);

    const app = new Application();
    await app.init({
      width: this.width,
      height: this.height,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: "webgl",
    });
    app.canvas.className = "live2d-canvas";
    app.canvas.setAttribute("aria-hidden", "true");
    root.append(app.canvas);
    this.app = app;

    const model = await Live2DModel.from(createModelSettings(this.assets), {
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: true,
      ticker: app.ticker,
      textureOptions: {
        lod: false,
        preferCreateImageBitmap: false,
      },
    }) as Live2DModel<CubismInternalModel>;
    const coreModel = model.internalModel.coreModel;
    coreModel.setOverrideFlagForModelCullings(true);
    for (let index = 0; index < coreModel.getDrawableCount(); index += 1) {
      coreModel.setDrawableCulling(index, false);
    }
    this.installTextureUploadCompatibility(model);
    app.stage.addChild(model);
    this.model = model;
    this.focusBindings = this.discoverFocusBindings(model);
    model.on("beforeModelUpdate", () => this.applyFrameParameters());
    this.fitModel();
    this.setFocus(this.focus);
    this.playIdle();
  }

  setState(state: PetEmotion): void {
    if (state === this.emotion) return;
    this.root?.classList.remove(`state-${this.emotion}`);
    this.emotion = state;
    this.root?.classList.add(`state-${state}`);
    this.applyEmotionExpression();
  }

  setMotion(frame: PetMotionFrame): void {
    this.root?.classList.remove(`locomotion-${this.motion.state}`);
    if (frame.state === "landing" && this.motion.state !== "landing") {
      this.landingStartedAt = performance.now();
    } else if (frame.state !== "landing") {
      this.landingStartedAt = undefined;
    }
    this.motion = frame;
    this.root?.classList.add(`locomotion-${frame.state}`);
    this.updateTransform(performance.now());
  }

  setFocus(focus: PetFocus): void {
    this.focus = {
      x: Number.isFinite(focus.x) ? Math.max(-1, Math.min(1, focus.x)) : 0,
      y: Number.isFinite(focus.y) ? Math.max(-1, Math.min(1, focus.y)) : 0,
    };
  }

  playAction(action: PetAction): boolean {
    if (!this.root || !this.model) return false;
    if (this.action) this.root.classList.remove(`action-${this.action}`);
    if (this.actionTimer) window.clearTimeout(this.actionTimer);
    this.model.stopMotions();
    this.action = action;
    this.actionStartedAt = performance.now();
    this.root.classList.add(`action-${action}`);
    const motion = resolveActionMotion(this.assets.info.id, action, this.assets.info.motionGroups);
    this.actionUsesMotion = Boolean(
      motion && this.playMotion([motion.group], motion.index, MotionPriority.FORCE),
    );
    const duration = motion && this.actionUsesMotion
      ? this.readMotionDuration(motion.group, motion.index) ?? proceduralActionDurationMs(action)
      : proceduralActionDurationMs(action);
    this.actionTimer = window.setTimeout(() => {
      this.root?.classList.remove(`action-${action}`);
      if (this.action === action) this.action = undefined;
      this.actionUsesMotion = false;
      this.actionStartedAt = 0;
      this.model?.stopMotions();
      this.updateTransform(performance.now());
      this.applyEmotionExpression();
      this.playIdle();
    }, duration);
    return true;
  }

  async speak(text: string): Promise<void> {
    const duration = Math.min(7000, Math.max(900, text.length * 105));
    this.speechUntil = performance.now() + duration;
    this.root?.classList.add("is-speaking");
    if (this.speakTimer) window.clearTimeout(this.speakTimer);
    await new Promise<void>((resolve) => {
      this.speakTimer = window.setTimeout(() => {
        this.speechUntil = 0;
        this.root?.classList.remove("is-speaking");
        resolve();
      }, duration);
    });
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.app?.renderer.resize(this.width, this.height);
    this.fitModel();
  }

  destroy(): void {
    if (this.actionTimer) window.clearTimeout(this.actionTimer);
    if (this.speakTimer) window.clearTimeout(this.speakTimer);
    const model = this.model;
    model?.stopMotions();
    if (model && this.app) {
      // Destroy the Live2D child while its ticker is still alive. Pixi destroys
      // application plugins before stage children, which otherwise makes the
      // model unregister from an already-destroyed ticker during hot switching.
      this.app.stage.removeChild(model);
      this.destroyModelCompatibility(model);
    }
    this.model = undefined;
    // Live2D textures are cached by data URL. Keep their CPU sources valid so a model
    // can be selected again after its old WebGL context has been released.
    this.app?.destroy({ removeView: true }, { children: true, texture: false, textureSource: false, context: true });
    this.app = undefined;
    this.focusBindings = {};
    this.appliedFocus = { x: 0, y: 0 };
    this.action = undefined;
    this.actionUsesMotion = false;
    this.actionStartedAt = 0;
    this.landingStartedAt = undefined;
    this.spring = neutralTransform();
    this.springVelocity = zeroTransform();
    this.lastTransformAt = 0;
    this.root?.remove();
    this.root = undefined;
  }

  private findMotionGroup(...aliases: string[]): string | undefined {
    const groups = Object.keys(this.assets.info.motionGroups);
    for (const alias of aliases) {
      const group = groups.find((candidate) => candidate.toLowerCase() === alias.toLowerCase());
      if (group) return group;
    }
    return undefined;
  }

  private playIdle(): void {
    const group = this.findMotionGroup("Idle", "idle");
    if (!group || !this.model) return;
    const count = this.assets.info.motionGroups[group] ?? 0;
    if (!count) return;
    const index = this.assets.info.source === "bundled" ? 0 : Math.floor(Math.random() * count);
    void this.model.motion(group, index, MotionPriority.IDLE, { loop: true }).catch(() => false);
  }

  private playMotion(groups: string[], index: number, priority: MotionPriority): boolean {
    const group = this.findMotionGroup(...groups);
    if (!group || !this.model) return false;
    const count = this.assets.info.motionGroups[group] ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= count) return false;
    void this.model.motion(group, index, priority, { loop: false }).catch(() => false);
    return true;
  }

  private applyEmotionExpression(): void {
    const expression = MAO_EXPRESSIONS[this.emotion];
    if (this.assets.info.id === "mao" && this.assets.info.expressionCount > expression) {
      void this.model?.expression(expression).catch(() => false);
    }
  }

  private fitModel(): void {
    const model = this.model;
    if (!model) return;
    const bounds = this.getVisibleBounds(model);
    this.baseScale = Math.min((this.width * 0.94) / bounds.width, (this.height * 0.98) / bounds.height);
    model.pivot.set(bounds.centerX, bounds.bottom);
    this.applySpringTransform();
  }

  private getVisibleBounds(model: Live2DModel<CubismInternalModel>): {
    width: number;
    height: number;
    centerX: number;
    bottom: number;
  } {
    const internal = model.internalModel;
    const core = internal.coreModel;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < core.getDrawableCount(); index += 1) {
      if (core.getDrawableOpacity(index) <= 0.001) continue;
      const bounds = internal.getDrawableBounds(index);
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) continue;
      left = Math.min(left, bounds.x);
      top = Math.min(top, bounds.y);
      right = Math.max(right, bounds.x + bounds.width);
      bottom = Math.max(bottom, bounds.y + bounds.height);
    }
    if (right <= left || bottom <= top) {
      left = 0;
      top = 0;
      right = Math.max(1, internal.width);
      bottom = Math.max(1, internal.height);
    }
    return {
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      centerX: (left + right) / 2,
      bottom,
    };
  }

  private updateTransform(now: number): void {
    const landingElapsed = this.landingStartedAt === undefined ? 0 : now - this.landingStartedAt;
    const proceduralAction = this.action && !this.actionUsesMotion ? this.action : undefined;
    const actionElapsed = this.actionStartedAt ? now - this.actionStartedAt : 0;
    const target = computePetTransform(this.motion, proceduralAction, actionElapsed, landingElapsed);
    const elapsed = this.lastTransformAt ? Math.max(1, Math.min(50, now - this.lastTransformAt)) : 16.67;
    this.lastTransformAt = now;
    const step = elapsed / 16.67;
    const damping = Math.pow(0.68, step);
    for (const key of TRANSFORM_KEYS) {
      const velocity = (this.springVelocity[key] + (target[key] - this.spring[key]) * 0.2 * step) * damping;
      this.springVelocity[key] = velocity;
      this.spring[key] += velocity * step;
    }
    this.applySpringTransform();
  }

  private applySpringTransform(): void {
    const model = this.model;
    if (!model) return;
    const facing = this.motion.state === "walk-left" ? -1 : 1;
    model.scale.set(
      this.baseScale * facing * this.spring.scaleX,
      this.baseScale * this.spring.scaleY,
    );
    model.position.set(
      this.width / 2 + this.spring.translateX,
      this.height - 2 + this.spring.translateY,
    );
    model.rotation = this.spring.rotation;
  }

  private applyLipSync(): void {
    if (!this.model || performance.now() >= this.speechUntil) return;
    const internal = this.model.internalModel as CubismInternalModel & {
      getIdSafe(id: string): unknown;
      coreModel: { addParameterValueById(id: unknown, value: number, weight?: number): void };
    };
    const parameters = this.assets.info.lipSyncParameters;
    if (!parameters.length) return;
    const value = 0.12 + Math.abs(Math.sin(performance.now() / 92)) * 0.72;
    for (const parameter of parameters) {
      internal.coreModel.addParameterValueById(internal.getIdSafe(parameter), value, 1);
    }
  }

  private discoverFocusBindings(model: Live2DModel<CubismInternalModel>): FocusBindings {
    const core = model.internalModel.coreModel;
    const parameterIds: string[] = [];
    for (let index = 0; index < core.getParameterCount(); index += 1) {
      parameterIds.push(core.getParameterId(index).getString().s);
    }
    return resolveFocusBindings(parameterIds);
  }

  private applyFrameParameters(): void {
    this.appliedFocus = advanceFocus(this.appliedFocus, this.focus, 0.16);
    this.applyFocusParameters();
    this.applyLipSync();
    this.updateTransform(performance.now());
  }

  private readMotionDuration(group: string, index: number): number | undefined {
    try {
      const settingsAsset = this.assets.files.find((asset) => asset.path.toLowerCase().endsWith(".model3.json"));
      if (!settingsAsset) return undefined;
      const settings = JSON.parse(new TextDecoder().decode(decodeBase64(settingsAsset.base64))) as {
        FileReferences?: { Motions?: Record<string, Array<{ File?: unknown }>> };
      };
      const groups = settings.FileReferences?.Motions;
      if (!groups) return undefined;
      const actualGroup = Object.keys(groups).find((candidate) => candidate.toLowerCase() === group.toLowerCase());
      const file = actualGroup ? groups[actualGroup]?.[index]?.File : undefined;
      if (typeof file !== "string") return undefined;
      const base = new URL(settingsAsset.path, "https://memory-pet.invalid/");
      const resolved = decodeURIComponent(new URL(file, base).pathname.replace(/^\/+/, ""));
      const motionAsset = this.assets.files.find((asset) => asset.path === resolved);
      if (!motionAsset) return undefined;
      const motion = JSON.parse(new TextDecoder().decode(decodeBase64(motionAsset.base64))) as unknown;
      return motionDurationMs(motion);
    } catch {
      return undefined;
    }
  }

  private applyFocusParameters(): void {
    const { x, y } = this.appliedFocus;
    const bindings = this.focusBindings;
    const profile = BUNDLED_FOCUS_PROFILES[this.assets.info.id] ?? DEFAULT_FOCUS_PROFILE;
    const hasEyePair = bindings.eyeX !== undefined && bindings.eyeY !== undefined;
    const headMultiplier = hasEyePair ? 1 : 1.35;
    const bodyMultiplier = hasEyePair ? 1 : 1.45;

    this.addBoundedParameter(bindings.eyeX, x * profile.eye);
    this.addBoundedParameter(bindings.eyeY, y * profile.eye);
    this.addBoundedParameter(bindings.angleX, x * profile.headX * headMultiplier);
    this.addBoundedParameter(bindings.angleY, y * profile.headY * headMultiplier);
    this.addBoundedParameter(bindings.angleZ, -x * y * profile.headZ * headMultiplier);
    this.addBoundedParameter(bindings.bodyX, x * profile.body * bodyMultiplier);
    this.addBoundedParameter(bindings.bodyY, y * profile.body * bodyMultiplier);
    this.addBoundedParameter(bindings.bodyZ, -x * profile.body * 0.45 * bodyMultiplier);
    this.addBoundedParameter(bindings.earLeft, (x + y * 0.2) * profile.ear);
    this.addBoundedParameter(bindings.earRight, (-x + y * 0.2) * profile.ear);
  }

  private addBoundedParameter(index: number | undefined, value: number): void {
    const core = this.model?.internalModel.coreModel;
    if (!core || index === undefined || !Number.isFinite(value)) return;
    const current = core.getParameterValueByIndex(index);
    const minimum = core.getParameterMinimumValue(index);
    const maximum = core.getParameterMaximumValue(index);
    if (![current, minimum, maximum].every(Number.isFinite) || minimum > maximum) return;
    const addition = Math.max(minimum - current, Math.min(maximum - current, value));
    core.addParameterValueByIndex(index, addition, 1);
  }

  private installTextureUploadCompatibility(model: Live2DModel<CubismInternalModel>): void {
    type Texture = Live2DModel<CubismInternalModel>["textures"][number];
    type UploadTarget = {
      uploadTextureForRender(renderer: WebGLRenderer, texture: Texture, shouldUpdateTexture: boolean): void;
    };
    const target = model as unknown as UploadTarget;
    // Engine 1.3.1 still probes TextureSource._gpuData, removed by PixiJS 8.13.
    // Binding through Pixi's public texture system creates/reuses the GL source safely.
    target.uploadTextureForRender = (renderer, texture) => {
      renderer.gl.pixelStorei(renderer.gl.UNPACK_FLIP_Y_WEBGL, model.internalModel.textureFlipY);
      renderer.texture.bind(texture, 0);
    };
  }

  private destroyModelCompatibility(model: Live2DModel<CubismInternalModel>): void {
    type MocHandle = { _modelCount?: number; release(): void };
    const internal = model.internalModel as CubismInternalModel & { __moc?: MocHandle };
    const moc = internal.__moc;
    if (moc) {
      // Engine 1.3.1 releases the Moc from an early `destroy` event, before the
      // core model is released, and never decrements CubismMoc._modelCount.
      // Defer that one listener until after model.destroy() to preserve the
      // official model-then-Moc lifetime and avoid a Cubism assertion.
      internal.removeAllListeners("destroy");
    }
    model.destroy({ children: true, texture: false, baseTexture: false });
    if (moc) {
      if (typeof moc._modelCount === "number" && moc._modelCount > 0) moc._modelCount -= 1;
      moc.release();
      internal.__moc = undefined;
    }
  }

}
