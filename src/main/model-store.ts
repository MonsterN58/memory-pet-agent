import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Live2DModelAssetPackage,
  Live2DModelInfo,
  PublicModelState,
} from "../common/types";
import { BUNDLED_MODEL_DEFINITIONS } from "../common/bundled-models";

const MAX_FILES = 240;
const MAX_DEPTH = 8;
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_MOC_BYTES = 24 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TEXTURES = 8;
const DEFAULT_BUNDLED_MODEL_ID = "hiyori";
const MOC3_MAGIC = Buffer.from("MOC3", "ascii");
const MIN_SUPPORTED_MOC3_VERSION = 1;
const MAX_SUPPORTED_MOC3_VERSION = 5;

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
}

interface StoredModelManifest extends Live2DModelInfo {
  settingsFile: string;
  files: string[];
}

interface ModelStoreState {
  active?: {
    kind: "bundled" | "imported";
    id: string;
  };
}

interface Live2DSettingsJson {
  Version?: unknown;
  FileReferences?: {
    Moc?: unknown;
    Textures?: unknown;
    Physics?: unknown;
    Pose?: unknown;
    UserData?: unknown;
    DisplayInfo?: unknown;
    Motions?: unknown;
    Expressions?: unknown;
  };
  Groups?: unknown;
}

function modelError(message: string): Error {
  return new Error(`模型导入失败：${message}`);
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.includes("\0")
    || normalized.includes(":")
    || isAbsolute(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw modelError(`模型包含不安全的资源路径：${value}`);
  }
  return normalized;
}

function resolveInside(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  const check = relative(resolvedRoot, resolvedPath);
  if (!check || check === ".") return resolvedPath;
  if (check.startsWith("..") || isAbsolute(check)) throw modelError(`资源路径超出所选目录：${path}`);
  return resolvedPath;
}

function resolveReference(settingsFile: string, reference: string): string {
  const safeReference = normalizeRelativePath(reference);
  const base = dirname(settingsFile);
  return normalizeRelativePath(base === "." ? safeReference : join(base, safeReference));
}

function mimeTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".moc3") return "application/octet-stream";
  throw modelError(`不支持的 Live2D 资源格式：${extension || "未知"}`);
}

function maximumBytesFor(path: string): number {
  const extension = extname(path).toLowerCase();
  if (extension === ".moc3") return MAX_MOC_BYTES;
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return MAX_TEXTURE_BYTES;
  if ([".wav", ".mp3", ".ogg"].includes(extension)) return MAX_AUDIO_BYTES;
  return MAX_JSON_BYTES;
}

async function collectFiles(root: string, directory = root, depth = 0, files: CandidateFile[] = []): Promise<CandidateFile[]> {
  if (depth > MAX_DEPTH) throw modelError(`目录层级不能超过 ${MAX_DEPTH} 层`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, absolutePath, depth + 1, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({ absolutePath, relativePath: normalizeRelativePath(relative(root, absolutePath)) });
    if (files.length > MAX_FILES) throw modelError(`目录文件数量不能超过 ${MAX_FILES} 个`);
  }
  return files;
}

async function readLimited(path: string, maximum: number, label: string): Promise<Buffer> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw modelError(`${label}不存在或不是普通文件`);
  if (info.size <= 0 || info.size > maximum) {
    throw modelError(`${label}大小必须在 1B 到 ${Math.round(maximum / 1024 / 1024)}MB 之间`);
  }
  return readFile(path);
}

function validateMoc3Header(content: Buffer): void {
  if (content.length < 5 || !content.subarray(0, MOC3_MAGIC.length).equals(MOC3_MAGIC)) {
    throw modelError("Moc 文件头损坏：magic 必须为 MOC3 且包含版本字节");
  }
  const version = content[4]!;
  if (version < MIN_SUPPORTED_MOC3_VERSION || version > MAX_SUPPORTED_MOC3_VERSION) {
    throw modelError(
      `Moc 版本 v${version} 不受支持；当前 Cubism Core 5.1 仅支持 v${MIN_SUPPORTED_MOC3_VERSION}-v${MAX_SUPPORTED_MOC3_VERSION}`,
    );
  }
}

function stringReference(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw modelError(`${label}路径无效`);
  return value;
}

