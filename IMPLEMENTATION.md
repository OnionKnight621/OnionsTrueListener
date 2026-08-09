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
- [x] Packaging: **`npm run build`** (`scripts/build.js`) — clean → electron-builder
      `dir` target → zip via bundled 7za (~772 MB). The model isn't bundled (it's a
      runtime download), so the release fits under GitHub's 2 GB limit. The script
      tolerates electron-builder's winCodeSign symlink error (the unpacked app is
      still produced; signing isn't needed for a `dir` build) → fully self-serve,
      no Developer Mode required.
- [x] Robustness: abort the model download + guard `webContents.send` on window
      close (no more "Object has been destroyed" dialog mid-download);
      `uncaughtException` is logged instead of popping a blocking dialog.
- [x] Model manager: catalog (large-v3 / turbo / medium / small), first-run
      choice (normal vs smaller), **⚙ Options → Models** panel to switch / download
      / delete (inline confirm). Models live in userData; active model in
      `config.json`; the whisper context is released & rebuilt on switch.

- [x] **User dictionary.** Hand-editable `glossary.json` in userData: canonical word
      + the variants Whisper mishears (`келем`/`кілем` → `килим`). Applied as the
      very last step of the pipeline (after the LLM pass, so cleanup can't undo it).
      Matching lives in the pure `glossary.js`; three modes — `root` (default:
      matches a word start, keeps the ending, so one rule covers all inflections),
      `word`, `anywhere` — with case upgraded to the transcript's. Options panel
      shows the entry count + OPEN FILE / RELOAD; the file is re-read on mtime change.
      `apply` returns the substitutions it made, rendered as a `FIXED келем → килим`
      line under the result — free, since they're collected in the same pass.
      Unit tests: `npm test`.

- [x] **Phase 0 — Windows multi-GPU.** Backend chosen by `nvidia-smi compute_cap`:
      CUDA on Blackwell (cc ≥ 12), Vulkan on every other NVIDIA/AMD/Intel, CPU
      fallback. All three variants bundled; active GPU+backend shown on screen.
      `OTL_BACKEND` env var forces a backend for testing. See [PLATFORMS.md](./PLATFORMS.md).

## Planned

See **[ROADMAP.md](./ROADMAP.md)** — real-time/streaming transcription (+ a second
cleanup model), macOS/Linux (Phase 1+ in [PLATFORMS.md](./PLATFORMS.md)), and
quality-of-life items (tray, overlay indicator, autostart, persistent mic).

## Key decisions

- **Optional LLM cleanup stage (in progress).** `large-v3` handles code-switching
  well on its own, so the second pass is **off by default** — but it's now wired in
  as an opt-in toggle for consistent Cyrillization of English terms (фетч→fetch),
  punctuation and casing. Engine: **Gemma 3 4B Q4 via `node-llama-cpp` on Vulkan**
  (Vulkan sidesteps the Blackwell sm_120 CUDA build pain). Few-shot prompting is
  required to stop Gemma-it from acting like a chat assistant. Fails open: a bad
  cleanup never blocks the paste. See **[CLEANUP_MODEL_PLAN.md](./CLEANUP_MODEL_PLAN.md)**.
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
4. **node-llama-cpp Vulkan dispose crashes at exit** (access violation 0xC0000005
   on Windows). Don't rely on graceful `context/model/llama.dispose()` for shutdown
   — force-exit like we already do (`app.exit(0)`). Releasing a context to switch
   LLM models needs the same caution (to validate).
5. **JS `\b` is useless for Cyrillic.** It's an ASCII word boundary, so it never
   fires between a space and `к` — `/\bкелем/` matches nothing. Use Unicode
   lookarounds instead: `(?<![\p{L}\p{N}_])` … `(?![\p{L}\p{N}_])` with the `u` flag.
6. **Gemma-it needs few-shot, not instructions.** Telling it "output only the
   cleaned text" fails — it replies like a chat assistant. Seeding the chat history
   with messy→clean example turns fixes it. See `cleanup.js`.
