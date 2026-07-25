# YTP-O-MATIC 9000 — Build Spec (v1)

A 100% client-side website that generates YouTube-Poop-style chaos edits from
video / audio / image / text input, plus a "SUS MACHINE" mouse-scrub glitch
instrument. No backend, no build step, no npm dependencies. Plain ES modules.
Target: latest desktop Chrome (degrade gracefully elsewhere). Served statically.

## File tree (all paths relative to repo root)

```
index.html          — page shell, all DOM (agent: UI)
css/style.css       — all styling (agent: UI)
js/main.js          — app state + wiring (agent: UI)
js/audio-engine.js  — AudioEngine class (agent: AUDIO)
js/visual-fx.js     — VisualFX class + CAPTIONS pool (agent: VFX)
js/ytp-generator.js — generateEDL + Conductor + Exporter (agent: GEN)
js/sus-machine.js   — SusMachine class (agent: SUS)
```

Every agent: write COMPLETE, WORKING code. No TODOs, no stubs, no placeholder
comments. Header comment in each file: one line saying what it is. Code style:
modern ES2022, `const`/`let`, small helper functions, no classes beyond those
specified. Do not import anything not listed in your file's "imports" section.

## Global conventions

- All modules are ES modules (`export` / `import`). index.html loads only
  `<script type="module" src="js/main.js"></script>`.
- The ONE shared AudioContext lives in AudioEngine (`engine.ctx`).
- The ONE main canvas is `#stage` (1280×720 internal resolution, CSS-scaled).
- Seeded RNG everywhere in generation: mulberry32. GEN exports it:
  `export function mulberry32(seed)` → returns `() => float in [0,1)`.
- Time units: seconds (float) everywhere unless a name ends in `Ms`.
- Nothing throws on bad input; catch, `console.warn`, and continue.

---

## js/audio-engine.js  (agent: AUDIO)

Imports: none.

```js
export class AudioEngine {
  ctx            // AudioContext, created in constructor (may start suspended)
  buffer         // AudioBuffer|null — decoded source audio
  masterGain     // GainNode — final volume (default 1.0)
  fxIn           // GainNode — ALL sources connect here
  analyser       // AnalyserNode (fftSize 2048), tapped off masterGain
  recordDest     // MediaStreamAudioDestinationNode fed by masterGain
}
```

Audio graph, built once in constructor:
`fxIn → shaper(WaveShaperNode) → masterGain → ctx.destination`
also `masterGain → analyser` and `masterGain → recordDest`.
`shaper.curve` is null (bypass) by default.

Methods:
- `async ensureRunning()` — `await ctx.resume()` if suspended; return whether
  the context actually reached `running`. Never throws.
- `async loadFromFile(file)` → `Promise<boolean>` — `file.arrayBuffer()` then
  `ctx.decodeAudioData`. Works for audio files AND video containers (Chrome
  demuxes mp4/webm/mov audio tracks). On failure return false, set
  `this.buffer = null`. Success: cache buffer, invalidate reversed cache,
  return true. NOTE: decodeAudioData detaches the ArrayBuffer — never reuse it.
- `setRoboVoiceFromText(text)` → `Promise<AudioBuffer>` — synthesize an
  Undertale/Animal-Crossing-style dialogue voice with OfflineAudioContext
  (mono, 44100 Hz): for each character: letters → a short square-wave blip,
  ~0.055s + gap 0.03s, frequency `150 + (lowercased charCode % 26) * 16` Hz
  with a slight downward pitch ramp per blip and a 5ms attack / 20ms release
  gain envelope (no clicks); vowels 1.4× longer; space → 0.06s silence;
  `.`/`,`/`!`/`?` → 0.18s silence. Cap text at 400 chars. Render, set
  `this.buffer` to the result, return it.
- `get duration()` — `buffer?.duration ?? 0`.
- `getReversed()` → AudioBuffer — lazily build + cache a copy with every
  channel's samples reversed.
- `setEarrape(on)` — on: `masterGain.gain = 2.5` and set `shaper.curve` to a
  hard-clip curve (`Math.tanh(x * 12)`, 1024 samples, oversample '4x');
  off: gain 1, curve null.
