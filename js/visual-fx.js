// visual-fx.js — VisualFX canvas compositor (cover-fit + zoom/shake/filters, mirror, rgbSplit, rainbow, flash, Impact captions, audio visualizer) and the CAPTIONS meme pool.

export const CAPTIONS = [
  'GET POOPED',
  '?????',
  'bruh.',
  'MOM GET THE CAMERA',
  '[SCREAMS GEOMETRICALLY]',
  'ok.',
  'WHY',
  'ｓｕｓ',
  'HE NEEDS SOME MILK',
  'NO U',
  '*dies*',
  "WAIT THAT'S ILLEGAL",
  'cursed.',
  'THE PROPHECY IS TRUE',
  'hmmmmmmm',
  '💀💀💀',
  'LOCAL MAN RUINS EVERYTHING',
  'not like this',
  '[CITATION NEEDED]',
  'AAAAAAAAAAAA',
  'do not.',
  'YOU FEEL YOUR SINS CRAWLING',
  'we live in a society',
  'INHALES',
  'gg no re',
];

export const CAPTIONS_RU = [
  'ЧТО.',
  'ПОЧЕМУ',
  'ЭТО ФИАСКО, БРАТАН',
  'НУ И ГДЕ СМЕЯТЬСЯ',
  'МАМ, Я В ТЕЛЕВИЗОРЕ',
  '[КРИЧИТ ГЕОМЕТРИЧЕСКИ]',
  'СЛЫШЬ',
  'ЭТО БАЗА',
  'КРИНЖ.',
  'сус.',
  'ЖЕСТЬ',
  'ВОТ ЭТО ПОВОРОТ',
  'Я В ШОКЕ',
  'ДЕРЖИТЕ МЕНЯ СЕМЕРО',
  'ЗА ЧТО',
  'ПРОСТИТЕ.',
  'ЭТО НЕ БАГ, ЭТО ФИЧА',
  'ПОЕХАЛИ!',
  'НУ ТАКОЕ',
  'ОТМЕНА.',
  'ШЕДЕВР',
  'УХОДИ',
  'ВСЁ ПО ПЛАНУ',
  'АААААААА',
  'НЕ ДЕЛАЙ ТАК',
  'ЭТО ВООБЩЕ ЗАКОННО?',
  'ВАЙБ ИСПОРЧЕН',
  'ОПЯТЬ ТЫ',
];

const W = 1280;
const H = 720;
const CAPTION_MAX_WIDTH = 1200;
const CAPTION_BOTTOM_Y = 690;
const CAPTION_MAX_SIZE = 72;
const CAPTION_MIN_SIZE = 22;
const CAPTION_MAX_LINES = 3;
const VIS_EMOJIS = ['💩', '😂', '🔥', '📼', '🗿'];
const VIS_BAR_PAIRS = 32; // 32 per side = 64 mirrored bars

const captionFont = (size) => `bold ${size}px Impact, "Arial Black", sans-serif`;

function toNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clampNum(v, def, min, max) {
  const n = toNum(v, def);
  return n < min ? min : n > max ? max : n;
}

