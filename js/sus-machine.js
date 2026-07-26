// sus-machine.js — SusMachine: DPR-aware timeline scrub instrument (grain spray, stuck-loop glitches, wheel pitch) for YTP-O-MATIC 9000.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

const GRAIN_MIN_MS = 35;    // min ms between spawned grains
const STUCK_MS = 130;       // no significant movement for this long => stuck loop
const WOBBLE_MS = 180;      // stuck-loop detune wobble interval
const STROBE_MS = 60;       // playhead strobe period while stuck
const MOVE_EPS_PX = 2;      // "real movement" threshold (px)
const SEEK_MIN_MS = 33;     // match the 30 fps recording capture cadence
const TRANSPORT_SEEK_TIMEOUT_MS = 1500;
const TRANSPORT_DRIFT_SEC = 0.08;
const TRANSPORT_SEEK_COOLDOWN_MS = 500;
// While recording, audio is nudged later to land with the picture it belongs
// to. Capped so a long-GOP file can't make the instrument unplayable.
const REC_SYNC_MAX_SEC = 0.12;
const FRAME_SEC = 1 / 60;
const VEL_EMA_ALPHA = 0.3;  // EMA smoothing for pointer velocity
const PITCH_STEP_CENTS = 100;
const PITCH_MAX_CENTS = 1200;

export class SusMachine {
  constructor({ engine, vfx, timelineCanvas, videoEl, imageEl, mediaKindGetter }) {
    this._engine = engine;
    this._vfx = vfx;
    this._tl = timelineCanvas;
    this._videoEl = videoEl || null;
    this._imageEl = imageEl || null;
    this._kindGetter = typeof mediaKindGetter === 'function' ? mediaKindGetter : () => 'audio';

    this._tctx = this._tl ? this._tl.getContext('2d') : null;
    if (this._tl) {
      // Pointer Events on touch devices need this or the page pans instead.
      try { this._tl.style.touchAction = 'none'; } catch (err) { console.warn('SusMachine: touchAction', err); }
    }

    // Runtime state
    this._active = false;
    this._raf = 0;
    this._engaged = false;
    this._pointerId = null;
    this._pos = 0;                 // current scrub position in source seconds
    this._lastX = 0;               // last pointer x (CSS px)
    this._lastMoveT = 0;           // last pointermove timestamp (ms)
    this._sigX = 0;                // anchor x of last significant (>2px) move
    this._lastSigMoveT = 0;        // timestamp of last significant move
    this._velEma = 0;              // px/s EMA
    this._dir = 1;                 // last movement direction (+1 / -1)
    this._lastRate = 1;            // last computed grain rate
    this._lastGrainT = 0;
    this._stuck = null;            // {pos, windowSec, rate} while stuck-looping
    this._latched = false;
    this._lastWobbleT = 0;
    this._wobble = 0;              // current wobble detune (cents)
    this._pitchCents = 0;          // wheel pitch offset (cents)
    this._lastSeekT = 0;
    this._transport = null;        // {node, startPos, startCtxT, rate} while normal-playing
    this._transportStarting = false;
    this._transportGen = 0;        // cancels async video seek/play starts
    this._resumeAfterScrub = false; // was playing when the scrub grabbed the timeline
    this._pendingVideoSeek = false; // latest _pos should be applied after seeked
    this._seekIssuedT = 0;          // performance.now() when the in-flight seek was issued
    this._seekLatencySec = 0;       // EMA of observed seek latency (s)
    this._recording = false;        // align audio to the picture while capturing

    // Canvas metrics
    this._cssW = 0;
    this._cssH = 0;
    this._dpr = 1;
    this._waveCache = null;        // {canvas, w, h, buf}

    // Bound handlers (so add/removeEventListener pairs match)
    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerEnd = (e) => this._pointerEnd(e);
    this._onWheel = (e) => this._wheel(e);
    this._onResize = () => this._handleResize();
    this._onVideoSeeked = () => {
      if (!this._active) return;
      const now = performance.now();
      if (this._seekIssuedT) {
        // Measure what a seek actually costs on this file, so the transport
        // drift threshold can stay above it (see _seekVideo).
        const lat = Math.min(1, Math.max(0, (now - this._seekIssuedT) / 1000));
        this._seekLatencySec = this._seekLatencySec * 0.6 + lat * 0.4;
        this._seekIssuedT = 0;
      }
      // Snapshot and paint the frame that just completed BEFORE launching the
      // retained next seek. Otherwise continuous dragging can keep VisualFX in
      // `seeking` forever and freeze the recording on one old cached frame.
      this._drawStage(now / 1000);
      // Only the scrub path re-fires immediately; letting a transport drift
      // correction re-fire from its own completion is a seek treadmill.
      if (this._pendingVideoSeek && !this._transport) this._seekVideo(now, true);
    };
    this._tick = () => this._frame();
  }

