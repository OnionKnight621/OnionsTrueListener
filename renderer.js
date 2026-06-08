// Onion's True Listener — renderer (pixel-art skin).
// Audio: microphone -> PCM 16-bit mono 16kHz -> IPC to main -> transcription.
// UI: TV screen with hints/text, segment meter, custom dropdowns.

const screenInner = document.getElementById('screen-inner');
const screenEl = document.getElementById('screen');
const meterEl = document.getElementById('meter');
const copyBtn = document.getElementById('copy-btn');
const clearBtn = document.getElementById('clear-btn');
const scrbtns = document.getElementById('scrbtns');
const toggleBtn = document.getElementById('toggle');
const hotkeyBtn = document.getElementById('hotkey-btn');
const hotkeyVal = document.getElementById('hotkey-val');
const langDrop = document.getElementById('lang-drop');
const langVal = document.getElementById('lang-val');
const langPopup = document.getElementById('lang-popup');
const micDrop = document.getElementById('mic-drop');
const micVal = document.getElementById('mic-val');
const micPopup = document.getElementById('mic-popup');
const overlay = document.getElementById('overlay');
const modelListEl = document.getElementById('model-list');
const gpuLabelEl = document.getElementById('gpu-label');

// Window controls
document.getElementById('min-btn').addEventListener('click', () => window.win.minimize());
document.getElementById('close-btn').addEventListener('click', () => window.win.close());
document.getElementById('opts-btn').addEventListener('click', openOptions);
document.getElementById('opts-close').addEventListener('click', () => overlay.classList.remove('show'));

const TARGET_RATE = 16000;
const SEGMENTS = 22;

const LANGS = [
  { id: 'uk', short: 'UKR', label: 'UKR' },
  { id: 'en', short: 'ENG', label: 'ENG' },
  { id: 'auto', short: 'AUTO', label: 'AUTO' },
];

let audioCtx = null, source = null, processor = null, analyser = null, stream = null;
let chunks = [];
let capturing = false;        // audio is being recorded
let inputRate = TARGET_RATE;
let rafId = null;
let triggeredByPtt = false;

let selectedDeviceId = null;  // null = default device
let currentLang = localStorage.getItem('lang') || 'uk';
let hotkeyName = 'F9';
let lastText = '';
let modelReady = false;
let activeModelId = null;

// ---------- Screen ----------
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function renderScreen(state, payload = '') {
  let html = '';
  if (state === 'idle') {
    html = `<div class="scr-big">STANDBY</div>
      <div class="scr-hint">hold <b>${escapeHtml(hotkeyName)}</b> → speak → release</div>
      <div class="scr-hint">text is inserted at the cursor</div>`;
  } else if (state === 'listening') {
    html = `<div class="scr-big live">● REC</div>
      <div class="scr-hint">speak… release <b>${escapeHtml(hotkeyName)}</b></div>`;
  } else if (state === 'processing') {
    html = `<div class="scr-big">PROCESSING…</div>
      <div class="scr-hint">transcribing on GPU</div>`;
  } else if (state === 'capture') {
    html = `<div class="scr-big">PRESS…</div>
      <div class="scr-hint">a key or combo · <b>Esc</b> to cancel</div>`;
  } else if (state === 'choose') {
    html = `<div class="scr-big">CHOOSE MODEL</div>
      <div class="scr-hint">pick one to download (one time):</div>
      <div class="scr-choices">
        <button class="scr-choice" data-model="large-v3"><b>Large-v3</b> · 3.1 GB<br><span>best quality, heavier</span></button>
        <button class="scr-choice" data-model="large-v3-turbo"><b>Turbo</b> · 1.6 GB<br><span>almost as good, lighter</span></button>
      </div>
      <div class="scr-hint">more in <b>⚙</b> options</div>`;
  } else if (state === 'downloading') {
    const pct = Math.round((payload || 0) * 100);
    html = `<div class="scr-big">DOWNLOADING…</div>
      <div class="scr-hint">${pct}% · one-time (~3 GB)</div>`;
  } else if (state === 'result') {
    html = `<div class="scr-text">${escapeHtml(payload)}</div>`;
  } else if (state === 'error') {
    html = `<div class="scr-big err">ERROR</div><div class="scr-hint">${escapeHtml(payload)}</div>`;
  }
  screenInner.innerHTML = html;
  screenEl.classList.toggle('live', state === 'listening');
  scrbtns.classList.toggle('show', state === 'result' && !!payload);
}

