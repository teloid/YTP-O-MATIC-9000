// ytp-generator.js — seeded EDL generation (generateEDL), live playback conductor (Conductor), and canvas+audio recording (Exporter) for YTP-O-MATIC 9000.

import { CAPTIONS, CAPTIONS_RU } from './visual-fx.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// A source node's real playback speed is rate * 2^(detune/1200); every piece
// of timeline math must use this or detuned segments drift off their slots.
const effectiveRate = (rate, detune) =>
  (rate || 1) * Math.pow(2, (detune || 0) / 1200);
const lerp = (a, b, t) => a + (b - a) * t;

// VisualFX accepts zoom in 0.05..8, but a watchable poop lives in 1.0..2.0 —
// generated zooms stay inside the practical band, the hard range is only the
// final safety clamp on interpolated values.
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;
const ZOOM_PRACTICAL = 2;

// Output length budget. DEFAULT_MAX_OUT is the historical ceiling and stays the
// default so callers that never ask for a length behave exactly as before;
// MIN_TARGET_OUT keeps a short source from yielding a pointlessly tiny edit.
const DEFAULT_MAX_OUT = 45;
const MIN_TARGET_OUT = 4;
// Shortest source window a trimmed final event may keep; comfortably above the
// audio engine's 10ms degenerate-segment threshold.
const MIN_TRIM_SRC = 0.02;

// Weighted index pick — one rng draw, weights need not be normalized.
function pickWeighted(rng, weights) {
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

// ---------------------------------------------------------------------------
// mulberry32 — standard seeded PRNG, returns () => float in [0, 1)
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = (seed ?? 0) >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// generateEDL — deterministic, chaos-weighted edit decision list
// ---------------------------------------------------------------------------

function pickRate(rng, p) {
  const rates = [0.25, 0.5, 1.5, 2, 3, 4];
  // "wildness" of each rate (distance from normal speed); higher chaos leans wilder.
  const wild = [3, 1, 1, 2, 3, 4];
  return rates[pickWeighted(rng, wild.map((w) => 1 + w * p * 1.5))];
}

// Zoom comes in five flavors: the original static hold, plus four ANIMATED ones
// the Conductor interpolates per frame (zoomFrom -> zoomTo, see zoomAtProgress).
// Animated flavors emit no static `zoom` at all. Travel scales with chaos p:
// calm edits mostly hold or creep, wild ones punch and pulse.
function rollZoom(rng, p) {
  const cx = rng();
  const cy = rng();
  // Every amount below is written to land inside 1..ZOOM_PRACTICAL on its own;
  // the clamps are a safety net, not the shape of the distribution.
  const flavors = [
    // Static hold: one fixed zoom for the whole event (the classic jump cut).
    () => ({ zoom: clamp(1.15 + rng() * (0.3 + 0.35 * p), 1, ZOOM_PRACTICAL) }),
    // Slow creep in: sits still at the cut, then drifts closer.
    () => ({
      zoomFrom: 1,
      zoomTo: clamp(1.15 + rng() * (0.12 + 0.3 * p), 1, ZOOM_PRACTICAL),
      zoomEase: 'inOut',
    }),
    // Snap out: opens tight on the frame and falls back to full.
    () => ({
      zoomFrom: clamp(1.4 + rng() * (0.15 + 0.35 * p), 1, ZOOM_PRACTICAL),
      zoomTo: 1,
      zoomEase: 'out',
    }),
    // Hard punch in: slams close in the first fraction, then holds.
    () => ({
      zoomFrom: 1,
      zoomTo: clamp(1.5 + rng() * (0.12 + 0.33 * p), 1, ZOOM_PRACTICAL),
      zoomEase: 'out',
    }),
    // Pulse: oscillates between two zooms N whole cycles across the event.
    () => {
      const lo = 1 + rng() * 0.1;
      return {
        zoomFrom: lo,
        zoomTo: clamp(lo + 0.15 + rng() * (0.1 + 0.45 * p), 1, ZOOM_PRACTICAL),
        zoomPulses: 1 + Math.floor(rng() * (2 + Math.round(4 * p))),
      };
    },
  ];
  // Weights mirror the flavor order above: chaos drains the creep and feeds the
  // punches and pulses, the static hold keeps a steady share for variety.
  const weights = [2, 3 - 1.5 * p, 1.5 + 1.5 * p, 0.5 + 3 * p, 0.5 + 2.5 * p];
  return { ...flavors[pickWeighted(rng, weights)](), zoomCx: cx, zoomCy: cy };
}

function rollFx(rng, p) {
  const fx = {};
  const builders = [
    () => { fx.invert = 1; },
    () => { fx.hue = [90, 180, 270][Math.floor(rng() * 3)]; },
    () => { fx.saturate = 3; },
    () => { Object.assign(fx, rollZoom(rng, p)); },
    () => { fx.shake = 4 + rng() * 10; },
    () => { if (rng() < 0.15) fx.mirror = true; },
    () => { if (rng() < 0.2) fx.rainbow = true; },
    () => { fx.rgbSplit = 2 + rng() * 4; },
  ];
  const n = 1 + Math.floor(rng() * 3); // 1..3 effects
  const order = builders.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 0; i < n; i++) builders[order[i]]();
  return fx;
}

