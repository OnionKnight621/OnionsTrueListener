# Cleanup model — implementation plan

A second, optional LLM pass that tidies the raw Whisper transcript before it's
pasted: punctuation, casing, word boundaries, and consistent handling of
code-switched English terms inside Ukrainian speech. Background and motivation
live in [ROADMAP.md](./ROADMAP.md); this file is the concrete engineering plan.

## Decisions (locked)

- **Engine: `node-llama-cpp` on the Vulkan backend.** In-process GGUF inference,
  same shape as the existing whisper binding, so it reuses our model-download /
  userData / lazy-context patterns. Vulkan sidesteps the Blackwell **sm_120**
  CUDA build pain we already know from whisper — prebuilt llama.cpp CUDA binaries
  routinely omit sm_120, requiring a `CMAKE_CUDA_ARCHITECTURES=120` + CUDA 12.8
  source build. Vulkan is plenty fast for a small cleanup model and needs no
  build. CUDA can be revisited later as an opt-in speed-up.
- **Trigger: a UI toggle, default OFF.** Cleanup adds latency, so it's never
  forced. The user turns it on when they want it.
- **Model: a small LLM catalog**, mirroring the whisper model catalog. Ships a
  couple of instruct GGUFs (e.g. Gemma 3 4B Q4, Qwen2.5 3B Q4); user downloads /
  switches / deletes like the whisper models. Default candidate: Gemma 3 4B Q4
  (~2.5 GB VRAM; fits alongside large-v3 on the 16 GB RTX 5080).

## Architecture (respecting CLAUDE.md layering)

- `main.js` owns the new side effects (LLM context lifecycle, IPC handlers).
- New module `cleanup.js` (main-process): owns the llama context + a pure-ish
  `buildPrompt(text, lang)` and `cleanup(text, lang)`. Prompt construction is a
  pure function (easy to test); the model call is the side effect at the edge.
- `preload.js`: extend the `model` bridge (or add a `cleanup` bridge) — no logic.
- `renderer.js`: add the toggle + LLM entries in the Options panel; call cleanup
  between transcription and paste when enabled.
- The whisper catalog/manager code is the template — generalize, don't fork.

## Pipeline change

Today (`renderer.js` `stop()`):

```
transcribe -> auto-copy -> (if PTT) paste -> render result
```

With cleanup enabled:

```
transcribe -> [cleanup pass] -> auto-copy(cleaned) -> (if PTT) paste(cleaned) -> render
```

- Cleanup runs in **main**, invoked over IPC, so the heavy model stays off the
  renderer. Renderer shows a `CLEANING…` screen state between PROCESSING and the
  result.
- **Fail-open**: if cleanup errors or times out, fall back to the raw transcript
  (never block paste on the LLM). Log and continue.
- Optional UX: paste the raw text immediately, then... no — keep it simple, one
  paste of the final text. Revisit streaming later.

## Prompt design (the hard part)

Goal: *clean, don't rewrite*. The model must preserve meaning and the user's
code-switching, not translate or paraphrase.

- System instruction: "You are a transcript cleaner. Fix punctuation, casing and
  obvious recognition slips. Keep the original language(s) exactly — do NOT
  translate. Keep English technical terms in Latin script. Do not add or remove
  content. Output only the cleaned text."
- Low temperature (~0.1–0.3), tight max tokens relative to input.
- Guard against the model being chatty (no preamble/quotes) — strip wrapping if
  it appears.
- Future: a user glossary of preferred spellings injected into the prompt.

## Work breakdown

### Phase 1 — Engine spike (de-risk first) ✅ DONE
- [x] Add `node-llama-cpp` (3.18.1); load Gemma 3 4B Q4_K_M on the **Vulkan**
      backend. Prebuilt `@node-llama-cpp/win-x64-vulkan` ships, no source build.
- [x] Confirmed on the RTX 5080 (Blackwell sm_120): model loads in ~3.3 s; Vulkan
      enumerates `RTX 5080` + iGPU. **No sm_120 build pain** — the whole point.
