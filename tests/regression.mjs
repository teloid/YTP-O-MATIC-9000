import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const asDataModule = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const visualSource = await fs.readFile(new URL('../js/visual-fx.js', import.meta.url), 'utf8');
const visualUrl = asDataModule(visualSource);
const i18nUrl = asDataModule(await fs.readFile(new URL('../js/i18n.js', import.meta.url), 'utf8'));

// Modules are inlined as data: URLs, where a relative specifier like
// './i18n.js' cannot resolve — rewrite each sibling import to its own inlined
// module so any file is loadable in isolation.
const inlineImports = (source) => source
  .replace("'./visual-fx.js'", `'${visualUrl}'`)
  .replace("'./i18n.js'", `'${i18nUrl}'`);

async function loadModule(path) {
  return import(asDataModule(inlineImports(await fs.readFile(new URL(path, import.meta.url), 'utf8'))));
}

const generatorSource = inlineImports(await fs.readFile(new URL('../js/ytp-generator.js', import.meta.url), 'utf8'));

const [{ AudioEngine }, { SusMachine }, visualModule, generatorModule] = await Promise.all([
  loadModule('../js/audio-engine.js'),
  loadModule('../js/sus-machine.js'),
  import(visualUrl),
  import(asDataModule(generatorSource)),
]);
const { VisualFX } = visualModule;
const { Conductor, Exporter, generateEDL } = generatorModule;

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ getContext: () => null, width: 0, height: 0 }),
};
globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
// SusMachine._frame re-arms itself via rAF; the tests drive it by hand.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// Reverse scratches must begin at the visible playhead, not one grain ahead.
{
  const engine = Object.create(AudioEngine.prototype);
  engine.buffer = { duration: 10 };
  let options = null;
  engine.playSegment = (value) => { options = value; return {}; };
  engine.playGrain({ pos: 5, dur: 0.1, reverse: true });
  assert.equal(options.start, 4.9);
  assert.equal(options.reverse, true);
  engine.playGrain({ pos: 5, dur: 0.1, reverse: false });
  assert.equal(options.start, 5);
  engine.playGrain({ pos: 0.05, dur: 0.1, reverse: true });
  assert.equal(options.start, 0);
  assert.equal(options.duration, 0.05);
  engine.playGrain({ pos: 9.95, dur: 0.1, reverse: false });
  assert.equal(options.start, 9.95);
  assert.ok(Math.abs(options.duration - 0.05) < 1e-9);
}

// AudioContext resume failures must be observable by callers.
{
  const failed = Object.create(AudioEngine.prototype);
  failed.ctx = { state: 'suspended', resume: async () => {} };
  assert.equal(await failed.ensureRunning(), false);
  const resumed = Object.create(AudioEngine.prototype);
  resumed.ctx = {
    state: 'suspended',
    async resume() { this.state = 'running'; },
  };
  assert.equal(await resumed.ensureRunning(), true);
}

class FakeVideo {
  constructor() {
    this.readyState = 4;
    this.duration = 10;
    this.videoWidth = 1280;
    this.videoHeight = 720;
    this.currentSrc = 'blob:test';
    this.seeking = false;
    this._time = 0;
    this._listeners = new Map();
  }

  get currentTime() { return this._time; }

  set currentTime(value) {
    this._time = value;
    this.seeking = true;
    queueMicrotask(() => {
      this.seeking = false;
      this._emit('seeked');
    });
  }

  addEventListener(type, listener, options = {}) {
    const list = this._listeners.get(type) || [];
    list.push({ listener, once: !!options.once });
    this._listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(type) || [];
    this._listeners.set(type, list.filter((item) => item.listener !== listener));
  }

  _emit(type) {
    const list = [...(this._listeners.get(type) || [])];
    for (const item of list) {
      item.listener();
      if (item.once) this.removeEventListener(type, item.listener);
    }
  }

  pause() {}

  async play() {
    this._time += 0.04;
  }
}

