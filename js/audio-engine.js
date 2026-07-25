// audio-engine.js — AudioEngine: the one shared AudioContext, decoding, robo-voice synth, reversed cache, earrape shaper, segment/grain/stuck-loop playback, waveform peaks.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);

const MIN_SEGMENT_SEC = 0.01;   // segments shorter than 10ms are degenerate
const MICRO_FADE_SEC = 0.003;   // 3ms click-killer edges
const STUCK_FADE_SEC = 0.02;    // 20ms stuck-loop fades
const RATE_MIN = 0.03125;
const RATE_MAX = 16;
const AUDIO_RESUME_TIMEOUT_MS = 2000;

export class AudioEngine {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.buffer = null;

    // Graph: fxIn → shaper → masterGain → destination; masterGain → analyser; masterGain → recordDest.
    this.fxIn = this.ctx.createGain();
    this._shaper = this.ctx.createWaveShaper();
    this._shaper.curve = null; // bypass by default
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.recordDest = this.ctx.createMediaStreamDestination();

    this.fxIn.connect(this._shaper);
    this._shaper.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
    this.masterGain.connect(this.analyser);
    this.masterGain.connect(this.recordDest);

    this._sources = new Set();        // live/scheduled one-shot AudioBufferSourceNodes
    this._segmentGains = new WeakMap(); // source → its per-segment GainNode (for fade-on-stop)
    this._stuck = null;               // { source, gain } for the single stuck loop
    this._reversed = null;            // cached reversed AudioBuffer
    this._reversedOf = null;          // which buffer the cache was built from
    this._earrapeCurve = null;        // cached hard-clip curve
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  async ensureRunning() {
    let timer = null;
    try {
      if (this.ctx.state !== 'running') {
        await Promise.race([
          this.ctx.resume(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, AUDIO_RESUME_TIMEOUT_MS);
          }),
        ]);
      }
      return this.ctx.state === 'running';
    } catch (err) {
      console.warn('AudioEngine.ensureRunning: resume failed', err);
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // Decode WITHOUT committing — callers decide whether the result still
  // belongs to the current load (protects against stale async loads).
  async decodeFile(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      // decodeAudioData detaches the ArrayBuffer — never reuse it after this call.
      return await this.ctx.decodeAudioData(arrayBuffer);
    } catch (err) {
      console.warn('AudioEngine.decodeFile: decode failed', err);
      return null;
    }
  }

  setBuffer(buf) {
    this.buffer = buf ?? null;
    this._invalidateReversed();
  }

  async loadFromFile(file) {
    const decoded = await this.decodeFile(file);
    this.setBuffer(decoded);
    return !!decoded;
  }

  // Render only — does NOT commit to this.buffer; callers use setBuffer()
  // once they know the load is still current.
  async renderRoboVoice(text) {
    const SR = 44100;
    try {
      let str = String(text ?? '');
      if (str.length > 400) str = str.slice(0, 400);

      const BLIP = 0.055;
      const GAP = 0.03;
      const SPACE = 0.06;
      const PUNCT = 0.18;

      // Plan blips first so we know the total render length.
      const blips = []; // { t, dur, freq }
      let t = 0.05; // tiny lead-in
      for (const ch of str) {
        const lower = ch.toLowerCase();
        if (/\s/.test(ch)) {
          t += SPACE;
        } else if (/[.,!?]/.test(ch)) {
          t += PUNCT;
        } else if (/[\p{L}\p{N}]/u.test(ch)) {
          const code = lower.charCodeAt(0);
          const freq = 150 + (code % 26) * 16;
          const isVowel = 'aeiou'.includes(lower);
          const dur = BLIP * (isVowel ? 1.4 : 1);
          blips.push({ t, dur, freq });
          t += dur + GAP;
        } else {
          t += 0.02; // unspecified symbol: tiny beat
        }
      }

      const totalDur = Math.max(t + 0.1, 0.25);
      const offline = new OfflineAudioContext(1, Math.ceil(totalDur * SR), SR);

      for (const b of blips) {
        const osc = offline.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(b.freq, b.t);
        // slight downward pitch ramp per blip
        osc.frequency.linearRampToValueAtTime(b.freq * 0.88, b.t + b.dur);

        const gain = offline.createGain();
        const peak = 0.28; // square waves are loud; keep headroom
        const attack = 0.005;
        const release = 0.02;
        gain.gain.setValueAtTime(0, b.t);
        gain.gain.linearRampToValueAtTime(peak, b.t + attack);
        gain.gain.setValueAtTime(peak, b.t + Math.max(attack, b.dur - release));
        gain.gain.linearRampToValueAtTime(0, b.t + b.dur);

        osc.connect(gain);
        gain.connect(offline.destination);
        osc.start(b.t);
        osc.stop(b.t + b.dur + 0.005);
      }

      return await offline.startRendering();
    } catch (err) {
      console.warn('AudioEngine.renderRoboVoice: synth failed', err);
      return this.ctx.createBuffer(1, Math.ceil(SR * 0.5), SR);
    }
  }

  async setRoboVoiceFromText(text) {
    const rendered = await this.renderRoboVoice(text);
    this.setBuffer(rendered);
    return rendered;
  }

  getReversed() {
    const buf = this.buffer;
    if (!buf) return null;
    if (this._reversed && this._reversedOf === buf) return this._reversed;
    try {
      const rev = this.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const src = buf.getChannelData(ch);
        const dst = rev.getChannelData(ch);
        for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
      }
      this._reversed = rev;
      this._reversedOf = buf;
      return rev;
    } catch (err) {
      console.warn('AudioEngine.getReversed: failed to build reversed buffer', err);
      return null;
    }
  }

  setEarrape(on) {
    try {
      const now = this.ctx.currentTime;
      const g = this.masterGain.gain;
      g.cancelScheduledValues(now);
      // short ramp instead of instant jump so toggling never clicks
      g.setTargetAtTime(on ? 2.5 : 1, now, 0.01);
      if (on) {
        if (!this._earrapeCurve) {
          const N = 1024;
          const curve = new Float32Array(N);
          for (let i = 0; i < N; i++) {
            const x = (i / (N - 1)) * 2 - 1;
            curve[i] = Math.tanh(x * 12);
          }
          this._earrapeCurve = curve;
        }
        this._shaper.oversample = '4x';
        this._shaper.curve = this._earrapeCurve;
      } else {
        this._shaper.curve = null;
      }
    } catch (err) {
      console.warn('AudioEngine.setEarrape: failed', err);
    }
  }

  playSegment(opts = {}) {
    try {
      const buf = this.buffer;
      if (!buf) return null;
      const total = buf.duration;

      let start = finiteOr(opts.start, 0);
      let duration = finiteOr(opts.duration, 0);
      const rate = clamp(finiteOr(opts.rate, 1), RATE_MIN, RATE_MAX);
      const reverse = !!opts.reverse;
      const detune = clamp(finiteOr(opts.detune, 0), -12000, 12000);
      const gainMul = Math.max(finiteOr(opts.gainMul, 1), 0);
      const triangle = opts._env === 'triangle';

      // Clamp segment bounds into the buffer.
      start = clamp(start, 0, total);
      duration = clamp(duration, 0, total - start);
      if (duration < MIN_SEGMENT_SEC) return null;

      let playBuf = buf;
      let offset = start;
      if (reverse) {
        const rev = this.getReversed();
        if (rev) {
          playBuf = rev;
          offset = clamp(total - start - duration, 0, total);
        }
      }

      const now = this.ctx.currentTime;
      let when = finiteOr(opts.when, 0);
      if (when < now) when = now; // absolute-time scheduling; never in the past

      const source = this.ctx.createBufferSource();
      source.buffer = playBuf;
      source.playbackRate.value = rate;
      let effRate = rate;
      if (source.detune) {
        source.detune.value = detune;
        effRate = rate * Math.pow(2, detune / 1200);
      }
      const outDur = duration / Math.max(effRate, 0.001);

      const gain = this.ctx.createGain();
      const g = gain.gain;
      if (triangle) {
        // full triangle envelope: up first half, down second half
        g.setValueAtTime(0, when);
        g.linearRampToValueAtTime(gainMul, when + outDur / 2);
        g.linearRampToValueAtTime(0, when + outDur);
      } else {
        // micro-fades at the edges to kill clicks
        const fade = Math.min(MICRO_FADE_SEC, outDur / 2);
        g.setValueAtTime(0, when);
        g.linearRampToValueAtTime(gainMul, when + fade);
        g.setValueAtTime(gainMul, Math.max(when + fade, when + outDur - fade));
        g.linearRampToValueAtTime(0, when + outDur);
      }

      source.connect(gain);
      gain.connect(this.fxIn);
      source.start(when, offset, duration);

      this._sources.add(source);
      this._segmentGains.set(source, gain);
      source.onended = () => {
        this._sources.delete(source);
        try { gain.disconnect(); } catch { /* already gone */ }
        try { source.disconnect(); } catch { /* already gone */ }
      };
      return source;
    } catch (err) {
      console.warn('AudioEngine.playSegment: failed', err);
      return null;
    }
  }

  playGrain(opts = {}) {
    try {
      const total = this.duration;
      if (!total) return null;
      const requestedDur = clamp(finiteOr(opts.dur, 0.06), MIN_SEGMENT_SEC, total);
      const reverse = !!opts.reverse;
      const pos = clamp(finiteOr(opts.pos, 0), 0, total);
      // A reverse grain must END at the playhead. Starting its source window at
      // pos would make the first audible sample come from pos + dur, visibly
      // ahead of the video frame during a recorded scratch.
      const dur = Math.min(requestedDur, reverse ? pos : total - pos);
      if (dur < MIN_SEGMENT_SEC) return null;
      const start = reverse ? pos - dur : pos;
      return this.playSegment({
        start,
        duration: dur,
        rate: finiteOr(opts.rate, 1),
        reverse,
        when: 0,
        detune: 0,
        gainMul: finiteOr(opts.gainMul, 1),
        _env: 'triangle',
      });
    } catch (err) {
      console.warn('AudioEngine.playGrain: failed', err);
      return null;
    }
  }

  startStuckLoop(opts = {}) {
    try {
      const buf = this.buffer;
      if (!buf) return;
      if (this._stuck) this.stopStuckLoop();

      const total = buf.duration;
      const windowSec = clamp(finiteOr(opts.windowSec, 0.12), MIN_SEGMENT_SEC, Math.max(total, MIN_SEGMENT_SEC));
      const rate = clamp(finiteOr(opts.rate, 1), RATE_MIN, RATE_MAX);
      let loopStart = clamp(finiteOr(opts.pos, 0), 0, total);
      let loopEnd = Math.min(loopStart + windowSec, total);
      if (loopEnd - loopStart < MIN_SEGMENT_SEC) {
        // window fell off the end — slide it back
        loopStart = Math.max(0, total - windowSec);
        loopEnd = total;
      }
      if (loopEnd - loopStart < 0.005) return; // buffer too tiny to loop

      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      source.loopStart = loopStart;
      source.loopEnd = loopEnd;
      source.playbackRate.value = rate;

      const gain = this.ctx.createGain();
      const now = this.ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1, now + STUCK_FADE_SEC);

      source.connect(gain);
      gain.connect(this.fxIn);
      source.start(now, loopStart);
      source.onended = () => {
        try { gain.disconnect(); } catch { /* already gone */ }
        try { source.disconnect(); } catch { /* already gone */ }
      };

      this._stuck = { source, gain };
    } catch (err) {
      console.warn('AudioEngine.startStuckLoop: failed', err);
    }
  }

  updateStuckLoop(opts = {}) {
    const stuck = this._stuck;
    if (!stuck) return;
    try {
      if (Number.isFinite(opts.rate)) {
        stuck.source.playbackRate.value = clamp(opts.rate, RATE_MIN, RATE_MAX);
      }
      if (Number.isFinite(opts.detune) && stuck.source.detune) {
        stuck.source.detune.value = clamp(opts.detune, -12000, 12000);
      }
    } catch (err) {
      console.warn('AudioEngine.updateStuckLoop: failed', err);
    }
  }

  stopStuckLoop() {
    const stuck = this._stuck;
    this._stuck = null;
    if (!stuck) return;
    try {
      const now = this.ctx.currentTime;
      const g = stuck.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + STUCK_FADE_SEC);
      stuck.source.stop(now + STUCK_FADE_SEC + 0.005);
    } catch (err) {
      try { stuck.source.stop(); } catch { /* already stopped */ }
    }
  }

  stopAll() {
    this.stopStuckLoop();
    const now = this.ctx.currentTime;
    for (const source of this._sources) {
      try {
        const gain = this._segmentGains.get(source);
        if (gain) {
          const g = gain.gain;
          g.cancelScheduledValues(now);
          g.setValueAtTime(g.value, now);
          g.linearRampToValueAtTime(0, now + 0.015);
        }
        source.stop(now + 0.02);
      } catch (err) {
        try { source.stop(); } catch { /* already stopped / never started */ }
      }
    }
    this._sources.clear();
  }

  getWaveformPeaks(numBuckets) {
    let n = Math.floor(finiteOr(Number(numBuckets), 0));
    if (n < 1) n = 1;
    n = Math.min(n, 1_000_000);
    const out = new Float32Array(n);
    const buf = this.buffer;
    if (!buf || buf.length === 0) return out;
    try {
      const data = buf.getChannelData(0);
      const len = data.length;
      const step = len / n;
      let overallMax = 0;
      for (let b = 0; b < n; b++) {
        const s = Math.floor(b * step);
        const e = Math.min(len, Math.max(s + 1, Math.floor((b + 1) * step)));
        let m = 0;
        for (let i = s; i < e; i++) {
          const v = Math.abs(data[i]);
          if (v > m) m = v;
        }
        out[b] = m;
        if (m > overallMax) overallMax = m;
      }
      if (overallMax > 0) {
        for (let b = 0; b < n; b++) out[b] /= overallMax;
      }
    } catch (err) {
      console.warn('AudioEngine.getWaveformPeaks: failed', err);
    }
    return out;
  }

  _invalidateReversed() {
    this._reversed = null;
    this._reversedOf = null;
  }
}
