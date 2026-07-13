# 中文离线语音识别模型

- 模型：`sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`
- 上游：`csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`
- 固定版本：`204ad334e2e683fd295359930cc16fc0432a23ac`
- 许可证：Apache-2.0
- Runtime：`sherpa-onnx` 1.13.4
- 运行时模型大小：约 29.5 MiB（不含约 21 MiB WASM Runtime）

运行文件只保存在本项目的
`resources/voice/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/` 目录，
不会加入安装包。运行 `npm run voice:model:download` 可下载/修复，运行
`npm run voice:model:verify` 可按固定 SHA-256 校验现有文件。`test_wavs/0.wav`
是约 176 KiB 的上游官方测试音频，只用于 `npm run smoke:voice`，不参与正常录音。
