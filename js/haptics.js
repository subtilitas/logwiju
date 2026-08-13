/*
 * haptics.js — short vibration feedback for touch gestures.
 *
 * Deliberately restrained. Scrubbing a chart can fire hundreds of events a
 * second, and a device buzzing continuously is worse than no feedback at all,
 * so every pattern is short and the whole module is rate limited.
 *
 * navigator.vibrate is unsupported on iOS Safari and is a no-op on desktop, so
 * everything here is feature detected and silently does nothing when absent.
 */

const STORAGE_KEY = 'logwiju.haptics';

/** Vibration patterns, in milliseconds. */
export const PATTERN = {
  // A gesture began or ended: the lightest possible confirmation.
  tick: 8,
  // Crosshair moved onto a new sample while scrubbing.
  snap: 4,
  // You have hit the end of the log, or the zoom limit: nothing more to give.
  limit: [14, 26, 14],
  // A discrete action landed, e.g. double-tap to fit.
  confirm: [10, 30, 18],
};

export class Haptics {
  constructor() {
    this.supported =
      typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

    // Level: 'off' | 'limits' | 'edges' | 'full'
    //   limits — only when a boundary is hit
    //   edges  — the above, plus gesture start/end            (default)
    //   full   — the above, plus a tick per sample snap
    this.level = this.load() || 'edges';

    this._last = 0;
    this._lastSnap = 0;
  }

  load() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null; // private mode, or storage disabled
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, this.level);
    } catch {
      /* preference just won't persist */
    }
  }

  setLevel(level) {
    this.level = level;
    this.save();
    // Let the user feel what they picked.
    if (level !== 'off') this.fire(PATTERN.tick, true);
  }

  get enabled() {
    return this.supported && this.level !== 'off';
  }

  /** Does the current level permit this class of feedback? */
  allows(kind) {
    switch (this.level) {
      case 'off':
        return false;
      case 'limits':
        return kind === 'limit';
      case 'edges':
        return kind === 'limit' || kind === 'edge';
      case 'full':
        return true;
      default:
        return false;
    }
  }

  fire(pattern, force = false) {
    if (!this.supported) return false;
    if (!force && this.level === 'off') return false;

    // Global rate limit so overlapping gestures cannot stack into a buzz.
    const now = Date.now();
    if (!force && now - this._last < 40) return false;
    this._last = now;

    try {
      navigator.vibrate(pattern);
      return true;
    } catch {
      return false;
    }
  }

  /** A gesture started or finished. */
  edge() {
    if (!this.allows('edge')) return;
    this.fire(PATTERN.tick);
  }

  /** A pan or zoom ran into the end of the log, or the zoom limit. */
  limit() {
    if (!this.allows('limit')) return;
    this.fire(PATTERN.limit);
  }

  /** A discrete action completed. */
  confirm() {
    if (!this.allows('edge')) return;
    this.fire(PATTERN.confirm);
  }

  /**
   * The crosshair moved to a new sample. Rate limited harder than everything
   * else, because at speed this fires far faster than a motor can respond.
   */
  snap() {
    if (!this.allows('snap')) return;
    const now = Date.now();
    if (now - this._lastSnap < 55) return;
    this._lastSnap = now;
    this.fire(PATTERN.snap);
  }
}

export const haptics = new Haptics();
