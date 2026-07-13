const { app } = require("electron");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const {
  LocalAsrService,
  LOCAL_ASR_MODEL_ID,
} = require("../dist/main/local-asr-service.js");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const modelDirectory = join(process.cwd(), "resources", "voice", LOCAL_ASR_MODEL_ID);
  const wavPath = join(modelDirectory, "test_wavs", "0.wav");
  const service = new LocalAsrService(modelDirectory);
  try {
    const status = await service.status();
    if (status.state !== "ready") throw new Error(status.message);
    const audio = parseMonoPcm16Wav(await readFile(wavPath));
    const result = await service.recognize(audio);
    if (!result.text) throw new Error("真实 Electron ASR smoke 没有返回文本");
    console.log(`ELECTRON_LOCAL_ASR_SMOKE_READY ${result.durationMs}ms ${result.text}`);
    await service.close();
    app.quit();
  } catch (error) {
    console.error("ELECTRON_LOCAL_ASR_SMOKE_FAILED", error);
    await service.close();
    app.exit(1);
  }
});

function parseMonoPcm16Wav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("测试录音不是 WAV 文件");
  }
  let format;
  let data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw new Error("测试 WAV 区块越界");
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!format || format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16_000 || format.bitsPerSample !== 16) {
    throw new Error("测试 WAV 必须是单声道 16 kHz PCM16");
  }
  if (!data) throw new Error("测试 WAV 缺少 PCM 数据");
  return {
    sampleRate: 16_000,
    pcm16: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
}