- `playSegment({start, duration, rate = 1, reverse = false, when = 0, detune = 0, gainMul = 1})`
  → AudioBufferSourceNode|null. Creates a one-shot AudioBufferSourceNode from
  `buffer` (or `getReversed()` when reverse; map offset: reversedStart =
  totalDur - start - duration). `when` is an ABSOLUTE ctx.currentTime value
  (if `when < ctx.currentTime` use ctx.currentTime). Per-segment GainNode with
  3ms micro-fades in/out to avoid clicks, `gain = gainMul`, → fxIn. `detune`
  in cents via `source.detune`. Clamp start/duration into buffer bounds; if
  degenerate (<10ms) return null. Track the node in an internal Set; remove
  `onended`.
- `playGrain({pos, dur = 0.06, rate = 1, reverse = false, gainMul = 1})` —
  sugar over playSegment with a full triangle envelope (ramp up half, down
  half). Used ~every 40ms by the sus scrubber.
- `startStuckLoop({pos, windowSec = 0.12, rate = 1})` — ONE looping
  AudioBufferSourceNode: `loop = true`, `loopStart = pos`,
  `loopEnd = min(pos + windowSec, duration)`, start at loopStart, through its
  own GainNode (20ms fade-in) → fxIn. Store as `this._stuck`. If one is
  already running, stop it first (with 20ms fade-out).
- `updateStuckLoop({rate, detune})` — mutate the running stuck source's
  playbackRate/detune (no-op if none).
- `stopStuckLoop()` — 20ms fade-out then stop; clear `_stuck`.
- `stopAll()` — stop stuck loop and every tracked segment source (try/catch
  around each `.stop()`), clear the Set.
- `getWaveformPeaks(numBuckets)` → Float32Array(numBuckets), max |sample| of
  channel 0 per bucket, normalized so overall max = 1. Empty buffer → zeros.

## js/visual-fx.js  (agent: VFX)

Imports: none.

```js
export const CAPTIONS = [ /* ~25 all-caps meme strings, see below */ ];
export class VisualFX {
  constructor(canvas)      // canvas = #stage; get 2d context; W=1280 H=720
  setAnalyser(analyser)    // AnalyserNode for the visualizer
  draw(source, fx, tSec)   // call every rAF
}
```

- `source`: HTMLVideoElement (even while seeking), HTMLImageElement, or null
  (null ⇒ audio-only visualizer). Seeking video holds the last confirmed frame.
- `fx` (all optional, this exact shape — GEN and SUS produce it):

```js
{ invert: 0|1, hue: degrees, saturate: number (1 = normal), zoom: number
  (1 = none, up to ~1.8), zoomCx: 0..1, zoomCy: 0..1, shake: px, mirror: bool,
  rainbow: bool, flash: 0..1, caption: string|null, rgbSplit: 0..~8 (px) }
```

draw() behavior, in order:
1. Fill background `#000`.
2. Compute draw transform: cover-fit source into 1280×720; apply zoom about
   (zoomCx, zoomCy); add shake as `(Math.random()*2-1)*shake` px offsets on
   both axes.
3. `ctx.filter` from invert/hue/saturate (only include non-default parts,
   else 'none'). Draw source. If mirror: also draw the right half as a
   mirrored copy of the left (classic YTP mirror mode).
4. rgbSplit > 0: two extra draws with `globalCompositeOperation='screen'`,
   `globalAlpha=0.5`, offset ±rgbSplit px horizontally, hue-rotated ±120deg.
5. rainbow: full-canvas overlay `hsl((tSec*240)%360 70% 50%)` with
   `globalCompositeOperation = 'hue'`, alpha 0.85.
6. flash > 0: white overlay with alpha = flash.
7. caption: Impact-style meme text ('bold 72px Impact, "Arial Black",
   sans-serif', white fill, black stroke lineWidth 8, strokeText THEN
   fillText, centered, bottom at y=690, wrap/shrink to fit 1200px width).