  get currentPos() { return this._pos; }

  get isPlayingTransport() { return !!this._transport || this._transportStarting; }

  resetForMedia() {
    this._stopTransport();
    this._pos = 0;
    this._lastSeekT = 0;
    this._pendingVideoSeek = false;
    this._seekIssuedT = 0;
    this._seekLatencySec = 0; // re-measure seek cost for the new file
    this._waveCache = null;
  }

  // ----- normal-play transport (▶/⏸): plays at original speed from the
  // playhead; grabbing the timeline scratches, releasing resumes. -----

  togglePlay() {
    if (!this._active) return;
    if (this._engaged) {
      // Mid-scratch the scrub owns playback; space arms/disarms
      // "keep rolling when I let go" instead of fighting it.
      this._resumeAfterScrub = !this._resumeAfterScrub;
      return;
    }
    if (this._transport || this._transportStarting) {
      this._stopTransport();
      return;
    }
    const dur = this._duration();
    if (dur <= 0) return;
    this._clearStuck(true);
    if (this._pos >= dur - 0.05) this._pos = 0; // replay from the top
    this._startTransport(this._pos);
  }

  _transportPos(transport = this._transport) {
    const t = transport;
    if (!t) return this._pos;
    let now = t.startCtxT;
    try { now = this._engine.ctx.currentTime; } catch (err) { /* keep start */ }
    return clamp(t.startPos + (now - t.startCtxT) * t.rate, 0, this._duration());
  }

