// main.js — YTP-O-MATIC 9000 app state + UI wiring: loading matrix, tabs, poop/export flows, toasts, idle renderer (agent: UI)

import { AudioEngine } from './audio-engine.js';
import { VisualFX } from './visual-fx.js';
import { generateEDL, Conductor, Exporter } from './ytp-generator.js';
import { SusMachine } from './sus-machine.js';
import { t, initLang, setLang, getLang, applyTo, onLangChange } from './i18n.js';

const $ = (id) => document.getElementById(id);

// ---------- DOM refs ----------
const dropzoneEl = $('dropzone');
const appEl = $('app');
const stageCanvas = $('stage');
const timelineCanvas = $('timeline');
const videoEl = $('src-video');
const imageEl = $('src-image');
const toastsEl = $('toasts');

const fileInput = $('file-input');

const tabPoopBtn = $('tab-poop');
const tabSusBtn = $('tab-sus');
const ejectBtn = $('eject-btn');
const poopPanel = $('poop-panel');
const susPanel = $('sus-panel');

const chaosEl = $('chaos');
const chaosLabel = $('chaos-label');
const poopBtn = $('poop-btn');
const rerollBtn = $('reroll-btn');
const stopBtn = $('stop-btn');
const exportBtn = $('export-btn');
const seedLabel = $('seed-label');
const progressEl = $('poop-progress');

const susRecordBtn = $('sus-record-btn');
const susStopBtn = $('sus-stop-btn');
const lengthEl = $('length');
const liteEl = $('tgl-lite');
const langSwitch = $('lang-switch');

const TOGGLE_KEYS = ['stutter', 'reverse', 'speed', 'pitch', 'earrape', 'jumpcuts', 'visuals', 'captions'];

// ---------- core instances (constructors synchronous, built once) ----------
const engine = new AudioEngine();
const vfx = new VisualFX(stageCanvas);
vfx.setAnalyser(engine.analyser);
const conductor = new Conductor({ engine, vfx, videoEl, imageEl, canvas: stageCanvas });
const exporter = new Exporter({ canvas: stageCanvas, engine });

const state = {
  mediaKind: null, // 'video' | 'audio' | 'image' | null
  engine,
  vfx,
  conductor,
  sus: null,
  exporter,
  currentEdit: null,
  objectUrl: null,
  susActive: false,
  exporting: false,
  susRecording: false,
};

// Load generation token: any await-crossing load checks it stayed current,
// so a slow decode can't resurrect after an eject or a newer load.
let loadGen = 0;
let susRecordGen = 0;

const sus = new SusMachine({
  engine,
  vfx,
  timelineCanvas,
  videoEl,
  imageEl,
  mediaKindGetter: () => state.mediaKind ?? 'audio',
});
state.sus = sus;

// ---------- tiny helpers ----------

function toast(msg, ms = 3500) {
  try {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toastsEl.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 700); // fallback (reduced-motion kills animations)
    }, ms);
  } catch (err) {
    console.warn('toast failed', err);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const blobExt = (blob) => ((blob?.type || '').includes('mp4') ? 'mp4' : 'webm');

const fmtMB = (bytes) => (bytes / 1048576).toFixed(1);

function readToggles() {
  const toggles = {};
  for (const key of TOGGLE_KEYS) toggles[key] = !!$(`tgl-${key}`)?.checked;
  return toggles;
}

// Resolve on okEvent (true) or failEvent/timeout (false). Never rejects.
function waitForEvent(target, okEvent, failEvent, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeEventListener(okEvent, onOk);
      target.removeEventListener(failEvent, onFail);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onFail = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    target.addEventListener(okEvent, onOk, { once: true });
    target.addEventListener(failEvent, onFail, { once: true });
  });
}

// ---------- teardown ----------