8. Visualizer (source==null): if analyser set, getByteFrequencyData; draw
   ~64 mirrored bars from center, hue = bar index * 6 + tSec*120; plus a
   center emoji (cycle 💩😂🔥📼🗿 every 0.7s) whose font size pulses with
   average level (base 140px + level*160). No analyser → pulsing 💩 only.

State resets: save/restore around draw(); never leak filter/alpha/transform.

CAPTIONS pool (~25, this spirit): "GET POOPED", "?????", "bruh.", "MOM GET THE
CAMERA", "[SCREAMS GEOMETRICALLY]", "ok.", "WHY", "ｓｕｓ", "HE NEEDS SOME
MILK", "NO U", "*dies*", "WAIT THAT'S ILLEGAL", "cursed.", "THE PROPHECY IS
TRUE", "hmmmmmmm", "💀💀💀", "LOCAL MAN RUINS EVERYTHING", "not like this",
"[CITATION NEEDED]", "AAAAAAAAAAAA", "do not.", "YOU FEEL YOUR SINS CRAWLING",
"we live in a society", "INHALES", "gg no re".

## js/ytp-generator.js  (agent: GEN)

Imports: none (self-contained; receives engine/vfx instances).

```js
export function mulberry32(seed) // standard mulberry32 → () => [0,1)
export function generateEDL({duration, chaos, seed, toggles})
export class Conductor extends EventTarget { constructor({engine, vfx, videoEl, imageEl, canvas}) }
export class Exporter { constructor({canvas, engine}) }
```

### generateEDL
- `duration`: source audio duration (s). `chaos`: 1..11. `seed`: uint32.
- `toggles`: `{stutter, reverse, speed, pitch, earrape, jumpcuts, visuals, captions}` booleans.
- Returns `{seed, totalOut, events: Segment[]}` where Segment =

```js
{ tOut,        // absolute output-time this event starts (s)
  srcStart,    // source position (s)
  srcDur,      // duration IN SOURCE TIME (s)
  rate,        // playbackRate (0.25..4)
  reverse,     // bool
  detune,      // cents (source.detune)
  gainMul,     // 1 normally; 2.5 during earrape bursts
  earrape,     // bool → Conductor calls engine.setEarrape around it
  repeat,      // 1 = normal; 2..8 = stutter (segment replayed back-to-back)
  fx,          // VisualFX fx object for this event's span (may be {})
  caption }    // string|null
```

Algorithm: let `p = chaos / 11`. Target output length
`targetOut = clamp(duration, 4, 45)`. Walk a source cursor from a random
start; build events until sum of output durations ≥ targetOut. Per event:
- base srcDur: lerp(0.9, 0.15, p) .. lerp(2.2, 0.6, p) (uniform)
- jumpcuts on: probability `0.2 + 0.6*p` → cursor teleports to random source
  position; else advances sequentially (wrap around end)
- stutter on: prob `0.25*p+0.05` → repeat 2..(2+round(6*p)), srcDur 0.08..0.4
- reverse on: prob `0.25*p`
- speed on: prob `0.35*p` → rate from [0.25,0.5,1.5,2,3,4] weighted wilder
  with chaos; else rate 1
- pitch on: prob `0.3*p` → detune ±(400 + 2000*p) cents (rounded)
- earrape on: prob `0.06*p` (max 1s of srcDur, gainMul 2.5, earrape: true)
- visuals on: prob `0.5*p` → random fx combo (1–3 of: invert flash, hue spin
  (hue 90/180/270), saturate 3, zoom 1.15–1.7 punch at random cx/cy, shake
  4–14, mirror (prob 0.15), rainbow (prob 0.2), rgbSplit 2–6)
- captions on: prob `0.15 + 0.15*p` → random CAPTION (Conductor imports? NO —
  main.js passes captions through: generateEDL takes captions from... )

  ⚠ To keep GEN dependency-free: generateEDL picks `caption: true|null`
  (a boolean flag), and Conductor — which receives vfx — swaps `true` for a
  random string from `CAPTIONS` at load(). GEN imports NOTHING. Conductor may
  import CAPTIONS from './visual-fx.js'.

