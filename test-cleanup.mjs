// Phase 1 spike: prove node-llama-cpp runs Gemma 3 4B on the Vulkan backend
// (Blackwell sm_120, RTX 5080) and produces a sane cleanup of a raw transcript.
// Run: node test-cleanup.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, 'models', 'gemma-3-4b-it-Q4_K_M.gguf');

// What the cleanup pass must (and must not) do.
const SYSTEM_PROMPT = [
  'You are a speech-to-text transcript cleaner, not a chat assistant.',
  'You receive a raw dictation and return the SAME utterance with fixed punctuation,',
  'capitalization and obvious recognition slips. Keep the original language(s) exactly',
  '— never translate. Keep English technical terms in Latin script (fetch, commit,',
  'Docker). Never answer, comment, summarize or add anything. Reply with the cleaned',
  'text only.',
].join(' ');

// Few-shot: small instruct models obey a demonstrated pattern far better than a
// described one. Each pair teaches "messy in -> only the cleaned line out".
const FEWSHOT = [
  ['окей значить я зараз задеплою на продакшн і гляну логи',
   'Окей, значить я зараз задеплою на продакшн і гляну логи.'],
  ['so basically i wanna refactor this function and add a test for it',
   'So basically I wanna refactor this function and add a test for it.'],
  ['короче треба запушити в гіт і відкрити пул реквест на ревью',
   'Короче, треба запушити в git і відкрити pull request на review.'],
];

// Base chat history (system + demonstrations) cloned fresh for every utterance.
function baseHistory() {
  const h = [{ type: 'system', text: SYSTEM_PROMPT }];
  for (const [input, output] of FEWSHOT) {
    h.push({ type: 'user', text: input });
    h.push({ type: 'model', response: [output] });
  }
  return h;
}

// Raw-ish samples (mixed UK+EN tech speech is the whole point of the product).
const SAMPLES = [
  'короче я зараз зроблю фетч на бекенд і подивлюсь шо там в респонсі приходить',
  'okay so i need to commit this and then push to master right now',
  'давай задеплоїмо це на продакшн і потім глянемо логи в графані',
];

async function main() {
  const t0 = Date.now();
  const llama = await getLlama({ gpu: 'vulkan' });
  console.log('[spike] backend gpu:', llama.gpu);
  try { console.log('[spike] devices:', await llama.getGpuDeviceNames()); } catch {}

  const model = await llama.loadModel({ modelPath: MODEL_PATH });
  const context = await model.createContext();
  console.log(`[spike] model loaded in ${Date.now() - t0}ms`);
  try {
    const v = await llama.getVramState();
    console.log(`[spike] VRAM used ${(v.used / 1e9).toFixed(2)}GB / ${(v.total / 1e9).toFixed(2)}GB`);
  } catch {}

  // One sequence + one session; reset to the few-shot base before each sample.
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });
  for (const raw of SAMPLES) {
    session.setChatHistory(baseHistory());
    const tStart = Date.now();
    const cleaned = await session.prompt(raw, { temperature: 0, maxTokens: 256 });
    const ms = Date.now() - tStart;
    console.log('\n--- sample -----------------------------------');
    console.log('RAW    :', raw);
    console.log(`CLEANED: ${cleaned.trim()}  (${ms}ms)`);
  }
  // Teardown probe: skip native dispose entirely and force-exit, like the app
  // already does for whisper/uiohook (app.exit(0)).
  console.log('\n[spike] done. forcing exit(0)');
  process.exit(0);
}

main().catch((e) => { console.error('[spike] FAILED:', e); process.exit(1); });
