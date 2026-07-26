// i18n.js — EN/RU string tables + lookup / DOM-apply layer for YTP-O-MATIC 9000. English is the fallback source of truth; nothing here ever throws.

export const LANGS = ['en', 'ru'];

const STORAGE_KEY = 'ytp-lang';
const DEFAULT_LANG = 'en';

// ---------- tables ----------
// Keys are flat dotted strings, values are plain text with {name} placeholders.
// Keep EN and RU key-for-key identical (the regression harness checks this) and
// keep the placeholder tokens byte-identical between the two.

export const EN = {
  // chrome / layout
  'tagline': 'THE MIRACLE NOBODY ASKED FOR ★ 100% ARTIFICIAL STUPIDITY ★ NO REFUNDS ★ POOP RESPONSIBLY ★ AS SEEN ON THE INTERNET ★ ZERO STARS ON YELP ★',
  'drop.title': 'DROP A VIDEO / AUDIO / IMAGE HERE',
  'drop.browse': '…or click to browse',
  'tab.poop': '💩 POOP MACHINE',
  'tab.sus': '📼 SUS MACHINE',
  'btn.eject': '⏏ EJECT',

  // poop panel
  'label.chaos': 'CHAOS',
  'chaos.max': '11 (WHY.)',
  'label.length': 'LENGTH',
  'length.full': 'FULL ⚠',
  'label.captionLang': '🗣 captions in',
  'tgl.stutter': '✂️ stutter',
  'tgl.reverse': '⏪ reverse',
  'tgl.speed': '🐇 speed',
  'tgl.pitch': '🎹 pitch',
  'tgl.earrape': '🔊 earrape (⚠ actually loud)',
  'tgl.jumpcuts': '✈️ jumpcuts',
  'tgl.visuals': '🌈 visuals',
  'tgl.captions': '💬 captions',
  'tgl.lite': '⚡ lite (easier on phones)',
  'btn.poop': '💩 POOP IT',
  'btn.reroll': '🎲 RE-POOP',
  'btn.stop': '🛑 STOP',
  'btn.export': '📼 RECORD & DOWNLOAD',
  'btn.exportBusy': '🔴 RECORDING… (watch it cook)',
  'seed': 'seed: {seed}',

  // sus panel
  'sus.instructions': "scrub the timeline with your mouse. stop moving = get stuck. press ▶ (or space) to just let it play — grab it mid-play to scratch. it's art.",
  'sus.play': '▶ PLAY',
  'sus.pause': '⏸ PAUSE',
  'sus.syncing': '⏳ SYNCING…',
  'sus.clean': '🧼 clean scroll (no pitch warp)',
  'sus.latch': '🔒 latch loop on release',
  'sus.record': '🔴 RECORD PERFORMANCE',
  'sus.stopDownload': '⏹ STOP & DOWNLOAD',

  // toasts
  'toast.loaded': '✅ LOADED. NOW POOP IT.',
  'toast.pressPoop': 'press 💩',
  'toast.noAudioTrack': 'no audio track I can chew — video will be SILENT chaos',
  'toast.audioDecodeFail': '💀 could not decode that audio. it defeated me.',
  'toast.notMedia': '🤨 not a video, audio, or image. what IS that.',
  'toast.loadFail': '💥 could not load that file. it fought back and won.',
  'toast.recordingBusy': '⏳ hold on — a recording is cooking',
  'toast.susRecordingBusy': '🔴 a sus performance is still recording — stop it first.',
  'toast.stopSusFirst': '🔴 stop the sus recording first.',
  'toast.loadSoundFirst': 'load something with sound first 💀',
  'toast.generatorJam': '💥 the generator jammed. try again.',
  'toast.audioNoStart': '🔇 audio could not start. click once and try again.',
  'toast.poopFirst': 'poop first.',
  'toast.exportDone': '💾 {mb} MB of pure damage (.{ext} — post it anywhere)',
  'toast.exportFail': '💥 export imploded. try again.',
  'toast.recStart': '🔴 recording the performance. go nuts.',
  'toast.recNo': '💥 recorder said no.',
  'toast.susSaved': '💾 {mb} MB of certified sus',
  'toast.susSaveFail': '💥 could not save the recording.',
  'toast.susNeedsAudio': '🚫 sus machine needs audio and this image somehow has none.',
  'toast.ejected': '⏏ ejected. feed me something new.',
  'toast.longRisk': '⚠ FULL length on a {seconds}s video — this may choke a phone.',
};

