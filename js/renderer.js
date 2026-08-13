/*
 * renderer.js — canvas renderer for blackbox traces.
 *
 * Draws one stacked "lane" per selected field: each lane has its own auto-scaled
 * Y axis, and all lanes share a single time axis.
 *
 * Performance notes:
 *  - Logs routinely hold 100k+ samples. Drawing every point is pointless when a
 *    lane is only ~700 px wide, so we decimate with a min/max envelope: for each
 *    pixel column we draw a vertical segment from the minimum to the maximum
 *    sample in that column. That preserves spikes exactly, unlike subsampling.
 *  - Sample spacing is not uniform (dropped frames, ESC telemetry), so we locate
 *    the visible range by binary search on the time array rather than by index
 *    arithmetic.
 */

const AXIS_W = 74; // left gutter for Y labels
const TIME_AXIS_H = 26; // bottom gutter for the time axis
const LANE_GAP = 6;

const PALETTE = [
  '#4ea3ff', '#ff8a4c', '#5ed17f', '#ff5f7e', '#c07dff',
  '#ffc94a', '#4fd6d6', '#ff6ec7', '#9ad34e', '#7e8cff',
];

export function colorForIndex(i) {
  return PALETTE[i % PALETTE.length];
}

/** Index of the last sample with time <= t (or -1). */
function lowerBound(time, t) {
  let lo = 0;
  let hi = time.length - 1;
  if (t < time[0]) return -1;
  if (t >= time[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (time[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Index of the sample closest in time to `t`. */
function nearestIndex(time, t) {
  const i = lowerBound(time, t);
  if (i < 0) return 0;
  if (i >= time.length - 1) return time.length - 1;
  return t - time[i] <= time[i + 1] - t ? i : i + 1;
}

/** Pick a "nice" step (1/2/5 x 10^n) covering roughly `target` divisions. */
function niceStep(range, target) {
  if (!(range > 0)) return 1;
  const rough = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  return step * mag;
}

function formatTime(t, step) {
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);

  // Deep zoom: seconds are useless, switch to milliseconds.
  if (step < 0.001) {
    const msDecimals = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step * 1000))));
    return `${sign}${(a * 1000).toFixed(msDecimals)}ms`;
  }

  const decimals = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step))));
  // Only bother with mm:ss once ticks are at least a second apart.
  if (step >= 1 && a >= 60) {
    const m = Math.floor(a / 60);
    const s = a % 60;
    return `${sign}${m}:${s.toFixed(0).padStart(2, '0')}`;
  }
  return `${sign}${a.toFixed(decimals)}s`;
}

function formatValue(v, span) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100000) return v.toExponential(2);
  if (span >= 100 || a >= 1000) return v.toFixed(0);
  if (span >= 10) return v.toFixed(1);
  if (span >= 1) return v.toFixed(2);
  if (span >= 0.01) return v.toFixed(3);
  return v.toPrecision(3);
}