function collectModelMetadata(settingsFile: string, json: Live2DSettingsJson): {
  referencedFiles: string[];
  mocFile: string;
  motionGroups: Record<string, number>;
  expressionCount: number;
  lipSyncParameters: string[];
  textureCount: number;
  settingsVersion: number;
} {
  if (json.Version !== 3) throw modelError(`model3.json Version 必须为 3，当前为 ${String(json.Version ?? "未知")}`);
  const references = json.FileReferences;
  if (!references || typeof references !== "object") throw modelError("model3.json 缺少 FileReferences");
  const moc = stringReference(references.Moc, "Moc");
  if (extname(moc).toLowerCase() !== ".moc3") throw modelError("Moc 必须是 .moc3 文件");
  if (!Array.isArray(references.Textures) || references.Textures.length === 0) throw modelError("模型至少需要一张贴图");
  if (references.Textures.length > MAX_TEXTURES) throw modelError(`模型贴图不能超过 ${MAX_TEXTURES} 张`);

  const referenced = new Set<string>([settingsFile]);
  const add = (value: unknown, label: string): void => {
    if (value === undefined || value === null || value === "") return;
    referenced.add(resolveReference(settingsFile, stringReference(value, label)));
  };
  const mocFile = resolveReference(settingsFile, moc);
  referenced.add(mocFile);
  for (const texture of references.Textures) add(texture, "Textures");
  add(references.Physics, "Physics");
  add(references.Pose, "Pose");
  add(references.UserData, "UserData");
  add(references.DisplayInfo, "DisplayInfo");

  const motionGroups: Record<string, number> = {};
  if (references.Motions !== undefined) {
    if (!references.Motions || typeof references.Motions !== "object" || Array.isArray(references.Motions)) {
      throw modelError("Motions 必须是动作组对象");
    }
    for (const [group, motions] of Object.entries(references.Motions as Record<string, unknown>)) {
      if (!Array.isArray(motions)) throw modelError(`动作组 ${group} 格式无效`);
      motionGroups[group] = motions.length;
      for (const [index, motion] of motions.entries()) {
        if (!motion || typeof motion !== "object" || Array.isArray(motion)) throw modelError(`动作组 ${group}[${index}] 格式无效`);
        const item = motion as { File?: unknown; Sound?: unknown };
        add(item.File, `动作组 ${group}[${index}].File`);
        add(item.Sound, `动作组 ${group}[${index}].Sound`);
      }
    }
  }

  let expressionCount = 0;
  if (references.Expressions !== undefined) {
    if (!Array.isArray(references.Expressions)) throw modelError("Expressions 必须是数组");
    expressionCount = references.Expressions.length;
    for (const [index, expression] of references.Expressions.entries()) {
      if (!expression || typeof expression !== "object" || Array.isArray(expression)) {
        throw modelError(`Expressions[${index}] 格式无效`);
      }
      add((expression as { File?: unknown }).File, `Expressions[${index}].File`);
    }
  }

  const lipSyncParameters: string[] = [];
  if (Array.isArray(json.Groups)) {
    for (const group of json.Groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      const value = group as { Name?: unknown; Ids?: unknown };
      if (value.Name !== "LipSync" || !Array.isArray(value.Ids)) continue;
      for (const id of value.Ids) {
        if (typeof id === "string" && id && !lipSyncParameters.includes(id)) lipSyncParameters.push(id);
      }
    }
  }

  return {
    referencedFiles: [...referenced],
    mocFile,
    motionGroups,
    expressionCount,
    lipSyncParameters,
    textureCount: references.Textures.length,
    settingsVersion: json.Version,
  };
}

export class ModelStore {
  private readonly modelsDirectory: string;
  private readonly statePath: string;
  private readonly bundledRoot: string;
  private readonly bundled = new Map<string, StoredModelManifest>();
  private active?: { kind: "bundled" | "imported"; manifest: StoredModelManifest };

  constructor(dataDirectory: string, bundledRoot = join(__dirname, "../renderer/live2d")) {
    this.modelsDirectory = join(dataDirectory, "models");
    this.statePath = join(this.modelsDirectory, "model-state.json");
    this.bundledRoot = resolve(bundledRoot);
  }