// RU is deliberately shitposter-register, not dictionary-register: "poop" is the
// пук family throughout (ПУК-МАШИНА / ПУКНУТЬ / ПЕРЕПУК), "sus" stays сус like
// the CAPTIONS_RU pool, and Yelp becomes Яндекс Карты because nobody here has
// heard of Yelp. Translations are kept at or under the English length — these
// are buttons and chips in a cramped mobile row.
export const RU = {
  // chrome / layout
  'tagline': 'ЧУДО, О КОТОРОМ НИКТО НЕ ПРОСИЛ ★ 100% ИСКУССТВЕННАЯ ТУПОСТЬ ★ ВОЗВРАТА НЕТ ★ ПУКАЙ ОТВЕТСТВЕННО ★ КАК В ТЕЛЕМАГАЗИНЕ, ТОЛЬКО В ИНТЕРНЕТЕ ★ НОЛЬ ЗВЁЗД НА ЯНДЕКС КАРТАХ ★',
  'drop.title': 'БРОСЬ СЮДА ВИДЕО / АУДИО / КАРТИНКУ',
  'drop.browse': '…или тыкни, чтобы выбрать',
  'tab.poop': '💩 ПУК-МАШИНА',
  'tab.sus': '📼 СУС-МАШИНА',
  'btn.eject': '⏏ ИЗВЛЕЧЬ',

  // poop panel
  'label.chaos': 'ХАОС',
  'chaos.max': '11 (ЗАЧЕМ.)',
  'label.length': 'ДЛИНА',
  'length.full': 'ВСЁ ⚠',
  'label.captionLang': '🗣 субтитры на',
  'tgl.stutter': '✂️ заика',
  'tgl.reverse': '⏪ реверс',
  'tgl.speed': '🐇 разгон',
  'tgl.pitch': '🎹 питч',
  'tgl.earrape': '🔊 уши в фарш (⚠ и правда громко)',
  'tgl.jumpcuts': '✈️ склейки',
  'tgl.visuals': '🌈 визуал',
  'tgl.captions': '💬 субтитры',
  'tgl.lite': '⚡ лайт (телефону легче)',
  'btn.poop': '💩 ПУКНУТЬ',
  'btn.reroll': '🎲 ПЕРЕПУК',
  'btn.stop': '🛑 СТОП',
  'btn.export': '📼 ЗАПИСАТЬ И СКАЧАТЬ',
  'btn.exportBusy': '🔴 ПИШУ… (смотри, как варится)',
  'seed': 'сид: {seed}',

  // sus panel
  'sus.instructions': 'води мышкой по таймлайну. замер = залип. жми ▶ (или пробел), чтобы просто играло — хватай на ходу и скретчи. это искусство.',
  'sus.play': '▶ ПУСК',
  'sus.pause': '⏸ ПАУЗА',
  'sus.syncing': '⏳ СИНХРОН…',
  'sus.clean': '🧼 чистый скролл (без питча)',
  'sus.latch': '🔒 луп при отпускании',
  'sus.record': '🔴 ЗАПИСАТЬ СЕТ',
  'sus.stopDownload': '⏹ СТОП И СКАЧАТЬ',

  // toasts
  'toast.loaded': '✅ ЗАГРУЖЕНО. ТЕПЕРЬ ПУКНИ.',
  'toast.pressPoop': 'жми 💩',
  'toast.noAudioTrack': 'звука тут нечего жевать — будет БЕЗЗВУЧНЫЙ хаос',
  'toast.audioDecodeFail': '💀 не смог раскодировать этот звук. он меня победил.',
  'toast.notMedia': '🤨 это не видео, не аудио и не картинка. что ЭТО.',
  'toast.loadFail': '💥 не смог открыть файл. он сопротивлялся и победил.',
  'toast.recordingBusy': '⏳ погоди — запись ещё варится',
  'toast.susRecordingBusy': '🔴 сус-сет ещё пишется — сначала останови его.',
  'toast.stopSusFirst': '🔴 сначала останови сус-запись.',
  'toast.loadSoundFirst': 'сначала загрузи что-нибудь со звуком 💀',
  'toast.generatorJam': '💥 генератор заклинило. попробуй ещё.',
  'toast.audioNoStart': '🔇 звук не запустился. тыкни один раз и попробуй снова.',
  'toast.poopFirst': 'сначала пукни.',
  'toast.exportDone': '💾 {mb} МБ чистого урона (.{ext} — заливай куда угодно)',
  'toast.exportFail': '💥 экспорт схлопнулся. попробуй ещё.',
  'toast.recStart': '🔴 пишу сет. отрывайся.',
  'toast.recNo': '💥 рекордер сказал нет.',
  'toast.susSaved': '💾 {mb} МБ отборного суса',
  'toast.susSaveFail': '💥 не смог сохранить запись.',
  'toast.susNeedsAudio': '🚫 сус-машине нужен звук, а у этой картинки его почему-то нет.',
  'toast.ejected': '⏏ извлёк. покорми меня чем-то новым.',
  'toast.longRisk': '⚠ длина ВСЁ на {seconds}-секундном видео — телефон может подавиться.',
};

export const STRINGS = { en: EN, ru: RU };

const TOKEN_RE = /\{(\w+)\}/g;

