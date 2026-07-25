import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const asDataModule = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

async function loadModule(path) {
  return import(asDataModule(await fs.readFile(new URL(path, import.meta.url), 'utf8')));
}

const visualSource = await fs.readFile(new URL('../js/visual-fx.js', import.meta.url), 'utf8');
const visualUrl = asDataModule(visualSource);
const generatorSource = (await fs.readFile(new URL('../js/ytp-generator.js', import.meta.url), 'utf8'))
  .replace("'./visual-fx.js'", `'${visualUrl}'`);

const [{ AudioEngine }, { SusMachine }, visualModule, generatorModule] = await Promise.all([
  loadModule('../js/audio-engine.js'),
  loadModule('../js/sus-machine.js'),
  import(visualUrl),
  import(asDataModule(generatorSource)),
]);
const { VisualFX } = visualModule;
const { Conductor, Exporter, generateEDL } = generatorModule;

globalThis.document = { getElementById: () => null };

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

console.log('regression checks passed');