  async initialize(): Promise<void> {
    await mkdir(this.modelsDirectory, { recursive: true });
    this.bundled.clear();
    for (const definition of BUNDLED_MODEL_DEFINITIONS) {
      const directory = resolveInside(this.bundledRoot, definition.directory);
      const manifest = await this.inspectDirectory(directory, {
        id: definition.id,
        name: definition.name,
        source: "bundled",
        origin: definition.origin,
        temperamentSeed: definition.temperamentSeed,
      });
      this.bundled.set(definition.id, manifest);
    }

    let restored = false;
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as ModelStoreState;
      if (state.active?.kind === "bundled") {
        const manifest = this.bundled.get(state.active.id);
        if (manifest) {
          this.active = { kind: "bundled", manifest };
          restored = true;
        }
      } else if (state.active?.kind === "imported" && /^[a-zA-Z0-9-]+$/.test(state.active.id)) {
        const directory = join(this.modelsDirectory, "imported", state.active.id);
        const stored = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as StoredModelManifest;
        if (stored.id !== state.active.id || stored.source !== "imported") throw new Error("model id mismatch");
        const manifest = await this.inspectDirectory(directory, {
          id: stored.id,
          name: stored.name,
          source: "imported",
          origin: "user-import",
          importedAt: stored.importedAt,
        });
        this.active = { kind: "imported", manifest };
        restored = true;
      }
    } catch {
      restored = false;
    }
    if (!restored) {
      const fallback = this.bundled.get(DEFAULT_BUNDLED_MODEL_ID);
      if (!fallback) throw new Error("内置 Live2D 模型缺失");
      this.active = { kind: "bundled", manifest: fallback };
      await this.persistState();
    }
  }

  getState(): PublicModelState {
    if (!this.active) throw new Error("模型仓库尚未初始化");
    return {
      kind: this.active.kind,
      model: this.publicInfo(this.active.manifest),
      bundledModels: [...this.bundled.values()].map((manifest) => this.publicInfo(manifest)),
    };
  }

  async selectBundled(modelId: string): Promise<PublicModelState> {
    const manifest = this.bundled.get(modelId);
    if (!manifest) throw modelError("未知的内置 Live2D 模型");
    this.active = { kind: "bundled", manifest };
    await this.persistState();
    return this.getState();
  }

  async importFromDirectory(sourceDirectory: string): Promise<PublicModelState> {
    const sourceRoot = resolve(sourceDirectory);
    const sourceInfo = await stat(sourceRoot).catch(() => undefined);
    if (!sourceInfo?.isDirectory()) throw modelError("所选路径不是文件夹");
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const importedAt = new Date().toISOString();
    const manifest = await this.inspectDirectory(sourceRoot, {
      id,
      name: basename(sourceRoot).slice(0, 80) || "导入的 Live2D 模型",
      source: "imported",
      origin: "user-import",
      importedAt,
    });
    const importedRoot = join(this.modelsDirectory, "imported");
    const temporaryDirectory = join(importedRoot, `${id}.tmp`);
    const destinationDirectory = join(importedRoot, id);
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      for (const file of manifest.files) {
        await this.copyInto(temporaryDirectory, resolveInside(sourceRoot, file), file);
      }
      await writeFile(join(temporaryDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await mkdir(importedRoot, { recursive: true });
      await rename(temporaryDirectory, destinationDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    this.active = { kind: "imported", manifest };
    await this.persistState();
    return this.getState();
  }

  async getActiveAssets(): Promise<Live2DModelAssetPackage> {
    if (!this.active) throw new Error("模型仓库尚未初始化");
    const manifest = this.active.manifest;
    const directory = this.active.kind === "bundled"
      ? resolveInside(this.bundledRoot, BUNDLED_MODEL_DEFINITIONS.find((item) => item.id === manifest.id)!.directory)
      : join(this.modelsDirectory, "imported", manifest.id);
    const files = await Promise.all(manifest.files.map(async (file) => {
      const path = resolveInside(directory, file);
      const content = await readLimited(path, maximumBytesFor(file), `资源 ${file}`);
      return {
        path: file,
        mimeType: mimeTypeFor(file),
        base64: content.toString("base64"),
      };
    }));
    return { info: this.publicInfo(manifest), files };
  }

  private async inspectDirectory(
    sourceRoot: string,
    identity: Pick<Live2DModelInfo, "id" | "name" | "source" | "origin" | "temperamentSeed" | "importedAt">,
  ): Promise<StoredModelManifest> {
    const root = resolve(sourceRoot);
    const realRoot = await realpath(root).catch(() => undefined);
    if (!realRoot) throw modelError("模型目录不存在");
    const candidates = await collectFiles(root);
    const settingsCandidates = candidates.filter((file) => file.relativePath.toLowerCase().endsWith(".model3.json"));
    if (settingsCandidates.length !== 1) throw modelError("目录中必须且只能包含一个 .model3.json");
    const settingsCandidate = settingsCandidates[0]!;
    const settingsBuffer = await readLimited(settingsCandidate.absolutePath, MAX_SETTINGS_BYTES, "model3.json");
    let settings: Live2DSettingsJson;
    try {
      settings = JSON.parse(settingsBuffer.toString("utf8")) as Live2DSettingsJson;
    } catch {
      throw modelError("model3.json 不是有效 JSON");
    }
    const metadata = collectModelMetadata(settingsCandidate.relativePath, settings);
    const candidateMap = new Map(candidates.map((file) => [file.relativePath, file]));
    let totalBytes = 0;
    for (const file of metadata.referencedFiles) {
      mimeTypeFor(file);
      const candidate = candidateMap.get(file);
      if (!candidate) throw modelError(`model3.json 引用的资源不存在：${file}`);
      const linkInfo = await lstat(candidate.absolutePath).catch(() => undefined);
      if (!linkInfo?.isFile() || linkInfo.isSymbolicLink()) throw modelError(`资源不能是链接或特殊文件：${file}`);
      const realPath = await realpath(candidate.absolutePath);
      const check = relative(realRoot, realPath);
      if (check.startsWith("..") || isAbsolute(check)) throw modelError(`资源超出所选目录：${file}`);
      const fileInfo = await stat(candidate.absolutePath);
      const maximum = maximumBytesFor(file);
      if (fileInfo.size <= 0 || fileInfo.size > maximum) {
        throw modelError(`资源 ${file} 大小必须在 1B 到 ${Math.round(maximum / 1024 / 1024)}MB 之间`);
      }
      totalBytes += fileInfo.size;
    }
    const mocCandidate = candidateMap.get(metadata.mocFile)!;
    validateMoc3Header(await readLimited(mocCandidate.absolutePath, MAX_MOC_BYTES, `Moc ${metadata.mocFile}`));
    if (totalBytes > MAX_TOTAL_BYTES) throw modelError(`模型总大小不能超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB`);
    return {
      ...identity,
      settingsVersion: metadata.settingsVersion,
      motionGroups: metadata.motionGroups,
      motionCount: Object.values(metadata.motionGroups).reduce((sum, count) => sum + count, 0),
      expressionCount: metadata.expressionCount,
      lipSyncParameters: metadata.lipSyncParameters,
      textureCount: metadata.textureCount,
      settingsFile: settingsCandidate.relativePath,
      files: metadata.referencedFiles,
    };
  }

  private async copyInto(root: string, source: string, relativePath: string): Promise<void> {
    const destination = resolveInside(root, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  private publicInfo(manifest: StoredModelManifest): Live2DModelInfo {
    const {
      id, name, source, origin, temperamentSeed, settingsVersion, motionGroups,
      motionCount, expressionCount, lipSyncParameters, textureCount, importedAt,
    } = manifest;
    return {
      id,
      name,
      source,
      origin,
      temperamentSeed: temperamentSeed ? { ...temperamentSeed } : undefined,
      settingsVersion,
      motionGroups: { ...motionGroups },
      motionCount,
      expressionCount,
      lipSyncParameters: [...lipSyncParameters],
      textureCount,
      importedAt,
    };
  }

  private async persistState(): Promise<void> {
    await mkdir(this.modelsDirectory, { recursive: true });
    await writeFile(
      this.statePath,
      JSON.stringify({
        active: this.active ? { kind: this.active.kind, id: this.active.manifest.id } : undefined,
      } satisfies ModelStoreState, null, 2),
      "utf8",
    );
  }
}