function teardown() {
  try { conductor.stop(); } catch (err) { console.warn(err); }
  state.susActive = false;
  try { sus.deactivate(); } catch (err) { console.warn(err); }
  try { sus.setRecording(false); } catch (err) { console.warn(err); }
  try { sus.resetForMedia(); } catch (err) { console.warn(err); }
  if (state.susRecording) {
    susRecordGen += 1;
    state.susRecording = false;
    susRecordBtn.disabled = false;
    susStopBtn.disabled = true;
    tabPoopBtn.disabled = false;
    try { exporter.stop()?.catch?.((err) => console.warn(err)); } catch (err) { console.warn(err); }
  }
  try { engine.stopAll(); } catch (err) { console.warn(err); }
  try { engine.setEarrape(false); } catch (err) { console.warn(err); }
  try { engine.setBuffer(null); } catch (err) { console.warn(err); }
  try { vfx.resetLastFrame(); } catch (err) { console.warn(err); }
  try { vfx.fitToSource(0, 0, liteEl?.checked ? 720 : 1280); } catch (err) { console.warn(err); } // back to 16:9
  try { videoEl.pause(); } catch (err) { console.warn(err); }
  videoEl.removeAttribute('src');
  try { videoEl.load(); } catch (err) { console.warn(err); }
  imageEl.removeAttribute('src');
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  state.currentEdit = null;
  seedLabel.textContent = '';
  progressEl.value = 0;
}

// ---------- tabs ----------

function showPoopTab() {
  tabPoopBtn.classList.add('active');
  tabSusBtn.classList.remove('active');
  tabPoopBtn.setAttribute('aria-selected', 'true');
  tabSusBtn.setAttribute('aria-selected', 'false');
  poopPanel.hidden = false;
  susPanel.hidden = true;
  if (state.susActive) {
    state.susActive = false;
    try { sus.deactivate(); } catch (err) { console.warn(err); }
  }
}

function showSusTab() {
  tabPoopBtn.classList.remove('active');
  tabSusBtn.classList.add('active');
  tabPoopBtn.setAttribute('aria-selected', 'false');
  tabSusBtn.setAttribute('aria-selected', 'true');
  poopPanel.hidden = true;
  susPanel.hidden = false;
  try { conductor.stop(); } catch (err) { console.warn(err); }
  if (!state.susActive) {
    state.susActive = true;
    try { sus.activate(); } catch (err) { console.warn(err); }
  }
}

// ---------- loading matrix ----------

async function loadVideo(file, current) {
  state.objectUrl = URL.createObjectURL(file);
  const metaPromise = waitForEvent(videoEl, 'loadedmetadata', 'error');
  videoEl.src = state.objectUrl;
  try { videoEl.load(); } catch (err) { console.warn(err); }
  const decodePromise = engine.decodeFile(file); // reads file.arrayBuffer() independently
  const metaOk = await metaPromise;
  const decoded = await decodePromise;
  if (!current() || !metaOk) return false;
  if (decoded) {
    engine.setBuffer(decoded);
  } else {
    toast(t('toast.noAudioTrack'));
    const robo = await engine.renderRoboVoice('no audio no audio no audio aaaaaa');
    if (!current()) return false;
    engine.setBuffer(robo);
  }
  return true;
}

async function loadAudio(file, current) {
  const decoded = await engine.decodeFile(file);
  if (!current()) return false;
  if (!decoded) {
    toast(t('toast.audioDecodeFail'));
    return false;
  }
  engine.setBuffer(decoded);
  return true;
}

async function loadImage(file, current) {
  state.objectUrl = URL.createObjectURL(file);
  const loadPromise = waitForEvent(imageEl, 'load', 'error');
  imageEl.src = state.objectUrl;
  const ok = await loadPromise;
  if (!current() || !ok) return false;
  const baseName = (file.name || 'a mystery').replace(/\.\w+$/, '');
  const robo = await engine.renderRoboVoice(`behold. an image. ${baseName} aaaaa`);
  if (!current()) return false;
  engine.setBuffer(robo);
  return true;
}

async function loadFile(file) {
  if (!file) return;
  if (state.exporting || state.susRecording) {
    toast(t(state.susRecording ? 'toast.susRecordingBusy' : 'toast.recordingBusy'));
    return;
  }
  const mime = file.type || '';
  const kind = mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
      : mime.startsWith('image/') ? 'image'
        : null;
  if (!kind) {
    toast(t('toast.notMedia'));
    return;
  }

  teardown(); // replacing media = full teardown first
  state.mediaKind = null;
  appEl.hidden = true;
  dropzoneEl.hidden = false;
  const gen = ++loadGen;
  const current = () => gen === loadGen;

  let ok = false;
  try {
    if (kind === 'video') ok = await loadVideo(file, current);
    else if (kind === 'audio') ok = await loadAudio(file, current);
    else ok = await loadImage(file, current);
  } catch (err) {
    console.warn('load failed', err);
    ok = false;
  }

  if (!current()) return; // superseded by eject or a newer load

  if (!ok) {
    failedLoadReset();
    toast(t('toast.loadFail'));
    return;
  }

  state.mediaKind = kind;
  onMediaLoaded();
}

