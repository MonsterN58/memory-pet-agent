import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { BUNDLED_MODEL_DEFINITIONS } from "../src/common/bundled-models";
import { ModelStore } from "../src/main/model-store";

interface FixtureOptions {
  settingsVersion?: number;
  texturePath?: string;
  mocVersion?: number;
  mocMagic?: string;
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
  await writeFile(join(source, `${name}.moc3`), Buffer.concat([
    Buffer.from(options.mocMagic ?? "MOC3", "ascii"),
    Buffer.from([options.mocVersion ?? 3, 0, 0, 0]),
  ]));
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
  for (const name of ["Hiyori", "Mao", "Wanko", "Haru", "Mark", "Nana", "Rice", "Cyannyan", "Xiaoyun"]) {
    await createLive2DDirectory(bundled, name);
  }
  return bundled;
}

test("所有内置 Live2D 模型的 Moc 均兼容锁定的 Cubism Core 5.1", async () => {
  const bundledRoot = join(process.cwd(), "src", "renderer", "public", "live2d");

  for (const definition of BUNDLED_MODEL_DEFINITIONS) {
    const modelRoot = join(bundledRoot, definition.directory);
    const settingsPath = join(modelRoot, definition.settingsFile);
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      FileReferences?: { Moc?: unknown };
    };
    const mocReference = settings.FileReferences?.Moc;

    assert.ok(typeof mocReference === "string", `${definition.id} 的 model3.json 必须引用 Moc`);
    const moc = await readFile(join(dirname(settingsPath), mocReference));
    assert.ok(moc.length >= 5, `${definition.id} 的 Moc 文件头不完整`);
    assert.equal(moc.subarray(0, 4).toString("ascii"), "MOC3", `${definition.id} 的 Moc 文件头无效`);
    assert.ok(
      moc[4]! >= 1 && moc[4]! <= 5,
      `${definition.id} 使用 moc3 v${moc[4]}，高于 Cubism Core 5.1 支持的 v5`,
    );
  }
});

test("模型仓库默认加载九套内置 Live2D 模型并打包当前资源", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-bundled-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = await createBundledRoot(directory);
  const store = new ModelStore(join(directory, "data"), bundled);
  await store.initialize();

  const state = store.getState();
  assert.equal(state.kind, "bundled");
  assert.equal(state.model.id, "hiyori");
  assert.equal(state.bundledModels.length, 9);
  assert.deepEqual(state.bundledModels.map((model) => model.id), [
    "hiyori", "mao", "wanko", "haru", "mark", "nana", "rice", "cyannyan", "xiaoyun",
  ]);
  const temperamentFingerprints = new Set(state.bundledModels.map((model) => {
    const seed = model.temperamentSeed;
    assert.ok(seed, `${model.id} 必须有初始气质`);
    for (const score of [
      seed.warmth, seed.curiosity, seed.playfulness,
      seed.directness, seed.initiative, seed.expressiveness,
    ]) {
      assert.ok(score >= 0 && score <= 1, `${model.id} 气质分数越界`);
    }
    return JSON.stringify(seed);
  }));
  assert.equal(temperamentFingerprints.size, state.bundledModels.length);
  assert.equal(state.model.origin, "official-sample");
  assert.equal(state.model.temperamentSeed?.label, "温柔好奇");
  assert.deepEqual(state.model.motionGroups, { Idle: 1, TapBody: 1 });
  assert.deepEqual(state.model.lipSyncParameters, ["ParamMouthOpenY"]);

  const assets = await store.getActiveAssets();
  assert.equal(assets.info.name, "Hiyori（Live2D 官方样例）");
  assert.ok(assets.files.some((file) => file.path === "Hiyori.model3.json"));
  assert.ok(assets.files.some((file) => file.path === "Hiyori.moc3"));
  assert.match(assets.files[0]?.base64 ?? "", /^[A-Za-z0-9+/]+=*$/);
});

