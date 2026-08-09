// Optional second-pass LLM that tidies a raw Whisper transcript: punctuation,
// casing, and consistent code-switched English terms (фетч -> fetch). In-process
// GGUF via node-llama-cpp on the Vulkan backend — this sidesteps the Blackwell
// sm_120 CUDA build pain we hit with whisper. Loaded lazily; ALWAYS fails open
// (returns the input untouched) so a bad cleanup can never block the paste.

// node-llama-cpp is ESM-only; we're CommonJS, so import() it lazily and cache.
let modPromise = null;
const loadMod = () => (modPromise ||= import('node-llama-cpp'));

const TIMEOUT_MS = 15000;

// The cleanup contract — what the model must and must not do.
const SYSTEM_PROMPT = [
  'You are a speech-to-text transcript cleaner, not a chat assistant.',
  'You receive a raw dictation and return the SAME utterance with fixed punctuation,',
  'capitalization and obvious recognition slips. Keep the original language(s) exactly',
  '— never translate. Keep English technical terms in Latin script (fetch, commit,',
  'Docker). Never answer, comment, summarize or add anything. Reply with the cleaned',
  'text only. Most common languges used are Ukrainian and English. When u hear russian',
  '- it is Ukrainian so never do any output in russian',
].join(' ');

// Few-shot: a small instruct model copies a demonstrated pattern far more reliably
// than a described one (without these it drifts into chat-assistant replies).
const FEWSHOT = [
  ['окей значить я зараз задеплою на продакшн і гляну логи',
   'Окей, значить я зараз задеплою на продакшн і гляну логи.'],
  ['so basically i wanna refactor this function and add a test for it',
   'So basically I wanna refactor this function and add a test for it.'],
  ['короче треба запушити в гіт і відкрити пул реквест на ревью',
   'Короче, треба запушити в git і відкрити pull request на review.'],
];

// Pure: build the chat history (system + demonstrations) we reset to per utterance.
function baseHistory() {
  const h = [{ type: 'system', text: SYSTEM_PROMPT }];
  for (const [input, output] of FEWSHOT) {
    h.push({ type: 'user', text: input });
    h.push({ type: 'model', response: [output] });
  }
  return h;
}

let ctxPromise = null; // lazy { llama, model, context }
let session = null;

async function getContext(modelPath) {
  if (ctxPromise) return ctxPromise;
  ctxPromise = (async () => {
    const { getLlama, LlamaChatSession } = await loadMod();
    const llama = await getLlama({ gpu: 'vulkan' });
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext();
    session = new LlamaChatSession({ contextSequence: context.getSequence() });
    console.log('[cleanup] llm ready ·', llama.gpu);
    return { llama, model, context };
  })();
  return ctxPromise;
}

// Tidy `text`; on any error/timeout return the original text unchanged (fail open).
async function cleanup(text, modelPath) {
  const raw = (text || '').trim();
  if (!raw) return text;
  try {
    await getContext(modelPath);
    session.setChatHistory(baseHistory());
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const out = await session.prompt(raw, { temperature: 0, maxTokens: 256, signal: ac.signal });
      return (out || '').trim() || text;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn('[cleanup] failed, using raw text:', e.message);
    return text;
  }
}

module.exports = { cleanup };