export function generateEDL({
  duration,
  chaos,
  seed,
  toggles,
  maxOut = DEFAULT_MAX_OUT,
} = {}) {
  const cleanSeed = (seed ?? 0) >>> 0;
  const rng = mulberry32(cleanSeed);
  const tgl = toggles || {};
  const c = clamp(Number(chaos) || 1, 1, 11);
  const p = c / 11;
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;

  // maxOut is the requested OUTPUT length in seconds. Anything non-finite
  // (Infinity, null, garbage) means "as long as the source" — the caller's
  // explicit at-your-own-risk choice, since a long source then makes a long,
  // heavy edit. A non-positive cap is nonsense, so warn and use the default.
  let outCap = Number(maxOut ?? Infinity);
  if (!Number.isFinite(outCap)) {
    outCap = Infinity;
  } else if (outCap <= 0) {
    console.warn('generateEDL: maxOut must be positive, using default', maxOut);
    outCap = DEFAULT_MAX_OUT;
  }

  const events = [];
  let tOut = 0;

  if (dur <= 0) {
    console.warn('generateEDL: bad/zero source duration, producing minimal edit');
  } else {
    // Play the whole source, bounded by the requested cap. The floor steps
    // aside when the caller asked for a poop shorter than the floor itself, so
    // the cap always wins; dur is finite here, so targetOut is too even when
    // outCap is Infinity.
    const targetOut = clamp(dur, Math.min(MIN_TARGET_OUT, outCap), outCap);
    const minDur = lerp(0.9, 0.15, p);
    const maxDur = lerp(2.2, 0.6, p);
    let cursor = rng() * dur;
    let guard = 0;

    while (tOut < targetOut && guard++ < 4000) {
      // Jumpcut teleport vs sequential advance (cursor already sits just past
      // the previous segment; wrap when we run off the end of the source).
      if (tgl.jumpcuts && rng() < 0.2 + 0.6 * p) cursor = rng() * dur;
      if (!(cursor >= 0) || cursor >= dur - 0.05) cursor = 0;

      let srcDur = minDur + rng() * (maxDur - minDur);
      let repeat = 1;
      if (tgl.stutter && rng() < 0.25 * p + 0.05) {
        repeat = 2 + Math.floor(rng() * (Math.round(6 * p) + 1));
        srcDur = 0.08 + rng() * 0.32;
      }

      const reverse = !!(tgl.reverse && rng() < 0.25 * p);

      let rate = 1;
      if (tgl.speed && rng() < 0.35 * p) rate = pickRate(rng, p);

      let detune = 0;
      if (tgl.pitch && rng() < 0.3 * p) {
        detune = Math.round((rng() * 2 - 1) * (400 + 2000 * p));
      }

      let gainMul = 1;
      let earrape = false;
      if (tgl.earrape && rng() < 0.06 * p) {
        earrape = true;
        gainMul = 2.5;
        srcDur = Math.min(srcDur, 1);
      }

      srcDur = Math.min(srcDur, dur - cursor);

      let fx = {};
      if (tgl.visuals && rng() < 0.5 * p) fx = rollFx(rng, p);

      // Boolean flag only — Conductor swaps `true` for a CAPTIONS string at load().
      const caption = tgl.captions && rng() < 0.15 + 0.15 * p ? true : null;

      // How much OUTPUT this event fills. An unbounded cap leans on tOut alone
      // to end the loop, so a non-finite slot would both poison totalOut and
      // leave only the guard to stop us — drop the event and keep going.
      const slotOut = (srcDur / effectiveRate(rate, detune)) * repeat;
      if (!Number.isFinite(slotOut) || slotOut <= 0) {
        console.warn('generateEDL: skipping event with unusable length', slotOut);
        continue;
      }

      events.push({
        tOut,
        srcStart: cursor,
        srcDur,
        rate,
        reverse,
        detune,
        gainMul,
        earrape,
        repeat,
        fx,
        caption,
      });

      tOut += slotOut;
      cursor += srcDur;
    }

    // The loop accumulates until it passes the target, so it can overshoot by a
    // whole event — and one event is not small when a 0.25x rate stretches a
    // 1s segment into 4s of output, which turns a "5s" request into nine.
    // Trim the last event back into the budget (or drop it if there's no room).
    if (events.length > 1 && tOut > targetOut) {
      const last = events[events.length - 1];
      const reps = Math.max(1, last.repeat | 0);
      const eff = effectiveRate(last.rate, last.detune);
      const remaining = targetOut - last.tOut;
      const shrunk = (remaining * eff) / reps;
      // MIN_TRIM_SRC stays above the engine's 10ms degenerate-segment floor.
      if (remaining > 0.05 && shrunk >= MIN_TRIM_SRC && shrunk < last.srcDur) {
        last.srcDur = shrunk;
        tOut = last.tOut + remaining;
      } else {
        // Can't make it fit (a heavily slowed segment can't be shortened
        // enough to matter) — drop it rather than blow past the budget.
        events.pop();
        tOut = last.tOut;
      }
    }
  }

  // No tacked-on ending: the edit just stops on its last cut. (A forced white
  // flash + "GET POOPED" card used to live here and read as a dead frame.)
  return { seed: cleanSeed, totalOut: tOut, events };
}