// Video transport waits for seek/play, then anchors Web Audio to actual mediaTime.
{
  const video = new FakeVideo();
  let segment = null;
  const engine = {
    duration: 10,
    ctx: { state: 'running', currentTime: 42 },
    ensureRunning: async () => true,
    playSegment: (options) => {
      segment = options;
      return { stop() {} };
    },
  };
  const sus = new SusMachine({
    engine,
    vfx: { draw() {} },
    timelineCanvas: null,
    videoEl: video,
    imageEl: null,
    mediaKindGetter: () => 'video',
  });
  sus._active = true;
  assert.equal(await sus._startTransport(2), true);
  assert.ok(Math.abs(segment.start - 2.04) < 1e-9);
  assert.equal(segment.when, 42);
  assert.equal(sus._transport.startCtxT, 42);
}

// Seeking video remains a video source and holds the confirmed frame.
{
  const video = new FakeVideo();
  video.seeking = true;
  let source = null;
  const sus = new SusMachine({
    engine: {},
    vfx: { draw(value) { source = value; } },
    timelineCanvas: null,
    videoEl: video,
    imageEl: null,
    mediaKindGetter: () => 'video',
  });
  sus._drawStage(0);
  assert.equal(source, video);
  const visual = Object.create(VisualFX.prototype);
  visual._warn = () => {};
  assert.equal(visual._resolveDrawable(video), null);
  video.seeking = false;
  assert.equal(visual._resolveDrawable(video).el, video);
  const conductor = Object.create(Conductor.prototype);
  conductor.videoEl = video;
  conductor.imageEl = null;
  video.readyState = 1;
  assert.equal(conductor._pickSource(), video);

  const order = [];
  sus._active = true;
  sus._pendingVideoSeek = true;
  sus._vfx.draw = () => order.push('draw');
  sus._seekVideo = () => order.push('seek');
  sus._onVideoSeeked();
  assert.deepEqual(order, ['draw', 'seek']);
}

