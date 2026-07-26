# 💩 YTP-O-MATIC 9000

A 100% client-side YouTube-Poop generator. No backend, no build step, no
dependencies, no dignity. Everything runs in your browser; nothing you feed it
ever leaves your machine.

## Run it

Any static file server works:

```bash
python3 -m http.server 4173 --directory .
```

Then open <http://localhost:4173> in Chrome (best) or any modern browser.
(A plain `file://` open won't work — ES modules need http.)

Run the zero-dependency regression checks with:

```bash
node tests/regression.mjs
```

## Deploy on Cloudflare Pages

Connect this GitHub repository in Cloudflare Pages and use:

- Production branch: `main`
- Framework preset: `None`
- Build command: leave blank
- Build output directory: `.`

The app is entirely static; there are no dependencies or environment variables.
Live at <https://ytp9000.pages.dev>.

Because there is no build step, `js/` and `css/` filenames never change between
deploys, so `_headers` marks them `no-cache` (revalidate, don't re-download).
Without it a visitor can end up holding one stale module beside a fresh one,
which fails in ways that look like ghost bugs rather than caching.

## 💩 POOP MACHINE

Drop in (or browse for) any of:

- **a video file** — the classic. Audio is demuxed and pooped along with the picture.
- **an audio file** — visuals become a rainbow spectrum visualizer with a pulsing 🗿.
- **an image** — a robo-voice solemnly announces your image while it gets destroyed.

The stage takes on your media's shape, so vertical video stays vertical (and
exports vertical) instead of being cropped to a horizontal sliver.

Want a YouTube video? Download it yourself and drop the file in — browsers
can't fetch it (CORS), and ripping it isn't ours to automate.

**LENGTH** picks how long the result runs — 5s / 10s / 20s (default) / 45s, or
**FULL ⚠** to poop the entire source at your own risk (a long video makes a long,
heavy edit; you get a warning past a minute). **⚡ lite** halves the stage
resolution, which is what actually rescues playback on a tired phone — it turns
itself on for small screens and low-core devices.

Crank the CHAOS dial (1–11), pick your poisons — stutter, reverse, speed
chaos, pitch demons, earrape (off by default, it's *actually loud*), jump
cuts, visual glitches, Impact captions — and hit **POOP IT**. Every edit is
seeded: the seed is shown, and **RE-POOP** rolls a new one.

Captions come in **EN / RU / BOTH** (🗣 selector): the Russian pool ships
classics like «ЭТО ФИАСКО, БРАТАН» and «МАМ, Я В ТЕЛЕВИЗОРЕ», and in RU mode
the final flash bang says «ПОКАКАНО.»

**📼 RECORD & DOWNLOAD** replays the current edit while capturing the canvas
and audio in real time with MediaRecorder, then downloads a genuine **`.mp4`
(H.264 + AAC)** — posts and plays inline everywhere, including Telegram.
(Browsers whose MediaRecorder can't mux mp4 fall back to `.webm`.) Keep the
tab visible while it cooks — hidden tabs get their frame rate strangled by
the browser.

## 📼 SUS MACHINE

Load anything with audio and switch tabs. You get a rainbow waveform timeline:

- **drag across it** — playback follows your mouse: direction = play direction,
  speed = playback rate, like scrubbing a haunted tape deck.
- **stop moving** — you get *stuck*: a ~100 ms slice loops with pitch wobble
  and occasional re-grabs, exactly like the good glitch. Visuals RGB-split
  while you're stuck.
- **▶ PLAY (or spacebar)** — normal playback from the playhead. Grab the
  timeline mid-play to scratch; let go and it keeps rolling from where you
  released it, like a record deck.
- **🧼 clean scroll** — no pitch warp: grains and stuck loops play at the
  source's original pitch/speed. Scrubbing sounds like honest audio and the
  stuck loop becomes a perfect skipping-CD. Often funnier.
- **mouse wheel** — pitch-bend the whole instrument ±1 octave.
- **← / →** — scratch from the keyboard: each press steps the playhead *and*
  plays that slice (leftwards plays reversed), so holding a key rides the key
  repeat into a continuous scratch. Hold **shift** for 1-second jumps. Works
  while it's playing too — it keeps rolling from the new spot.
- **🔒 latch** — release the mouse and let the loop run forever. It's art.
- **🔴 RECORD PERFORMANCE** — capture your scrubbing session as a video file.

## Языки / Languages

The whole interface speaks English and Russian — hit the **EN / RU** switch in
the header. It remembers your choice and starts in Russian if that's your
browser's language. (Captions inside the video are a separate setting, so you
can have an English UI pooping Russian captions.)

## Console toys

`window.YTP` exposes `{ engine, vfx, conductor, sus, exporter, state }` if you
want to poke the machinery from DevTools.

## Architecture (for the curious)

```
js/audio-engine.js   Web Audio: decoding, reversed buffers, grains, stuck
                     loops, earrape waveshaper, robo-voice synth, record tap
js/ytp-generator.js  seeded EDL generator + Conductor (sample-accurate audio
                     scheduling, best-effort video seeking) + MediaRecorder Exporter
js/visual-fx.js      canvas fx: filters, zoom punch, shake, mirror, rgb split,
                     rainbow, Impact captions, audio visualizer
js/sus-machine.js    the scrub instrument: waveform timeline, pointer velocity
                     → grain playback, stuck-loop detection, latch
js/main.js           app state, loading matrix, tabs, toasts, export flows
js/i18n.js           EN/RU string tables + the data-i18n DOM localizer
```

Audio is the clock: segments are scheduled sample-accurately on the
AudioContext timeline from reversed/forward buffer copies; the video element
just does its best to keep up, which is honestly very in-genre.

Built by a fleet of Claude agents.