// ---------- Meter ----------
const segs = [];
for (let i = 0; i < SEGMENTS; i++) {
  const s = document.createElement('span');
  s.className = 'px-seg' + (i >= SEGMENTS - 4 ? ' hot' : '');
  meterEl.appendChild(s);
  segs.push(s);
}
function setMeter(level) {
  const lit = Math.round(level * SEGMENTS);
  for (let i = 0; i < SEGMENTS; i++) segs[i].classList.toggle('on', i < lit);
}

function beep(freq, ms = 120) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.07;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, ms);
  } catch {}
}

// ---------- Dropdowns ----------
function closeDropdowns() {
  langDrop.classList.remove('open');
  micDrop.classList.remove('open');
}
function buildPopup(popup, options, currentId, onPick) {
  popup.innerHTML = '';
  options.forEach((o) => {
    const el = document.createElement('div');
    el.className = 'px-opt' + (o.id === currentId ? ' sel' : '');
    el.textContent = o.label;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(o);
      closeDropdowns();
    });
    popup.appendChild(el);
  });
}
langDrop.addEventListener('click', () => {
  const wasOpen = langDrop.classList.contains('open');
  closeDropdowns();
  if (!wasOpen) {
    buildPopup(langPopup, LANGS, currentLang, (o) => setLang(o.id));
    langDrop.classList.add('open');
  }
});
micDrop.addEventListener('click', async () => {
  const wasOpen = micDrop.classList.contains('open');
  closeDropdowns();
  if (!wasOpen) {
    const opts = await getMicOptions();
    buildPopup(micPopup, opts, selectedDeviceId || '', (o) => setMic(o.id));
    micDrop.classList.add('open');
  }
});
document.addEventListener('click', (e) => {
  if (!langDrop.contains(e.target) && !micDrop.contains(e.target)) closeDropdowns();
});

function setLang(id) {
  currentLang = id;
  localStorage.setItem('lang', id);
  const o = LANGS.find((l) => l.id === id) || LANGS[0];
  langVal.textContent = o.short + ' ▾';
}
function micShort(label) {
  if (!label) return 'DEFAULT';
  return label.replace(/\s*\(.*\)$/, '').slice(0, 10).toUpperCase();
}
async function getMicOptions() {
  const opts = [{ id: '', short: 'DEFAULT', label: 'Default device' }];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    all.filter((d) => d.kind === 'audioinput').forEach((d, i) => {
      opts.push({ id: d.deviceId, short: micShort(d.label), label: d.label || `Microphone ${i + 1}` });
    });
  } catch {}
  return opts;
}
async function setMic(id) {
  selectedDeviceId = id || null;
  const opts = await getMicOptions();
  const o = opts.find((m) => m.id === (id || '')) || opts[0];
  micVal.textContent = o.short + ' ▾';
  await resetMic();
}

// ---------- Audio ----------
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
  setMeter(Math.min(1, rms * 4));
  rafId = requestAnimationFrame(meterLoop);
}

async function start(byPtt = false) {
  if (capturing || !modelReady) return;
  try { await ensureMic(); } catch (e) { renderScreen('error', e.message); return; }
  triggeredByPtt = byPtt;
  chunks = [];
  capturing = true;
  beep(880, 120);
  renderScreen('listening');
  toggleBtn.textContent = '■ STOP';
  toggleBtn.classList.add('is-on');
  meterLoop();
}
async function stop() {
  if (!capturing) return;
  capturing = false;
  if (rafId) cancelAnimationFrame(rafId);
  setMeter(0);
  toggleBtn.textContent = '▶ START';
  toggleBtn.classList.remove('is-on');

  const length = chunks.reduce((a, c) => a + c.length, 0);
  let float = new Float32Array(length);
  let off = 0;
  for (const c of chunks) { float.set(c, off); off += c.length; }
  chunks = [];
  if (length === 0) { renderScreen('idle'); return; }

  if (inputRate !== TARGET_RATE) float = downsample(float, inputRate, TARGET_RATE);
  const pcm = floatToInt16(float);

  renderScreen('processing');
  toggleBtn.disabled = true;
  try {
    const res = await window.whisper.transcribe(pcm.buffer, currentLang);
    if (res.text) {
      lastText = res.text;
      beep(523, 150);
      await window.actions.copy(res.text); // auto-copy to clipboard
      if (triggeredByPtt) await window.actions.paste(res.text);
      renderScreen('result', res.text);
    } else {
      renderScreen('idle');
    }
  } catch (e) {
    renderScreen('error', e.message);
  } finally {
    toggleBtn.disabled = false;
  }
}

// ---------- Models ----------
function setReady(ready) {
  modelReady = ready;
  toggleBtn.textContent = ready ? '▶ START' : '⚙ CHOOSE MODEL';
}