// ---------------------------------------------------------------------------
// Conductor — plays an EDL live: sample-accurate audio scheduling on the
// AudioContext clock, best-effort video driving, vfx drawn every rAF.
// ---------------------------------------------------------------------------

// Easing for animated zooms: 'out' covers most of the distance immediately and
// settles (punches, snap-outs), anything else glides at both ends (creeps).
function easeZoom(x, mode) {
  if (mode === 'out') return 1 - Math.pow(1 - x, 3);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(2 - 2 * x, 3) / 2;
}

// Resolve an animated zoom into the concrete number VisualFX wants, given the
// event's progress (0..1) across its output span. Returns null when the event
// carries no zoom animation, so those events reach VisualFX untouched.
function zoomAtProgress(fx, prog) {
  const from = Number(fx.zoomFrom);
  const to = Number(fx.zoomTo);
  if (!Number.isFinite(from) && !Number.isFinite(to)) return null;
  const a = Number.isFinite(from) ? from : 1;
  const b = Number.isFinite(to) ? to : 1;
  const x = Number.isFinite(prog) ? clamp(prog, 0, 1) : 0;
  const pulses = Math.floor(Number(fx.zoomPulses));
  // Whole cycles of (1 - cos)/2 land back on zoomFrom at prog 1, so a pulse
  // never leaves the next cut mid-swing.
  const w =
    Number.isFinite(pulses) && pulses > 0
      ? (1 - Math.cos(x * pulses * Math.PI * 2)) / 2
      : easeZoom(x, fx.zoomEase);
  const z = lerp(a, b, w);
  return Number.isFinite(z) ? clamp(z, ZOOM_MIN, ZOOM_MAX) : 1;
}

const SCHED_INTERVAL_MS = 50;
// Generous lookahead: hidden tabs throttle timers to >=1s ticks, and audio
// must survive that during a backgrounded RECORD & DOWNLOAD.
const LOOKAHEAD_SEC = 1.5;
const FALLBACK_PAINT_MS = 300;
const START_DELAY_SEC = 0.15;

