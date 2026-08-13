/*
 * interaction.js — zoom, pan, scroll and keyboard handling for the canvas.
 *
 * Zooming keeps the time under the mouse pointer pinned, which is what makes
 * "wheel to zoom" feel right. All view changes go through the renderer's
 * `view` window and a single requestAnimationFrame-coalesced redraw.
 */

export class ViewController {
  /**
   * @param {BlackboxRenderer} renderer
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} scrollbar  horizontal scrollbar track element
   * @param {() => void} onChange    called after any view change (for readouts)
   */
  constructor(renderer, canvas, scrollbar, onChange = () => {}) {
    this.r = renderer;
    this.canvas = canvas;
    this.scrollbar = scrollbar;
    this.thumb = scrollbar ? scrollbar.querySelector('.thumb') : null;
    this.onChange = onChange;

    this._raf = 0;
    this._drag = null;
    this._thumbDrag = null;

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

  /** Zoom by `factor` (>1 zooms in), keeping time `pivotT` fixed on screen. */
  zoomAt(factor, pivotT) {
    const { t0, t1 } = this.r.view;
    const span = t1 - t0;
    const newSpan = span / factor;
    const frac = span > 0 ? (pivotT - t0) / span : 0.5;
    this.r.view = { t0: pivotT - frac * newSpan, t1: pivotT + (1 - frac) * newSpan };
    this.r.clampView();
    this.requestRender();
  }

  /** Zoom about the centre of the current view. */
  zoom(factor) {
    const { t0, t1 } = this.r.view;
    this.zoomAt(factor, (t0 + t1) / 2);
  }

  /** Pan by a fraction of the visible span (positive = later in time). */
  panByFraction(frac) {
    const { t0, t1 } = this.r.view;
    const d = (t1 - t0) * frac;
    this.r.view = { t0: t0 + d, t1: t1 + d };
    this.r.clampView();
    this.requestRender();
  }

  /** Pan by a pixel delta (positive = content moves left / time increases). */
  panByPixels(dx) {
    const p = this.r.plot;
    const { t0, t1 } = this.r.view;
    const d = (dx / p.w) * (t1 - t0);
    this.r.view = { t0: t0 + d, t1: t1 + d };
    this.r.clampView();
    this.requestRender();
  }

  fit() {
    const ext = this.r.extent;
    this.r.view = { t0: ext.t0, t1: ext.t1 };
    this.r.clampView();
    this.requestRender();
  }

  /** Zoom to an explicit time window (used by the drag-to-zoom box). */
  zoomToRange(a, b) {
    const t0 = Math.min(a, b);
    const t1 = Math.max(a, b);
    if (t1 - t0 <= 0) return;
    this.r.view = { t0, t1 };
    this.r.clampView();
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Scrollbar
  // -------------------------------------------------------------------------

  syncScrollbar() {
    if (!this.thumb || !this.r.log) return;
    const ext = this.r.extent;
    const total = ext.t1 - ext.t0;
    const { t0, t1 } = this.r.view;
    if (total <= 0) return;
    const frac = Math.min(1, (t1 - t0) / total);
    const pos = (t0 - ext.t0) / total;
    this.thumb.style.left = `${pos * 100}%`;
    this.thumb.style.width = `${Math.max(1.5, frac * 100)}%`;
    this.scrollbar.classList.toggle('full', frac >= 0.999);
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  attach() {
    const c = this.canvas;

    // --- wheel: zoom (or pan with shift) ---
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.r.log) return;
        e.preventDefault();

        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;

        if (e.shiftKey) {
          // Horizontal pan
          this.panByPixels(e.deltaY !== 0 ? e.deltaY : e.deltaX);
          return;
        }

        // Normalise across deltaMode (pixel / line / page)
        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 16;
        else if (e.deltaMode === 2) delta *= 400;

        const factor = Math.exp(-delta * 0.0022);
        this.zoomAt(factor, this.r.xToTime(x));
      },
      { passive: false }
    );

    // --- pointer: drag to pan, shift-drag to box-zoom ---
    c.addEventListener('pointerdown', (e) => {
      if (!this.r.log || e.button !== 0) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      c.setPointerCapture(e.pointerId);

      if (e.shiftKey) {
        this._drag = { mode: 'box', startX: x, curX: x };
      } else {
        this._drag = { mode: 'pan', lastX: e.clientX };
        c.classList.add('grabbing');
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.r.log) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this._drag && this._drag.mode === 'pan') {
        const dx = e.clientX - this._drag.lastX;
        this._drag.lastX = e.clientX;
        this.panByPixels(-dx);
        return;
      }

      if (this._drag && this._drag.mode === 'box') {
        this._drag.curX = x;
        this.r.cursor = { x, y };
        this.requestRender();
        this.drawBox();
        return;
      }

      this.r.cursor = { x, y };
      this.requestRender();
    });

