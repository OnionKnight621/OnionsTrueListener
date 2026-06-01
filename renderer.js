// Захоплення мікрофона → PCM 16-bit mono 16kHz → IPC у main → транскрипція.
// Мікрофон тримаємо «теплим»: ініціалізуємо раз, далі лише вмикаємо/вимикаємо
// накопичення семплів (щоб push-to-talk не обрізав перше слово).

const toggleBtn = document.getElementById('toggle');
const copyBtn = document.getElementById('copy-btn');
const langSeg = document.getElementById('lang-seg');
const micSel = document.getElementById('mic-select');
const hotkeyNameEl = document.getElementById('hotkey-name');
const hotkeyChangeBtn = document.getElementById('hotkey-change');
const meterEl = document.getElementById('meter');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const langDetectedEl = document.getElementById('lang-detected');

const TARGET_RATE = 16000;

let audioCtx = null;
let source = null;
let processor = null;
let analyser = null;
let stream = null;

let chunks = [];
let capturing = false;
let inputRate = TARGET_RATE;
let rafId = null;
let triggeredByPtt = false;

let selectedDeviceId = null; // null = пристрій за замовчуванням
let currentLang = localStorage.getItem('lang') || 'uk';

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function beep(freq, ms = 120) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.07;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, ms);
  } catch {}
}

// --- Мова ---
function renderLang() {
  langSeg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === currentLang);
  });
}
langSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-lang]');
  if (!btn) return;
  currentLang = btn.dataset.lang;
  localStorage.setItem('lang', currentLang);
  renderLang();
});
renderLang();

// --- Мікрофон ---
async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter((d) => d.kind === 'audioinput');
    micSel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'За замовчуванням';
    micSel.appendChild(def);
    mics.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Мікрофон ${i + 1}`;
      micSel.appendChild(opt);
    });
    micSel.value = selectedDeviceId || '';
  } catch {}
}
micSel.addEventListener('change', async () => {
  selectedDeviceId = micSel.value || null;
  await resetMic(); // наступний запис відкриє новий пристрій
  setStatus('Мікрофон змінено.', 'ok');
});

function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(buffer, inRate, outRate) {
  if (inRate === outRate) return buffer;
  const ratio = inRate / outRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, buffer.length - 1);
    const frac = idx - i0;
    result[i] = buffer[i0] * (1 - frac) + buffer[i1] * frac;
  }
  return result;
}

async function resetMic() {
  if (capturing) return;
  try {
    if (processor) processor.disconnect();
    if (source) source.disconnect();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (audioCtx) await audioCtx.close();
  } catch {}
  audioCtx = source = processor = analyser = stream = null;
}

async function ensureMic() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
  });
  await listDevices();

  audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
  inputRate = audioCtx.sampleRate;
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!capturing) return;
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);
}

function meterLoop() {
  if (!capturing) return;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / data.length);
  meterEl.style.width = Math.min(100, rms * 400) + '%';
  rafId = requestAnimationFrame(meterLoop);
}

async function start(byPtt = false) {
  if (capturing) return;
  try {
    await ensureMic();
  } catch (e) {
    setStatus('Помилка доступу до мікрофона: ' + e.message, 'err');
    return;
  }
  triggeredByPtt = byPtt;
  chunks = [];
  capturing = true;
  beep(880, 120); // «слухаю — можна говорити»
  setStatus(byPtt ? '🔴 Диктую…' : '🔴 Запис… натисни «Стоп».', 'warn');
  toggleBtn.textContent = '⏹️ Стоп';
  toggleBtn.classList.add('recording');
  meterLoop();
}

async function stop() {
  if (!capturing) return;
  capturing = false;
  if (rafId) cancelAnimationFrame(rafId);
  meterEl.style.width = '0%';
  toggleBtn.textContent = '⏺️ Старт запису';
  toggleBtn.classList.remove('recording');

  const length = chunks.reduce((a, c) => a + c.length, 0);
  let float = new Float32Array(length);
  let off = 0;
  for (const c of chunks) {
    float.set(c, off);
    off += c.length;
  }
  chunks = [];

  if (length === 0) {
    setStatus('Запис порожній — нічого не почув.', 'warn');
    return;
  }

  const seconds = (length / inputRate).toFixed(1);
  if (inputRate !== TARGET_RATE) float = downsample(float, inputRate, TARGET_RATE);
  const pcm = floatToInt16(float);

  setStatus(`⏳ Обробка ${seconds}s на GPU…`, 'warn');
  toggleBtn.disabled = true;
  try {
    const res = await window.whisper.transcribe(pcm.buffer, currentLang);
    if (res.text) {
      outputEl.textContent = res.text;
      outputEl.classList.remove('empty');
      beep(523, 150); // «готово»
      await window.actions.copy(res.text); // авто-копія в буфер
      if (triggeredByPtt) {
        await window.actions.paste(res.text);
        setStatus(`✅ Вставлено за ${res.ms} ms (${res.language}). У буфері.`, 'ok');
      } else {
        setStatus(`✅ Готово за ${res.ms} ms (${res.language}). У буфері.`, 'ok');
      }
    } else {
      outputEl.textContent = '(порожньо — спробуй гучніше/довше)';
      setStatus('Нічого не розпізнано.', 'warn');
    }
    langDetectedEl.textContent = `мова: ${res.language || '—'} · ${res.ms} ms`;
  } catch (e) {
    setStatus('Помилка транскрипції: ' + e.message, 'err');
  } finally {
    toggleBtn.disabled = false;
  }
}

toggleBtn.addEventListener('click', () => {
  if (capturing) stop();
  else start(false);
});

copyBtn.addEventListener('click', async () => {
  const text = outputEl.classList.contains('empty') ? '' : outputEl.textContent;
  if (!text) return;
  await window.actions.copy(text);
  const prev = copyBtn.textContent;
  copyBtn.textContent = '✅ Скопійовано';
  setTimeout(() => (copyBtn.textContent = prev), 1200);
});

// Глобальний push-to-talk
window.ptt.onStart(() => start(true));
window.ptt.onStop(() => stop());

// --- Хоткей ---
window.hotkey.get().then((r) => { hotkeyNameEl.textContent = r.name; });

hotkeyChangeBtn.addEventListener('click', async () => {
  const prevBtn = hotkeyChangeBtn.textContent;
  const prevName = hotkeyNameEl.textContent;
  hotkeyChangeBtn.textContent = 'Очікую…';
  hotkeyChangeBtn.disabled = true;
  hotkeyNameEl.textContent = '⌨️ натисни й відпусти комбінацію (Esc — скасувати)';
  const r = await window.hotkey.capture();
  hotkeyNameEl.textContent = r.name;
  hotkeyChangeBtn.textContent = prevBtn;
  hotkeyChangeBtn.disabled = false;
  if (r.cancelled) setStatus('Зміну хоткея скасовано.', 'warn');
  else setStatus(`Новий хоткей: ${r.name}`, 'ok');
});

listDevices();