// A failed replacement load can't roll back (the old media is already torn
// down) — finish the job into a clean "nothing loaded" state instead of
// leaving a zombie (stale audio buffer + interactive UI with no visuals).
function failedLoadReset() {
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  videoEl.removeAttribute('src');
  imageEl.removeAttribute('src');
  try { engine.setBuffer(null); } catch (err) { console.warn(err); }
  showPoopTab();
  appEl.hidden = true;
  dropzoneEl.hidden = false;
}

// The stage takes on the media's own shape, so a vertical video fills a
// vertical frame instead of being cropped to a horizontal sliver. Only ever
// called on load/teardown — resizing the canvas mid-recording would change
// the captureStream track size.
function applyStageSize() {
  // Lite mode halves the stage's long edge: a 720-wide canvas is ~3x cheaper to
  // fill than 1280, which is what actually rescues playback on a tired phone.
  const maxLong = liteEl?.checked ? 720 : 1280;
  try {
    if (state.mediaKind === 'video' && videoEl.videoWidth > 0) {
      vfx.fitToSource(videoEl.videoWidth, videoEl.videoHeight, maxLong);
    } else if (state.mediaKind === 'image' && imageEl.naturalWidth > 0) {
      vfx.fitToSource(imageEl.naturalWidth, imageEl.naturalHeight, maxLong);
    } else {
      vfx.fitToSource(0, 0, maxLong); // audio / no video track => 16:9
    }
  } catch (err) {
    console.warn('stage sizing failed', err);
  }
}

function onMediaLoaded() {
  dropzoneEl.hidden = true;
  appEl.hidden = false;
  showPoopTab();
  applyStageSize();
  toast(t('toast.loaded'));
  // Auto-generate a first edit, but never auto-play (autoplay policies).
  if (engine.duration > 0) {
    try { makeEdit(); } catch (err) { console.warn('auto-generate failed', err); }
  }
  toast(t('toast.pressPoop'), 4500);
}

// ---------- poop / re-poop / stop / export ----------

const captionLang = () => $('caption-lang')?.value || 'en';