test("九套实际内置模型暴露准确动作、表情、口型、来源和初始气质", async (context) => {
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

  const expectations = {
    haru: { groups: { Idle: 2, TapBody: 4 }, expressions: 8, lipSync: ["ParamMouthOpenY"], origin: "official-sample" },
    mark: { groups: { Idle: 6 }, expressions: 0, lipSync: ["ParamMouthOpenY"], origin: "official-sample" },
    nana: { groups: {}, expressions: 0, lipSync: [], origin: "third-party" },
    rice: { groups: { Idle: 1, TapBody: 3 }, expressions: 0, lipSync: [], origin: "official-sample" },
    cyannyan: { groups: {}, expressions: 16, lipSync: ["ParamMouthOpenY"], origin: "third-party" },
    xiaoyun: { groups: {}, expressions: 18, lipSync: ["ParamMouthOpenY"], origin: "third-party" },
  } as const;
  const temperamentLabels = new Set<string>();
  for (const [id, expected] of Object.entries(expectations)) {
    const selected = await store.selectBundled(id);
    assert.deepEqual(selected.model.motionGroups, expected.groups, `${id} motion groups`);
    assert.equal(selected.model.expressionCount, expected.expressions, `${id} expressions`);
    assert.deepEqual(selected.model.lipSyncParameters, expected.lipSync, `${id} lip sync`);
    assert.equal(selected.model.origin, expected.origin, `${id} origin`);
    assert.ok(selected.model.temperamentSeed?.label, `${id} temperament`);
    temperamentLabels.add(selected.model.temperamentSeed!.label);
  }
  assert.equal(temperamentLabels.size, Object.keys(expectations).length);
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
  assert.equal(state.model.origin, "user-import");
  assert.equal(state.model.temperamentSeed, undefined);
  const importedId = state.model.id;

  const reloaded = new ModelStore(data, bundled);
  await reloaded.initialize();
  assert.equal(reloaded.getState().kind, "imported");
  assert.equal(reloaded.getState().model.id, importedId);
  const manifest = JSON.parse(await readFile(join(data, "models", "imported", importedId, "manifest.json"), "utf8"));
  assert.equal(manifest.source, "imported");
});

test("可在九套内置 Live2D 模型间切换并持久化选择", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-select-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = await createBundledRoot(directory);
  const data = join(directory, "data");
  const store = new ModelStore(data, bundled);
  await store.initialize();
  const selected = await store.selectBundled("xiaoyun");
  assert.equal(selected.model.id, "xiaoyun");

  const reloaded = new ModelStore(data, bundled);
  await reloaded.initialize();
  assert.equal(reloaded.getState().model.id, "xiaoyun");
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

test("模型仓库拒绝错误的设置版本、Moc 版本、Moc 文件头和缺失资源", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-live2d-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundled = await createBundledRoot(directory);
  const store = new ModelStore(join(directory, "data"), bundled);
  await store.initialize();
  const wrongVersion = await createLive2DDirectory(directory, "WrongVersion", { settingsVersion: 2 });
  await assert.rejects(() => store.importFromDirectory(wrongVersion), /Version 必须为 3/);
  const unsupportedMoc = await createLive2DDirectory(directory, "UnsupportedMoc", { mocVersion: 6 });
  await assert.rejects(
    () => store.importFromDirectory(unsupportedMoc),
    /Moc 版本 v6 不受支持.*Cubism Core 5\.1 仅支持 v1-v5/,
  );
  const corruptMoc = await createLive2DDirectory(directory, "CorruptMoc", { mocMagic: "BAD!" });
  await assert.rejects(() => store.importFromDirectory(corruptMoc), /Moc 文件头损坏.*magic 必须为 MOC3/);
  const missing = await createLive2DDirectory(directory, "Missing");
  await rm(join(missing, "Missing.moc3"));
  await assert.rejects(() => store.importFromDirectory(missing), /引用的资源不存在/);
});
