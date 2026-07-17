# Bundled Live2D model sources

Runtime model files in this directory are third-party assets and are not covered by
the application's own source-code terms.

## Live2D official sample models

Hiyori, Mao, Wanko, Haru, Mark and Rice come from
[Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples/tree/develop).
The six bundled official models in the 2026-07 adaptation were audited against commit
`b1de66b0b1f1cb881d95fb6158622aeb6a2827bd`; Natori was deliberately not
included because its collaboration-character terms are not suitable for this
project's bundled model workflow. The project is pinned to Cubism Core 5.1 and
only treats files with a `MOC3` header and moc version byte no higher than 5 as
compatible bundled resources; v6 data requires a newer compatible runtime.

The upstream `LICENSE.md` and `NOTICE.md` are preserved as
`CUBISM_WEB_SAMPLES_LICENSE.md` and `CUBISM_WEB_SAMPLES_NOTICE.md`.
The models are additionally subject to Live2D's Free Material License and
per-model sample terms. Haru's sample sound files are not included, and the
local Haru `model3.json` copy only removes those `Sound` references so model
motions do not conflict with the desktop pet's TTS. Wanko's local
`model3.json` additionally declares seven motion files that are present in the
same pinned official sample commit but were not referenced by its upstream
settings file (`idle_02`, four additional touch motions, and two Shake
motions). Mark's local settings fill the otherwise empty LipSync group with
the model's existing `ParamMouthOpenY` parameter. No moc, texture, motion, or
artwork data was altered by either settings-only adaptation.

## Nana

The model comes from [nna774/nana](https://github.com/nna774/nana) at commit
`baab37660fc2fd160162d054a979729651c5e34c`. The upstream README licenses all
repository contents under CC BY-SA 4.0. See
`Nana/UPSTREAM_README.md` and `Nana/MODEL_ATTRIBUTION.md`.

## Cyannyan

The 2048px web model comes from
[jupiterbjy/Live2DPractice-Cyannyan](https://github.com/jupiterbjy/Live2DPractice-Cyannyan)
at commit `898d849e594712cd6afb3bb81c07ecc58c59e024`.
It is licensed under CC BY-SA 4.0. See
`Cyannyan/CC-BY-SA-4.0-LICENSE.md`,
`Cyannyan/UPSTREAM_README.md`, and
`Cyannyan/MODEL_ATTRIBUTION.md`.

## 小云 / Xiaoyun

The model comes from [YunYouJun/yun](https://github.com/YunYouJun/yun) at
commit `834d7f0cab813fb725c6efc5416e9a9a3ee7fef1`.
It is licensed under CC BY-NC-SA 4.0. See
`Xiaoyun/MODEL_CREDITS.md`,
`Xiaoyun/UPSTREAM_README.md`, and
`Xiaoyun/MODEL_LICENSE.md`. The local settings declare the already bundled
pose and expression files and add standard EyeBlink/LipSync groups; the
underlying model assets are unchanged.
