/*
 * interaction.js — zoom, pan, scroll, pinch and keyboard handling.
 *
 * Zooming always keeps one time value pinned in place: the pointer under the
 * cursor for a wheel zoom, the midpoint between the fingers for a pinch. That
 * anchoring is what makes both gestures feel direct rather than approximate.
 *
 * Pointer Events unify mouse, touch and pen, so there is a single code path
 * here; the only branch is one pointer (pan) versus two (pinch).
 */

import { haptics } from './haptics.js';

// Below this movement a touch is a tap, not a drag.
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 300;
const DOUBLE_TAP_MAX_MS = 320;

export class ViewController {
  /**
   * @param {BlackboxRenderer} renderer
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} scrollbar horizontal scrollbar track
   * @param {() => void} onChange called after any view change
   */
  constructor(renderer, canvas, scrollbar, onChange = () => {}) {
    this.r = renderer;
    this.canvas = canvas;
    this.scrollbar = scrollbar;
    this.thumb = scrollbar ? scrollbar.querySelector('.thumb') : null;
    this.onChange = onChange;

    this._raf = 0;
    this._pointers = new Map(); // pointerId -> { x, y, startX, startY, startT }
    this._pinch = null; // { dist, midX, midTime }
    this._pan = null; // { lastX }
    this._box = null; // { startX, curX }
    this._thumbDrag = null;
    this._lastTapAt = 0;
    this._lastSnapIndex = -1;

    // Remembers whether we were already clamped, so the limit buzz fires once
    // on arrival at the edge rather than continuously while pushing against it.
    this._wasAtLimit = false;

    this.attach();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.r.render();
      this.syncScrollbar();
      this.onChange();
    });
  }

  // -------------------------------------------------------------------------
  // View operations
  // -------------------------------------------------------------------------

  /** True when the view covers the whole log and cannot widen further. */
  atExtent() {
    const e = this.r.extent;
    const v = this.r.view;
    return v.t0 <= e.t0 + 1e-12 && v.t1 >= e.t1 - 1e-12;
  }

  /** Apply a view, clamp it, and buzz once if that clamp hit a boundary. */
  commit(view, { feedback = true } = {}) {
    const wanted = { ...view };
    this.r.view = view;
    this.r.clampView();

    if (feedback) {
      const clamped =
        Math.abs(this.r.view.t0 - wanted.t0) > 1e-9 ||
        Math.abs(this.r.view.t1 - wanted.t1) > 1e-9;
      if (clamped && !this._wasAtLimit) haptics.limit();
      this._wasAtLimit = clamped;
    }
    this.requestRender();
  }

  /** Zoom by `factor` (>1 zooms in), keeping time `pivotT` fixed on screen. */
  zoomAt(factor, pivotT, opts) {
    const { t0, t1 } = this.r.view;
    const span = t1 - t0;
    const newSpan = span / factor;
    const frac = span > 0 ? (pivotT - t0) / span : 0.5;
    this.commit({ t0: pivotT - frac * newSpan, t1: pivotT + (1 - frac) * newSpan }, opts);
  }

  zoom(factor) {
    const { t0, t1 } = this.r.view;
    this.zoomAt(factor, (t0 + t1) / 2);
  }

  panByFraction(frac) {
    const { t0, t1 } = this.r.view;
    const d = (t1 - t0) * frac;
    this.commit({ t0: t0 + d, t1: t1 + d });
  }

  /** Pan by a pixel delta (positive = time increases). */
  panByPixels(dx) {
    const p = this.r.plot;
    const { t0, t1 } = this.r.view;
    const d = (dx / p.w) * (t1 - t0);
    this.commit({ t0: t0 + d, t1: t1 + d });
  }

  fit() {
    const e = this.r.extent;
    this._wasAtLimit = false;
    this.commit({ t0: e.t0, t1: e.t1 }, { feedback: false });
  }

  zoomToRange(a, b) {
    const t0 = Math.min(a, b);
    const t1 = Math.max(a, b);
    if (t1 - t0 <= 0) return;
    this.commit({ t0, t1 });
  }

  // -------------------------------------------------------------------------
  // Scrollbar
  // -------------------------------------------------------------------------

  syncScrollbar() {
    if (!this.thumb || !this.r.log) return;
    const e = this.r.extent;
    const total = e.t1 - e.t0;
    if (total <= 0) return;
    const { t0, t1 } = this.r.view;
    const frac = Math.min(1, (t1 - t0) / total);
    this.thumb.style.left = `${((t0 - e.t0) / total) * 100}%`;
    this.thumb.style.width = `${Math.max(1.5, frac * 100)}%`;
    this.scrollbar.classList.toggle('full', frac >= 0.999);
  }

  // -------------------------------------------------------------------------
  // Pointer helpers
  // -------------------------------------------------------------------------

  localPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  twoPointers() {
    const it = this._pointers.values();
    return [it.next().value, it.next().value];
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  attach() {
    const c = this.canvas;

    // --- wheel: zoom, or pan with shift ---
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.r.log) return;
        e.preventDefault();
        const { x } = this.localPoint(e);

        if (e.shiftKey) {
          this.panByPixels(e.deltaY !== 0 ? e.deltaY : e.deltaX);
          return;
        }

        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 16;
        else if (e.deltaMode === 2) delta *= 400;

        this.zoomAt(Math.exp(-delta * 0.0022), this.r.xToTime(x));
      },
      { passive: false }
    );

    // --- pointer down ---
    c.addEventListener('pointerdown', (e) => {
      if (!this.r.log) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const p = this.localPoint(e);
      this._pointers.set(e.pointerId, {
        ...p,
        startX: p.x,
        startY: p.y,
        startT: Date.now(),
      });
      c.setPointerCapture(e.pointerId);

      if (this._pointers.size === 2) {
        // Second finger down: cancel any pan/box and begin a pinch.
        this._pan = null;
        this._box = null;
        this.beginPinch();
        haptics.edge();
        return;
      }

      if (this._pointers.size === 1) {
        if (e.shiftKey && e.pointerType === 'mouse') {
          this._box = { startX: p.x, curX: p.x };
        } else {
          this._pan = { lastX: e.clientX };
          this._wasAtLimit = false;
          c.classList.add('grabbing');
          if (e.pointerType !== 'mouse') haptics.edge();
        }
      }
    });

    // --- pointer move ---
    c.addEventListener('pointermove', (e) => {
      if (!this.r.log) return;
      const p = this.localPoint(e);

      const tracked = this._pointers.get(e.pointerId);
      if (tracked) {
        tracked.x = p.x;
        tracked.y = p.y;
      }

      if (this._pointers.size >= 2) {
        this.updatePinch();
        return;
      }

      if (this._pan) {
        const dx = e.clientX - this._pan.lastX;
        this._pan.lastX = e.clientX;
        this.panByPixels(-dx);
        // Keep the readout under the finger while dragging on touch.
        if (e.pointerType !== 'mouse') this.r.cursor = { x: p.x, y: p.y };
        return;
      }

      if (this._box) {
        this._box.curX = p.x;
        this.r.cursor = { x: p.x, y: p.y };
        this.requestRender();
        this.drawBox();
        return;
      }

      // Hover crosshair (mouse), or a finger resting without dragging.
      this.r.cursor = { x: p.x, y: p.y };
      this.maybeSnapHaptic(p.x);
      this.requestRender();
    });

    // --- pointer up / cancel ---
    const release = (e) => {
      const tracked = this._pointers.get(e.pointerId);
      this._pointers.delete(e.pointerId);

      if (this._box) {
        const p = this.localPoint(e);
        if (Math.abs(p.x - this._box.startX) > 4) {
          this.zoomToRange(this.r.xToTime(this._box.startX), this.r.xToTime(p.x));
        }
        this._box = null;
      }

      if (this._pointers.size < 2 && this._pinch) {
        this._pinch = null;
        haptics.edge();
        // If one finger is still down, continue as a pan from where it is.
        if (this._pointers.size === 1) {
          const [only] = this.twoPointers();
          this._pan = { lastX: this.canvas.getBoundingClientRect().left + only.x };
        }
      }

      if (this._pointers.size === 0) {
        if (this._pan) {
          this._pan = null;
          this.canvas.classList.remove('grabbing');
          if (e.pointerType !== 'mouse') haptics.edge();
        }

        // Double tap on touch fits the log, mirroring double-click on mouse.
        if (tracked && e.pointerType !== 'mouse' && this.isTap(tracked, e)) {
          const now = Date.now();
          if (now - this._lastTapAt < DOUBLE_TAP_MAX_MS) {
            this._lastTapAt = 0;
            this.fit();
            haptics.confirm();
          } else {
            this._lastTapAt = now;
          }
        }

        if (e.pointerType !== 'mouse') {
          // Leave the crosshair where the finger lifted; it is the readout.
          this.requestRender();
        }
      }
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);

    c.addEventListener('pointerleave', (e) => {
      if (this._pan || this._box || this._pinch) return;
      if (e.pointerType !== 'mouse') return;
      this.r.cursor = null;
      this.requestRender();
    });

    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.fit();
    });

    // Stop iOS/Android from hijacking two-finger gestures over the canvas.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
      c.addEventListener(ev, (e) => e.preventDefault());
    }
    c.addEventListener('contextmenu', (e) => {
      if (this._pointers.size) e.preventDefault();
    });

    this.attachScrollbar();
    this.attachKeyboard();

    const ro = new ResizeObserver(() => this.requestRender());
    ro.observe(this.canvas);
    window.addEventListener('resize', () => this.requestRender());
  }

  isTap(tracked, e) {
    const p = this.localPoint(e);
    return (
      Date.now() - tracked.startT < TAP_MAX_MS &&
      Math.abs(p.x - tracked.startX) < TAP_SLOP_PX &&
      Math.abs(p.y - tracked.startY) < TAP_SLOP_PX
    );
  }

  /** Tick when the crosshair moves onto a different sample. */
  maybeSnapHaptic(x) {
    if (!haptics.allows('snap')) return;
    const i = this.r.indexAtX(x);
    if (i !== this._lastSnapIndex) {
      this._lastSnapIndex = i;
      haptics.snap();
    }
  }

  // -------------------------------------------------------------------------
  // Pinch
  // -------------------------------------------------------------------------

  beginPinch() {
    const [a, b] = this.twoPointers();
    if (!a || !b) return;
    const midX = (a.x + b.x) / 2;
    this._pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      midX,
      // The time under the midpoint stays put for the whole gesture, so the
      // content does not creep while the fingers move.
      midTime: this.r.xToTime(midX),
    };
    this._wasAtLimit = false;
  }

  updatePinch() {
    if (!this._pinch) {
      this.beginPinch();
      return;
    }
    const [a, b] = this.twoPointers();
    if (!a || !b) return;

    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const midX = (a.x + b.x) / 2;

    // Scale from the finger separation, and translate from the midpoint, so a
    // two-finger drag pans and a spread zooms — usually both at once.
    const scale = dist / this._pinch.dist;
    const p = this.r.plot;
    const { t0, t1 } = this.r.view;
    const span = t1 - t0;
    const newSpan = span / scale;

    // Place midTime under the new midpoint position.
    const frac = (midX - p.x) / p.w;
    this.commit({
      t0: this._pinch.midTime - frac * newSpan,
      t1: this._pinch.midTime + (1 - frac) * newSpan,
    });

    this._pinch.dist = dist;
    this._pinch.midX = midX;
    this.r.cursor = { x: midX, y: (a.y + b.y) / 2 };
  }

  // -------------------------------------------------------------------------
  // Scrollbar + keyboard
  // -------------------------------------------------------------------------

  attachScrollbar() {
    if (!this.scrollbar) return;

    this.scrollbar.addEventListener('pointerdown', (e) => {
      if (!this.r.log) return;
      const track = this.scrollbar.getBoundingClientRect();
      const thumb = this.thumb.getBoundingClientRect();
      this.scrollbar.setPointerCapture(e.pointerId);

      if (e.clientX < thumb.left || e.clientX > thumb.right) {
        const ext = this.r.extent;
        const total = ext.t1 - ext.t0;
        const centre = ext.t0 + ((e.clientX - track.left) / track.width) * total;
        const span = this.r.view.t1 - this.r.view.t0;
        this.commit({ t0: centre - span / 2, t1: centre + span / 2 });
      }
      this._thumbDrag = { lastX: e.clientX, trackW: track.width };
      if (e.pointerType !== 'mouse') haptics.edge();
    });

    this.scrollbar.addEventListener('pointermove', (e) => {
      if (!this._thumbDrag) return;
      const ext = this.r.extent;
      const total = ext.t1 - ext.t0;
      const dx = e.clientX - this._thumbDrag.lastX;
      this._thumbDrag.lastX = e.clientX;
      const d = (dx / this._thumbDrag.trackW) * total;
      this.commit({ t0: this.r.view.t0 + d, t1: this.r.view.t1 + d });
    });

    const end = (e) => {
      if (!this._thumbDrag) return;
      this._thumbDrag = null;
      if (e && e.pointerType !== 'mouse') haptics.edge();
    };
    this.scrollbar.addEventListener('pointerup', end);
    this.scrollbar.addEventListener('pointercancel', end);
  }

  attachKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (!this.r.log) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.querySelector('.modal:not([hidden])')) return;

      const span = this.r.view.t1 - this.r.view.t0;
      switch (e.key) {
        case 'ArrowLeft':
          this.panByFraction(e.shiftKey ? -0.5 : -0.1);
          break;
        case 'ArrowRight':
          this.panByFraction(e.shiftKey ? 0.5 : 0.1);
          break;
        case 'Home':
          this.commit({ t0: this.r.extent.t0, t1: this.r.extent.t0 + span });
          break;
        case 'End':
          this.commit({ t0: this.r.extent.t1 - span, t1: this.r.extent.t1 });
          break;
        case '+':
        case '=':
          this.zoom(1.5);
          break;
        case '-':
        case '_':
          this.zoom(1 / 1.5);
          break;
        case '0':
          this.fit();
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  /** Overlay for the shift-drag zoom selection. */
  drawBox() {
    if (!this._box) return;
    const ctx = this.r.ctx;
    const p = this.r.plot;
    const a = Math.min(this._box.startX, this._box.curX);
    const b = Math.max(this._box.startX, this._box.curX);
    ctx.save();
    ctx.setTransform(this.r.dpr, 0, 0, this.r.dpr, 0, 0);
    ctx.fillStyle = 'rgba(78,163,255,0.18)';
    ctx.fillRect(a, p.y, b - a, p.h);
    ctx.strokeStyle = 'rgba(78,163,255,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(a + 0.5, p.y + 0.5, b - a - 1, p.h - 1);
    ctx.restore();
  }
}
