# Roadmap

Where Onion's True Listener is headed. Nothing here is promised — it's a fun
side project — but this is the direction.

## Real-time / streaming transcription

Today the whole clip is transcribed after you release the hotkey. The goal is to
**transcribe while you're still speaking**:

- Split the incoming audio into chunks and transcribe them incrementally, so the
  first words appear almost immediately.
- Run a **second pass / cleanup model** once the utterance ends to finalize the
  text (fix word boundaries, punctuation, consistent anglicisms) — streaming
  partials are fast but rough, so a final tidy-up gives the best of both.

## More platforms

- **macOS** and **Linux** support (paste, hotkey, and Metal/Vulkan backends per OS).
- See [PLATFORMS.md](./PLATFORMS.md) for the detailed, phased engineering plan.

## Quality-of-life

- Tray icon / hide the window so it lives quietly in the background.
- On-screen (overlay) recording indicator that's visible while another app is focused.
- Autostart with the OS.
- Persistent microphone choice; custom model URLs.
- Optional local LLM cleanup pass (punctuation, formatting, glossary of your terms).
- Packaging niceties: signed installer, auto-update.
