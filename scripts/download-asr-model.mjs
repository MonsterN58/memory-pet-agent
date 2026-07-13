import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelId = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23";
const revision = "204ad334e2e683fd295359930cc16fc0432a23ac";
const repository = `https://huggingface.co/csukuangfj/${modelId}`;
const targetDirectory = resolve(projectRoot, "resources", "voice", modelId);
const verifyOnly = process.argv.includes("--verify-only");
const files = [
  {
    name: "encoder-epoch-99-avg-1.int8.onnx",
    size: 21_621_684,
    sha256: "1c556ea57cec304e55ec4b72e52c1cc098bb01476ed7d90f3de939fe126487b1",
  },
  {
    name: "decoder-epoch-99-avg-1.onnx",
    size: 7_509_745,
    sha256: "5ee0f03a2768ff1d5c83ef3a493243c7935d316cd41280037b14783a3467cc78",
  },
  {
    name: "joiner-epoch-99-avg-1.int8.onnx",
    size: 1_795_562,
    sha256: "a7cf9d82757bdcf786059454495a9ca95e4bd7347f72473fc08d794475c36169",
  },
  {
    name: "tokens.txt",
    size: 48_697,
    sha256: "8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac",
  },
  {
    name: "test_wavs/0.wav",
    size: 179_646,
    sha256: "668bf8df51a10027b84d5d8816a1ce11ae93545538dc05cfe2aa6811d399c250",
  },
];

await mkdir(targetDirectory, { recursive: true });
console.log(`离线 ASR 模型目录：${targetDirectory}`);

for (const file of files) {
  const target = resolve(targetDirectory, file.name);
  if (await isValid(target, file)) {
    console.log(`校验通过：${file.name}`);
    continue;
  }
  if (verifyOnly) throw new Error(`文件缺失或校验失败：${target}`);
  await downloadFile(`${repository}/resolve/${revision}/${file.name}`, target, file);
  if (!await isValid(target, file)) throw new Error(`下载后的文件校验失败：${target}`);
  console.log(`下载并校验完成：${file.name}`);
}

console.log(verifyOnly ? "离线 ASR 模型完整。" : "离线 ASR 模型已准备完成，所有文件均位于当前项目目录。" );

async function isValid(path, expected) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== expected.size) return false;
    return await sha256(path) === expected.sha256;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadFile(url, target, expected) {
  const temporary = `${target}.download`;
  await mkdir(dirname(target), { recursive: true });
  await unlink(temporary).catch(() => undefined);
  console.log(`开始下载：${expected.name}（${formatBytes(expected.size)}）`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  const stream = Readable.fromWeb(response.body);
  let received = 0;
  let nextProgress = 10;
  stream.on("data", (chunk) => {
    received += chunk.length;
    const percentage = Math.floor(received / expected.size * 100);
    if (percentage >= nextProgress) {
      console.log(`${expected.name}：${Math.min(100, percentage)}%`);
      nextProgress += 10;
    }
  });
  try {
    await pipeline(stream, createWriteStream(temporary, { flags: "wx" }));
    try {
      await rename(target, `${target}.invalid-${Date.now()}`);
    } catch {
      // 目标不存在时无需保留旧副本。
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