// '5' | '10' | '20' | '45' | 'full' — how long the generated poop runs.
function readMaxOut() {
  const raw = lengthEl?.value ?? '20';
  if (raw === 'full') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function makeEdit() {
  const chaos = Math.min(11, Math.max(1, Number(chaosEl.value) || 7));
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  const edit = generateEDL({
    duration: engine.duration, chaos, seed, toggles: readToggles(), maxOut: readMaxOut(),
  });
  state.currentEdit = edit;
  conductor.captionLang = captionLang();
  conductor.load(edit);
  seedLabel.textContent = t('seed', { seed: edit.seed });
  progressEl.value = 0;
  return edit;
}

async function poopIt() {
  if (state.exporting) return;
  if (state.susRecording) {
    toast(t('toast.susRecordingBusy'));
    return;
  }
  if (engine.duration === 0) {
    toast(t('toast.loadSoundFirst'));
    return;
  }
  try { conductor.stop(); } catch (err) { console.warn(err); }
  try {
    makeEdit();
  } catch (err) {
    console.warn('generateEDL failed', err);
    toast(t('toast.generatorJam'));
    return;
  }
  try {
    await conductor.play();
  } catch (err) {
    console.warn('play failed', err);
    toast(t('toast.audioNoStart'));
  }
}

function setExportUI(on) {
  poopBtn.disabled = on;
  rerollBtn.disabled = on;
  exportBtn.disabled = on;
  ejectBtn.disabled = on;
  tabSusBtn.disabled = on;
  exportBtn.textContent = t(on ? 'btn.exportBusy' : 'btn.export');
  // #stop-btn stays enabled: it ends playback, which finishes the recording early.
}

async function exportEdit() {
  if (state.exporting) return;
  if (state.susRecording) {
    toast(t('toast.susRecordingBusy'));
    return;
  }
  if (!state.currentEdit) {
    toast(t('toast.poopFirst'));
    return;
  }
  try { conductor.stop(); } catch (err) { console.warn(err); }
  state.exporting = true;
  setExportUI(true);
  try {
    if (!await engine.ensureRunning()) throw new Error('AudioContext could not be started');
    exporter.start();
    conductor.captionLang = captionLang();
    conductor.load(state.currentEdit);
    await conductor.play(); // resolves on 'ended' (natural end OR stop-btn)
    const blob = await exporter.stop();
    if (!blob.size) throw new Error('Recorder produced an empty file');
    downloadBlob(blob, `ytp-${state.currentEdit.seed}.${blobExt(blob)}`);
    toast(t('toast.exportDone', { mb: fmtMB(blob.size), ext: blobExt(blob) }));
  } catch (err) {
    console.warn('export failed', err);
    toast(t('toast.exportFail'));
    try {
      await exporter.stop();
    } catch (_) { /* recorder already dead */ }
  } finally {
    state.exporting = false;
    setExportUI(false);
  }
}

// ---------- sus recording (reuses Exporter) ----------

async function startSusRecording() {
  if (state.susRecording || state.exporting) return;
  const gen = ++susRecordGen;
  // Claim the state BEFORE any await so load/export/eject guards see it, but
  // keep Stop disabled until a recorder really exists.
  state.susRecording = true;
  susRecordBtn.disabled = true;
  susStopBtn.disabled = true;
  tabPoopBtn.disabled = true; // keep the stop button reachable while recording
  try {
    const running = await engine.ensureRunning();
    if (gen !== susRecordGen || !state.susRecording) return;
    if (!running) throw new Error('AudioContext could not be started');
    exporter.start();
    if (gen !== susRecordGen || !state.susRecording) {
      try { await exporter.stop(); } catch (_) { /* canceled startup cleanup */ }
      return;
    }
    susStopBtn.disabled = false;
    try { sus.setRecording(true); } catch (err) { console.warn(err); }
    toast(t('toast.recStart'));
  } catch (err) {
    console.warn('sus recording failed to start', err);
    if (gen !== susRecordGen) return;
    toast(t('toast.recNo'));
    state.susRecording = false; // roll back the claim
    susRecordBtn.disabled = false;
    susStopBtn.disabled = true;
    tabPoopBtn.disabled = false;
  }
}

async function stopSusRecording() {
  if (!state.susRecording) return;
  const gen = ++susRecordGen; // cancel a start still waiting on AudioContext
  susStopBtn.disabled = true;
  susRecordBtn.disabled = true;
  try {
    const blob = await exporter.stop();
    if (!blob.size) throw new Error('Recorder produced an empty file');
    downloadBlob(blob, `sus-performance.${blobExt(blob)}`);
    toast(t('toast.susSaved', { mb: fmtMB(blob.size) }));
  } catch (err) {
    console.warn('sus recording failed to stop', err);
    toast(t('toast.susSaveFail'));
  } finally {
    if (gen === susRecordGen) {
      state.susRecording = false;
      susRecordBtn.disabled = false;
      susStopBtn.disabled = true;
      tabPoopBtn.disabled = false;
      try { sus.setRecording(false); } catch (err) { console.warn(err); }
    }
  }
}

// ---------- idle stage renderer ----------
// Keeps #stage painted whenever neither the conductor is playing nor sus is
// active — captureStream needs a continuously-painted canvas, and the app
// should never show a dead black box.

let idleWarned = false;

function idleFrame(nowMs) {
  requestAnimationFrame(idleFrame);
  let playing = false;
  try { playing = !!conductor.isPlaying; } catch (_) { playing = false; }
  if (playing || state.susActive) return;
  let source = null;
  if (state.mediaKind === 'video') source = videoEl;
  else if (state.mediaKind === 'image' && imageEl.complete && imageEl.naturalWidth > 0) source = imageEl;
  try {
    vfx.draw(source, {}, nowMs / 1000);
  } catch (err) {
    if (!idleWarned) {
      idleWarned = true;
      console.warn('idle draw failed', err);
    }
  }
}

requestAnimationFrame(idleFrame);

// ---------- chaos slider ----------

function updateChaosLabel() {
  const v = Number(chaosEl.value);
  chaosLabel.textContent = v === 11 ? t('chaos.max') : String(v);
  document.body.classList.toggle('maxchaos', v === 11);
}

chaosEl.addEventListener('input', updateChaosLabel);
updateChaosLabel();

// ---------- wiring ----------

poopBtn.addEventListener('click', poopIt);
rerollBtn.addEventListener('click', poopIt); // identical on purpose — it's funny to have both
stopBtn.addEventListener('click', () => {
  try { conductor.stop(); } catch (err) { console.warn(err); }
});
exportBtn.addEventListener('click', exportEdit);

conductor.addEventListener('progress', (e) => {
  const { tNow, totalOut } = e.detail || {};
  if (totalOut > 0) progressEl.value = Math.min(1, Math.max(0, tNow / totalOut));
});

tabPoopBtn.addEventListener('click', showPoopTab);
tabSusBtn.addEventListener('click', () => {
  if (state.mediaKind === 'image' && engine.duration === 0) {
    toast(t('toast.susNeedsAudio'));
    return;
  }
  showSusTab();
});

ejectBtn.addEventListener('click', () => {
  if (state.exporting) return;
  if (state.susRecording) {
    toast(t('toast.stopSusFirst'));
    return;
  }
  teardown();
  loadGen += 1; // invalidate any in-flight load
  state.mediaKind = null;
  showPoopTab();
  appEl.hidden = true;
  dropzoneEl.hidden = false;
  toast(t('toast.ejected'));
});

susRecordBtn.addEventListener('click', startSusRecording);
susStopBtn.addEventListener('click', stopSusRecording);

$('sus-play')?.addEventListener('click', () => {
  try { sus.togglePlay(); } catch (err) { console.warn(err); }
});

// Sus-machine keys: space = play/pause, ←/→ = scratch (Shift = coarse jump).
// Never hijack typing or a focused control.
const NUDGE_FINE_SEC = 0.1;
const NUDGE_COARSE_SEC = 1;

document.addEventListener('keydown', (e) => {
  if (!state.susActive) return;
  if (e.code !== 'Space' && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
    || t.tagName === 'BUTTON' || t.isContentEditable)) return;
  e.preventDefault();
  try {
    if (e.code === 'Space') {
      sus.togglePlay();
      return;
    }
    const step = e.shiftKey ? NUDGE_COARSE_SEC : NUDGE_FINE_SEC;
    sus.nudge(e.code === 'ArrowLeft' ? -step : step);
  } catch (err) {
    console.warn(err);
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = ''; // allow re-picking the same file
  loadFile(file);
});

// ---------- drag & drop (document level; works even when #app is visible) ----------

let dragDepth = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add('dragging');
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dragging');
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

// ---------- first-gesture audio unlock ----------

document.addEventListener('pointerdown', () => {
  engine.ensureRunning();
}, { once: true, capture: true });

// ---------- length / lite / language ----------

lengthEl?.addEventListener('change', () => {
  if (lengthEl.value !== 'full') return;
  const secs = Math.round(engine.duration);
  if (secs > 60) toast(t('toast.longRisk', { seconds: secs }), 5000);
});

liteEl?.addEventListener('change', () => {
  // Never resize the canvas mid-capture: captureStream's track size is fixed
  // when recording starts.
  if (state.exporting || state.susRecording) {
    liteEl.checked = !liteEl.checked;
    toast(t('toast.recordingBusy'));
    return;
  }
  if (state.mediaKind) applyStageSize();
});

// Phones and low-core machines start in lite mode; it's the difference between
// smooth playback and a slideshow, and it can always be switched off.
if (liteEl && (window.innerWidth <= 700 || (navigator.hardwareConcurrency || 8) <= 4)) {
  liteEl.checked = true;
}

function syncLangUI() {
  const lang = getLang();
  document.documentElement.lang = lang;
  for (const opt of langSwitch?.querySelectorAll('.lang-opt') || []) {
    const on = opt.dataset.lang === lang;
    opt.classList.toggle('active', on);
    opt.setAttribute('aria-pressed', String(on));
  }
  applyTo(document);
  // Labels that JS owns rather than the DOM have to be re-rendered by hand.
  updateChaosLabel();
  setExportUI(state.exporting);
  try { sus.syncLabels(); } catch (err) { console.warn(err); }
  if (state.currentEdit) seedLabel.textContent = t('seed', { seed: state.currentEdit.seed });
}

langSwitch?.addEventListener('click', (e) => {
  const opt = e.target.closest?.('.lang-opt');
  if (opt?.dataset.lang) setLang(opt.dataset.lang);
});

onLangChange(syncLangUI);
initLang();
syncLangUI();

// Console toy for power users (and debugging): poke the machine directly.
window.YTP = { engine, vfx, conductor, sus, exporter, state };
