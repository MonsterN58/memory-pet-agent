import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAsrService, sanitizeLocalSpeechAudio } from "../src/main/local-asr-service";

test("本地 ASR 清晰报告项目模型缺失", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "memory-pet-asr-missing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const status = await new LocalAsrService(directory).status();
  assert.equal(status.state, "missing");
  assert.equal(status.directory, directory);
  assert.match(status.message, /voice:model:download/);
});

test("本地 ASR IPC 只接受 16 kHz、0.25 到 30 秒的 PCM16", () => {
  const valid = new ArrayBuffer(16_000);
  const sanitized = sanitizeLocalSpeechAudio({ sampleRate: 16_000, pcm16: valid });
  assert.equal(sanitized.sampleRate, 16_000);
  assert.notEqual(sanitized.pcm16, valid);
  assert.equal(sanitized.pcm16.byteLength, valid.byteLength);
  assert.throws(
    () => sanitizeLocalSpeechAudio({ sampleRate: 48_000, pcm16: valid }),
    /16 kHz/,
  );
  assert.throws(
    () => sanitizeLocalSpeechAudio({ sampleRate: 16_000, pcm16: new ArrayBuffer(100) }),
    /录音过短/,
  );
  assert.throws(
    () => sanitizeLocalSpeechAudio({ sampleRate: 16_000, pcm16: new ArrayBuffer(16_000 * 2 * 31) }),
    /不能超过 30 秒/,
  );
});