Event output duration = `srcDur / rate * repeat`. tOut accumulates. Final
event: fx `{flash: 1}`, caption "GET POOPED", srcDur 0.4, rate 1.

### Conductor
Plays an EDL live: audio scheduled sample-accurately on engine's clock; video
element seeks along best-effort; vfx drawn every rAF.

- `load(edit)` — store; resolve caption flags to strings (seeded by
  edit.seed); reset state.
- `async play()` — require `await engine.ensureRunning()` to succeed; `t0 = ctx.currentTime +
  0.15`. Scheduler tick (setInterval 50ms): schedule every audio event whose
  `t0 + ev.tOut` is within 0.25s lookahead via `engine.playSegment({...,
  when: t0 + ev.tOut + k*(srcDur/rate)})` for each repeat k (reverse flag
  passthrough; earrape events also toggle engine.setEarrape(true) at schedule
  time and back off after — track with setTimeout at the right delay).
  rAF loop: `tNow = ctx.currentTime - t0`; find current event (binary search
  or linear pointer); drive video: on event change, `videoEl.currentTime =
  ev.srcStart` (+ for reverse: step currentTime backwards ~each frame by
  rate/60; forward: `videoEl.playbackRate = clamp(rate, 0.0625, 16)` and
  `videoEl.play()`); videoEl always muted. Stutter repeats: re-seek at each
  repeat boundary. Then `vfx.draw(source, ev.fx merged with {caption}, tNow)`.
  source = videoEl if video media, imageEl if image, null otherwise.
  Dispatch `progress` CustomEvent (detail `{tNow, totalOut, i}`) each rAF.
  When `tNow ≥ totalOut`: stop scheduler, engine.stopAll(),
  engine.setEarrape(false), videoEl.pause(), dispatch `ended`, resolve.
- `stop()` — same teardown, dispatch `ended`, resolve play()'s promise early.
- `get isPlaying()`.

Robustness: all video seeks in try/catch; never let a media error kill the
rAF loop; guard `videoEl.readyState`.

### Exporter
- `static pickMime()` — prefer supported MP4 H.264/AAC variants, then
  `video/webm;codecs=vp9,opus`, `video/webm;codecs=vp8,opus`, `video/webm`,
  and finally bare `video/mp4` (`MediaRecorder.isTypeSupported`).
- `start()` — `canvas.captureStream(30)` video track + `engine.recordDest.stream`
  audio track → combined MediaStream → MediaRecorder (pickMime,
  videoBitsPerSecond 6_000_000), collect chunks on `dataavailable`, `start(250)`;
  return true or throw after cleanup when recording cannot start.
- `async stop()` → Promise<Blob> — onstop → resolve Blob(chunks, {type: mime});
  reject recorder errors and a bounded stop timeout.

## js/sus-machine.js  (agent: SUS)

Imports: none (receives instances).

```js
export class SusMachine {
  constructor({engine, vfx, timelineCanvas, videoEl, imageEl, mediaKindGetter})
  activate()    // start its own rAF loop (timeline + stage drawing)
  deactivate()  // stop rAF, engine.stopStuckLoop(), engine.stopAll()
}
```

`mediaKindGetter` = `() => 'video'|'audio'|'image'|'text'`.

Timeline canvas: internal size = its CSS box × devicePixelRatio (resize on
activate + on window resize). Render each frame:
- bg #1a0b2e; waveform from `engine.getWaveformPeaks(width/2)` as mirrored
  vertical bars around the mid-line, rainbow gradient (hue = x/width*300).
