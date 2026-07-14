const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");

const root = process.cwd();
const wavPath = join(
  root,
  "resources",
  "voice",
  "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23",
  "test_wavs",
  "0.wav",
);

if (!existsSync(wavPath)) {
  console.error("ELECTRON_LOCAL_ASR_UI_SMOKE_FAILED 缺少项目内测试 WAV，请运行 npm run voice:model:download");
  process.exit(1);
}

process.argv.push("--voice-ui-smoke");
app.setAppPath(root);
app.setPath("userData", join(root, "output", "voice-ui-smoke-data", String(process.pid)));
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${wavPath.replaceAll("\\", "/")}%noloop`);

const totalTimeout = setTimeout(() => fail(new Error("voice UI smoke 总计超时")), 70_000);
let finishing = false;

require("../dist/main/main.js");

app.whenReady().then(run).catch(fail);

async function run() {
  const window = await waitFor(() => BrowserWindow.getAllWindows().find((candidate) => (
    !candidate.isDestroyed() && !candidate.webContents.getURL().includes("mode=panel")
  )), 20_000, "宠物窗口未创建");
  const rendererErrors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") rendererErrors.push(details.message);
  });
  await waitFor(async () => {
    const state = await readState(window);
    return state.ready && !state.disabled ? state : undefined;
  }, 25_000, "麦克风按钮未就绪");

  const baseline = await readState(window);
  await clickMicrophone(window);
  await waitFor(async () => {
    const state = await readState(window);
    return state.input.startsWith("正在本地识别") ? state : undefined;
  }, 20_000, "首轮录音没有进入本地识别阶段");

  await clickMicrophone(window);
  const cancelled = await waitFor(async () => {
    const state = await readState(window);
    return !state.listening && state.input === "" ? state : undefined;
  }, 2_000, "取消后识别状态没有立即清空");
  if (cancelled.l1Length !== baseline.l1Length) throw new Error("取消识别意外写入了 L1");

  await delay(3_500);
  const afterLateResult = await readState(window);
  if (afterLateResult.input !== "" || afterLateResult.l1Length !== baseline.l1Length) {
    throw new Error("取消后的迟到结果污染了输入框或 L1");
  }

  await clickMicrophone(window);
  const recognized = await waitFor(async () => {
    const state = await readState(window);
    return state.l1Length >= baseline.l1Length + 2 && !state.listening ? state : undefined;
  }, 45_000, "取消后重新识别没有产生完整聊天结果");
  if (!recognized.lastUserText.trim()) throw new Error("真实 Renderer 链路没有写入识别文本");
  if (rendererErrors.length) throw new Error(`Renderer 控制台错误：${rendererErrors.join(" | ")}`);

  clearTimeout(totalTimeout);
  finishing = true;
  console.log(`ELECTRON_LOCAL_ASR_UI_SMOKE_READY ${recognized.lastUserText}`);
  app.quit();
}

async function readState(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const mic = document.querySelector("#pet-mic-button");
    const input = document.querySelector("#pet-message-input");
    const snapshot = await window.petAgent.getMemory();
    const lastUser = [...snapshot.l1].reverse().find((item) => item.role === "user");
    return {
      ready: Boolean(mic && input && window.petAgent),
      disabled: Boolean(mic?.disabled),
      listening: Boolean(mic?.classList.contains("listening")),
      input: input?.value ?? "",
      l1Length: snapshot.l1.length,
      lastUserText: lastUser?.content ?? "",
    };
  })()`, true);
}

async function clickMicrophone(window) {
  await window.webContents.executeJavaScript(`document.querySelector("#pet-mic-button")?.click()`, true);
}

async function waitFor(read, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(lastError ? `${message}：${lastError.message}` : message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(totalTimeout);
  console.error("ELECTRON_LOCAL_ASR_UI_SMOKE_FAILED", error);
  app.exit(1);
}
