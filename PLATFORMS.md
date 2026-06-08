# Platform support — plan

Planning doc for running on more systems (different GPUs and OSes).

**Status:** planning only. **Priority:** Phase 0 (broaden Windows GPU support).
OS ports (Linux/macOS) and CI are future phases.

## Platform-specific surface

What in the codebase is tied to a platform:

| Part | Now | Notes |
|---|---|---|
| Mic capture (Web Audio) | any | already cross-platform |
| Global hotkey (`uiohook-napi`) | Win | works on Win/Linux/macOS; macOS needs Accessibility, Wayland limited |
| STT engine (`@fugood/whisper.node`) | `cuda` variant | package ships variants for every OS+backend; we just select/bundle |
| **Text injection** (`win-paste.ps1`) | Win only | PowerShell + Win32; needs per-OS implementations |
| Foreground capture/restore | Win only | Win32; may be unneeded elsewhere |
| Model download (`net`) | any | already cross-platform |
| Window/frame (Electron) | any | per-OS config (macOS traffic lights) |
| Packaging (electron-builder) | Win | must build **on each OS** (cross-build infeasible) |

## Core abstractions to introduce

1. **Backend selector + fallback** — pick the best available backend and fall
   back on failure. Win/Linux: `cuda → vulkan → cpu`; macOS: `metal → cpu`.
   - Gotcha: the CUDA variant *loads* even on an incompatible GPU and only fails
     at transcription ("no kernel image for device"). So fallback must be
     failure-driven: catch the transcribe error → rebuild the context with the
     next backend → retry → cache the backend that worked.
2. **Text-injection layer** — `inject(text, target?)` with per-OS implementations
   behind one interface, selected by `process.platform`.

## Phases

### Phase 0 — Broaden Windows GPU support (NEXT UP)

Make the existing Windows build work on (almost) any GPU, not just Blackwell.

- Re-bundle the `vulkan` (~44 MB) and `cpu` (~2 MB) variants (currently excluded).
- Add the backend fallback `cuda → vulkan → cpu` (failure-driven, see above);
  remember the chosen backend in `config.json` to skip retries next launch.
- Bundling: CUDA runtime DLLs stay only with the cuda variant; Vulkan/CPU need none.
- Done when: runs on RTX 30/40/50 (CUDA or Vulkan), AMD/Intel (Vulkan), and CPU
  anywhere as a last resort.

### Phase 1 — Platform abstraction refactor (prep for OS ports)

- `platform/inject/{win,mac,linux}.js` behind a single `inject(text)`.
- `platform/backend.js` for variant selection/fallback per OS.
- `main.js` talks to the interfaces only; no behavior change on Windows.

### Phase 2 — Linux

- whisper variants: `node-whisper-linux-x64-{cuda,vulkan,cpu}`. Linux CUDA needs
  `libcudart`/`libcublas` (bundle or rely on system CUDA); Vulkan is the broad path.
- inject: X11 → `xdotool key ctrl+v`; Wayland → `wtype`/`ydotool` (needs a daemon,
  document as limited).
- hotkey: `uiohook` works on X11; Wayland global hotkeys are restricted.
- package: AppImage + deb.

### Phase 3 — macOS

- whisper: `darwin-arm64` (Metal) / `darwin-x64`; no CUDA.
- inject: `osascript` → `keystroke "v" using command down`.
- permissions: Accessibility (input/hotkey) + Microphone — must request and guide.
- window: `titleBarStyle: hiddenInset` or keep custom chrome.
- build: compile + code-sign + notarize **on a Mac** (Apple Developer account for
  distribution; unsigned works locally with a Gatekeeper prompt).

### Phase 4 — CI / release

- GitHub Actions matrix: `windows-latest`, `ubuntu-latest`, `macos-latest`; each
  runner builds its own OS with electron-builder (solves cross-build + native deps).
- Model stays a runtime download (never bundled) → artifacts stay small.
- Publish per-OS artifacts to a GitHub release.

## Constraints / risks

- Cross-building is infeasible — macOS in particular needs Mac hardware.
- Wayland: injection and global hotkeys are limited; X11 first.
- macOS signing/notarization is extra overhead for distribution.
- CUDA runtime libs differ per OS (Windows DLLs vs Linux `.so`).