- playhead: 3px vertical line at current position, white + glow.
- while stuck-looping: highlight the loop window (translucent #ff2d78 rect)
  and make the playhead strobe (alternate white/#ff2d78 every 60ms).

Pointer interaction (Pointer Events, `setPointerCapture`):
- `pointerdown` → engaged; `engine.ensureRunning()`.
- While engaged, each `pointermove`: `pos = clamp(offsetX/width) * duration`.
  Velocity: EMA of dx/dt (px/s) → `rate = clamp(|velEMA| / (width/6), 0.25, 3.5)`,
  direction = sign of recent dx. Spawn `engine.playGrain({pos, dur: 0.07,
  rate, reverse: dir < 0, gainMul: 0.9})` at most every 35ms. Kill any stuck
  loop on real movement (>2px).
- STUCK DETECTION: while engaged, if no move > 2px for 130ms →
  `engine.startStuckLoop({pos, windowSec: 0.06 + rand*0.14, rate: lastRate})`;
  every ~180ms while stuck: `engine.updateStuckLoop({detune: ±80 cents
  random})`, and with prob 0.15 restart the loop with a new random windowSec
  (the glitch "re-grab"). Track stuck state + window for the timeline render.
- `pointerup`/`pointercancel`/`pointerleave`: if `#sus-latch` checkbox is
  checked and currently stuck → leave the loop RUNNING (latched); else stop
  everything. Next pointerdown always clears latched loop.
- Wheel on timeline: pitch offset ±100 cents per notch, clamped ±1200,
  applied to grains (as detune via rate multiplier `2^(cents/1200)`) and
  `updateStuckLoop`. Reset to 0 on pointerdown.

Stage while active: video → throttled seek `videoEl.currentTime = pos`
(retain one latest target while `videoEl.seeking`, then apply on `seeked`), draw via
`vfx.draw(videoEl, fx, t)`; image → imageEl; audio/text → null (visualizer).
fx: normally `{}`; while stuck: `{rgbSplit: 3 + rand*3, shake: 3,
hue: (t*400)%360 with alpha... just hue: (t*90)%40 }` — keep it: rgbSplit
3–6 random per frame, shake 3, plus `caption: null`. While latched add
`{rainbow: true}` every other 0.5s. Keep it subtle enough to read the video.

Normal video transport waits for its seek/play to begin, then anchors Web Audio
to the video's actual media time; correct drift above ~80 ms. Recording:
main.js reuses Exporter (start/stop buttons) — SusMachine needs no recording
code. Expose `get currentPos()` for main.js if trivial.

## index.html + css/style.css + js/main.js  (agent: UI)

main.js imports: `AudioEngine` from './audio-engine.js', `VisualFX` from
'./visual-fx.js', `generateEDL, Conductor, Exporter` from
'./ytp-generator.js', `SusMachine` from './sus-machine.js'.

### DOM (exact IDs — other agents rely on none of these except #sus-latch)

- `header`: `<h1>💩 YTP-O-MATIC 9000</h1>`, tagline `<div id="tagline">` with
  CSS marquee-style scrolling text ("THE MIRACLE NOBODY ASKED FOR ★ 100% ARTIFICIAL
  STUPIDITY ★ NO REFUNDS ★ ..." repeated).
- `#dropzone` (visible at start, fills main area): big dashed box, "DROP A
  VIDEO / AUDIO / IMAGE HERE" + `<input type="file" id="file-input"
  accept="video/*,audio/*,image/*">` styled as a button ("...or click to
  browse"); below, two mini-forms:
  - text-to-poop: `<textarea id="text-input" placeholder="type something dumb…">`
    + `<button id="text-load-btn">🤖 POOP MY WORDS</button>`
  - youtube troll: `<input id="yt-input" placeholder="paste a YouTube link…">`
    + `<button id="yt-btn">🔗 GO</button>` → ALWAYS just shows toast:
    "❌ browsers can't rip YouTube (CORS + lawyers said no). Download the
    file yourself and drop it here 💅" — never fetches anything.
- `#app` (hidden until media loads):
  - tabs: `<button id="tab-poop" class="tab active">💩 POOP MACHINE</button>`
    `<button id="tab-sus" class="tab">📼 SUS MACHINE</button>`
    `<button id="eject-btn">⏏ EJECT</button>` (back to dropzone; full teardown)
  - `<div id="stage-wrap"><canvas id="stage" width="1280" height="720"></canvas></div>`
  - `#poop-panel`:
    - chaos: `<input type="range" id="chaos" min="1" max="11" value="7">` with
      `<span id="chaos-label">` showing value; at 11 the label says
      "11 (WHY.)" and the slider thumb wiggles (CSS)
    - toggles (checkboxes, all checked by default EXCEPT earrape):
      `#tgl-stutter #tgl-reverse #tgl-speed #tgl-pitch #tgl-earrape
       #tgl-jumpcuts #tgl-visuals #tgl-captions` with labels
      (earrape label: "🔊 earrape (⚠ actually loud)")
    - buttons: `<button id="poop-btn">💩 POOP IT</button>`
      `<button id="reroll-btn">🎲 RE-POOP</button>`
      `<button id="stop-btn">🛑 STOP</button>`
      `<button id="export-btn">📼 RECORD & DOWNLOAD</button>`
    - `<div id="seed-label">` (shows "seed: 123456789" after generation)
    - `<progress id="poop-progress" max="1" value="0">` (playback progress)
  - `#sus-panel` (hidden): instructions line ("scrub the timeline with your
    mouse. stop moving = get stuck. it's art."), `<canvas id="timeline"></canvas>`
    (block, 100% width, 110px CSS height), `<label><input type="checkbox"
    id="sus-latch"> 🔒 latch loop on release</label>`,
    `<button id="sus-record-btn">🔴 RECORD PERFORMANCE</button>`
    `<button id="sus-stop-btn" disabled>⏹ STOP & DOWNLOAD</button>`
- `#toasts` (fixed, bottom-right stack).
- Hidden media: `<video id="src-video" muted playsinline crossorigin="anonymous"></video>`
  `<img id="src-image" alt="">` — both `display:none`.

### main.js behavior

State: `{ mediaKind, engine, vfx, conductor, sus, exporter, currentEdit,
objectUrl }`. Construct engine/vfx once at startup; `vfx.setAnalyser(engine.analyser)`.

- Loading a FILE (drop anywhere on #dropzone OR file input): detect kind by
  MIME prefix. video/* → set videoEl.src = URL.createObjectURL(file), await
  `loadedmetadata`; ALSO `await engine.loadFromFile(file)`; if audio decode
  fails → toast "no audio track I can chew — video will be SILENT chaos"
  and synthesize 30s of robo-noise? NO — instead set engine buffer via
  `setRoboVoiceFromText("no audio no audio no audio aaaaaa")` for comedy.
  audio/* → engine.loadFromFile; mediaKind 'audio'. image/* → imageEl.src =
  objectURL, mediaKind 'image', AND engine.setRoboVoiceFromText(file.name
  repeated to ~10s? no—) → for images: engine.setRoboVoiceFromText(
  "behold. an image. " + file.name.replace(/\.\w+$/, '') + " aaaaa") so there
  is audio to poop. text (from textarea): `setRoboVoiceFromText(text)`,
  mediaKind 'text'.
  On success: hide dropzone, show #app, toast "✅ LOADED. NOW POOP IT.",
  auto-generate a first edit (see POOP IT) but do NOT auto-play (autoplay
  policies) — show toast "press 💩".
- Drag & drop: prevent default on dragover/drop at document level; drop
  anywhere works even when #app visible (replaces media: full teardown first).
- POOP IT (#poop-btn): stop current playback; read chaos + toggles;
  `seed = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0`;
  `currentEdit = generateEDL({duration: engine.duration, chaos, seed, toggles})`;
  conductor.load(currentEdit); update #seed-label; conductor.play().
- RE-POOP: same but keeps prior toggles (identical to POOP IT — it exists
  because it's funny to have both).
- STOP: conductor.stop().
- EXPORT (#export-btn): if no currentEdit → toast "poop first."; else stop,
  exporter.start(), conductor.load(currentEdit) + play(); on conductor
  'ended' → blob = await exporter.stop(); download via temp `<a download>`:
  filename `ytp-${seed}.webm` (or .mp4 if mime is mp4). Disable buttons while
  exporting; label export button "🔴 RECORDING… (watch it cook)". Toast the
  file size when done ("💾 12.3 MB of pure damage").
- Progress: conductor 'progress' → `#poop-progress.value = tNow/totalOut`.
- Tabs: poop tab ↔ sus tab. Switching to sus: conductor.stop(),
  sus.activate(). Switching away: sus.deactivate(). Sus tab disabled with
  toast if mediaKind === 'image' AND engine.duration === 0 (shouldn't happen
  since images get robo audio).
- Sus recording: use a generation token across AudioContext resume/start/stop;
  enable Stop only after exporter.start() succeeds. Stop downloads a non-empty
  `sus-performance.webm`/`.mp4`, then re-enables controls.
- Eject: stop/teardown (conductor.stop(), sus.deactivate(), reset SUS position,
  engine.stopAll(), clear decoded buffer, revoke objectUrl, clear srcs), show dropzone.
- Toast helper: `toast(msg, ms = 3500)` — div into #toasts, CSS
  animate in/out, remove after ms.
- A rAF "idle renderer" in main.js keeps the stage canvas painted whenever
  NEITHER conductor is playing NOR sus is active (draw current video frame /
  image / visualizer with fx={}). This matters: captureStream needs a
  continuously-painted canvas, and the app should never show a dead black box.
  Pause it while conductor plays or sus is active (they draw).
- First-gesture unlock: on first pointerdown anywhere, `engine.ensureRunning()`.

### style.css — THE VIBE

Deep-fried Geocities-meets-vaporwave, but genuinely usable:
- bg: #12081f with a subtle repeating-linear-gradient scanline overlay.
- Title: huge, font stack `Impact, "Arial Black", sans-serif`, rainbow
  gradient text (background-clip: text), slight permanent 1.5deg rotation,
  `animation: wiggle` on hover.
- tagline: white-on-magenta strip, infinite marquee via CSS keyframes
  (translateX), ★ separators.
- Buttons: chunky, thick 3px black borders, hard drop shadows (4px 4px 0 #000),
  hover: translate(-2px,-2px) + bigger shadow; active: translate(2px,2px) +
  no shadow. #poop-btn is BIG and gradient hot-pink/orange with a subtle
  pulsing animation. Emoji cursor on buttons:
  `cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><text y="24" font-size="24">💩</text></svg>') 16 16, pointer;`
- Stage: centered, max-width 960px, aspect-ratio 16/9, black, 4px solid #fff,
  border-radius 12px, `box-shadow: 0 0 40px rgba(255,45,120,.35)`.
- Range slider: custom thumb (24px, hot pink, black border). At value 11
  main.js adds class `maxchaos` to body → thumb + chaos-label get a fast
  shake keyframe animation.
- Checkboxes: accent-color hot pink; labels are little pill chips, checked
  chips get the gradient bg.
- Timeline canvas: full-width, 110px, rounded, crosshair cursor.
- Toasts: black bg, white text, 3px white border, hard shadow, slide-in from
  right, comic style.
- Tabs: fat top-rounded tabs, active = gradient bg + black text.
- Everything keyboard-focusable gets a loud focus ring (accessibility, 3px
  dashed #0ff). Respect `prefers-reduced-motion`: disable wiggle/marquee/
  pulse animations.
- Font for body text: system stack, but headers/buttons Impact-ish.
- Mobile: single column, stage full-width; it should not be broken on a
  phone, but desktop is the target.

## Shared gotchas (ALL agents)

- AudioContext starts suspended until a user gesture → `ensureRunning()`
  before any playback. Never assume resume() succeeded synchronously.
- `AudioBufferSourceNode` is one-shot: new node per grain/segment. Negative
  playbackRate is NOT a thing — reverse = reversed buffer copy.
- Always envelope grain/segment edges (≥3ms ramps) or you get clicks.
- `video.playbackRate` throws on values outside ~[0.0625, 16] in Chrome —
  clamp. `video.currentTime` seeks are async — guard with `seeking` flag /
  'seeked' events; retain one latest target rather than queueing unboundedly.
- MediaRecorder: feed it a canvas that's being painted every frame; call
  `start(250)` for periodic chunks; build final Blob with the ACTUAL mime used.
- `ctx.filter` on canvas 2D: reset to 'none' after use (save/restore).
- Object URLs: revoke old ones on replace/eject.
- No top-level await in modules that main.js imports (Safari quirk history) —
  constructors synchronous, async work in methods.
