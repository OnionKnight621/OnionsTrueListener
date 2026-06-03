# Onion's True Listener — project guidelines

Local, offline push-to-talk dictation (Electron + whisper.cpp/CUDA). See
`IMPLEMENTATION.md` for architecture and `README.md` for setup.

## Coding rules

- **Readability first.** Prefer simple, clear code over clever code. Short
  functions, descriptive names, early returns.
- **Pure functions where reasonable.** Keep transformations (audio math, parsing,
  formatting) free of side effects and DOM/IPC access so they're easy to reason
  about and test. Push side effects (IPC, clipboard, audio I/O) to the edges.
- **Decouple parts.** Keep responsibilities separated: `main.js` owns the OS side
  (window, hotkey, paste, whisper), `renderer.js` owns capture + UI, `preload.js`
  is only the IPC bridge. Don't leak one layer's concerns into another.
- **Comments only where they add value** — explain *why*, not *what*. No narration
  of obvious code. **Always write comments in English.**
