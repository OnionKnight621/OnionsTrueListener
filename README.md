# Onion's True Listener

<p align="center">
  <img src="assets/screenshot.png" alt="Onion's True Listener — pixel-art push-to-talk dictation UI" width="620">
</p>

Local, **offline** push-to-talk dictation for Windows. Hold a hotkey, speak
(Ukrainian / English / mixed), release — the recognized text is pasted into
whatever field your cursor is in. GPU-accelerated Whisper, nothing leaves your machine.

> A fun project, mostly vibe-coded. Open source under MIT — do whatever you want with it.

## Features

- 🎙️ **Global push-to-talk** — hold a hotkey (default **F9**, configurable, combos like `Ctrl+Win` too) in any app.
- ⚡ **Local GPU transcription** (Whisper) with automatic backend: **CUDA** (RTX 50xx),
  **Vulkan** (most NVIDIA 10xx+/AMD/Intel), **CPU** fallback. The active GPU + backend is shown on screen.
- 🇺🇦🇬🇧 **Ukrainian + English + mixed** — keeps English terms in Latin, Ukrainian in Cyrillic. UKR / ENG / Auto.
- 📋 **Pastes into the focused field** of any app, and keeps the text on the clipboard.
- 🧠 **Model manager** — pick / download / switch / delete models (Large-v3 / Turbo / Medium / Small) via **⚙**.
- 🕹️ 100% offline (after you download it and the model it uses)

## Download & run

1. Grab `onions-true-listener-<ver>-win-x64.zip` from [Releases](../../releases), extract it.
2. Run **`Onion's True Listener.exe`**.
3. First launch: **choose a model** — it downloads once (~0.5–3 GB) into your user-data folder.
4. Put the cursor anywhere, **hold F9**, speak, release.

## Run from source

```sh
npm install
npm start
```

> On an RTX 50xx, CUDA needs three CUDA 12.9 DLLs (`cudart64_12`, `cublas64_12`,
> `cublasLt64_12`) in `node_modules/@fugood/node-whisper-win32-x64-cuda/`
> (from <https://developer.download.nvidia.com/compute/cuda/redist/>). Without them
> the app just uses **Vulkan** — no setup needed. A model placed at
> `models/ggml-<name>.bin` is used directly (skips the download).

## Build

```sh
npm run build      # -> dist/onions-true-listener-<ver>-win-x64.zip
```

(The `winCodeSign` "cannot create symbolic link" warning during the build is
harmless — we build a `dir` target and zip it ourselves, no signing needed.)

## Requirements

Windows x64. Any reasonably modern GPU (Vulkan) or CPU works; an NVIDIA RTX 50xx
gets the fastest path via CUDA. Internet on first run (to fetch a model).

## Docs

- [ROADMAP.md](./ROADMAP.md) — what's planned next (real-time streaming, macOS/Linux, QoL).
- [PLATFORMS.md](./PLATFORMS.md) — cross-platform engineering plan.
- [IMPLEMENTATION.md](./IMPLEMENTATION.md) — status, decisions, gotchas.

## Tech stack

[Electron](https://www.electronjs.org/) ·
[@fugood/whisper.node](https://github.com/mybigday/whisper.node) (whisper.cpp binding) ·
[uiohook-napi](https://github.com/SnosMe/uiohook-napi) (global hotkey) ·
Web Audio (capture) · PowerShell (paste / focus).

## License

MIT