export class Conductor extends EventTarget {
  constructor({ engine, vfx, videoEl, imageEl, canvas } = {}) {
    super();
    this.engine = engine;
    this.vfx = vfx;
    this.videoEl = videoEl ?? null;
    this.imageEl = imageEl ?? null;
    this.canvas = canvas ?? null;

    this._edit = null;
    this._events = [];
    this._totalOut = 0;
    this.captionLang = 'en'; // 'en' | 'ru' | 'both' — pool used at load()

    this._playing = false;
    this._resolve = null;
    this._t0 = 0;
    this._interval = null;
    this._raf = null;
    this._timeouts = new Set();
    this._earrapeCount = 0;

    this._schedIdx = 0;
    this._evIdx = -1;
    this._repIdx = -1;
    this._pendingSeek = null;
  }

  get isPlaying() {
    return this._playing;
  }

  load(edit) {
    this.stop();
    this._edit = null;
    this._events = [];
    this._totalOut = 0;
    if (!edit || !Array.isArray(edit.events)) {
      console.warn('Conductor.load: invalid edit', edit);
      return;
    }
    // Resolve caption flags to strings, seeded by edit.seed (deterministic,
    // never mutates the caller's edit object).
    const rng = mulberry32((edit.seed ?? 0) >>> 0);
    const pool =
      this.captionLang === 'ru'
        ? CAPTIONS_RU
        : this.captionLang === 'both'
          ? CAPTIONS.concat(CAPTIONS_RU)
          : CAPTIONS;
    this._events = edit.events.map((ev) => {
      const out = { ...ev, fx: ev.fx || {} };
      if (out.caption === true) {
        out.caption = pool.length
          ? pool[Math.floor(rng() * pool.length)]
          : null;
      } else if (typeof out.caption !== 'string') {
        out.caption = null;
      }
      return out;
    });
    if (Number.isFinite(edit.totalOut)) {
      this._totalOut = edit.totalOut;
    } else if (this._events.length) {
      const last = this._events[this._events.length - 1];
      this._totalOut =
        last.tOut +
        (last.srcDur / effectiveRate(last.rate, last.detune)) *
          Math.max(1, last.repeat | 0);
    }
    this._edit = edit;
    this._resetPointers();
  }

  async play() {
    if (this._playing) this.stop();
    const engine = this.engine;
    if (!engine || !engine.ctx) {
      console.warn('Conductor.play: no engine');
      return;
    }
    if (!this._events.length || this._totalOut <= 0) {
      console.warn('Conductor.play: nothing loaded');
      return;
    }

    // Reentrancy guard: two play() calls can overlap across this await (e.g.
    // POOP double-clicked while ctx.resume() wakes a Bluetooth output), and
    // _teardown/stop during it must also cancel us. Generation token wins.
    const gen = (this._playGen = (this._playGen || 0) + 1);
    const running = await engine.ensureRunning();
    if (gen !== this._playGen) return;
    if (!running) throw new Error('AudioContext could not be started');
    if (this._playing) this.stop();

    this._resetPointers();
    this._playing = true;
    this._t0 = engine.ctx.currentTime + START_DELAY_SEC;

    try {
      if (this.videoEl) this.videoEl.muted = true;
    } catch (err) {
      console.warn('Conductor.play: could not mute video', err);
    }

    return new Promise((resolve) => {
      this._resolve = resolve;
      const tick = () => this._schedulerTick();
      this._interval = setInterval(tick, SCHED_INTERVAL_MS);
      tick(); // schedule anything inside the first lookahead window right now
      this._raf = requestAnimationFrame(() => this._frame());
    });
  }

  stop() {
    this._teardown();
  }

  // -- internals ------------------------------------------------------------

  _resetPointers() {
    this._schedIdx = 0;
    this._evIdx = -1;
    this._repIdx = -1;
    this._pendingSeek = null;
    this._earrapeCount = 0;
  }

  _schedulerTick() {
    if (!this._playing) return;
    const engine = this.engine;
    let now;
    try {
      now = engine.ctx.currentTime;
    } catch (err) {
      console.warn('Conductor: scheduler clock read failed', err);
      return;
    }
    const events = this._events;
    while (this._schedIdx < events.length) {
      const ev = events[this._schedIdx];
      const at = this._t0 + ev.tOut;
      if (at > now + LOOKAHEAD_SEC) break;
      this._scheduleAudioEvent(ev, at);
      this._schedIdx++;
    }
    // rAF is fully suspended in hidden tabs; keep the canvas (and any
    // MediaRecorder capture stream) alive at a low rate from this
    // throttle-resistant interval.
    if (performance.now() - (this._lastPaintMs || 0) > FALLBACK_PAINT_MS) {
      this._paintFrame();
    }
    // End-check here too so playback still finishes if rAF is throttled
    // (e.g. background tab).
    if (now - this._t0 >= this._totalOut) this._teardown();
  }

