# Implementation Notes

Status, decisions, and roadmap for **OnionsTrueListener**.
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
- [x] Normal focusable window with custom button UI (language segments, mic
      cycle, copy), audio cues, language selector (default `uk`, persisted).
- [x] Clean app exit (force `app.exit(0)` so native threads don't hang the close).

## Planned

- [ ] Tray icon / hide the window so it lives in the background.
- [ ] On-screen recording indicator (overlay).
- [ ] Settings: configurable hotkey and microphone.
- [ ] Autostart with Windows.
- [ ] Package to a standalone `.exe` (account for ~668 MB `cublasLt64_12.dll`).
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