let current = DEFAULT_LANG;
const warned = new Set();    // keys already complained about (one warn per key, ever)
const listeners = new Set(); // onLangChange callbacks

const isLang = (lang) => typeof lang === 'string' && LANGS.includes(lang);

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

// Fill {name} tokens from vars. An unknown/nullish var leaves its token visible
// on purpose — a stray "{mb}" in a toast is a readable bug, "undefined" is not.
function substitute(str, vars) {
  if (!vars || typeof vars !== 'object') return str;
  return str.replace(TOKEN_RE, (token, name) => {
    const value = vars[name];
    return value == null ? token : String(value);
  });
}

// Raw string for `key` in the current lang, else English, else null. The typeof
// guard also keeps inherited junk ('constructor', '__proto__') out of the UI.
function lookup(key) {
  if (typeof key !== 'string' || !key) return null;
  const table = STRINGS[current] || EN;
  if (typeof table[key] === 'string') return table[key];
  if (typeof EN[key] === 'string') {
    warnOnce(key, `i18n: no ${current} string for "${key}" — falling back to English`);
    return EN[key];
  }
  warnOnce(key, `i18n: missing key "${key}"`);
  return null;
}

// ---------- language state ----------

export function getLang() {
  return current;
}

function readSaved() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLang(saved) ? saved : null;
  } catch (err) {
    console.warn('i18n: localStorage unreadable', err);
    return null;
  }
}

// Only navigator.language decides (not the whole languages list) — an en-US
// user with Russian further down their list still gets the English UI.
function detect() {
  try {
    const nav = globalThis.navigator;
    const tag = typeof nav?.language === 'string' ? nav.language : nav?.languages?.[0];
    if (typeof tag === 'string' && tag.toLowerCase().startsWith('ru')) return 'ru';
  } catch (err) {
    console.warn('i18n: language detection failed', err);
  }
  return DEFAULT_LANG;
}

// Keep <html lang> honest: screen readers and hyphenation both read it.
function markDocument(lang) {
  try {
    globalThis.document?.documentElement?.setAttribute('lang', lang);
  } catch (err) {
    console.warn('i18n: could not set document lang', err);
  }
}

// Unknown values are ignored (the current lang survives). Always notifies, even
// when the lang is unchanged, so a re-render is never silently skipped.
export function setLang(lang) {
  if (!isLang(lang)) {
    console.warn('i18n: ignoring unknown lang', lang);
    return current;
  }
  current = lang;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch (err) {
    console.warn('i18n: could not persist lang', err);
  }
  markDocument(current);
  for (const fn of [...listeners]) {
    try {
      fn(current);
    } catch (err) {
      console.warn('i18n: lang listener failed', err);
    }
  }
  return current;
}

// Startup: saved choice wins, else the browser language, else English. Does not
// fire onLangChange — nothing has rendered yet when this runs.
export function initLang() {
  current = readSaved() || detect();
  markDocument(current);
  return current;
}

export function onLangChange(fn) {
  if (typeof fn !== 'function') {
    console.warn('i18n: onLangChange needs a function', fn);
    return () => {};
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- lookup ----------

export function t(key, vars) {
  try {
    const raw = lookup(key);
    if (raw == null) return typeof key === 'string' ? key : '';
    return substitute(raw, vars);
  } catch (err) {
    console.warn('i18n: t failed', key, err);
    return typeof key === 'string' ? key : '';
  }
}

// ---------- DOM ----------

const TARGETS = [
  ['data-i18n', (el, text) => { el.textContent = text; }],
  ['data-i18n-html', (el, text) => { el.innerHTML = text; }],
  ['data-i18n-ph', (el, text) => { el.setAttribute('placeholder', text); }],
  ['data-i18n-title', (el, text) => { el.setAttribute('title', text); }],
];

// querySelectorAll skips the root itself, so check it separately — applyTo(el)
// on a single localized node has to work.
function collect(scope, selector) {
  const out = [];
  try {
    if (typeof scope.matches === 'function' && scope.matches(selector)) out.push(scope);
    out.push(...scope.querySelectorAll(selector));
  } catch (err) {
    console.warn('i18n: could not query', selector, err);
  }
  return out;
}

// Localizes `root` (default: the whole document) in place; returns how many
// nodes were touched. Elements whose key has no string are left exactly as the
// HTML wrote them — blanking the UI is worse than showing the wrong language.
export function applyTo(root) {
  const scope = root || globalThis.document;
  if (!scope || typeof scope.querySelectorAll !== 'function') {
    console.warn('i18n: applyTo needs a document or element', root);
    return 0;
  }
  let applied = 0;
  for (const [attr, set] of TARGETS) {
    for (const el of collect(scope, `[${attr}]`)) {
      try {
        const raw = lookup(el.getAttribute(attr));
        if (raw == null) continue;
        set(el, raw);
        applied += 1;
      } catch (err) {
        console.warn('i18n: could not localize element', err);
      }
    }
  }
  return applied;
}
