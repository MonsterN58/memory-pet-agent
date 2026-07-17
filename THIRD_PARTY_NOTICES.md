# Third-party notices

This application uses Live2D Cubism Core, models and notices from Cubism Web Samples, `untitled-pixi-live2d-engine`, PixiJS, `@pixi/sound`, `sherpa-onnx`, and an optional sherpa-onnx Zipformer model. Imported model artwork is not covered by this application's license; users must verify the license of every model they import or redistribute.

## sherpa-onnx and the Chinese Zipformer model

Runtime: https://github.com/k2-fsa/sherpa-onnx

Model: https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23

Copyright (c) The next-gen Kaldi team and model contributors.

Both the npm Runtime and the selected model are distributed under the Apache License 2.0:
https://www.apache.org/licenses/LICENSE-2.0

The ONNX model is downloaded on demand into the local project and is not included in the current installer file list.

## Live2D Cubism Core

Copyright © Live2D Inc.

Cubism Core is redistributed under the Live2D Proprietary Software License Agreement:

- English: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
- Japanese: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_jp.html
- Simplified Chinese: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html

The bundled Core file identifies itself as "Redistributable Code" under that agreement. A copy of the official license pointer is included at `live2d-runtime/CUBISM_CORE_LICENSE.md` in the packaged renderer assets.

## Live2D Cubism Web Samples and sample models

Source: https://github.com/Live2D/CubismWebSamples/tree/develop

This application includes the Hiyori, Mao, Wanko, Haru, Mark, and Rice sample models. The 2026-07 model audit used upstream commit `b1de66b0b1f1cb881d95fb6158622aeb6a2827bd`. Natori is intentionally excluded because its collaboration-character terms are not compatible with this application's bundled model adaptation. The project is pinned to Cubism Core 5.1 and only bundles model data with a `MOC3` header and moc version byte no higher than 5; v6 resources require a compatible runtime and are not represented as supported here. Cubism Web Samples are Live2D Cubism Components and are provided under the Live2D Open Software License. The bundled sample models are also subject to the Free Material License and the terms for each sample model.

- Open Software License: https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html
- Free Material License: https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html
- Sample model terms: https://www.live2d.com/eula/live2d-sample-model-terms_en.html
- Cubism SDK Release License information: https://www.live2d.com/en/download/cubism-sdk/release-license/

Business users whose most recent annual gross revenue meets Live2D's stated threshold must review the Cubism SDK Release License requirements before distribution. The upstream `LICENSE.md` and `NOTICE.md` are preserved as `live2d/CUBISM_WEB_SAMPLES_LICENSE.md` and `live2d/CUBISM_WEB_SAMPLES_NOTICE.md` in the packaged renderer assets.

All rights in the official sample characters and model data remain with Live2D Inc. Mark must retain his cartoon-character nature under the per-model terms. Haru's sample sound files are not included; the local settings copy only removes their references so bundled motions do not play over the desktop pet's TTS. Wanko's local `model3.json` declares seven additional motion files that are already present in the same pinned official sample commit: `idle_02`, `touch_01`, `touch_03`, `touch_05`, `touch_06`, `shake_01`, and `shake_02`. Mark's local settings fill the upstream empty LipSync group with the model's existing `ParamMouthOpenY` parameter. These Wanko and Mark changes only adapt settings references; no moc, texture, motion, or artwork data was altered.

## Nana Live2D model

Source: https://github.com/nna774/nana/tree/baab37660fc2fd160162d054a979729651c5e34c/live2d/nana

Source publisher: nna774.

The upstream README states that all repository contents may be used under Creative Commons Attribution-ShareAlike 4.0 International:
https://creativecommons.org/licenses/by-sa/4.0/

Only the runtime-required model3, moc3 and 2048px texture were copied; no model or artwork data was modified. The packaged model remains under CC BY-SA 4.0. The upstream README, source commit and attribution notice are preserved in the bundled `live2d/Nana/` directory. No endorsement by the source publisher is implied.

## Cyannyan Live2D model

Source: https://github.com/jupiterbjy/Live2DPractice-Cyannyan/tree/898d849e594712cd6afb3bb81c07ecc58c59e024/CyanSDLowRes

Model creator and source publisher: jupiterbjy.

Character rights reference supplied by the upstream author: https://twitter.com/CyanNyan6

The 2048px web model is available under Creative Commons Attribution-ShareAlike 4.0 International:
https://creativecommons.org/licenses/by-sa/4.0/

This project added an empty neutral expression and its model3 reference so emotional expressions can return to neutral. The adapted model assets remain under CC BY-SA 4.0. The full license, upstream README, attribution, source commit, and modification notice are preserved in the bundled `live2d/Cyannyan/` directory. No endorsement by the model creator or character rights holder is implied.

## 小云 / Xiaoyun Live2D model

Source: https://github.com/YunYouJun/yun/tree/834d7f0cab813fb725c6efc5416e9a9a3ee7fef1/live2d

Character artwork: floverse (https://twitter.com/Ai_Floverse)

Live2D rigging: 鹿翎linger (https://space.bilibili.com/36903705)

The upstream project licenses these resources under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International:
https://creativecommons.org/licenses/by-nc-sa/4.0/

This project declared the existing pose and expression files and standard EyeBlink/LipSync parameter groups in the local model3 settings. The adapted model assets remain under CC BY-NC-SA 4.0 and must not be used commercially. Credits, the upstream README, source commit, and modification notice are preserved in the bundled `live2d/Xiaoyun/` directory. No endorsement by the upstream creators is implied.

## untitled-pixi-live2d-engine

MIT License

Copyright (c) 2026 GuangChen2333

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## PixiJS and @pixi/sound

The MIT License

Copyright (c) 2013-2023 Mathew Groves, Chad Engler and PixiJS contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