export class BlackboxRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.log = null;
    this.series = []; // [{ name, color, data, unit, group, visible }]
    this.view = { t0: 0, t1: 1 }; // visible time window in seconds
    this.cursor = null; // { x, y } in CSS px, or null
    this.dpr = 1;
    this.laneRects = [];
    this.theme = {
      bg: '#12151c',
      panel: '#171b24',
      grid: '#242a36',
      gridStrong: '#323a4a',
      text: '#c9d2e3',
      textDim: '#6f7c93',
      cursor: '#ffffff',
      zero: '#3d4757',
    };
    this.showPoints = true; // draw individual samples when zoomed in far enough
  }

  setLog(log) {
    this.log = log;
    this.view = { t0: 0, t1: log ? log.time[log.count - 1] : 1 };
  }

  setSeries(series) {
    this.series = series;
  }

  /** Full time extent of the log. */
  get extent() {
    if (!this.log) return { t0: 0, t1: 1 };
    return { t0: this.log.time[0], t1: this.log.time[this.log.count - 1] };
  }

  /** Clamp the view window to the log extent, keeping a minimum span. */
  clampView() {
    const ext = this.extent;
    const minSpan = Math.max(1e-4, (ext.t1 - ext.t0) / 5e6);
    let { t0, t1 } = this.view;
    if (t1 - t0 < minSpan) {
      const c = (t0 + t1) / 2;
      t0 = c - minSpan / 2;
      t1 = c + minSpan / 2;
    }
    const span = t1 - t0;
    if (span >= ext.t1 - ext.t0) {
      t0 = ext.t0;
      t1 = ext.t1;
    } else {
      if (t0 < ext.t0) {
        t0 = ext.t0;
        t1 = t0 + span;
      }
      if (t1 > ext.t1) {
        t1 = ext.t1;
        t0 = t1 - span;
      }
    }
    this.view = { t0, t1 };
  }

  /** Plot area in CSS pixels. */
  get plot() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return { x: AXIS_W, y: 0, w: Math.max(1, w - AXIS_W - 8), h: Math.max(1, h - TIME_AXIS_H) };
  }

  timeToX(t) {
    const p = this.plot;
    const { t0, t1 } = this.view;
    return p.x + ((t - t0) / (t1 - t0)) * p.w;
  }

  xToTime(x) {
    const p = this.plot;
    const { t0, t1 } = this.view;
    return t0 + ((x - p.x) / p.w) * (t1 - t0);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.dpr = dpr;
  }

  /**
   * Compute the min/max envelope of `data` over the visible window, one entry
   * per pixel column. Returns null when nothing is visible.
   */
  buildEnvelope(data, time, cols) {
    const { t0, t1 } = this.view;
    const i0 = Math.max(0, lowerBound(time, t0));
    const i1 = Math.min(time.length - 1, lowerBound(time, t1) + 1);
    if (i1 < i0) return null;

    const mins = new Float64Array(cols).fill(NaN);
    const maxs = new Float64Array(cols).fill(NaN);
    const firsts = new Float64Array(cols).fill(NaN);
    const lasts = new Float64Array(cols).fill(NaN);
    const counts = new Int32Array(cols);
    const span = t1 - t0;

    let vMin = Infinity;
    let vMax = -Infinity;

    for (let i = i0; i <= i1; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;

      // The bracketing samples just outside the window still matter: they are
      // what the line is drawn *from* and *to*, so they take part in the Y
      // range even though they fall outside the pixel columns.
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;

      const c = Math.floor(((time[i] - t0) / span) * cols);
      if (c < 0 || c >= cols) continue;
      if (counts[c] === 0) {
        mins[c] = v;
        maxs[c] = v;
        firsts[c] = v;
      } else {
        if (v < mins[c]) mins[c] = v;
        if (v > maxs[c]) maxs[c] = v;
      }
      lasts[c] = v;
      counts[c]++;
    }

    if (vMin === Infinity) return null;
    return { mins, maxs, firsts, lasts, counts, vMin, vMax, i0, i1, sampleCount: i1 - i0 + 1 };
  }

  render() {
    this.resize();
    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, W, H);

    this.laneRects = [];
    const visible = this.series.filter((s) => s.visible);
    if (!this.log || !visible.length) {
      ctx.fillStyle = this.theme.textDim;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        this.log ? 'Select one or more fields on the left' : 'Load a blackbox log to begin',
        W / 2,
        H / 2
      );
      return;
    }

    this.clampView();
    const p = this.plot;
    const cols = Math.max(1, Math.floor(p.w));
    const laneH = (p.h - LANE_GAP * (visible.length - 1)) / visible.length;

    this.drawTimeGrid(ctx, p);

    const time = this.log.time;
    for (let li = 0; li < visible.length; li++) {
      const s = visible[li];
      const y = p.y + li * (laneH + LANE_GAP);
      const rect = { x: p.x, y, w: p.w, h: laneH, series: s };
      this.laneRects.push(rect);
      this.drawLane(ctx, rect, s, time, cols);
    }

    this.drawTimeAxis(ctx, p);
    this.drawCursor(ctx, p);
  }

  drawTimeGrid(ctx, p) {
    const { t0, t1 } = this.view;
    const step = niceStep(t1 - t0, Math.max(2, Math.floor(p.w / 110)));
    const first = Math.ceil(t0 / step) * step;
    ctx.save();
    ctx.beginPath();
    for (let t = first; t <= t1 + 1e-9; t += step) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      ctx.moveTo(x, p.y);
      ctx.lineTo(x, p.y + p.h);
    }
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    this._timeStep = step;
  }

  drawLane(ctx, rect, s, time, cols) {
    const env = this.buildEnvelope(s.data, time, cols);

    // Lane background + frame
    ctx.fillStyle = this.theme.panel;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    // --- Y scale: auto-fit the visible window with a little headroom ---
    let lo;
    let hi;
    if (s.lockedRange) {
      [lo, hi] = s.lockedRange;
    } else if (env) {
      lo = env.vMin;
      hi = env.vMax;
      if (lo === hi) {
        const pad = Math.max(Math.abs(lo) * 0.1, 0.5);
        lo -= pad;
        hi += pad;
      } else {
        const pad = (hi - lo) * 0.08;
        lo -= pad;
        hi += pad;
      }
    } else {
      lo = 0;
      hi = 1;
    }
    const span = hi - lo;
    const valToY = (v) => rect.y + rect.h - ((v - lo) / span) * rect.h;
    s._scale = { lo, hi, valToY };

    // --- horizontal grid + Y labels ---
    const yStep = niceStep(span, Math.max(2, Math.floor(rect.h / 34)));
    ctx.save();
    ctx.beginPath();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const firstY = Math.ceil(lo / yStep) * yStep;
    for (let v = firstY; v <= hi + 1e-12; v += yStep) {
      const y = Math.round(valToY(v)) + 0.5;
      if (y < rect.y || y > rect.y + rect.h) continue;
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
      ctx.fillStyle = this.theme.textDim;
      ctx.fillText(formatValue(v, span), rect.x - 8, y);
    }
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Zero line, if in range
    if (lo < 0 && hi > 0) {
      const zy = Math.round(valToY(0)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(rect.x, zy);
      ctx.lineTo(rect.x + rect.w, zy);
      ctx.strokeStyle = this.theme.zero;
      ctx.stroke();
    }
    ctx.restore();

    // --- the trace ---
    if (env) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();

      // When there is roughly one sample per pixel or fewer, a polyline reads
      // better than an envelope; otherwise draw min/max bars.
      const dense = env.sampleCount > cols * 1.5;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';
      ctx.beginPath();

      if (dense) {
        // One continuous path: for each pixel column, enter at the column's
        // first sample, sweep the full min/max envelope, and leave at its last
        // sample. Sweeping keeps spikes exact; entering and leaving at real
        // values keeps flat stretches connected instead of collapsing into
        // invisible zero-length segments.
        let started = false;
        for (let c = 0; c < cols; c++) {
          if (!env.counts[c]) continue;
          const x = rect.x + c + 0.5;
          const yFirst = valToY(env.firsts[c]);
          const yTop = valToY(env.maxs[c]); // larger value = smaller y
          const yBottom = valToY(env.mins[c]);
          const yLast = valToY(env.lasts[c]);
          if (started) ctx.lineTo(x, yFirst);
          else {
            ctx.moveTo(x, yFirst);
            started = true;
          }
          if (yTop !== yBottom) {
            ctx.lineTo(x, yTop);
            ctx.lineTo(x, yBottom);
          }
          ctx.lineTo(x, yLast);
        }
      } else {
        let started = false;
        for (let i = env.i0; i <= env.i1; i++) {
          const v = s.data[i];
          if (!Number.isFinite(v)) {
            started = false;
            continue;
          }
          const x = this.timeToX(time[i]);
          const y = valToY(v);
          if (started) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            started = true;
          }
        }
      }
      ctx.stroke();

      // Individual sample dots once the zoom is deep enough to see them.
      if (this.showPoints && !dense && env.sampleCount < cols / 4) {
        ctx.fillStyle = s.color;
        for (let i = env.i0; i <= env.i1; i++) {
          const v = s.data[i];
          if (!Number.isFinite(v)) continue;
          ctx.beginPath();
          ctx.arc(this.timeToX(time[i]), valToY(v), 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // --- lane label ---
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = s.unit ? `${s.name}  [${s.unit}]` : s.name;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(18,21,28,0.78)';
    ctx.fillRect(rect.x + 6, rect.y + 5, tw + 14, 17);
    ctx.fillStyle = s.color;
    ctx.fillRect(rect.x + 6, rect.y + 5, 3, 17);
    ctx.fillStyle = this.theme.text;
    ctx.fillText(label, rect.x + 15, rect.y + 8);
    ctx.restore();

    // lane border
    ctx.strokeStyle = this.theme.gridStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }

  drawTimeAxis(ctx, p) {
    const { t0, t1 } = this.view;
    const step = this._timeStep || niceStep(t1 - t0, 8);
    const y = p.y + p.h;

    ctx.save();
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, y, this.canvas.clientWidth, TIME_AXIS_H);
    ctx.strokeStyle = this.theme.gridStrong;
    ctx.beginPath();
    ctx.moveTo(p.x, y + 0.5);
    ctx.lineTo(p.x + p.w, y + 0.5);
    ctx.stroke();

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = this.theme.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const first = Math.ceil(t0 / step) * step;
    for (let t = first; t <= t1 + 1e-9; t += step) {
      const x = this.timeToX(t);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y);
      ctx.lineTo(Math.round(x) + 0.5, y + 4);
      ctx.strokeStyle = this.theme.gridStrong;
      ctx.stroke();
      ctx.fillText(formatTime(t, step), x, y + 7);
    }
    ctx.restore();
  }

  drawCursor(ctx, p) {
    if (!this.cursor) return;
    if (this.cursor.x < p.x || this.cursor.x > p.x + p.w) return;

    // Snap to the nearest real sample so the crosshair, the value dots and the
    // readout all describe the same instant. At low zoom the snap is sub-pixel.
    const i = nearestIndex(this.log.time, this.xToTime(this.cursor.x));
    if (i < 0) return;
    const t = this.log.time[i];
    const x = this.timeToX(t);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, p.y);
    ctx.lineTo(Math.round(x) + 0.5, p.y + p.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Per-lane value marker
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const rect of this.laneRects) {
      const s = rect.series;
      if (!s._scale) continue;
      const v = s.data[i];
      if (!Number.isFinite(v)) continue;
      const y = Math.max(rect.y + 1, Math.min(rect.y + rect.h - 1, s._scale.valToY(v)));

      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();

      const txt = formatValue(v, s._scale.hi - s._scale.lo);
      const tw = ctx.measureText(txt).width;
      const flip = x + tw + 16 > rect.x + rect.w;
      const bx = flip ? x - tw - 14 : x + 8;
      ctx.fillStyle = 'rgba(10,12,17,0.9)';
      ctx.fillRect(bx - 3, y - 8, tw + 8, 16);
      ctx.fillStyle = s.color;
      ctx.textAlign = 'left';
      ctx.fillText(txt, bx + 1, y);
    }

    // Time readout on the axis
    const label = `${t.toFixed(3)} s`;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = '#39415a';
    ctx.fillRect(x - tw / 2 - 5, p.y + p.h + 4, tw + 10, 15);
    ctx.fillStyle = '#e6ecf7';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, x, p.y + p.h + 6);
    ctx.restore();
  }

  /** Sample index nearest to a canvas x position (for readouts). */
  indexAtX(x) {
    if (!this.log) return -1;
    return nearestIndex(this.log.time, this.xToTime(x));
  }
}

export { lowerBound, nearestIndex, formatValue, formatTime };