// Recorder startup failures must throw; successful recordings must expose state/data.
{
  const previousMediaStream = globalThis.MediaStream;
  const previousMediaRecorder = globalThis.MediaRecorder;
  class MockStream {
    constructor() { this.tracks = []; }
    addTrack(track) { this.tracks.push(track); }
  }
  class MockRecorder {
    static isTypeSupported(type) { return type.includes('webm'); }
    constructor(_stream, options) {
      this.state = 'inactive';
      this.mimeType = options.mimeType || 'video/webm';
    }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['recorded'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  globalThis.MediaStream = MockStream;
  globalThis.MediaRecorder = MockRecorder;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const broken = new Exporter({ canvas: null, engine: {} });
    assert.throws(() => broken.start(), /not supported/);

    let stoppedTracks = 0;
    const videoTrack = { stop() { stoppedTracks += 1; } };
    const audioTrack = {};
    const canvasStream = {
      getVideoTracks: () => [videoTrack],
      getTracks: () => [videoTrack],
    };
    const exporter = new Exporter({
      canvas: { captureStream: () => canvasStream },
      engine: { recordDest: { stream: { getAudioTracks: () => [audioTrack] } } },
    });
    assert.equal(exporter.start(), true);
    assert.equal(exporter.isRecording, true);
    const blob = await exporter.stop();
    assert.ok(blob.size > 0);
    assert.equal(exporter.isRecording, false);
    assert.equal(stoppedTracks, 1);

    exporter.start();
    exporter._recorder.state = 'inactive'; // simulate an asynchronous recorder failure
    exporter.start();
    assert.equal(stoppedTracks, 2); // stale canvas track was released before restart
    await exporter.stop();
  } finally {
    console.warn = originalWarn;
    globalThis.MediaStream = previousMediaStream;
    globalThis.MediaRecorder = previousMediaRecorder;
  }
}

// Seeded edit generation keeps every source window finite and in bounds.
for (const duration of [0.05, 0.2, 1, 60]) {
  for (const chaos of [1, 7, 11]) {
    for (let seed = 0; seed < 20; seed++) {
      const edit = generateEDL({ duration, chaos, seed });
      assert.ok(Number.isFinite(edit.totalOut) && edit.totalOut > 0);
      for (const event of edit.events) {
        assert.ok(Number.isFinite(event.srcStart) && event.srcStart >= 0);
        assert.ok(Number.isFinite(event.srcDur) && event.srcDur > 0);
        assert.ok(event.srcStart + event.srcDur <= duration + 1e-9);
      }
    }
  }
}

// An edit must never end on a tacked-on card: the forced white-flash
// "GET POOPED" frame read as a dead frame and was removed on purpose.
// Output slot lengths must also account for detune's playback-speed factor.
{
  const effectiveRate = (rate, detune) => (rate || 1) * Math.pow(2, (detune || 0) / 1200);
  const toggles = { stutter: 1, reverse: 1, speed: 1, pitch: 1, jumpcuts: 1, visuals: 1, captions: 1 };
  for (const duration of [0.2, 1, 12, 60]) {
    for (const chaos of [1, 7, 11]) {
      for (let seed = 0; seed < 15; seed++) {
        const edit = generateEDL({ duration, chaos, seed, toggles });
        const last = edit.events[edit.events.length - 1];
        assert.ok(last, 'edit must contain at least one event');
        assert.notEqual(last.caption, 'GET POOPED');
        assert.notEqual(last.fx && last.fx.flash, 1);
        let sum = 0;
        for (const e of edit.events) {
          sum += (e.srcDur / effectiveRate(e.rate, e.detune)) * Math.max(1, e.repeat | 0);
        }
        assert.ok(Math.abs(sum - edit.totalOut) < 1e-6, 'totalOut must equal the sum of output slots');
      }
    }
  }
  // Seeded determinism, and animated zoom stays finite / bounded / exclusive
  // with the static zoom (VisualFX only ever receives one numeric `zoom`).
  const a = generateEDL({ duration: 30, chaos: 11, seed: 4242, toggles });
  const b = generateEDL({ duration: 30, chaos: 11, seed: 4242, toggles });
  assert.deepEqual(a, b, 'same seed must produce the same edit');
  let animated = 0;
  for (let seed = 0; seed < 120; seed++) {
    for (const event of generateEDL({ duration: 30, chaos: 11, seed, toggles }).events) {
      const fx = event.fx || {};
      if (fx.zoomFrom == null && fx.zoom == null) continue;
      if (fx.zoomFrom != null) {
        animated += 1;
        assert.equal(fx.zoom, undefined, 'animated zoom must not also emit a static zoom');
        for (const v of [fx.zoomFrom, fx.zoomTo]) {
          assert.ok(Number.isFinite(v) && v >= 0.05 && v <= 8, `zoom out of range: ${v}`);
        }
        if (fx.zoomPulses != null) assert.ok(Number.isInteger(fx.zoomPulses) && fx.zoomPulses > 0);
      } else {
        assert.ok(Number.isFinite(fx.zoom) && fx.zoom >= 0.05 && fx.zoom <= 8);
      }
      for (const v of [fx.zoomCx, fx.zoomCy]) {
        if (v != null) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
      }
    }
  }
  assert.ok(animated > 0, 'chaos 11 must produce animated zooms');
}

// The stage adopts the media's aspect so cover-fit crops nothing; dims stay
// even (mp4 refuses odd sizes) and bounded. Vertical video must not be
// squeezed into a landscape frame.
{
  const canvas = { width: 1280, height: 720, getContext: () => ({}) };
  const vfx = new VisualFX(canvas);
  const cases = [
    [1920, 1080, 1280, 720], [1280, 720, 1280, 720], [1080, 1920, 720, 1280],
    [406, 720, 722, 1280], [1024, 1024, 1280, 1280], [2560, 1080, 1280, 540],
    [640, 480, 1280, 960], [5000, 100, 1280, 534], [100, 5000, 640, 1280],
    [0, 0, 1280, 720], [NaN, NaN, 1280, 720], [-16, -9, 1280, 720],
  ];
  for (const [sw, sh, w, h] of cases) {
    const got = vfx.fitToSource(sw, sh);
    assert.equal(got.w, w, `fitToSource(${sw},${sh}).w`);
    assert.equal(got.h, h, `fitToSource(${sw},${sh}).h`);
    assert.equal(vfx.W, w);
    assert.equal(vfx.H, h);
    assert.equal(canvas.width, w, 'canvas must stay in sync');
    assert.equal(canvas.height, h);
    assert.equal(w % 2, 0, 'width must be even for mp4');
    assert.equal(h % 2, 0, 'height must be even for mp4');
    if (sw > 0 && sh > 0) {
      const want = Math.min(2.4, Math.max(0.5, sw / sh));
      assert.ok(Math.abs(w / h - want) < 0.01, `stage aspect must match clamped source aspect (${sw}x${sh})`);
    }
  }
}

// A media file with no video track (audio-only .webm/.mp4 from yt-dlp carries a
// video/* MIME) must fall through to the visualizer, not a permanently black
// frame — while a real video mid-seek still reuses its cached frame.
{
  const calls = [];
  const stubCtx = new Proxy({}, {
    get(_target, key) {
      if (key === 'canvas') return { width: 1280, height: 720 };
      if (key === 'measureText') return () => ({ width: 100 });
      if (typeof key === 'string' && /^(fillStyle|filter|globalAlpha|globalCompositeOperation|font|textAlign|textBaseline|lineWidth|strokeStyle|shadowColor|shadowBlur|lineJoin|miterLimit)$/.test(key)) return '';
      return (...args) => { calls.push([key, ...args]); };
    },
    set() { return true; },
  });
  const mkVfx = (extra) => Object.assign(Object.create(VisualFX.prototype), {
    canvas: { width: 1280, height: 720 }, ctx: stubCtx, _warn: () => {},
    _analyser: null, _freq: null, _capCache: null, _lastWarnMs: -Infinity,
    _lastFrame: null, _lastFrameCtx: null, _lastFrameValid: false,
    _w: 1280, _h: 720,
  }, extra);

  calls.length = 0;
  mkVfx().draw({ videoWidth: 0, videoHeight: 0, readyState: 4, seeking: false, currentSrc: 'blob:audio' }, {}, 1);
  assert.ok(calls.some(([k]) => k === 'fillText'), 'trackless media must render the visualizer');

  calls.length = 0;
  mkVfx({ _lastFrame: { width: 640, height: 360 }, _lastFrameCtx: {}, _lastFrameValid: true })
    .draw({ videoWidth: 1280, videoHeight: 720, readyState: 4, seeking: true, currentSrc: 'blob:v' }, {}, 1);
  assert.ok(calls.some(([k]) => k === 'drawImage'), 'a seeking video must reuse its cached frame');
}

// Wheel pitch-bend restarts the transport on every event. Since _startTransport
// is async, a superseded attempt must not pause the shared <video> — that would
// abort the winning attempt's play() promise and kill playback outright.
{
  class SpecVideo {
    constructor(playLatencyMs) {
      this.playLatencyMs = playLatencyMs;
      this.readyState = 4; this.duration = 60; this.videoWidth = 1280; this.videoHeight = 720;
      this.currentSrc = 'blob:test'; this.seeking = false; this.paused = true;
      this.playbackRate = 1; this.muted = true;
      this._time = 0; this._pendingPlays = []; this._listeners = new Map();
    }
    get currentTime() { return this._time; }
    set currentTime(value) {
      this._time = value; this.seeking = true;
      setTimeout(() => { this.seeking = false; this._emit('seeked'); }, 1);
    }
    addEventListener(type, listener, options = {}) {
      const list = this._listeners.get(type) || [];
      list.push({ listener, once: !!options.once });
      this._listeners.set(type, list);
    }
    removeEventListener(type, listener) {
      this._listeners.set(type, (this._listeners.get(type) || []).filter((i) => i.listener !== listener));
    }
    _emit(type) {
      for (const item of [...(this._listeners.get(type) || [])]) {
        item.listener();
        if (item.once) this.removeEventListener(type, item.listener);
      }
    }
    // Per spec, pause() rejects every pending play() promise with AbortError.
    pause() {
      this.paused = true;
      const pending = this._pendingPlays;
      this._pendingPlays = [];
      for (const reject of pending) {
        setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 0);
      }
    }
    play() {
      return new Promise((resolve, reject) => {
        this._pendingPlays.push(reject);
        setTimeout(() => {
          const i = this._pendingPlays.indexOf(reject);
          if (i < 0) return;
          this._pendingPlays.splice(i, 1);
          this.paused = false;
          resolve();
        }, this.playLatencyMs);
      });
    }
  }

  for (const latency of [20, 30, 60]) {
    const video = new SpecVideo(latency);
    let clock = 100;
    const engine = {
      duration: 60,
      ctx: { state: 'running', get currentTime() { return clock; } },
      ensureRunning: async () => true,
      playSegment: () => ({ stop() {} }),
      startStuckLoop() {}, updateStuckLoop() {}, stopStuckLoop() {}, stopAll() {},
    };
    const sus = new SusMachine({
      engine, vfx: { draw() {} }, timelineCanvas: null,
      videoEl: video, imageEl: null, mediaKindGetter: () => 'video',
    });
    sus._active = true;
    sus._drawTimeline = () => {};
    assert.equal(await sus._startTransport(5), true, `transport must start (${latency}ms)`);
    for (let i = 0; i < 6; i++) {
      sus._wheel({ deltaY: -1, preventDefault() {} });
      await new Promise((r) => setTimeout(r, 13)); // trackpad flick cadence
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(sus._transport, `wheel burst must leave a live transport (${latency}ms)`);
    assert.equal(video.paused, false, `video must still be playing (${latency}ms)`);
    assert.equal(sus._transportStarting, false);
  }
}

// The transport drift correction must not become a seek treadmill: a seek costs
// media time, so a threshold below the seek latency re-creates the error that
// triggered it and the video degenerates into a slideshow for the whole track.
{
  const realPerformance = globalThis.performance;
  try {
    for (const latencyMs of [15, 60, 120, 250]) {
      let now = 0;
      globalThis.performance = { now: () => now };
      let mediaTime = 0, seeks = 0, seeking = false, seekLands = 0;
      const video = {
        readyState: 4, duration: 600, videoWidth: 1280, videoHeight: 720,
        currentSrc: 'blob:t', playbackRate: 1, muted: true, paused: false,
        get seeking() { return seeking; },
        get currentTime() { return mediaTime; },
        set currentTime(value) { seeks += 1; mediaTime = value; seeking = true; seekLands = now + latencyMs; },
        addEventListener() {}, removeEventListener() {}, pause() {}, play: async () => {},
      };
      const engine = {
        duration: 600,
        ctx: { state: 'running', get currentTime() { return now / 1000; } },
        ensureRunning: async () => true, playSegment: () => ({ stop() {} }),
        startStuckLoop() {}, updateStuckLoop() {}, stopStuckLoop() {}, stopAll() {},
      };
      const sus = new SusMachine({
        engine, vfx: { draw() {} }, timelineCanvas: null,
        videoEl: video, imageEl: null, mediaKindGetter: () => 'video',
      });
      sus._active = true;
      sus._drawTimeline = () => {};
      sus._transport = { node: { stop() {} }, startPos: 0, startCtxT: 0, rate: 1 };
      for (; now < 8000; now += 1) {
        if (seeking && now >= seekLands) { seeking = false; sus._onVideoSeeked(); }
        // A 300ms pipeline stall pushes drift past the correction threshold.
        if (!seeking && !(now > 1000 && now < 1300)) mediaTime += 0.001;
        if (now % 16 === 0) sus._frame();
      }
      assert.ok(seeks <= 8, `drift correction must converge, got ${seeks} seeks at ${latencyMs}ms`);
      assert.equal(seeking, false, `video must not be left mid-seek at ${latencyMs}ms`);
    }
  } finally {
    globalThis.performance = realPerformance;
  }
}

// A grain is audible instantly but its frame only appears once the video seek
// lands, so a recording captures audio ahead of picture. While recording, the
// audio is scheduled later to meet its frame; live monitoring stays immediate.
{
  const scheduled = [];
  const engine = {
    duration: 30,
    ctx: { state: 'running', currentTime: 500 },
    playGrain: (opts) => { scheduled.push(opts.when); return {}; },
    startStuckLoop() {}, updateStuckLoop() {}, stopStuckLoop() {}, stopAll() {},
    ensureRunning: async () => true,
  };
  const sus = new SusMachine({
    engine, vfx: { draw() {} }, timelineCanvas: null,
    videoEl: { readyState: 4, duration: 30, videoWidth: 1280, videoHeight: 720, currentTime: 0, seeking: false },
    imageEl: null, mediaKindGetter: () => 'video',
  });
  sus._active = true;
  sus._pos = 5;
  sus._seekLatencySec = 0.05; // measured seek cost for this file

  sus._maybeGrain(1000);
  assert.equal(scheduled.at(-1), 0, 'live monitoring must schedule grains immediately');

  sus.setRecording(true);
  sus._maybeGrain(2000);
  const when = scheduled.at(-1);
  assert.ok(when > engine.ctx.currentTime, 'a recorded grain must be scheduled into the future');
  const delay = when - engine.ctx.currentTime;
  assert.ok(Math.abs(delay - 0.05) < 1e-6, `delay must track the measured seek latency, got ${delay}`);
  assert.ok(delay <= 0.12 + 1e-9, 'delay must stay under the playability cap');

  sus.setRecording(false);
  sus._maybeGrain(3000);
  assert.equal(scheduled.at(-1), 0, 'monitoring must return to zero latency after recording');
}

// Arrow-key scratching moves the playhead AND makes a sound (a silent seek
// would feel broken), sets the grain direction, clamps at both ends, keeps a
// rolling transport rolling from the new spot, and never fights the mouse.
{
  const grains = [];
  let transportStarts = 0;
  const engine = {
    duration: 10,
    ctx: { state: 'running', currentTime: 100 },
    playGrain: (opts) => { grains.push(opts); return {}; },
    playSegment: () => ({ stop() {} }),
    ensureRunning: async () => true,
    startStuckLoop() {}, updateStuckLoop() {}, stopStuckLoop() {}, stopAll() {},
  };
  const mk = () => {
    const sus = new SusMachine({
      engine, vfx: { draw() {} }, timelineCanvas: null,
      videoEl: null, imageEl: null, mediaKindGetter: () => 'audio',
    });
    sus._active = true;
    sus._drawTimeline = () => {};
    return sus;
  };

  const sus = mk();
  sus._pos = 5;
  grains.length = 0;
  assert.equal(sus.nudge(0.1), true);
  assert.ok(Math.abs(sus._pos - 5.1) < 1e-9, `forward nudge: ${sus._pos}`);
  assert.equal(sus._dir, 1);
  assert.equal(grains.length, 1, 'a nudge must be audible');
  assert.ok(Math.abs(grains[0].pos - 5.1) < 1e-9);
  assert.equal(grains[0].reverse, false);

  sus._lastGrainT = -1e9; // clear the 35ms grain throttle
  assert.equal(sus.nudge(-0.1), true);
  assert.ok(Math.abs(sus._pos - 5) < 1e-9, `back nudge: ${sus._pos}`);
  assert.equal(sus._dir, -1);
  assert.equal(grains.at(-1).reverse, true, 'a leftward nudge plays reversed');

  // clamped at both ends, and a no-op move reports false
  sus._pos = 0;
  sus._lastGrainT = -1e9;
  assert.equal(sus.nudge(-1), false, 'no movement at the start reports false');
  assert.equal(sus._pos, 0);
  sus._pos = 10;
  sus._lastGrainT = -1e9;
  sus.nudge(5);
  assert.ok(sus._pos <= 10 && sus._pos >= 9.9, `clamped at the end: ${sus._pos}`);

  // garbage in, nothing out
  for (const bad of [undefined, null, NaN, Infinity, 'x', 0]) {
    assert.equal(sus.nudge(bad), false, `nudge(${String(bad)}) must be a no-op`);
  }

  // while the transport rolls, a nudge relocates it instead of going silent
  const rolling = mk();
  rolling._pos = 2;
  rolling._startTransport = (pos) => { transportStarts += 1; rolling._transport = { node: { stop() {} }, startPos: pos, startCtxT: 100, rate: 1 }; return true; };
  rolling._transport = { node: { stop() {} }, startPos: 2, startCtxT: 100, rate: 1 };
  transportStarts = 0;
  rolling.nudge(0.5);
  assert.equal(transportStarts, 1, 'a nudge must restart the transport');
  assert.ok(rolling._transport, 'transport must survive a nudge');
  assert.ok(Math.abs(rolling._transport.startPos - rolling._pos) < 1e-9);

  // a mouse drag owns the playhead: arrows must not fight it
  const dragging = mk();
  dragging._pos = 3;
  dragging._engaged = true;
  assert.equal(dragging.nudge(0.5), false, 'arrows are ignored mid-drag');
  assert.equal(dragging._pos, 3);

  // inactive machine ignores keys entirely
  const off = mk();
  off._active = false;
  off._pos = 1;
  assert.equal(off.nudge(0.5), false);
  assert.equal(off._pos, 1);
}

console.log('regression checks passed');
