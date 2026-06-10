# Platform support — plan

Planning doc for running on more systems (different GPUs and OSes).

**Status:** Phase 0 (broader Windows GPU support) is **done** — CUDA/Vulkan/CPU
auto-selected. Next up: the OS ports (Linux/macOS) and CI below.

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

### Phase 0 — Broaden Windows GPU support ✅ DONE

Make the existing Windows build work on (almost) any GPU, not just Blackwell.
**Unified, not per-GPU:** our `@fugood` CUDA variant is built for cc 12.0 only
(Blackwell / RTX 50xx). Rather than building multi-arch CUDA binaries ourselves,
use **Vulkan as the universal GPU path** — it covers every NVIDIA Pascal (GTX 10xx)
and newer, plus AMD/Intel, with one binary. CUDA stays only as the Blackwell
fast-path.

Backend by GPU:

| GPU | Backend |
|---|---|
| RTX 50xx (Blackwell, cc 12.0) | CUDA (bundled, fastest) |
| RTX 10xx–40xx, AMD, Intel | Vulkan |
| no GPU / anything else | CPU (slow fallback) |

**Detect, don't try-and-catch.** A CUDA binary built for cc 12.0 *loads* on an
older card but fails at kernel launch — and a CUDA error can `abort()` the whole
process (uncatchable). So decide up front:

1. `nvidia-smi --query-gpu=compute_cap --format=csv,noheader` → CUDA if `>= 12.0`.
2. No nvidia-smi / non-NVIDIA → Vulkan.
3. Vulkan init fails → CPU.
4. Cache the chosen backend in `config.json` (with a way to re-detect).

Steps:
- Re-bundle the `vulkan` (~44 MB) and `cpu` (~2 MB) variants (currently excluded).
- `main.js`: GPU detector + backend pick passed to `initWhisper(opts, backend)`,
  init-error handling, cache, surface the active backend (log / screen).
- CUDA runtime DLLs (~770 MB) are only needed by the cuda variant; they're dead
  weight for non-Blackwell users (possible later optimization: fetch them only
  when CUDA is selected).
- Testing: only CUDA (RTX 5080) is verifiable here; Vulkan/CPU need other machines
  (Vulkan can be force-selected on the 5080 to confirm the variant loads/runs).

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