  _scheduleAudioEvent(ev, at) {
    const engine = this.engine;
    const rate = ev.rate || 1;
    const reps = Math.max(1, ev.repeat | 0);
    const repDur = ev.srcDur / effectiveRate(ev.rate, ev.detune);
    for (let k = 0; k < reps; k++) {
      try {
        engine.playSegment({
          start: ev.srcStart,
          duration: ev.srcDur,
          rate,
          reverse: !!ev.reverse,
          when: at + k * repDur,
          detune: ev.detune || 0,
          gainMul: ev.gainMul ?? 1,
        });
      } catch (err) {
        console.warn('Conductor: playSegment failed', err);
      }
    }
    if (ev.earrape) {
      let now = at;
      try {
        now = engine.ctx.currentTime;
      } catch {}
      const onDelay = Math.max(0, (at - now) * 1000);
      const offDelay = Math.max(0, (at + repDur * reps - now) * 1000);
      const onId = setTimeout(() => {
        this._timeouts.delete(onId);
        this._earrapeCount++;
        try {
          engine.setEarrape(true);
        } catch (err) {
          console.warn('Conductor: setEarrape(true) failed', err);
        }
      }, onDelay);
      const offId = setTimeout(() => {
        this._timeouts.delete(offId);
        this._earrapeCount = Math.max(0, this._earrapeCount - 1);
        if (this._earrapeCount === 0) {
          try {
            engine.setEarrape(false);
          } catch (err) {
            console.warn('Conductor: setEarrape(false) failed', err);
          }
        }
      }, offDelay);
      this._timeouts.add(onId);
      this._timeouts.add(offId);
    }
  }

  _pickSource() {
    const v = this.videoEl;
    try {
      // Preserve the source identity while the element is temporarily
      // non-drawable during a seek. VisualFX will reuse its last confirmed
      // frame, and _driveVideo must retain the pending event boundary.
      if (v && (v.currentSrc || v.src)) return v;
    } catch (err) {
      console.warn('Conductor: video source check failed', err);
    }
    const img = this.imageEl;
    try {
      if (img && img.src && img.complete && img.naturalWidth > 0) return img;
    } catch (err) {
      console.warn('Conductor: image source check failed', err);
    }
    return null;
  }

  _frame() {
    if (!this._playing) return;
    this._raf = requestAnimationFrame(() => this._frame());
    this._paintFrame();
  }

  _paintFrame() {
    if (!this._playing) return;
    this._lastPaintMs = performance.now();

    let tNow;
    try {
      tNow = this.engine.ctx.currentTime - this._t0;
    } catch (err) {
      console.warn('Conductor: frame clock read failed', err);
      return;
    }
    const t = Math.max(0, tNow);

    const events = this._events;
    let i = Math.max(0, this._evIdx);
    while (i + 1 < events.length && events[i + 1].tOut <= t) i++;
    const ev = events[i];
    const reps = Math.max(1, ev.repeat | 0);
    const repDur = Math.max(0.001, ev.srcDur / effectiveRate(ev.rate, ev.detune));
    const k = clamp(Math.floor((t - ev.tOut) / repDur), 0, reps - 1);

    const source = this._pickSource();
    if (source === this.videoEl && source !== null) {
      this._driveVideo(ev, i, k);
    } else {
      this._evIdx = i;
      this._repIdx = k;
    }

    // Animated zooms live in the EDL as zoomFrom/zoomTo (+zoomPulses); VisualFX
    // only understands a plain number, so bake this frame's value from the
    // event's progress across its OUTPUT span (one repeat is repDur long).
    const frameFx = { ...ev.fx, caption: ev.caption ?? null };
    const span = repDur * reps;
    const animZoom = zoomAtProgress(frameFx, span > 0 ? (t - ev.tOut) / span : 0);
    if (animZoom !== null) frameFx.zoom = animZoom;

    try {
      this.vfx.draw(source, frameFx, t);
    } catch (err) {
      console.warn('Conductor: vfx.draw failed', err);
    }

    this.dispatchEvent(
      new CustomEvent('progress', {
        detail: { tNow: t, totalOut: this._totalOut, i },
      })
    );

    if (tNow >= this._totalOut) this._teardown();
  }