  _waitForVideoSeek(v, target) {
    if (!v || v.readyState < 1) return Promise.resolve(false);
    if (!v.seeking && Math.abs((v.currentTime || 0) - target) < 0.015) {
      return Promise.resolve(v.readyState >= 2);
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('loadeddata', onReady);
        v.removeEventListener('canplay', onReady);
        v.removeEventListener('error', onError);
        resolve(ok);
      };
      const onReady = () => {
        if (!v.seeking && v.readyState >= 2) finish(true);
      };
      const onSeeked = () => onReady();
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(!v.seeking && v.readyState >= 2), TRANSPORT_SEEK_TIMEOUT_MS);
      v.addEventListener('seeked', onSeeked, { once: true });
      v.addEventListener('loadeddata', onReady, { once: true });
      v.addEventListener('canplay', onReady, { once: true });
      v.addEventListener('error', onError, { once: true });
      try { v.currentTime = target; }
      catch (err) {
        console.warn('SusMachine: transport seek', err);
        finish(false);
      }
    });
  }

  async _playVideo(v) {
    try {
      const playPromise = v.play();
      if (!playPromise || typeof playPromise.then !== 'function') return true;
      let timer = null;
      const started = await Promise.race([
        Promise.resolve(playPromise).then(() => true, () => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), TRANSPORT_SEEK_TIMEOUT_MS);
        }),
      ]);
      if (timer !== null) clearTimeout(timer);
      return started;
    } catch (err) {
      console.warn('SusMachine: transport video play', err);
      return false;
    }
  }

  _finishTransportStart(gen) {
    if (gen === this._transportGen && !this._transport) {
      this._transportStarting = false;
      this._syncPlayBtn();
    }
  }

  async _startTransport(pos) {
    const dur = this._duration();
    if (dur <= 0 || !this._active) return false;
    const gen = ++this._transportGen;
    this._transportStarting = true;
    this._pendingVideoSeek = false;
    this._syncPlayBtn();

    const running = await this._engine.ensureRunning();
    if (!running || gen !== this._transportGen || !this._active) {
      this._finishTransportStart(gen);
      return false;
    }

    let start = clamp(pos, 0, Math.max(0, dur - 0.02));
    const rate = clamp(this._pitchMul(), 0.0625, 8);
    const isVideo = this._kindGetter() === 'video' && !!this._videoEl;
    if (isVideo) {
      const v = this._videoEl;
      try {
        v.pause();
        v.muted = true;
        v.playbackRate = clamp(rate, 0.0625, 16);
        const videoMax = Number.isFinite(v.duration) && v.duration > 0
          ? Math.max(0, v.duration - 0.01)
          : start;
        const target = clamp(start, 0, videoMax);
        const sought = await this._waitForVideoSeek(v, target);
        if (!sought || gen !== this._transportGen || !this._active) {
          this._finishTransportStart(gen);
          return false;
        }
        const playing = await this._playVideo(v);
        if (!playing || gen !== this._transportGen || !this._active) {
          // A newer attempt may already own this element — pausing here would
          // abort ITS play() promise and kill the winner too (wheel spam).
          if (gen === this._transportGen) { try { v.pause(); } catch (_) { /* already paused */ } }
          this._finishTransportStart(gen);
          return false;
        }
        // The video is now genuinely rolling. Anchor Web Audio to the frame it
        // actually reached instead of the earlier requested seek position.
        start = clamp(Number(v.currentTime) || start, 0, Math.max(0, dur - 0.02));
        this._pos = start;
      } catch (err) {
        console.warn('SusMachine: transport video sync', err);
        if (gen === this._transportGen) { try { v.pause(); } catch (_) { /* already paused */ } }
        this._finishTransportStart(gen);
        return false;
      }
    }

    if (gen !== this._transportGen || !this._active) {
      this._finishTransportStart(gen);
      return false;
    }
    let node = null;
    let startCtxT = 0;
    try {
      startCtxT = this._engine.ctx.currentTime;
      node = this._engine.playSegment({ start, duration: dur - start, rate, when: startCtxT });
    } catch (err) { console.warn('SusMachine: transport start', err); }
    if (!node || gen !== this._transportGen) {
      if (isVideo && gen === this._transportGen) {
        try { this._videoEl.pause(); } catch (_) { /* already paused */ }
      }
      if (node) {
        try { node.stop(); } catch (_) { /* already stopped */ }
      }
      this._finishTransportStart(gen);
      return false;
    }
    this._transport = { node, startPos: start, startCtxT, rate };
    this._transportStarting = false;
    this._syncPlayBtn();
    return true;
  }

  _stopTransport() {
    this._transportGen += 1;
    this._transportStarting = false;
    const t = this._transport;
    this._transport = null;
    if (t) {
      this._pos = this._transportPos(t);
      try { t.node.stop(); } catch (err) { /* already ended */ }
    }
    if (this._kindGetter() === 'video' && this._videoEl) {
      try { this._videoEl.pause(); } catch (err) { console.warn('SusMachine: pause', err); }
    }
    this._syncPlayBtn();
  }

  _syncPlayBtn() {
    const btn = document.getElementById('sus-play');
    if (btn) btn.textContent = this._transportStarting
      ? '⏳ SYNCING…'
      : this._transport ? '⏸ PAUSE' : '▶ PLAY';
  }

  activate() {
    if (this._active) return;
    if (!this._tl || !this._tctx || !this._engine || !this._vfx) {
      console.warn('SusMachine: missing engine/vfx/timeline canvas — cannot activate');
      return;
    }
    this._active = true;
    this._engaged = false;
    this._pointerId = null;
    this._stuck = null;
    this._latched = false;
    this._pitchCents = 0;
    this._wobble = 0;
    this._velEma = 0;
    this._dir = 1;
    this._lastRate = 1;
    this._pos = clamp(this._pos, 0, this._duration());
    this._waveCache = null;
    this._resumeAfterScrub = false;
    this._pendingVideoSeek = false;
    this._syncPlayBtn();

    try { if (this._videoEl) this._videoEl.pause(); } catch (err) { console.warn('SusMachine: pause', err); }

    this._syncCanvasSize();

    this._tl.addEventListener('pointerdown', this._onPointerDown);
    this._tl.addEventListener('pointermove', this._onPointerMove);
    this._tl.addEventListener('pointerup', this._onPointerEnd);
    this._tl.addEventListener('pointercancel', this._onPointerEnd);
    this._tl.addEventListener('pointerleave', this._onPointerEnd);
    this._tl.addEventListener('wheel', this._onWheel, { passive: false });
    if (this._videoEl) this._videoEl.addEventListener('seeked', this._onVideoSeeked);
    window.addEventListener('resize', this._onResize);

    this._raf = requestAnimationFrame(this._tick);
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;

    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }

    this._tl.removeEventListener('pointerdown', this._onPointerDown);
    this._tl.removeEventListener('pointermove', this._onPointerMove);
    this._tl.removeEventListener('pointerup', this._onPointerEnd);
    this._tl.removeEventListener('pointercancel', this._onPointerEnd);
    this._tl.removeEventListener('pointerleave', this._onPointerEnd);
    this._tl.removeEventListener('wheel', this._onWheel);
    if (this._videoEl) this._videoEl.removeEventListener('seeked', this._onVideoSeeked);
    window.removeEventListener('resize', this._onResize);

    if (this._engaged && this._pointerId != null) {
      try { this._tl.releasePointerCapture(this._pointerId); } catch (err) { /* already released */ }
    }
    this._engaged = false;
    this._pointerId = null;
    this._stuck = null;
    this._latched = false;
    this._resumeAfterScrub = false;
    this._stopTransport();

    try { this._engine.stopStuckLoop(); } catch (err) { console.warn('SusMachine: stopStuckLoop', err); }
    try { this._engine.stopAll(); } catch (err) { console.warn('SusMachine: stopAll', err); }
  }

  // ---------- internals ----------

  _duration() {
    const d = Number(this._engine && this._engine.duration);
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  _pitchMul() { return 2 ** (this._pitchCents / 1200); }

  // main.js flips this around a RECORD PERFORMANCE capture.
  setRecording(on) {
    this._recording = !!on;
  }

  // A grain for position P is audible instantly, but the frame showing P only
  // appears once the video seek lands — so in a recording the audio runs ahead
  // by that latency. Delay the audio by it while capturing. Live monitoring
  // stays at zero latency (the performer needs immediate feedback).
  _syncDelaySec() {
    if (!this._recording) return 0;
    if (this._kindGetter() !== 'video' || !this._videoEl) return FRAME_SEC;
    return clamp(this._seekLatencySec || FRAME_SEC, FRAME_SEC, REC_SYNC_MAX_SEC);
  }

  _syncWhen() {
    const delay = this._syncDelaySec();
    if (delay <= 0) return 0; // 0 = "as soon as possible"
    try { return this._engine.ctx.currentTime + delay; }
    catch (err) { return 0; }
  }

  // "Clean scroll": grains and stuck loops play at the source's original
  // pitch/speed (rate 1, no wobble) — scrubbing sounds like honest audio.
  _cleanMode() {
    const box = document.getElementById('sus-clean');
    return !!(box && box.checked);
  }

  _eventX(e) {
    const rect = this._tl.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  _setPosFromX(x) {
    const w = Math.max(1, this._cssW || this._tl.clientWidth || 1);
    this._pos = clamp01(x / w) * this._duration();
  }

  _clearStuck(stopAudio) {
    if (stopAudio && (this._stuck || this._latched)) {
      try { this._engine.stopStuckLoop(); } catch (err) { console.warn('SusMachine: stopStuckLoop', err); }
    }
    this._stuck = null;
    this._latched = false;
    this._wobble = 0;
  }

  // ----- pointer handlers -----

  _pointerDown(e) {
    if (!this._active) return;
    if (this._engaged) return; // ignore secondary pointers mid-scrub
    // Primary button only: a right-click's pointerup is eaten by the native
    // context menu (macOS opens it on mousedown) → phantom stuck drag.
    if (e.button !== 0) return;
    try { e.preventDefault(); } catch (err) { /* non-cancelable */ }

    // Grabbing the timeline scratches: pause the transport, resume on release.
    this._resumeAfterScrub = !!this._transport || this._transportStarting;
    this._stopTransport();

    // Next pointerdown always clears a latched loop.
    this._clearStuck(true);
    this._pitchCents = 0; // wheel pitch resets on pointerdown

    this._engaged = true;
    this._pointerId = e.pointerId;
    try { this._tl.setPointerCapture(e.pointerId); } catch (err) { console.warn('SusMachine: setPointerCapture', err); }

    try {
      const pointerId = this._pointerId;
      Promise.resolve(this._engine.ensureRunning()).then((running) => {
        if (running && this._active && this._engaged && this._pointerId === pointerId) {
          this._maybeGrain(performance.now());
        }
      }).catch(() => {});
    }
    catch (err) { console.warn('SusMachine: ensureRunning', err); }

    const now = performance.now();
    const x = this._eventX(e);
    this._lastX = x;
    this._lastMoveT = now;
    this._sigX = x;
    this._lastSigMoveT = now;
    this._velEma = 0;
    this._dir = 1;
    this._lastRate = 1;
    this._setPosFromX(x);
    this._seekVideo(now, true);
    this._maybeGrain(now); // instant audible feedback on grab
  }

  _pointerMove(e) {
    if (!this._active || !this._engaged) return;
    if (this._pointerId != null && e.pointerId !== this._pointerId) return;

    const events = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length)
      ? e.getCoalescedEvents() : [e];

    const pnow = performance.now();
    for (const ev of events) {
      // Coalesced events carry their own timestamps (same clock as
      // performance.now() in modern browsers); using one shared "now" for the
      // whole batch inflates per-sample velocity 4-8x on high-poll-rate mice.
      const ts = ev.timeStamp;
      const now = (typeof ts === 'number' && ts > pnow - 5000 && ts <= pnow + 5) ? ts : pnow;
      const x = this._eventX(ev);
      const dx = x - this._lastX;
      const dtMs = Math.max(1, now - this._lastMoveT);
      const v = dx / (dtMs / 1000); // px/s
      this._velEma = this._velEma * (1 - VEL_EMA_ALPHA) + v * VEL_EMA_ALPHA;
      if (dx !== 0) this._dir = dx < 0 ? -1 : 1;
      this._lastX = x;
      this._lastMoveT = now;
      this._setPosFromX(x);

      const w = Math.max(1, this._cssW || 1);
      this._lastRate = clamp(Math.abs(this._velEma) / (w / 6), 0.25, 3.5);

      if (Math.abs(x - this._sigX) > MOVE_EPS_PX) {
        // Real movement: kill any stuck loop and reset the stillness clock.
        this._sigX = x;
        this._lastSigMoveT = now;
        if (this._stuck) this._clearStuck(true);
      }
      if (!this._stuck) this._maybeGrain(now);
    }
    this._seekVideo(pnow);
  }

  _pointerEnd(e) {
    if (!this._active || !this._engaged) return;
    if (this._pointerId != null && e.pointerId != null && e.pointerId !== this._pointerId) return;

    this._engaged = false;
    if (this._pointerId != null) {
      try { this._tl.releasePointerCapture(this._pointerId); } catch (err) { /* already released */ }
    }
    this._pointerId = null;
    this._seekVideo(performance.now(), true);

    const latchBox = document.getElementById('sus-latch');
    const latchOn = !!(latchBox && latchBox.checked);
    // Belt-and-braces: no transport may survive into the release branches —
    // stopAll() below would kill its node but not its state (ghost playhead).
    this._stopTransport();
    if (latchOn && this._stuck) {
      this._latched = true; // leave the loop RUNNING (latch beats resume)
      this._resumeAfterScrub = false;
    } else {
      this._clearStuck(true);
      try { this._engine.stopAll(); } catch (err) { console.warn('SusMachine: stopAll', err); }
      if (this._resumeAfterScrub) {
        this._resumeAfterScrub = false;
        this._startTransport(this._pos); // let go of the record: keep rolling
      }
    }
  }

  _wheel(e) {
    if (!this._active) return;
    try { e.preventDefault(); } catch (err) { /* non-cancelable */ }
    const sign = Math.sign(e.deltaY || 0);
    if (!sign) return;
    // wheel up (deltaY < 0) => pitch up
    this._pitchCents = clamp(this._pitchCents - sign * PITCH_STEP_CENTS, -PITCH_MAX_CENTS, PITCH_MAX_CENTS);
    if (this._stuck) {
      try { this._engine.updateStuckLoop({ rate: this._stuck.rate, detune: this._pitchCents + this._wobble }); }
      catch (err) { console.warn('SusMachine: updateStuckLoop', err); }
    }
    if (this._transport || this._transportStarting) {
      // Restart at the current position so the new pitch takes effect.
      const p = this._transportPos();
      this._stopTransport();
      this._startTransport(p);
    }
  }

  // ----- audio -----

  _maybeGrain(now) {
    if (this._duration() <= 0) return;
    if (this._engine?.ctx?.state !== 'running') return;
    if (now - this._lastGrainT < GRAIN_MIN_MS) return;
    this._lastGrainT = now;
    const clean = this._cleanMode();
    const rate = clamp((clean ? 1 : this._lastRate) * this._pitchMul(), 0.0625, 8);
    try {
      this._engine.playGrain({
        pos: this._pos,
        dur: clean ? 0.09 : 0.07, // longer grains overlap more = smoother
        rate,
        reverse: this._dir < 0,
        gainMul: 0.9,
        when: this._syncWhen(),
      });
    } catch (err) { console.warn('SusMachine: playGrain', err); }
  }

  _startStuck(now) {
    if (this._engine?.ctx?.state !== 'running') return;
    const windowSec = 0.06 + Math.random() * 0.14;
    const rate = this._cleanMode() ? 1 : this._lastRate;
    try {
      this._engine.startStuckLoop({ pos: this._pos, windowSec, rate, when: this._syncWhen() });
      this._engine.updateStuckLoop({ rate, detune: this._pitchCents });
    } catch (err) { console.warn('SusMachine: startStuckLoop', err); return; }
    this._stuck = { pos: this._pos, windowSec, rate };
    this._wobble = 0;
    this._lastWobbleT = now;
  }

  _updateStuck(now) {
    if (!this._stuck) return;
    if (now - this._lastWobbleT < WOBBLE_MS) return;
    this._lastWobbleT = now;
    const clean = this._cleanMode();
    try {
      if (Math.random() < 0.15) {
        // The glitch "re-grab": restart the loop with a new random window.
        // (Kept in clean mode — it's the skipping-CD effect, pitch untouched.)
        const windowSec = 0.06 + Math.random() * 0.14;
        this._engine.startStuckLoop({ pos: this._stuck.pos, windowSec, rate: this._stuck.rate, when: this._syncWhen() });
        this._stuck.windowSec = windowSec;
        this._wobble = 0;
        this._engine.updateStuckLoop({ rate: this._stuck.rate, detune: this._pitchCents });
      } else if (!clean) {
        this._wobble = Math.random() * 160 - 80; // ±80 cents
        this._engine.updateStuckLoop({ rate: this._stuck.rate, detune: this._pitchCents + this._wobble });
      } else if (this._wobble !== 0) {
        // clean mode enabled mid-loop: drop the stale dirty-mode wobble
        this._wobble = 0;
        this._engine.updateStuckLoop({ rate: this._stuck.rate, detune: this._pitchCents });
      }
    } catch (err) { console.warn('SusMachine: stuck wobble', err); }
  }

  // ----- video seeking -----

  _seekVideo(now, force = false) {
    const v = this._videoEl;
    if (!v || this._kindGetter() !== 'video') return;
    if (this._transportStarting) return; // async startup owns the exact seek
    try {
      if (v.readyState < 1) return;      // no metadata yet
      const vd = Number(v.duration);
      const max = Number.isFinite(vd) && vd > 0 ? Math.max(0, vd - 0.01) : this._pos;
      const target = clamp(this._pos, 0, max);
      if (v.seeking) {
        // Retain only the latest desired position. The seeked handler applies
        // it immediately, so long-GOP footage cannot leave video arbitrarily
        // behind the audio during a recorded scratch.
        this._pendingVideoSeek = true;
        return;
      }
      if (!force && now - this._lastSeekT < SEEK_MIN_MS) {
        this._pendingVideoSeek = true;
        return;
      }
      // While the transport plays, the video element rolls on its own — only
      // correct real drift or the constant micro-seeks would stutter it.
      const lat = this._transport ? this._seekLatencySec : 0;
      // A correction costs `lat` seconds of media time, so a threshold below
      // that cost is self-sustaining: each seek re-creates the error that
      // triggers the next one. Keep the bar above the measured seek cost.
      const eps = this._transport ? Math.max(TRANSPORT_DRIFT_SEC, lat * 2) : 0.015;
      if (Math.abs((v.currentTime || 0) - target) < eps) {
        this._pendingVideoSeek = false;
        return;
      }
      if (this._transport && now - this._lastSeekT < TRANSPORT_SEEK_COOLDOWN_MS) {
        this._pendingVideoSeek = false;
        return;
      }
      this._lastSeekT = now;
      this._seekIssuedT = now;
      this._pendingVideoSeek = false;
      // Aim where the playhead WILL be once the seek lands, not where it is now.
      v.currentTime = clamp(target + lat * (this._transport ? this._transport.rate : 0), 0, max);
    } catch (err) { console.warn('SusMachine: video seek', err); }
  }

  // ----- rendering -----

  _handleResize() {
    if (!this._active) return;
    this._syncCanvasSize();
  }

  _syncCanvasSize() {
    const c = this._tl;
    const cssW = Math.max(1, c.clientWidth || 600);
    const cssH = Math.max(1, c.clientHeight || 110);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      this._waveCache = null;
    }
    this._cssW = cssW;
    this._cssH = cssH;
    this._dpr = dpr;
  }

  _getWaveCanvas() {
    const w = this._tl.width;
    const h = this._tl.height;
    const buf = this._engine.buffer || null;
    const cached = this._waveCache;
    if (cached && cached.w === w && cached.h === h && cached.buf === buf) return cached.canvas;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a0b2e';
    ctx.fillRect(0, 0, w, h);

    const dpr = this._dpr || 1;
    ctx.scale(dpr, dpr);
    const cssW = w / dpr;
    const cssH = h / dpr;
    const mid = cssH / 2;
    const buckets = Math.max(1, Math.floor(cssW / 2));

    let peaks = null;
    try { peaks = this._engine.getWaveformPeaks(buckets); }
    catch (err) { console.warn('SusMachine: getWaveformPeaks', err); }
    if (!peaks || !peaks.length) peaks = new Float32Array(buckets);

    // faint mid-line under the bars
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, mid - 0.5, cssW, 1);

    for (let i = 0; i < buckets; i++) {
      const x = i * 2;
      const p = clamp01(peaks[i] || 0);
      const half = Math.max(1, p * (mid - 3));
      ctx.fillStyle = `hsl(${(x / cssW) * 300}, 100%, 60%)`;
      ctx.fillRect(x, mid - half, 1.6, half * 2);
    }

    this._waveCache = { canvas, w, h, buf };
    return canvas;
  }

  _drawTimeline(now) {
    this._syncCanvasSize();
    const ctx = this._tctx;
    const { _cssW: cssW, _cssH: cssH, _dpr: dpr } = this;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.drawImage(this._getWaveCanvas(), 0, 0, cssW, cssH);

    const dur = this._duration();

    // loop-window highlight while stuck-looping
    if (this._stuck && dur > 0) {
      const wx = clamp01(this._stuck.pos / dur) * cssW;
      const ww = Math.max(2, (this._stuck.windowSec / dur) * cssW);
      ctx.fillStyle = 'rgba(255, 45, 120, 0.35)';
      ctx.fillRect(wx, 0, Math.min(ww, cssW - wx), cssH);
    }

    // playhead: 3px white line with glow; strobes while stuck
    const px = dur > 0 ? clamp01(this._pos / dur) * cssW : 0;
    const strobing = !!this._stuck;
    const color = strobing && Math.floor(now / STROBE_MS) % 2 === 1 ? '#ff2d78' : '#ffffff';
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = color;
    ctx.fillRect(clamp(px - 1.5, 0, cssW - 3), 0, 3, cssH);

    ctx.restore();
  }

  _drawStage(tSec) {
    const kind = this._kindGetter();
    let source = null;
    // Keep passing the video element while a seek temporarily makes it
    // non-drawable. VisualFX can then reuse its last good frame; passing null
    // here would incorrectly switch to the audio-only waveform visualizer.
    if (kind === 'video' && this._videoEl) {
      source = this._videoEl;
    } else if (kind === 'image' && this._imageEl && this._imageEl.naturalWidth > 0) {
      source = this._imageEl;
    } // audio/text => null => visualizer

    const fx = {};
    if (this._stuck) {
      fx.rgbSplit = 3 + Math.random() * 3;
      fx.shake = 3;
      fx.hue = (tSec * 90) % 40;
      fx.caption = null;
      if (this._latched && Math.floor(tSec * 2) % 2 === 0) fx.rainbow = true;
    }

    try { this._vfx.draw(source, fx, tSec); }
    catch (err) { console.warn('SusMachine: vfx.draw', err); }
  }

  _frame() {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._tick);
    const now = performance.now();
    try {
      // transport playhead advances on the audio clock; stops at the end
      if (this._transport) {
        this._pos = this._transportPos();
        if (this._pos >= this._duration() - 0.02) this._stopTransport();
      }
      // stuck detection: engaged + still for 130ms
      if (this._engaged && !this._stuck && this._duration() > 0 &&
          now - this._lastSigMoveT >= STUCK_MS) {
        this._startStuck(now);
      }
      this._updateStuck(now);
      this._drawTimeline(now);
      this._drawStage(now / 1000);
      this._seekVideo(now);
    } catch (err) {
      console.warn('SusMachine: frame error', err);
    }
  }
}