    const endDrag = (e) => {
      if (!this._drag) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (this._drag.mode === 'box' && Math.abs(x - this._drag.startX) > 4) {
        this.zoomToRange(this.r.xToTime(this._drag.startX), this.r.xToTime(x));
      }
      this._drag = null;
      c.classList.remove('grabbing');
      this.requestRender();
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    c.addEventListener('pointerleave', () => {
      if (this._drag) return;
      this.r.cursor = null;
      this.requestRender();
    });

    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.fit();
    });

    // --- scrollbar dragging ---
    if (this.scrollbar) {
      this.scrollbar.addEventListener('pointerdown', (e) => {
        if (!this.r.log) return;
        const track = this.scrollbar.getBoundingClientRect();
        const thumb = this.thumb.getBoundingClientRect();
        this.scrollbar.setPointerCapture(e.pointerId);

        if (e.clientX < thumb.left || e.clientX > thumb.right) {
          // Jump: centre the view on the clicked position
          const ext = this.r.extent;
          const total = ext.t1 - ext.t0;
          const frac = (e.clientX - track.left) / track.width;
          const span = this.r.view.t1 - this.r.view.t0;
          const centre = ext.t0 + frac * total;
          this.r.view = { t0: centre - span / 2, t1: centre + span / 2 };
          this.r.clampView();
          this.requestRender();
        }
        this._thumbDrag = { lastX: e.clientX, trackW: track.width };
      });

      this.scrollbar.addEventListener('pointermove', (e) => {
        if (!this._thumbDrag) return;
        const ext = this.r.extent;
        const total = ext.t1 - ext.t0;
        const dx = e.clientX - this._thumbDrag.lastX;
        this._thumbDrag.lastX = e.clientX;
        const d = (dx / this._thumbDrag.trackW) * total;
        this.r.view = { t0: this.r.view.t0 + d, t1: this.r.view.t1 + d };
        this.r.clampView();
        this.requestRender();
      });

      const endThumb = () => {
        this._thumbDrag = null;
      };
      this.scrollbar.addEventListener('pointerup', endThumb);
      this.scrollbar.addEventListener('pointercancel', endThumb);
    }

    // --- keyboard ---
    window.addEventListener('keydown', (e) => {
      if (!this.r.log) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case 'ArrowLeft':
          this.panByFraction(e.shiftKey ? -0.5 : -0.1);
          break;
        case 'ArrowRight':
          this.panByFraction(e.shiftKey ? 0.5 : 0.1);
          break;
        case 'Home':
          this.r.view = { t0: this.r.extent.t0, t1: this.r.extent.t0 + (this.r.view.t1 - this.r.view.t0) };
          this.r.clampView();
          this.requestRender();
          break;
        case 'End':
          this.r.view = { t0: this.r.extent.t1 - (this.r.view.t1 - this.r.view.t0), t1: this.r.extent.t1 };
          this.r.clampView();
          this.requestRender();
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

    // --- resize ---
    const ro = new ResizeObserver(() => this.requestRender());
    ro.observe(this.canvas);
    window.addEventListener('resize', () => this.requestRender());
  }

  /** Overlay for the shift-drag zoom selection. */
  drawBox() {
    if (!this._drag || this._drag.mode !== 'box') return;
    const ctx = this.r.ctx;
    const p = this.r.plot;
    const a = Math.min(this._drag.startX, this._drag.curX);
    const b = Math.max(this._drag.startX, this._drag.curX);
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
