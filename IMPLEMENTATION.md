# Implementation Notes

Status, decisions, and roadmap for **Onion's True Listener**.
For setup/usage see [README.md](./README.md).

## Goal

Local offline push-to-talk dictation: hold a hotkey anywhere, speak
(Ukrainian / English / mixed), release, and the text is pasted into the focused
field. The key use case is code-switched Ukrainian + English tech speech, which
built-in OS dictation can't do (one language at a time).

## Stack

- **Electron + Node.js** wrapper.
- **Whisper `large-v3`** via `@fugood/whisper.node` (prebuilt CUDA binding),
  running in the main process. Audio is captured in the renderer and sent over IPC.
- **`uiohook-napi`** for the global push-to-talk hotkey (needs key-up, which
  Electron's `globalShortcut` doesn't provide).
- **PowerShell** for paste (clipboard + `Ctrl+V`) and focus restore.

## Done

- [x] GPU transcription confirmed on RTX 5080 (CUDA, cc 12.0); ~0.5–0.8 s/phrase.
- [x] End-to-end: mic → PCM 16 kHz → IPC → Whisper → text. Native module loads
      fine under Electron (N-API, no `electron-rebuild`).
- [x] `large-v3`: reliable Ukrainian (Cyrillic) and mixed UK+EN in one utterance.
- [x] Global push-to-talk (hold **F9**) via `uiohook-napi`.
- [x] Paste into the focused field of any app (capture foreground on key-down,
      restore it before `Ctrl+V`).
- [x] Clean app exit (force `app.exit(0)` so native threads don't hang the close).
- [x] Configurable push-to-talk hotkey — modelled as a set of keys, so it
      supports single keys, modifier+key, and modifier-only combos (e.g. Ctrl+Win).
      Captured in UI (press & release, `Esc` cancels), saved to `config.json`;
      default F9. Left/right modifiers normalized.
- [x] Pixel-art "old TV" UI (frameless window, custom title bar, TV screen with
      on-screen hints/results, segment meter, custom dropdowns, COPY/CLEAR),
      bundled Pixelify Sans font. English UI.
- [x] Packaging via electron-builder (asar + unpacked native bits, model as
      extraResources). `win-unpacked` runs standalone; NSIS installer pending
      (Windows symlink privilege / Developer Mode).

## Planned

- [ ] Tray icon / hide the window so it lives in the background.
- [ ] On-screen recording indicator (overlay).
- [ ] Settings: persistent microphone choice.
- [ ] Autostart with Windows.
- [ ] **Streaming / chunked transcription** — transcribe early words while the
      user is still speaking (lower perceived latency). Likely needs a second
      pass / model to finalize the text once the utterance ends.
- [ ] **Broader platform support** where feasible (macOS / Linux; non-CUDA GPU
      backends like Vulkan/Metal, CPU fallback).
- [ ] Optional: local LLM cleanup pass (punctuation, consistent anglicisms) —
      only if real usage demands it.

## Key decisions

- **No LLM stage (for now).** `large-v3` handles code-switching well on its own;
  a second model was dropped (YAGNI). The language selector (force `uk`) fixes the
  occasional uk→ru misdetection cheaply. Revisit a local LLM
  (`node-llama-cpp`, GGUF Gemma 3 / Qwen) only if inconsistent Cyrillization of
  English terms becomes annoying.
- **In-process Node binding, not a subprocess.** `transcribeData` takes PCM
  16-bit mono 16 kHz — exactly what Web Audio produces.
- **Window must stay focusable.** `focusable: false` made paste trivial but killed
  the native window chrome (menu, min/max/close, dragging). Final approach:
  normal window + capture/restore foreground around the paste.

## Gotchas (so we don't relearn them)

1. **Missing CUDA DLLs.** The CUDA variant of `@fugood/whisper.node` doesn't bundle
   `cudart64_12` / `cublas64_12` / `cublasLt64_12`; without them it fails to load
   and **silently falls back to CPU**. Fix: copy them from the CUDA 12.9 redist
   next to `index.node` (see README). The binary targets cc 12.0 (Blackwell).
2. **Model option is `filePath`, not `model`** (the README of the binding is wrong)
   — otherwise `TypeError: Model path is required`.
3. **Focus restore must be gentle.** `SetForegroundWindow` + `AttachThreadInput`
   is fine; adding `ShowWindow` / `BringWindowToTop` was the suspected cause of
   user windows getting hidden/minimized — don't reintroduce them.