// Select a model as active; download it first if it isn't present yet.
async function selectModel(id, downloaded) {
  overlay.classList.remove('show');
  activeModelId = id;
  await window.model.setActive(id);
  if (downloaded) {
    setReady(true);
    renderScreen('idle');
    return;
  }
  toggleBtn.disabled = true;
  renderScreen('downloading', 0);
  const res = await window.model.download(id);
  toggleBtn.disabled = false;
  if (res.ok) { setReady(true); renderScreen('idle'); }
  else { setReady(false); renderScreen('error', res.error || 'download failed'); }
}

window.model.onProgress((d) => {
  if (d.id === activeModelId) renderScreen('downloading', d.pct);
});

// Options panel (model list)
async function openOptions() {
  await renderModelList();
  overlay.classList.add('show');
}
async function renderModelList() {
  const data = await window.model.list();
  activeModelId = data.active;
  modelListEl.innerHTML = '';
  data.items.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'px-mrow' + (m.id === data.active ? ' active' : '');

    const status = m.downloaded ? '<span class="px-mstatus ok">DOWNLOADED</span>'
                                : '<span class="px-mstatus">~' + m.gb + ' GB</span>';
    const trash = m.downloaded ? '<button class="px-mtrash">DEL</button>' : '';
    row.innerHTML =
      '<div class="px-mradio"></div>' +
      '<div class="px-minfo"><div class="px-mname">' + m.label +
      '<span class="px-mtag">' + m.gb + ' GB</span></div>' +
      '<div class="px-mnote">' + m.note + '</div></div>' +
      status + trash;

    // pick model (ignore clicks on the trash button / its confirm)
    row.addEventListener('click', (e) => {
      if (e.target.closest('.px-mtrash') || e.target.closest('.px-mconfirm')) return;
      selectModel(m.id, m.downloaded);
    });

    const trashBtn = row.querySelector('.px-mtrash');
    if (trashBtn) trashBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      askDelete(row, m);
    });

    modelListEl.appendChild(row);
  });
}
function askDelete(row, m) {
  const slot = row.querySelector('.px-mtrash');
  const confirm = document.createElement('div');
  confirm.className = 'px-mconfirm';
  confirm.innerHTML = 'delete? <button class="yes">yes</button><button class="no">no</button>';
  slot.replaceWith(confirm);
  confirm.querySelector('.no').addEventListener('click', (e) => { e.stopPropagation(); renderModelList(); });
  confirm.querySelector('.yes').addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.model.remove(m.id);
    if (m.id === activeModelId) setReady(false); // active model gone
    await renderModelList();
  });
}

toggleBtn.addEventListener('click', () => {
  if (!modelReady) { openOptions(); return; }
  if (capturing) stop(); else start(false);
});

// First-run quick picks rendered on the screen
screenInner.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-model]');
  if (btn) selectModel(btn.dataset.model, false);
});

// ---------- GPU / backend label ----------
function updateGpu(d) {
  if (d) gpuLabelEl.innerHTML = `${escapeHtml(d.name)} · <b>${escapeHtml(d.backend)}</b>`;
}
window.gpu.onUpdate(updateGpu);
window.gpu.info().then(updateGpu);

copyBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!lastText) return;
  await window.actions.copy(lastText);
  copyBtn.textContent = 'OK';
  setTimeout(() => (copyBtn.textContent = 'COPY'), 1000);
});

clearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  lastText = '';
  renderScreen('idle');
});

// ---------- Hotkey ----------
hotkeyBtn.addEventListener('click', async () => {
  hotkeyBtn.classList.add('is-capturing');
  renderScreen('capture');
  const r = await window.hotkey.capture();
  hotkeyName = r.name;
  hotkeyVal.textContent = r.name;
  hotkeyBtn.classList.remove('is-capturing');
  renderScreen(lastText ? 'result' : 'idle', lastText);
});

// ---------- PTT ----------
window.ptt.onStart(() => start(true));
window.ptt.onStop(() => stop());

// ---------- Init ----------
(async () => {
  setLang(currentLang);
  const opts = await getMicOptions();
  micVal.textContent = (opts[0].short) + ' ▾';
  try { const r = await window.hotkey.get(); hotkeyName = r.name; hotkeyVal.textContent = r.name; } catch {}

  const data = await window.model.list();
  activeModelId = data.active;
  const active = data.items.find((m) => m.id === data.active);
  if (active && active.downloaded) {
    setReady(true);
    renderScreen('idle');
  } else {
    setReady(false);
    renderScreen('choose'); // first run: pick normal vs smaller
  }
})();
