// Smoke test: чи заводиться whisper.node на CUDA (RTX 5080 / sm_120)
// і чи коректно транскрибує. Запуск: node test-transcribe.js
const path = require('path');
const {
  initWhisper,
  toggleNativeLog,
  addNativeLogListener,
} = require('@fugood/whisper.node');

const VARIANT = process.argv[2] || 'cuda'; // 'cuda' | 'vulkan' | 'default'

async function main() {
  // Нативний лог whisper.cpp — тут видно, який бекенд і пристрій реально обрано
  await toggleNativeLog(true);
  addNativeLogListener((level, text) => process.stdout.write(`[native] ${text}`));

  console.log(`\n=== Variant requested: "${VARIANT}" ===\n`);

  const t0 = Date.now();
  const context = await initWhisper(
    {
      filePath: path.join(__dirname, 'models', 'ggml-base.bin'),
      useGpu: true,
    },
    VARIANT
  );
  console.log(`\n[init] context ready in ${Date.now() - t0} ms\n`);

  const t1 = Date.now();
  const { promise } = context.transcribeFile(
    path.join(__dirname, 'samples', 'jfk.wav'),
    { language: 'en' }
  );
  const result = await promise;
  const took = Date.now() - t1;

  console.log('\n=== RESULT ===');
  console.log('text:', (result.result || result.text || JSON.stringify(result)).trim());
  console.log(`\n[transcribe] took ${took} ms`);

  await context.release();
  console.log('[done] context released');
}

main().catch((e) => {
  console.error('\n!!! ERROR:', e);
  process.exit(1);
});
