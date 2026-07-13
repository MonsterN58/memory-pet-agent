import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelStore } from "../src/main/model-store";

interface FixtureOptions {
  settingsVersion?: number;
  texturePath?: string;
}

async function createLive2DDirectory(root: string, name: string, options: FixtureOptions = {}): Promise<string> {
  const source = join(root, name);
  await mkdir(join(source, "textures"), { recursive: true });
  await mkdir(join(source, "motions"), { recursive: true });
  const texturePath = options.texturePath ?? "textures/texture_00.png";
  await writeFile(join(source, `${name}.model3.json`), JSON.stringify({
    Version: options.settingsVersion ?? 3,
    FileReferences: {
      Moc: `${name}.moc3`,
      Textures: [texturePath],
      Physics: `${name}.physics3.json`,
      Motions: {
        Idle: [{ File: "motions/idle.motion3.json" }],
        TapBody: [{ File: "motions/tap.motion3.json" }],
      },
    },
    Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] }],
  }), "utf8");
  await writeFile(join(source, `${name}.moc3`), Buffer.from("MOC3-test"));
  await writeFile(join(source, `${name}.physics3.json`), JSON.stringify({ Version: 3, Meta: {}, PhysicsSettings: [] }), "utf8");
  await writeFile(join(source, "motions", "idle.motion3.json"), JSON.stringify({ Version: 3, Meta: {}, Curves: [] }), "utf8");
  await writeFile(join(source, "motions", "tap.motion3.json"), JSON.stringify({ Version: 3, Meta: {}, Curves: [] }), "utf8");
  if (texturePath === "textures/texture_00.png") {
    await writeFile(join(source, "textures", "texture_00.png"), Buffer.from([137, 80, 78, 71]));
  }
  return source;
}

async function createBundledRoot(root: string): Promise<string> {
  const bundled = join(root, "bundled");
  await createLive2DDirectory(bundled, "Hiyori");
  await createLive2DDirectory(bundled, "Mao");
  await createLive2DDirectory(bundled, "Wanko");
  return bundled;
}

test("模型仓库默认加载三套内置 Live2D 模型并打包当前资源", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-bundled-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = await createBundledRoot(directory);
  const store = new ModelStore(join(directory, "data"), bundled);
  await store.initialize();

  const state = store.getState();
  assert.equal(state.kind, "bundled");
  assert.equal(state.model.id, "hiyori");
  assert.equal(state.bundledModels.length, 3);
  assert.deepEqual(state.model.motionGroups, { Idle: 1, TapBody: 1 });
  assert.deepEqual(state.model.lipSyncParameters, ["ParamMouthOpenY"]);

  const assets = await store.getActiveAssets();
  assert.equal(assets.info.name, "Hiyori（官方样例）");
  assert.ok(assets.files.some((file) => file.path === "Hiyori.model3.json"));
  assert.ok(assets.files.some((file) => file.path === "Hiyori.moc3"));
  assert.match(assets.files[0]?.base64 ?? "", /^[A-Za-z0-9+/]+=*$/);
});

test("实际内置 Mao 与 Wanko 暴露完整表情和动作资源", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-real-bundled-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = join(process.cwd(), "src", "renderer", "public", "live2d");
  const store = new ModelStore(join(directory, "data"), bundled);
  await store.initialize();

  const mao = await store.selectBundled("mao");
  assert.deepEqual(mao.model.motionGroups, { Idle: 2, TapBody: 6 });
  assert.equal(mao.model.expressionCount, 8);

  const wanko = await store.selectBundled("wanko");
  assert.deepEqual(wanko.model.motionGroups, { Idle: 4, TapBody: 6, Shake: 2 });
  assert.equal(wanko.model.motionCount, 12);
  const assets = await store.getActiveAssets();
  assert.ok(assets.files.some((file) => file.path === "motions/shake_01.motion3.json"));
  assert.ok(assets.files.some((file) => file.path === "motions/touch_06.motion3.json"));
});

test("用户导入的 Live2D 模型会复制、切换并持久化", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-import-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = await createBundledRoot(directory);
  const source = await createLive2DDirectory(directory, "星光猫");
  const data = join(directory, "data");
  const store = new ModelStore(data, bundled);
  await store.initialize();

  const state = await store.importFromDirectory(source);
  assert.equal(state.kind, "imported");
  assert.equal(state.model.name, "星光猫");
  assert.equal(state.model.motionCount, 2);
  assert.equal(state.model.textureCount, 1);
  const importedId = state.model.id;

  const reloaded = new ModelStore(data, bundled);
  await reloaded.initialize();
  assert.equal(reloaded.getState().kind, "imported");
  assert.equal(reloaded.getState().model.id, importedId);
  const manifest = JSON.parse(await readFile(join(data, "models", "imported", importedId, "manifest.json"), "utf8"));
  assert.equal(manifest.source, "imported");
});

test("可在三套内置 Live2D 模型间切换并持久化选择", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-select-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = await createBundledRoot(directory);
  const data = join(directory, "data");
  const store = new ModelStore(data, bundled);
  await store.initialize();
  const selected = await store.selectBundled("wanko");
  assert.equal(selected.model.id, "wanko");

  const reloaded = new ModelStore(data, bundled);
  await reloaded.initialize();
  assert.equal(reloaded.getState().model.id, "wanko");
  await assert.rejects(() => reloaded.selectBundled("unknown"), /未知的内置 Live2D 模型/);
});

test("模型仓库拒绝路径穿越和目录外贴图链接", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-boundary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = await createBundledRoot(directory);
  const traversal = await createLive2DDirectory(directory, "Traversal", { texturePath: "../outside.png" });
  await writeFile(join(directory, "outside.png"), Buffer.from([137, 80, 78, 71]));
  const store = new ModelStore(join(directory, "data"), bundled);
  await store.initialize();
  await assert.rejects(() => store.importFromDirectory(traversal), /不安全的资源路径/);

  const linked = await createLive2DDirectory(directory, "Linked");
  const outside = join(directory, "outside-textures");
  await mkdir(outside);
  await writeFile(join(outside, "texture_00.png"), Buffer.from([137, 80, 78, 71]));
  await rm(join(linked, "textures"), { recursive: true, force: true });
  await symlink(outside, join(linked, "textures"), "junction");
  await assert.rejects(() => store.importFromDirectory(linked), /引用的资源不存在|链接或特殊文件/);
});

test("模型仓库拒绝错误的 model3 设置版本和缺失资源", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = await createBundledRoot(directory);
  const store = new ModelStore(join(directory, "data"), bundled);
  await store.initialize();
  const wrongVersion = await createLive2DDirectory(directory, "WrongVersion", { settingsVersion: 2 });
  await assert.rejects(() => store.importFromDirectory(wrongVersion), /Version 必须为 3/);
  const missing = await createLive2DDirectory(directory, "Missing");
  await rm(join(missing, "Missing.moc3"));
  await assert.rejects(() => store.importFromDirectory(missing), /引用的资源不存在/);
});