// CSS filter string from fx (only non-default parts, else 'none').
function buildFilter(fx) {
  const parts = [];
  if (fx.invert) parts.push('invert(1)');
  const hue = toNum(fx.hue, 0);
  if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`);
  const sat = toNum(fx.saturate, 1);
  if (sat !== 1 && sat >= 0) parts.push(`saturate(${sat})`);
  return parts.length ? parts.join(' ') : 'none';
}

function withExtraHue(baseFilter, deg) {
  const extra = `hue-rotate(${deg}deg)`;
  return baseFilter === 'none' ? extra : `${baseFilter} ${extra}`;
}

// Greedy word wrap at the ctx's CURRENT font.
function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const test = `${line} ${words[i]}`;
    if (ctx.measureText(test).width <= maxW) {
      line = test;
    } else {
      lines.push(line);
      line = words[i];
    }
  }
  lines.push(line);
  return lines;
}

export class VisualFX {
  constructor(canvas) {
    this.canvas = canvas || null;
    this.ctx = null;
    try {
      this.ctx = canvas ? canvas.getContext('2d') : null;
    } catch (err) {
      console.warn('VisualFX: getContext failed', err);
    }
    if (!this.ctx) console.warn('VisualFX: no 2d context; draw() will be a no-op');
    this._analyser = null;
    this._freq = null;
    this._capCache = null; // { text, size, lines }
    this._lastWarnMs = -Infinity;
    // Last good video frame, reused while the element is mid-seek so rapid
    // scrubbing/jump-cuts don't strobe black frames.
    this._lastFrame = null;
    this._lastFrameCtx = null;
    this._lastFrameValid = false;
  }

  resetLastFrame() {
    this._lastFrameValid = false;
  }

  setAnalyser(analyser) {
    try {
      if (analyser && typeof analyser.getByteFrequencyData === 'function') {
        this._analyser = analyser;
        this._freq = new Uint8Array(analyser.frequencyBinCount || 1024);
      } else {
        this._analyser = null;
        this._freq = null;
      }
    } catch (err) {
      console.warn('VisualFX.setAnalyser failed', err);
      this._analyser = null;
      this._freq = null;
    }
  }

  // source: HTMLVideoElement | HTMLImageElement | null (null ⇒ visualizer).
  // fx: { invert, hue, saturate, zoom, zoomCx, zoomCy, shake, mirror,
  //       rainbow, flash, caption, rgbSplit } — all optional.
  draw(source, fx, tSec) {
    const ctx = this.ctx;
    if (!ctx) return;
    const f = fx && typeof fx === 'object' ? fx : {};
    const t = toNum(tSec, 0);

    ctx.save();
    try {
      // Hard reset in case a previous caller leaked state.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';

      // 1. Background.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      // 2. Sanitized transform params (shake computed ONCE per frame so the
      //    rgbSplit ghost passes line up with the main pass).
      const zoom = clampNum(f.zoom, 1, 0.05, 8);
      const zoomCx = clampNum(f.zoomCx, 0.5, 0, 1);
      const zoomCy = clampNum(f.zoomCy, 0.5, 0, 1);
      const shake = clampNum(f.shake, 0, 0, 400);
      const shakeX = shake > 0 ? (Math.random() * 2 - 1) * shake : 0;
      const shakeY = shake > 0 ? (Math.random() * 2 - 1) * shake : 0;
      const rgbSplit = clampNum(f.rgbSplit, 0, 0, 64);
      const flash = clampNum(f.flash, 0, 0, 1);
      const baseFilter = buildFilter(f);
      const xform = { zoom, zoomCx, zoomCy, dx: shakeX, dy: shakeY };

      let drawable = this._resolveDrawable(source);
      const isVideo = !!(source && typeof source === 'object' && 'videoWidth' in source);
      if (drawable && isVideo) {
        this._snapshotFrame(drawable);
      } else if (!drawable && isVideo && this._lastFrameValid && this._lastFrame) {
        // Mid-seek: reuse the last good frame instead of flashing black.
        drawable = { el: this._lastFrame, sw: this._lastFrame.width, sh: this._lastFrame.height };
      }

      if (drawable) {
        // 3. Filtered cover-fit draw (+ mirror mode).
        this._drawSourceLayer(drawable, xform, 0, baseFilter, 1, 'source-over');
        if (f.mirror) this._mirrorLeftOntoRight();
        // 4. RGB split ghost passes.
        if (rgbSplit > 0) {
          this._drawSourceLayer(drawable, xform, -rgbSplit, withExtraHue(baseFilter, -120), 0.5, 'screen');
          this._drawSourceLayer(drawable, xform, rgbSplit, withExtraHue(baseFilter, 120), 0.5, 'screen');
        }
      } else if (source == null) {
        // 8. Audio-only visualizer stands in for the source layer so shake /
        //    filters / rgbSplit from SUS-machine fx remain visible on it.
        this._drawVisualizer(t, xform, baseFilter);
        if (rgbSplit > 0) this._rgbSplitSelf(rgbSplit);
      }
      // (source given but not ready/broken ⇒ leave the black frame.)

      // 5. Rainbow hue overlay.
      if (f.rainbow) {
        ctx.save();
        ctx.globalCompositeOperation = 'hue';
        ctx.globalAlpha = 0.85;
        const hue = (((t * 240) % 360) + 360) % 360;
        ctx.fillStyle = `hsl(${hue.toFixed(1)}, 70%, 50%)`;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      // 6. Flash.
      if (flash > 0) {
        ctx.save();
        ctx.globalAlpha = flash;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      // 7. Impact meme caption.
      if (f.caption != null && f.caption !== '') this._drawCaption(String(f.caption));
    } catch (err) {
      this._warn('VisualFX.draw failed', err);
    } finally {
      ctx.restore();
    }
  }

  // ---- internals -----------------------------------------------------------

  _warn(msg, err) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - this._lastWarnMs > 1000) {
      this._lastWarnMs = now;
      console.warn(msg, err);
    }
  }

  // Copy the current (raw, unfiltered) video frame into the reuse cache.
  _snapshotFrame(drawable) {
    try {
      const scale = Math.min(1, W / drawable.sw, H / drawable.sh);
      const w = Math.max(1, Math.round(drawable.sw * scale));
      const h = Math.max(1, Math.round(drawable.sh * scale));
      if (!this._lastFrame) {
        this._lastFrame = document.createElement('canvas');
        this._lastFrameCtx = this._lastFrame.getContext('2d');
      }
      if (!this._lastFrameCtx) return;
      if (this._lastFrame.width !== w || this._lastFrame.height !== h) {
        this._lastFrame.width = w;
        this._lastFrame.height = h;
      }
      this._lastFrameCtx.drawImage(drawable.el, 0, 0, w, h);
      this._lastFrameValid = true;
    } catch (err) {
      this._warn('VisualFX: frame snapshot failed', err);
    }
  }

  // Returns { el, sw, sh } for a drawable source, or null.
  _resolveDrawable(source) {
    if (!source || typeof source !== 'object') return null;
    try {
      if ('videoWidth' in source) {
        // readyState can still expose the pre-seek frame while a new seek is
        // in flight. Hold the confirmed snapshot until `seeked` instead of
        // caching that stale frame as though it belonged to the new position.
        if (!source.seeking && source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0) {
          return { el: source, sw: source.videoWidth, sh: source.videoHeight };
        }
        return null;
      }
      if ('naturalWidth' in source) {
        if (source.complete && source.naturalWidth > 0 && source.naturalHeight > 0) {
          return { el: source, sw: source.naturalWidth, sh: source.naturalHeight };
        }
        return null;
      }
      // Anything else drawImage-compatible (canvas, bitmap).
      const sw = toNum(source.width, 0);
      const sh = toNum(source.height, 0);
      if (sw > 0 && sh > 0) return { el: source, sw, sh };
    } catch (err) {
      this._warn('VisualFX: unreadable source', err);
    }
    return null;
  }

  // One cover-fit pass: screen-space offset+shake, zoom about (zoomCx, zoomCy),
  // filter/alpha/composite fully scoped by save/restore.
  _drawSourceLayer(drawable, xform, extraDx, filter, alpha, composite) {
    const ctx = this.ctx;
    ctx.save();
    try {
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = composite;
      ctx.filter = filter;
      ctx.translate(xform.dx + extraDx, xform.dy);
      if (xform.zoom !== 1) {
        const px = xform.zoomCx * W;
        const py = xform.zoomCy * H;
        ctx.translate(px, py);
        ctx.scale(xform.zoom, xform.zoom);
        ctx.translate(-px, -py);
      }
      const s = Math.max(W / drawable.sw, H / drawable.sh);
      const dw = drawable.sw * s;
      const dh = drawable.sh * s;
      ctx.drawImage(drawable.el, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } catch (err) {
      this._warn('VisualFX: source draw failed', err);
    } finally {
      ctx.restore();
    }
  }

  // Classic YTP mirror: stamp a flipped copy of the left half onto the right.
  _mirrorLeftOntoRight() {
    const ctx = this.ctx;
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      const srcW = (this.canvas.width || W) / 2;
      const srcH = this.canvas.height || H;
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.canvas, 0, 0, srcW, srcH, 0, 0, W / 2, H);
    } catch (err) {
      this._warn('VisualFX: mirror draw failed', err);
    } finally {
      ctx.restore();
    }
  }

  // rgbSplit for the visualizer path: ghost the canvas over itself.
  _rgbSplitSelf(amount) {
    const ctx = this.ctx;
    for (let k = 0; k < 2; k++) {
      const sign = k === 0 ? -1 : 1;
      ctx.save();
      try {
        ctx.globalAlpha = 0.5;
        ctx.globalCompositeOperation = 'screen';
        ctx.filter = `hue-rotate(${sign * 120}deg)`;
        ctx.drawImage(this.canvas, sign * amount, 0);
      } catch (err) {
        this._warn('VisualFX: rgb split failed', err);
      } finally {
        ctx.restore();
      }
    }
  }

  // Mirrored rainbow frequency bars + pulsing center emoji.
  _drawVisualizer(t, xform, filter) {
    const ctx = this.ctx;
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = filter;
      ctx.translate(xform.dx, xform.dy);
      if (xform.zoom !== 1) {
        const px = xform.zoomCx * W;
        const py = xform.zoomCy * H;
        ctx.translate(px, py);
        ctx.scale(xform.zoom, xform.zoom);
        ctx.translate(-px, -py);
      }

      let level = 0;
      let emoji = '💩';
      const an = this._analyser;
      const freq = this._freq;

      if (an && freq) {
        try {
          an.getByteFrequencyData(freq);
        } catch (err) {
          this._warn('VisualFX: analyser read failed', err);
          freq.fill(0);
        }

        const barW = (W / 2) / VIS_BAR_PAIRS;
        const usable = Math.max(1, Math.floor(freq.length / 2)); // top half is mostly empty
        let sum = 0;
        for (let i = 0; i < VIS_BAR_PAIRS; i++) {
          const bin = Math.min(freq.length - 1, Math.floor((i / VIS_BAR_PAIRS) * usable));
          const v = freq[bin] / 255;
          sum += v;
          const half = 4 + v * 300;
          // Right bar (overall index 32+i) and its horizontal mirror (31-i).
          const rIdx = VIS_BAR_PAIRS + i;
          const lIdx = VIS_BAR_PAIRS - 1 - i;
          const rHue = (((rIdx * 6 + t * 120) % 360) + 360) % 360;
          const lHue = (((lIdx * 6 + t * 120) % 360) + 360) % 360;
          ctx.fillStyle = `hsl(${rHue.toFixed(1)}, 100%, 55%)`;
          ctx.fillRect(W / 2 + i * barW + 1, H / 2 - half, barW - 2, half * 2);
          ctx.fillStyle = `hsl(${lHue.toFixed(1)}, 100%, 55%)`;
          ctx.fillRect(W / 2 - (i + 1) * barW + 1, H / 2 - half, barW - 2, half * 2);
        }
        level = sum / VIS_BAR_PAIRS;
        const idx = ((Math.floor(t / 0.7) % VIS_EMOJIS.length) + VIS_EMOJIS.length) % VIS_EMOJIS.length;
        emoji = VIS_EMOJIS[idx];
      } else {
        // No analyser → just the pulsing poop.
        level = 0.25 + 0.25 * Math.sin(t * 5);
      }

      const size = Math.max(8, Math.round(140 + level * 160));
      ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(emoji, W / 2, H / 2);
    } catch (err) {
      this._warn('VisualFX: visualizer draw failed', err);
    } finally {
      ctx.restore();
    }
  }

  // Wrap + shrink caption to fit CAPTION_MAX_WIDTH; layout cached per string.
  _layoutCaption(text) {
    const cached = this._capCache;
    if (cached && cached.text === text) return cached;
    const ctx = this.ctx;
    let size = CAPTION_MAX_SIZE;
    let lines = [text];
    for (;;) {
      ctx.font = captionFont(size);
      lines = wrapText(ctx, text, CAPTION_MAX_WIDTH);
      let widest = 0;
      for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > widest) widest = w;
      }
      const fits = lines.length <= CAPTION_MAX_LINES && widest <= CAPTION_MAX_WIDTH;
      if (fits || size <= CAPTION_MIN_SIZE) break;
      size -= 4;
    }
    this._capCache = { text, size, lines };
    return this._capCache;
  }

  _drawCaption(caption) {
    const text = caption.length > 300 ? caption.slice(0, 300) : caption;
    if (!text.trim()) return;
    const ctx = this.ctx;
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      const layout = this._layoutCaption(text); // sets ctx.font while measuring
      ctx.font = captionFont(layout.size);
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#fff';
      const lineHeight = layout.size * 1.12;
      const n = layout.lines.length;
      for (let i = 0; i < n; i++) {
        const y = CAPTION_BOTTOM_Y - (n - 1 - i) * lineHeight;
        ctx.strokeText(layout.lines[i], W / 2, y);
        ctx.fillText(layout.lines[i], W / 2, y);
      }
    } catch (err) {
      this._warn('VisualFX: caption draw failed', err);
    } finally {
      ctx.restore();
    }
  }
}