  _driveVideo(ev, i, k) {
    const v = this.videoEl;
    const changed = i !== this._evIdx || k !== this._repIdx;
    try {
      if (!v || v.readyState < 2) {
        // Not seekable yet — retry the boundary seek on a later frame.
        return;
      }
      v.muted = true;
      if (changed) {
        // Event or stutter-repeat boundary: re-seek. Reverse segments start
        // at their source END so the picture tracks the reversed audio.
        const target = ev.reverse ? ev.srcStart + ev.srcDur : ev.srcStart;
        this._seekVideo(target);
        if (ev.reverse) {
          v.pause();
        } else {
          // Picture chipmunks/slows along with the detuned audio.
          v.playbackRate = clamp(effectiveRate(ev.rate, ev.detune), 0.0625, 16);
          const playP = v.play();
          if (playP && typeof playP.catch === 'function') playP.catch(() => {});
        }
        this._evIdx = i;
        this._repIdx = k;
      } else if (this._pendingSeek !== null && !v.seeking) {
        const target = this._pendingSeek;
        this._pendingSeek = null;
        this._seekVideo(target);
      } else if (ev.reverse && !v.seeking) {
        // Reverse frame-stepping: walk currentTime backwards ~effRate/60 per frame.
        const floorT = Math.max(0, ev.srcStart);
        const next = Math.max(
          floorT,
          (v.currentTime || 0) - effectiveRate(ev.rate, ev.detune) / 60
        );
        v.currentTime = next;
      }
    } catch (err) {
      console.warn('Conductor: video drive failed', err);
      // Mark handled so a broken video element can't spam errors every frame.
      this._evIdx = i;
      this._repIdx = k;
    }
  }

  _seekVideo(target) {
    const v = this.videoEl;
    if (!v || v.readyState < 1) return;
    try {
      if (v.seeking) {
        // Drop-and-replace: at most ONE pending seek, never an unbounded queue.
        this._pendingSeek = target;
        return;
      }
      const cap =
        Number.isFinite(v.duration) && v.duration > 0
          ? Math.max(0, v.duration - 0.033)
          : Math.max(0, target);
      v.currentTime = clamp(target, 0, cap);
    } catch (err) {
      console.warn('Conductor: video seek failed', err);
    }
  }

  _teardown() {
    this._playGen = (this._playGen || 0) + 1; // cancel any play() mid-await
    if (!this._playing) return;
    this._playing = false;

    if (this._interval !== null) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._raf !== null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    for (const id of this._timeouts) clearTimeout(id);
    this._timeouts.clear();
    this._earrapeCount = 0;

    try {
      this.engine?.stopAll();
    } catch (err) {
      console.warn('Conductor: stopAll failed', err);
    }
    try {
      this.engine?.setEarrape(false);
    } catch (err) {
      console.warn('Conductor: setEarrape(false) failed', err);
    }
    try {
      if (this.videoEl) {
        this.videoEl.pause();
        this.videoEl.playbackRate = 1;
      }
    } catch (err) {
      console.warn('Conductor: video pause failed', err);
    }
    this._pendingSeek = null;

    this.dispatchEvent(new CustomEvent('ended'));

    const resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve();
  }
}

// ---------------------------------------------------------------------------
// Exporter — records the stage canvas + engine.recordDest audio to a Blob.
// ---------------------------------------------------------------------------

const RECORDER_STOP_TIMEOUT_MS = 5000;

export class Exporter {
  constructor({ canvas, engine } = {}) {
    this.canvas = canvas;
    this.engine = engine;
    this.mime = '';
    this._recorder = null;
    this._chunks = [];
    this._canvasStream = null;
    this._recordError = null;
  }

  get isRecording() {
    return !!this._recorder && this._recorder.state !== 'inactive';
  }

