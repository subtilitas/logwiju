/*
 * bbl-parser.js — Betaflight / Cleanflight blackbox log decoder.
 *
 * Pure ES module, zero dependencies. Runs in the browser and in Node.
 *
 * The encodings and predictors implemented here follow the reference decoder in
 * betaflight/blackbox-log-viewer (src/decoders.js, src/flightlog_parser.js),
 * including the v1/v2 split of TAG8_4S16 and the 554/877 bit packings of
 * TAG2_3SVARIABLE.
 *
 *   import { parseBlackbox } from './bbl-parser.js';
 *   const logs = parseBlackbox(uint8Array);
 *
 * Each entry of the returned array is one logging session:
 *   {
 *     header, headerLines,
 *     fields:  [ { index, name, group, unit, signed } ],
 *     columns: { <fieldName>: Float64Array },  // scaled to real units
 *     raw:     { <fieldName>: Float64Array },  // unscaled decoder output
 *     time:    Float64Array,                   // seconds, zero-based
 *     count, events, stats
 *   }
 */

// ---------------------------------------------------------------------------
// Spec constants
// ---------------------------------------------------------------------------

export const PREDICTOR = {
  ZERO: 0,
  PREVIOUS: 1,
  STRAIGHT_LINE: 2,
  AVERAGE_2: 3,
  MINTHROTTLE: 4,
  MOTOR_0: 5,
  INCREMENT: 6,
  HOME_COORD: 7,
  MID_1500: 8,
  VBATREF: 9,
  LAST_MAIN_FRAME_TIME: 10,
  MINMOTOR: 11,
  HOME_COORD_1: 256,
};

export const ENCODING = {
  SIGNED_VB: 0,
  UNSIGNED_VB: 1,
  NEG_14BIT: 3,
  TAG8_8SVB: 6,
  TAG2_3S32: 7,
  TAG8_4S16: 8,
  NULL: 9,
  TAG2_3SVARIABLE: 10,
};

const EVENT_NAMES = {
  0: 'SYNC_BEEP',
  10: 'AUTOTUNE_CYCLE_START',
  11: 'AUTOTUNE_CYCLE_RESULT',
  12: 'AUTOTUNE_TARGETS',
  13: 'INFLIGHT_ADJUSTMENT',
  14: 'LOGGING_RESUME',
  30: 'DISARM',
  40: 'GTUNE_CYCLE_RESULT',
  41: 'FLIGHTMODE',
  255: 'LOG_END',
};

const LOG_START_MARKER = 'H Product:Blackbox flight data recorder';

// Sanity limits used to detect a desynchronised stream (same as the reference).
const MAX_TIME_JUMP = 10 * 1000000; // 10 s
const MAX_ITERATION_JUMP = 500 * 10;

// ---------------------------------------------------------------------------
// Sign extension helpers
// ---------------------------------------------------------------------------

const se2 = (v) => ((v << 30) >> 30);
const se4 = (v) => ((v << 28) >> 28);
const se5 = (v) => ((v << 27) >> 27);
const se6 = (v) => ((v << 26) >> 26);
const se7 = (v) => ((v << 25) >> 25);
const se8 = (v) => ((v << 24) >> 24);
const se14 = (v) => ((v << 18) >> 18);
const se16 = (v) => ((v << 16) >> 16);
const se24 = (v) => ((v << 8) >> 8);

// ---------------------------------------------------------------------------
// Byte stream
// ---------------------------------------------------------------------------

class Stream {
  constructor(data, pos, end) {
    this.d = data;
    this.pos = pos;
    this.end = end;
    this.eof = false;
  }

  u8() {
    if (this.pos < this.end) return this.d[this.pos++];
    this.eof = true;
    return 0;
  }

  peek() {
    return this.pos < this.end ? this.d[this.pos] : -1;
  }