- [x] Latency ~2.5–4.8 s per 1-sentence cleanup at temp 0 (generous budget, ok).
- [x] **Prompt design solved**: a described "output only" rule fails (Gemma acts as
      a chat assistant and answers/summarizes); **few-shot demonstration turns** fix
      it completely — clean text only, anglicisms → Latin (фетч→fetch), no translation.
- [x] **Teardown gotcha**: native `dispose()` on Vulkan/Windows crashes with an
      access violation (0xC0000005) at exit. Don't rely on graceful release —
      force-exit, as the app already does (`app.exit(0)`). ⚠️ Validate context
      release on **model switch** in Phase 3 (may need the same care).

Spike harness: `test-cleanup.mjs` (run `node test-cleanup.mjs`).

### Phase 1.5 — Minimal app integration (done alongside the spike)
- [x] `cleanup.js`: lazy Vulkan context, few-shot `baseHistory()`, `cleanup(text,
      modelPath)` with 15 s abort timeout + fail-open.
- [x] `main.js`: hard-coded `LLM` descriptor + path resolver (dev copy in `./models`
      wins); IPC `cleanup:info` / `cleanup:setEnabled` / `cleanup:run`; `cleanup`
      flag in `config.json`.
- [x] `preload.js`: `cleanup` bridge. `renderer.js`: CLEAN toggle, `CLEANING…`
      screen state, cleanup runs between transcribe and copy/paste when enabled.
- [x] UI shows the active LLM (`LLM: Gemma 3 4B · on/off/not installed`).
- [x] Result screen shows **RAW vs CLEANED** side-by-side when cleanup changed the
      text (so the second pass's impact is visible); text sits in a thin-bordered,
      independently-scrollable box.
- [ ] **Voice end-to-end test** (mic + hotkey) — needs a human; engine already proven.

### Phase 2 — Cleanup module + IPC
- [ ] `cleanup.js`: lazy context (mirror `getContext`/`releaseContext`),
      `buildPrompt`, `cleanup(text, lang)` with timeout + fail-open.
- [ ] IPC handler `cleanup:run` in `main.js`; expose via `preload.js`.
- [ ] Release/rebuild the llama context on model switch (like whisper).

### Phase 3 — LLM model catalog + manager
- [ ] Generalize the whisper catalog code to a second `LLM_CATALOG`
      (id/file/gb/label/note + HF base URL).
- [ ] Reuse download/setActive/delete handlers (parameterize by catalog) or add
      `llm:*` siblings. Keep one downloader.
- [ ] Store active LLM id + cleanup-enabled flag in `config.json`.

### Phase 4 — UI
- [ ] Cleanup ON/OFF toggle (near the language dropdown).
- [ ] LLM section in the Options panel (download / switch / delete), reusing the
      whisper model-row UI.
- [ ] `CLEANING…` screen state; wire cleanup into `stop()` before copy/paste.

### Phase 5 — Polish
- [ ] Tune prompt on real UK+EN tech speech; verify no translation/hallucination.
- [ ] Handle "model not downloaded but cleanup on" gracefully (prompt to fetch).
- [ ] Update IMPLEMENTATION.md "Key decisions" (revisit the YAGNI note) and
      ROADMAP.md (mark cleanup in progress).
- [ ] Packaging: ensure `node-llama-cpp` native binaries are in `asarUnpack`;
      keep LLM models out of the bundle (runtime download, like whisper).

## Open questions / risks

- **VRAM coexistence**: large-v3 (~3–4 GB) + 4B Q4 (~2.5 GB) on 16 GB is fine,
  but confirm under real load. Option: unload whisper during cleanup if tight.
- **Latency budget**: if Vulkan cleanup is too slow, consider a smaller model
  (3B/1B) as default, or the CUDA build as an opt-in.
- **node-llama-cpp Vulkan maturity** on Blackwell — validate in Phase 1 before
  committing further.
- **Packaging size**: node-llama-cpp prebuilt binaries add weight; check release
  stays under the GitHub limit.