  static pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    // mp4 (H.264+AAC) first: it posts/plays inline everywhere (Telegram,
    // iMessage, Twitter…). webm only if the browser can't mux mp4. Bare
    // 'video/mp4' goes last — its default codecs are unknown and could be
    // less compatible than a good webm.
    const candidates = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    for (const m of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch (err) {
        console.warn('Exporter: isTypeSupported failed for', m, err);
      }
    }
    return '';
  }

  start() {
    if (this.isRecording) throw new Error('Exporter is already recording');
    if (this._recorder) {
      // A recorder can become inactive after an asynchronous error before the
      // UI asks us to stop. Do not leak its canvas track into the next run.
      this._recorder.ondataavailable = null;
      this._recorder.onstop = null;
      this._recorder.onerror = null;
      this._recorder = null;
      this._chunks = [];
      this._recordError = null;
      this._releaseCanvasStream();
    }
    try {
      if (!this.canvas || typeof this.canvas.captureStream !== 'function') {
        throw new Error('Canvas recording is not supported by this browser');
      }
      const stream = new MediaStream();
      this._canvasStream = this.canvas.captureStream(30);
      const videoTracks = this._canvasStream.getVideoTracks();
      if (!videoTracks.length) throw new Error('Canvas capture produced no video track');
      for (const track of videoTracks) {
        stream.addTrack(track);
      }
      const audioTracks = this.engine?.recordDest?.stream?.getAudioTracks?.() || [];
      if (!audioTracks.length) {
        throw new Error('Audio capture produced no audio track');
      }
      for (const track of audioTracks) {
        stream.addTrack(track);
      }
      const mime = Exporter.pickMime();
      const opts = { videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 192_000 };
      if (mime) opts.mimeType = mime;
      this._chunks = [];
      this._recordError = null;
      this._recorder = new MediaRecorder(stream, opts);
      this.mime = this._recorder.mimeType || mime || 'video/webm';
      this._recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this._chunks.push(e.data);
      };
      this._recorder.onerror = (event) => {
        this._recordError = event?.error || new Error('MediaRecorder failed');
        console.warn('Exporter: recorder error', this._recordError);
      };
      this._recorder.start(250);
      if (this._recorder.state === 'inactive') {
        throw new Error('MediaRecorder did not enter the recording state');
      }
      return true;
    } catch (err) {
      console.warn('Exporter: failed to start recording', err);
      try {
        if (this._recorder) {
          this._recorder.ondataavailable = null;
          this._recorder.onerror = null;
          if (this._recorder.state !== 'inactive') this._recorder.stop();
        }
      } catch (_) { /* best-effort cleanup */ }
      this._recorder = null;
      this._chunks = [];
      this._recordError = null;
      this._releaseCanvasStream();
      throw err;
    }
  }

  async stop() {
    const rec = this._recorder;
    let settled = false;
    let timer = null;
    const finish = (stopError = null) => {
      if (settled) return null;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      const recordError = stopError || this._recordError;
      const blob = new Blob(this._chunks, { type: this.mime || 'video/webm' });
      this._chunks = [];
      this._recorder = null;
      this._recordError = null;
      if (rec) {
        rec.ondataavailable = null;
        rec.onstop = null;
        rec.onerror = null;
      }
      this._releaseCanvasStream();
      return { blob, error: recordError };
    };
    const settle = (resolve, reject, stopError = null) => {
      const result = finish(stopError);
      if (!result) return;
      if (result.error) reject(result.error);
      else resolve(result.blob);
    };
    if (!rec || rec.state === 'inactive') {
      const result = finish();
      if (result.error) throw result.error;
      return result.blob;
    }
    return new Promise((resolve, reject) => {
      rec.onstop = () => settle(resolve, reject);
      rec.onerror = (event) => {
        const error = event?.error || new Error('MediaRecorder failed');
        this._recordError = error;
        console.warn('Exporter: recorder error', error);
        try {
          if (rec.state !== 'inactive') rec.stop();
          else settle(resolve, reject, error);
        } catch (_) {
          settle(resolve, reject, error);
        }
      };
      timer = setTimeout(() => {
        settle(resolve, reject, new Error('MediaRecorder did not stop in time'));
      }, RECORDER_STOP_TIMEOUT_MS);
      try {
        rec.stop();
      } catch (err) {
        console.warn('Exporter: stop failed', err);
        settle(resolve, reject, err);
      }
    });
  }

  _releaseCanvasStream() {
    // Only stop the canvas-capture tracks; engine.recordDest's audio track is
    // persistent and must survive for future recordings.
    if (!this._canvasStream) return;
    for (const track of this._canvasStream.getTracks()) {
      try {
        track.stop();
      } catch (err) {
        console.warn('Exporter: track stop failed', err);
      }
    }
    this._canvasStream = null;
  }
}