  uvb() {
    let shift = 0;
    let result = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      if (this.eof) return 0;
      result |= (b & 0x7f) << shift;
      if (b < 128) return result >>> 0;
      shift += 7;
    }
    return 0;
  }

  svb() {
    const u = this.uvb();
    return (u >>> 1) ^ -(u & 1);
  }

  s16le() {
    return se16(this.u8() | (this.u8() << 8));
  }

  // --- TAG2_3S32: three signed values, 2-bit layout selector -----------------
  tag2_3S32(v) {
    let lead = this.u8();
    switch (lead >> 6) {
      case 0:
        v[0] = se2((lead >> 4) & 0x03);
        v[1] = se2((lead >> 2) & 0x03);
        v[2] = se2(lead & 0x03);
        break;
      case 1:
        v[0] = se4(lead & 0x0f);
        lead = this.u8();
        v[1] = se4(lead >> 4);
        v[2] = se4(lead & 0x0f);
        break;
      case 2:
        v[0] = se6(lead & 0x3f);
        v[1] = se6(this.u8() & 0x3f);
        v[2] = se6(this.u8() & 0x3f);
        break;
      default:
        for (let i = 0; i < 3; i++) {
          switch (lead & 0x03) {
            case 0:
              v[i] = se8(this.u8());
              break;
            case 1:
              v[i] = se16(this.u8() | (this.u8() << 8));
              break;
            case 2:
              v[i] = se24(this.u8() | (this.u8() << 8) | (this.u8() << 16));
              break;
            default:
              v[i] = (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) | 0;
              break;
          }
          lead >>= 2;
        }
        break;
    }
  }

  // --- TAG2_3SVARIABLE: three signed values, 2 / 554 / 877 / wide ------------
  tag2_3SVariable(v) {
    let lead = this.u8();
    switch (lead >> 6) {
      case 0:
        // ss11 2233
        v[0] = se2((lead >> 4) & 0x03);
        v[1] = se2((lead >> 2) & 0x03);
        v[2] = se2(lead & 0x03);
        break;
      case 1: {
        // ss11 1112 2222 3333
        v[0] = se5((lead & 0x3e) >> 1);
        const b2 = this.u8();
        v[1] = se5(((lead & 0x01) << 5) | ((b2 & 0xf0) >> 4));
        v[2] = se4(b2 & 0x0f);
        break;
      }
      case 2: {
        // ss11 1111 1122 2222 2333 3333
        const b2 = this.u8();
        const b3 = this.u8();
        v[0] = se8(((lead & 0x3f) << 2) | ((b2 & 0xc0) >> 6));
        v[1] = se7(((b2 & 0x3f) << 1) | ((b3 & 0x80) >> 7));
        v[2] = se7(b3 & 0x7f);
        break;
      }
      default:
        for (let i = 0; i < 3; i++) {
          switch (lead & 0x03) {
            case 0:
              v[i] = se8(this.u8());
              break;
            case 1:
              v[i] = se16(this.u8() | (this.u8() << 8));
              break;
            case 2:
              v[i] = se24(this.u8() | (this.u8() << 8) | (this.u8() << 16));
              break;
            default:
              v[i] = (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) | 0;
              break;
          }
          lead >>= 2;
        }
        break;
    }
  }

  // --- TAG8_4S16 (data version 1) -------------------------------------------
  tag8_4S16_v1(v) {
    let selector = this.u8();
    for (let i = 0; i < 4; i++) {
      switch (selector & 0x03) {
        case 0:
          v[i] = 0;
          break;
        case 1: {
          const combined = this.u8();
          v[i] = se4(combined & 0x0f);
          i++;
          selector >>= 2;
          v[i] = se4(combined >> 4);
          break;
        }
        case 2:
          v[i] = se8(this.u8());
          break;
        default:
          v[i] = se16(this.u8() | (this.u8() << 8));
          break;
      }
      selector >>= 2;
    }
  }

  // --- TAG8_4S16 (data version 2) -------------------------------------------
  tag8_4S16_v2(v) {
    let selector = this.u8();
    let nibbleIndex = 0;
    let buffer = 0;
    for (let i = 0; i < 4; i++) {
      switch (selector & 0x03) {
        case 0:
          v[i] = 0;
          break;
        case 1:
          if (nibbleIndex === 0) {
            buffer = this.u8();
            v[i] = se4(buffer >> 4);
            nibbleIndex = 1;
          } else {
            v[i] = se4(buffer & 0x0f);
            nibbleIndex = 0;
          }
          break;
        case 2:
          if (nibbleIndex === 0) {
            v[i] = se8(this.u8());
          } else {
            let c = (buffer & 0x0f) << 4;
            buffer = this.u8();
            c |= buffer >> 4;
            v[i] = se8(c);
          }
          break;
        default:
          if (nibbleIndex === 0) {
            const c1 = this.u8();
            const c2 = this.u8();
            v[i] = se16((c1 << 8) | c2);
          } else {
            const c1 = this.u8();
            const c2 = this.u8();
            v[i] = se16(((buffer & 0x0f) << 12) | (c1 << 4) | (c2 >> 4));
            buffer = c2;
          }
          break;
      }
      selector >>= 2;
    }
  }

  // --- TAG8_8SVB ------------------------------------------------------------
  tag8_8SVB(v, valueCount) {
    if (valueCount === 1) {
      v[0] = this.svb();
      return;
    }
    let header = this.u8();
    for (let i = 0; i < 8; i++, header >>= 1) {
      v[i] = header & 0x01 ? this.svb() : 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Field presentation metadata
// ---------------------------------------------------------------------------

const FIELD_META = [
  [/^loopIteration$/, 'Meta', '', null],
  [/^time$/, 'Meta', 's', null],
  [/^axis[PIDF]\[/, 'PID', '', null],
  [/^axisSum\[/, 'PID', '', null],
  [/^axisError\[/, 'PID', '', null],
  [/^rcCommand\[3\]$/, 'RC', '', null],
  [/^rcCommand\[/, 'RC', '', null],
  [/^setpoint\[/, 'RC', '', null],
  [/^rssi$/, 'RC', '', null],
  [/^gyroADC\[/, 'Gyro', '°/s', 'gyro'],
  [/^gyroUnfilt\[/, 'Gyro', '°/s', 'gyro'],
  [/^accSmooth\[/, 'Accel', 'g', 'acc'],
  [/^motor\[/, 'Motor', '', null],
  [/^eRPM\[/, 'RPM', 'eRPM', null],
  [/^eRPMkiss\[/, 'RPM', 'eRPM', null],
  [/^rpm\[/, 'RPM', 'eRPM', null],
  [/^escTemperature/, 'ESC', '°C', null],
  [/^escConsumption/, 'ESC', 'mAh', null],
  [/^escStress/, 'ESC', '', null],
  [/^vbat/i, 'Power', 'V', 'vbat'],
  [/^amperage/i, 'Power', 'A', 'amperage'],
  [/^energyCumulative$/, 'Power', 'mAh', null],
  [/^debug\[/, 'Debug', '', null],
  [/^magADC\[/, 'Mag', '', null],
  [/^BaroAlt$/, 'Baro', 'm', 'baro'],
  [/^heading\[/, 'Attitude', 'rad', null],
  [/^(flightModeFlags|stateFlags|failsafePhase|rxSignalReceived|rxFlightChannelsValid)$/, 'Flags', '', null],
  [/^GPS_/, 'GPS', '', null],
];

export function fieldMeta(name) {
  for (const [re, group, unit, scale] of FIELD_META) {
    if (re.test(name)) return { group, unit, scale };
  }
  return { group: 'Other', unit: '', scale: null };
}

/**
 * Build a raw -> real-unit converter, or null to leave values untouched.
 * Only conversions we can justify from the header are applied; anything
 * uncertain stays raw so the plot never lies about magnitude.
 */
function makeScaler(kind, header) {
  switch (kind) {
    case 'gyro': {
      // gyro.scale is rad/us per LSB, stored as a hex float32 bit pattern.
      if (!header.gyroScale) return null;
      const f = header.gyroScale * (1e6 / Math.PI) * 180.0;
      return (v) => v * f;
    }
    case 'acc':
      return header.acc_1G > 1 ? (v) => v / header.acc_1G : null;
    case 'vbat':
      // Betaflight >= 4.0 logs battery voltage in 10 mV steps.
      return header.bfMajor >= 4 ? (v) => v / 100 : null;
    case 'amperage':
      // ...and current in 10 mA steps.
      return header.bfMajor >= 4 ? (v) => v / 100 : null;
    case 'baro':
      return (v) => v / 100;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function parseHeaderLines(lines) {
  const h = { raw: {}, fieldDefs: {} };

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    h.raw[key] = value;

    const m = /^Field ([IPSGH]) (\w+)$/.exec(key);
    if (m) {
      const [, ft, prop] = m;
      const def = (h.fieldDefs[ft] = h.fieldDefs[ft] || {});
      def[prop] =
        prop === 'name' ? value.split(',') : value.split(',').map((x) => parseInt(x, 10) | 0);
    }
  }

  // P frames are never given their own "Field P name" line — they describe the
  // same fields as the I frame and only override predictor/encoding.
  if (h.fieldDefs.P && !h.fieldDefs.P.name && h.fieldDefs.I && h.fieldDefs.I.name) {
    h.fieldDefs.P.name = h.fieldDefs.I.name.slice();
    if (!h.fieldDefs.P.signed && h.fieldDefs.I.signed) {
      h.fieldDefs.P.signed = h.fieldDefs.I.signed.slice();
    }
  }

  // Every frame definition needs a field count and a name->index map.
  for (const ft of Object.keys(h.fieldDefs)) {
    const def = h.fieldDefs[ft];
    if (!def.name) {
      delete h.fieldDefs[ft];
      continue;
    }
    def.count = def.name.length;
    def.nameToIndex = {};
    def.name.forEach((n, i) => (def.nameToIndex[n] = i));
    // I-frame definitions supply defaults for missing P/S/G arrays.
    if (!def.predictor) def.predictor = new Array(def.count).fill(0);
    if (!def.encoding) def.encoding = new Array(def.count).fill(ENCODING.SIGNED_VB);
    if (!def.signed) def.signed = new Array(def.count).fill(1);
  }

  const num = (k, dflt) => {
    const v = parseFloat(h.raw[k]);
    return Number.isFinite(v) ? v : dflt;
  };

  h.firmware = h.raw['Firmware revision'] || 'unknown';
  h.firmwareType = h.raw['Firmware type'] || '';
  h.craftName = h.raw['Craft name'] || '';
  h.dataVersion = num('Data version', 2);
  h.iInterval = num('I interval', 32);
  h.pInterval = h.raw['P interval'] || '1/1';
  h.minthrottle = num('minthrottle', 1000);
  h.maxthrottle = num('maxthrottle', 2000);
  h.acc_1G = num('acc_1G', 1);
  h.vbatscale = num('vbatscale', 110);
  h.vbatref = num('vbatref', 0);
  h.looptime = num('looptime', 0);

  const bf = /Betaflight\s+(\d+)\.(\d+)/.exec(h.firmware);
  h.bfMajor = bf ? parseInt(bf[1], 10) : 0;
  h.bfMinor = bf ? parseInt(bf[2], 10) : 0;

  const mo = (h.raw['motorOutput'] || '').split(',');
  h.motorOutputLow = parseFloat(mo[0]);
  h.motorOutputHigh = parseFloat(mo[1]);
  if (!Number.isFinite(h.motorOutputLow)) h.motorOutputLow = h.minthrottle;
  if (!Number.isFinite(h.motorOutputHigh)) h.motorOutputHigh = h.maxthrottle;

  const gs = h.raw['gyro.scale'] || h.raw['gyro_scale'];
  if (gs) {
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    dv.setUint32(0, parseInt(gs.replace(/^0x/i, ''), 16) >>> 0, false);
    h.gyroScale = dv.getFloat32(0, false);
  }

  // P interval "num/denom" controls how many loop iterations a P frame covers.
  const pi = /^(\d+)(?:\/(\d+))?$/.exec(h.pInterval.trim());
  h.pNum = pi ? parseInt(pi[1], 10) : 1;
  h.pDenom = pi && pi[2] ? parseInt(pi[2], 10) : 1;

  return h;
}

// ---------------------------------------------------------------------------
// Frame decoding
// ---------------------------------------------------------------------------

function makeDecoder(header, ctx) {
  const dataVersion = header.dataVersion;

  return function parseFrame(def, current, previous, previous2, skippedFrames) {
    const { predictor, encoding, count } = def;
    const values = new Array(8).fill(0);
    let i = 0;

    while (i < count) {
      if (predictor[i] === PREDICTOR.INCREMENT) {
        // Nothing is read from the stream for INC fields.
        current[i] = skippedFrames + 1 + (previous ? previous[i] : 0);
        i++;
        continue;
      }

      let value;
      switch (encoding[i]) {
        case ENCODING.SIGNED_VB:
          value = ctx.stream.svb();
          break;
        case ENCODING.UNSIGNED_VB:
          value = ctx.stream.uvb();
          break;
        case ENCODING.NEG_14BIT:
          value = -se14(ctx.stream.uvb());
          break;
        case ENCODING.NULL:
          value = 0;
          break;

        case ENCODING.TAG8_4S16: {
          if (dataVersion < 2) ctx.stream.tag8_4S16_v1(values);
          else ctx.stream.tag8_4S16_v2(values);
          for (let j = 0; j < 4 && i < count; j++, i++) {
            current[i] = applyPrediction(i, predictor[i], values[j], current, previous, previous2, ctx);
          }
          continue;
        }
        case ENCODING.TAG2_3S32: {
          ctx.stream.tag2_3S32(values);
          for (let j = 0; j < 3 && i < count; j++, i++) {
            current[i] = applyPrediction(i, predictor[i], values[j], current, previous, previous2, ctx);
          }
          continue;
        }
        case ENCODING.TAG2_3SVARIABLE: {
          ctx.stream.tag2_3SVariable(values);
          for (let j = 0; j < 3 && i < count; j++, i++) {
            current[i] = applyPrediction(i, predictor[i], values[j], current, previous, previous2, ctx);
          }
          continue;
        }
        case ENCODING.TAG8_8SVB: {
          // The group runs until the encoding changes, max 8 fields.
          let n = 1;
          while (n < 8 && i + n < count && encoding[i + n] === ENCODING.TAG8_8SVB) n++;
          ctx.stream.tag8_8SVB(values, n);
          for (let j = 0; j < n; j++, i++) {
            current[i] = applyPrediction(i, predictor[i], values[j], current, previous, previous2, ctx);
          }
          continue;
        }

        default:
          throw new Error(`Unsupported field encoding ${encoding[i]}`);
      }

      current[i] = applyPrediction(i, predictor[i], value, current, previous, previous2, ctx);
      i++;
    }
  };
}

function applyPrediction(fieldIndex, predictor, value, current, previous, previous2, ctx) {
  switch (predictor) {
    case PREDICTOR.ZERO:
      return value;
    case PREDICTOR.MINTHROTTLE:
      return Math.trunc(value) + ctx.minthrottle;
    case PREDICTOR.MINMOTOR:
      return Math.trunc(value) + Math.trunc(ctx.motorOutputLow);
    case PREDICTOR.MID_1500:
      return value + 1500;
    case PREDICTOR.MOTOR_0:
      return ctx.motor0Index >= 0 ? value + current[ctx.motor0Index] : value;
    case PREDICTOR.VBATREF:
      return value + ctx.vbatref;
    case PREDICTOR.PREVIOUS:
      return previous ? value + previous[fieldIndex] : value;
    case PREDICTOR.STRAIGHT_LINE:
      return previous ? value + 2 * previous[fieldIndex] - previous2[fieldIndex] : value;
    case PREDICTOR.AVERAGE_2:
      return previous ? value + Math.trunc((previous[fieldIndex] + previous2[fieldIndex]) / 2) : value;
    case PREDICTOR.HOME_COORD:
      return value + (ctx.gpsHome[0] || 0);
    case PREDICTOR.HOME_COORD_1:
      return value + (ctx.gpsHome[1] || 0);
    case PREDICTOR.LAST_MAIN_FRAME_TIME:
      return value + ctx.lastMainFrameTime;
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// One logging session
// ---------------------------------------------------------------------------

function decodeSession(data, start, end) {
  const dec = new TextDecoder('latin1');

  // --- header lines ---
  const lines = [];
  let p = start;
  while (p < end && data[p] === 0x48 /* H */ && data[p + 1] === 0x20) {
    let q = p + 2;
    while (q < end && data[q] !== 0x0a) q++;
    lines.push(dec.decode(data.subarray(p + 2, q)).replace(/\r$/, ''));
    p = q + 1;
  }
  if (!lines.length) return null;

  const header = parseHeaderLines(lines);
  const defI = header.fieldDefs.I;
  if (!defI) return null;
  const defP = header.fieldDefs.P || defI;
  const defS = header.fieldDefs.S;
  const defG = header.fieldDefs.G;
  const defH = header.fieldDefs.H;

  // P frames reuse the I frame's field list; make sure counts line up.
  defP.count = defI.count;
  defP.name = defI.name;

  const names = defI.name;
  const n = names.length;
  const timeIndex = names.indexOf('time');
  const iterIndex = names.indexOf('loopIteration');

  const ctx = {
    stream: new Stream(data, p, end),
    minthrottle: header.minthrottle,
    motorOutputLow: header.motorOutputLow,
    vbatref: header.vbatref,
    motor0Index: names.indexOf('motor[0]'),
    gpsHome: [0, 0],
    lastMainFrameTime: 0,
  };
  const stream = ctx.stream;
  const parseFrame = makeDecoder(header, ctx);

  // --- history ring: [0]=current, [1]=previous, [2]=previous-previous --------
  const ring = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  let cur = ring[0];
  let prev = null;
  let prev2 = null;

  // --- growable columnar store ---
  let cap = 16384;
  let cols = [];
  for (let f = 0; f < n; f++) cols.push(new Float64Array(cap));
  let count = 0;

  const commit = (frame) => {
    if (count === cap) {
      cap *= 2;
      cols = cols.map((c) => {
        const bigger = new Float64Array(cap);
        bigger.set(c);
        return bigger;
      });
    }
    for (let f = 0; f < n; f++) cols[f][count] = frame[f];
    count++;
  };

  const events = [];
  const slowNames = defS ? defS.name : [];
  const slowCols = slowNames.map(() => []);
  const slowTimes = [];
  const scratch = new Float64Array(
    Math.max(n, slowNames.length, defG ? defG.count : 0, defH ? defH.count : 0) + 8
  );

  let iFrames = 0;
  let pFrames = 0;
  let corrupt = 0;
  let lastIteration = -1;
  let lastTime = -1;
  let streamValid = false;
  let skippedFrames = 0;

  // How many loop iterations were intentionally not logged before `index`.
  const shouldHaveFrame = (index) =>
    ((index % header.iInterval) + header.pNum - 1) % header.pDenom < header.pNum;

  const advanceHistory = (frameValid, isIntra) => {
    if (isIntra) {
      // Nothing before an I frame is usable as a reference.
      prev = Float64Array.from(cur);
      prev2 = prev;
    } else if (frameValid) {
      prev2 = prev;
      prev = Float64Array.from(cur);
    }
    cur = new Float64Array(prev || n);
  };

  while (stream.pos < end && !stream.eof) {
    const frameStart = stream.pos;
    const type = stream.u8();

    try {
      if (type === 0x49 /* I */) {
        cur = new Float64Array(n);
        parseFrame(defI, cur, null, null, 0);

        const it = iterIndex >= 0 ? cur[iterIndex] : count;
        const t = timeIndex >= 0 ? cur[timeIndex] : count;
        const accept =
          lastIteration === -1 ||
          (it >= lastIteration && it < lastIteration + MAX_ITERATION_JUMP &&
            t >= lastTime && t < lastTime + MAX_TIME_JUMP);

        if (accept) {
          lastIteration = it;
          lastTime = t;
          ctx.lastMainFrameTime = t;
          streamValid = true;
          commit(cur);
          iFrames++;
          advanceHistory(true, true);
        } else {
          streamValid = false;
          corrupt++;
        }
      } else if (type === 0x50 /* P */) {
        if (!streamValid || !prev) {
          corrupt++;
          // Skip forward to the next frame marker.
          let q = frameStart + 1;
          while (q < end && data[q] !== 0x49) q++;
          stream.pos = q;
          continue;
        }

        // Work out how many iterations this P frame skipped over.
        skippedFrames = 0;
        for (let i = lastIteration + 1; !shouldHaveFrame(i); i++) skippedFrames++;

        cur = new Float64Array(n);
        parseFrame(defP, cur, prev, prev2, skippedFrames);

        const it = iterIndex >= 0 ? cur[iterIndex] : lastIteration + 1;
        const t = timeIndex >= 0 ? cur[timeIndex] : lastTime + 1;
        const accept =
          it >= lastIteration && it < lastIteration + MAX_ITERATION_JUMP &&
          t >= lastTime && t < lastTime + MAX_TIME_JUMP;

        if (accept) {
          lastIteration = it;
          lastTime = t;
          ctx.lastMainFrameTime = t;
          commit(cur);
          pFrames++;
          advanceHistory(true, false);
        } else {
          streamValid = false;
          corrupt++;
        }
      } else if (type === 0x53 /* S */ && defS) {
        parseFrame(defS, scratch, null, null, 0);
        for (let f = 0; f < slowNames.length; f++) slowCols[f].push(scratch[f]);
        slowTimes.push(ctx.lastMainFrameTime);
      } else if (type === 0x47 /* G */ && defG) {
        parseFrame(defG, scratch, null, null, 0);
      } else if (type === 0x48 /* H */ && defH) {
        parseFrame(defH, scratch, null, null, 0);
        ctx.gpsHome = [scratch[0], scratch[1]];
      } else if (type === 0x45 /* E */) {
        const evType = stream.u8();
        const ev = {
          timeUs: ctx.lastMainFrameTime,
          type: evType,
          name: EVENT_NAMES[evType] || `EVENT_${evType}`,
          data: {},
        };
        if (evType === 0 || evType === 14) {
          ev.data.time = stream.uvb();
          if (evType === 14) ev.data.iteration = stream.uvb();
        } else if (evType === 30) {
          ev.data.reason = stream.uvb();
        } else if (evType === 41) {
          ev.data.flags = stream.uvb();
          ev.data.lastFlags = stream.uvb();
        } else if (evType === 13) {
          const fn = stream.u8();
          ev.data.function = fn & 0x7f;
          ev.data.value = fn & 0x80 ? stream.svb() : stream.uvb();
        } else if (evType === 255) {
          let q = stream.pos;
          while (q < end && data[q] !== 0x00) q++;
          ev.data.message = dec.decode(data.subarray(stream.pos, q));
          stream.pos = q + 1;
          events.push(ev);
          break;
        }
        events.push(ev);
      } else {
        // Desync — hunt for the next I frame.
        corrupt++;
        streamValid = false;
        let q = frameStart + 1;
        while (q < end && data[q] !== 0x49) q++;
        if (q >= end) break;
        stream.pos = q;
        if (corrupt > 10000) break;
      }
    } catch (err) {
      corrupt++;
      streamValid = false;
      let q = frameStart + 1;
      while (q < end && data[q] !== 0x49) q++;
      if (q >= end) break;
      stream.pos = q;
      if (corrupt > 10000) break;
    }
  }

  if (count === 0) return null;

  // --- build columns, scaled and raw ---
  const columns = {};
  const raw = {};
  const fields = [];
  for (let f = 0; f < n; f++) {
    const name = names[f];
    const meta = fieldMeta(name);
    const rawArr = Float64Array.from(cols[f].subarray(0, count));
    raw[name] = rawArr;

    const scaler = makeScaler(meta.scale, header);
    let arr = rawArr;
    if (scaler) {
      arr = new Float64Array(count);
      for (let k = 0; k < count; k++) arr[k] = scaler(rawArr[k]);
    }
    columns[name] = arr;

    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < count; k++) {
      const v = arr[k];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    fields.push({
      index: f,
      name,
      group: meta.group,
      unit: scaler ? meta.unit : meta.scale ? '' : meta.unit,
      signed: !!defI.signed[f],
      min,
      max,
      constant: min === max,
    });
  }

  // --- time axis in seconds, zero based ---
  const time = new Float64Array(count);
  if (timeIndex >= 0) {
    const t0 = cols[timeIndex][0];
    for (let k = 0; k < count; k++) time[k] = (cols[timeIndex][k] - t0) / 1e6;
  } else {
    for (let k = 0; k < count; k++) time[k] = k;
  }

  const durationSec = count > 1 ? time[count - 1] - time[0] : 0;

  // Sample spacing is often far from uniform (ESC telemetry, dropped frames),
  // so report the nominal (median) rate alongside the average.
  let medianDtSec = 0;
  let maxGapSec = 0;
  if (count > 1) {
    const dts = new Float64Array(count - 1);
    for (let k = 1; k < count; k++) {
      const dt = time[k] - time[k - 1];
      dts[k - 1] = dt;
      if (dt > maxGapSec) maxGapSec = dt;
    }
    const sorted = Float64Array.from(dts).sort();
    medianDtSec = sorted[sorted.length >> 1];
  }

  return {
    header,
    headerLines: lines,
    fields,
    columns,
    raw,
    time,
    count,
    events,
    slow: { names: slowNames, times: slowTimes, columns: slowCols },
    stats: {
      frames: count,
      durationSec,
      sampleRateHz: medianDtSec > 0 ? 1 / medianDtSec : 0, // nominal rate
      avgRateHz: durationSec > 0 ? (count - 1) / durationSec : 0,
      medianDtSec,
      maxGapSec,
      iFrames,
      pFrames,
      corrupt,
      byteLength: end - start,
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Decode a .BFL / .BBL file. A file may contain several concatenated sessions.
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Array<object>} one entry per decodable logging session
 */
export function parseBlackbox(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);

  const marker = [];
  for (let i = 0; i < LOG_START_MARKER.length; i++) marker.push(LOG_START_MARKER.charCodeAt(i));

  const starts = [];
  outer: for (let i = 0; i + marker.length <= data.length; i++) {
    if (data[i] !== marker[0]) continue;
    for (let k = 1; k < marker.length; k++) {
      if (data[i + k] !== marker[k]) continue outer;
    }
    starts.push(i);
    i += marker.length;
  }

  if (!starts.length) {
    throw new Error(
      'No Betaflight blackbox header found — expected a .BFL/.BBL file written by the flight controller.'
    );
  }

  const logs = [];
  const errors = [];
  for (let s = 0; s < starts.length; s++) {
    const end = s + 1 < starts.length ? starts[s + 1] : data.length;
    try {
      const log = decodeSession(data, starts[s], end);
      if (log) {
        log.index = logs.length;
        logs.push(log);
      }
    } catch (err) {
      errors.push(`session ${s + 1}: ${err.message}`);
    }
  }

  if (!logs.length) {
    throw new Error(
      `Header found but no decodable flight data.${errors.length ? ` (${errors.join('; ')})` : ''}`
    );
  }
  return logs;
}
