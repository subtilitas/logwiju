/*
 * csv-parser.js — CSV/TSV import, producing the same log object the viewer
 * already renders (see bbl-parser.js for the shape).
 *
 * Expects field names on the first line. Values may carry a unit suffix
 * ("10.23A", "22,34V"), and numbers may follow either the German or the English
 * decimal convention — see numbers.js for how that is decided.
 *
 * Two-phase by design: `analyseCsv` reports what it detected without committing
 * to it, so the import dialog can show the user a preview and let them override
 * the delimiter, decimal convention and time column before `buildCsvLog` runs.
 */

import {
  CONVENTION,
  AMBIGUOUS_AS,
  inferConvention,
  parseWith,
  splitValue,
  dominantUnit,
  unitFromHeader,
  TIME_UNIT_SCALE,
} from './numbers.js';
import { fieldMeta } from './bbl-parser.js';

const DELIMITERS = [
  { char: ';', label: 'Semicolon  ;' },
  { char: ',', label: 'Comma  ,' },
  { char: '\t', label: 'Tab' },
  { char: '|', label: 'Pipe  |' },
];

// Column names that suggest a time axis, in several languages.
const TIME_NAME_RE =
  /^(time|timestamp|zeit|zeitstempel|t|elapsed|clock|sekunden|seconds|millis|micros)$/i;
const TIME_CONTAINS_RE = /(time|zeit|elapsed|timestamp)/i;

// ---------------------------------------------------------------------------
// Line and field splitting
// ---------------------------------------------------------------------------

/** Split CSV text into rows of fields, honouring quotes and escaped quotes. */
export function splitRows(text, delimiter) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // handled by the \n branch
    } else {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Guess the delimiter: the candidate giving the most consistent, widest split
 * across the sample lines.
 */
export function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 25);
  if (!sample.length) return ',';

  let best = ',';
  let bestScore = -1;

  for (const { char } of DELIMITERS) {
    const counts = sample.map((line) => splitRows(line, char)[0].length);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((n) => n === first).length / counts.length;
    // Consistency matters far more than width: a stray comma inside text
    // should not beat a clean semicolon layout.
    const score = consistent * 100 + Math.min(first, 40);
    if (score > bestScore) {
      bestScore = score;
      best = char;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Analysis (no commitment — feeds the import dialog)
// ---------------------------------------------------------------------------

/**
 * Inspect CSV text and report everything the import dialog needs.
 * @param {string} text
 * @param {object} [opts] { delimiter, convention, ambiguousAs }
 */
export function analyseCsv(text, opts = {}) {
  const delimiter = opts.delimiter || sniffDelimiter(text);
  const ambiguousAs = opts.ambiguousAs || AMBIGUOUS_AS.THOUSANDS;

  const rows = splitRows(text.replace(/^﻿/, ''), delimiter).filter(
    (r) => r.length > 1 || (r.length === 1 && r[0].trim())
  );
  if (rows.length < 2) {
    throw new Error('Need a header line and at least one data row.');
  }

  const rawHeader = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1).filter((r) => r.some((c) => c && c.trim()));
  if (!dataRows.length) throw new Error('No data rows found below the header.');

  const nCols = rawHeader.length;

  // Rows whose field count differs from the header usually mean the delimiter
  // is wrong, or that a grouped number like 1,520 was written unquoted into a
  // comma-separated file. Either way the columns after it are shifted, so this
  // has to be reported rather than quietly absorbed.
  let raggedRows = 0;
  let maxFields = nCols;
  for (const r of dataRows) {
    if (r.length !== nCols) raggedRows++;
    if (r.length > maxFields) maxFields = r.length;
  }

  const columnsRaw = [];
  for (let c = 0; c < nCols; c++) {
    columnsRaw.push(dataRows.map((r) => (r[c] === undefined ? '' : r[c].trim())));
  }

  // --- decimal convention -------------------------------------------------
  // Decided across all numeric-looking columns at once: a file uses one
  // convention throughout, so evidence from any column informs the rest.
  const forced = opts.convention && opts.convention !== CONVENTION.AUTO ? opts.convention : null;
  const allValues = [];
  for (const col of columnsRaw) for (const v of col) if (v) allValues.push(v);

  const inferred = inferConvention(allValues, ambiguousAs);
  const convention = forced || inferred.convention;

  // --- per column: units, parse success, stats ----------------------------
  const columns = [];
  for (let c = 0; c < nCols; c++) {
    const { name, unit: headerUnit } = unitFromHeader(rawHeader[c] || `column ${c + 1}`);
    const raw = columnsRaw[c];

    const units = [];
    let parsed = 0;
    let nonEmpty = 0;
    for (const v of raw) {
      if (!v) continue;
      nonEmpty++;
      const p = splitValue(v);
      if (p) units.push(p.unit);
      if (parseWith(v, convention)) parsed++;
    }

    const { unit: valueUnit, mixed } = dominantUnit(units);
    columns.push({
      index: c,
      rawHeader: rawHeader[c],
      name: name || `column ${c + 1}`,
      unit: valueUnit || headerUnit,
      unitFromValues: !!valueUnit,
      mixedUnits: mixed,
      nonEmpty,
      parsed,
      numeric: nonEmpty > 0 && parsed / nonEmpty >= 0.8,
      parseRate: nonEmpty ? parsed / nonEmpty : 0,
      sample: raw.slice(0, 5),
    });
  }

  // --- time column --------------------------------------------------------
  let timeIndex = -1;
  if (opts.timeIndex !== undefined && opts.timeIndex !== null) {
    timeIndex = opts.timeIndex;
  } else {
    timeIndex = columns.findIndex((c) => c.numeric && TIME_NAME_RE.test(c.name));
    if (timeIndex < 0) {
      timeIndex = columns.findIndex((c) => c.numeric && TIME_CONTAINS_RE.test(c.rawHeader));
    }
    // A first column that only ever increases is very likely a time axis.
    if (timeIndex < 0 && columns[0] && columns[0].numeric) {
      const vals = columnsRaw[0].map((v) => parseWith(v, convention)).filter(Boolean).map((p) => p.value);
      let monotonic = vals.length > 1;
      for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1]) { monotonic = false; break; }
      if (monotonic) timeIndex = 0;
    }
  }

  const timeUnit =
    opts.timeUnit ||
    (timeIndex >= 0 ? guessTimeUnit(columns[timeIndex], columnsRaw[timeIndex], convention) : 's');

  return {
    delimiter,
    delimiters: DELIMITERS,
    convention,
    conventionForced: !!forced,
    conventionConfident: inferred.confident,
    conventionConflict: inferred.conflict,
    conventionVotes: inferred.votes,
    ambiguousAs,
    columns,
    columnsRaw,
    timeIndex,
    timeUnit,
    rowCount: dataRows.length,
    header: rawHeader,
    raggedRows,
    maxFields,
  };
}

/** Guess whether a time column is in s, ms or µs. */
function guessTimeUnit(col, raw, convention) {
  const u = (col.unit || '').toLowerCase().replace(/[()[\]]/g, '');
  if (TIME_UNIT_SCALE[u] !== undefined) return u;
  if (/millis/i.test(col.rawHeader)) return 'ms';
  if (/micros/i.test(col.rawHeader)) return 'us';

  // Fall back on magnitude: a flight log is minutes long, so a span in the
  // millions is microseconds, in the hundreds of thousands milliseconds.
  const vals = raw.map((v) => parseWith(v, convention)).filter(Boolean).map((p) => p.value);
  if (vals.length < 2) return 's';
  const span = vals[vals.length - 1] - vals[0];
  if (span > 5e6) return 'us';
  if (span > 5e3) return 'ms';
  return 's';
}

// ---------------------------------------------------------------------------
// Build the log object
// ---------------------------------------------------------------------------

/**
 * Turn an analysis into a renderable log.
 * @param {object} analysis  from analyseCsv
 * @param {object} meta      { name } source file name
 */
export function buildCsvLog(analysis, meta = {}) {
  const { columns, columnsRaw, convention, timeIndex, timeUnit } = analysis;

  // The time column drives the x axis; plotting it against itself as a lane
  // would just draw a diagonal line, so it is left out of the field list.
  const usable = columns.filter((c) => c.numeric && c.index !== timeIndex);
  if (!usable.length) {
    throw new Error(
      'No numeric columns found. Check the delimiter and decimal settings — the preview shows how values are being read.'
    );
  }

  const count = analysis.rowCount;

  // --- parse every numeric column ----------------------------------------
  const columnsOut = {};
  const raw = {};
  const fields = [];
  let unparsedCells = 0;

  for (const col of usable) {
    const src = columnsRaw[col.index];
    const arr = new Float64Array(count);
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < count; i++) {
      const p = src[i] ? parseWith(src[i], convention) : null;
      if (!p) {
        // Hold the previous value across gaps so a single unreadable cell does
        // not punch a hole in the trace; count it so the UI can report it.
        arr[i] = i > 0 ? arr[i - 1] : NaN;
        if (src[i]) unparsedCells++;
        continue;
      }
      arr[i] = p.value;
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }

    if (min === Infinity) {
      min = 0;
      max = 0;
    }

    columnsOut[col.name] = arr;
    raw[col.name] = arr;

    // Reuse the blackbox grouping when names match (a CSV exported from a
    // blackbox tool groups exactly like the binary log); otherwise group by
    // unit, which keeps related channels together.
    const bbMeta = fieldMeta(col.name);
    const group =
      bbMeta.group !== 'Other' ? bbMeta.group : col.unit ? `Unit ${col.unit}` : 'Data';

    fields.push({
      index: fields.length,
      name: col.name,
      group,
      unit: col.unit,
      signed: min < 0,
      min,
      max,
      constant: min === max,
      mixedUnits: col.mixedUnits,
    });
  }

  // --- time axis ----------------------------------------------------------
  const time = new Float64Array(count);
  let timeName = null;

  if (timeIndex >= 0 && columns[timeIndex] && columns[timeIndex].numeric) {
    const scale = TIME_UNIT_SCALE[(timeUnit || 's').toLowerCase()] ?? 1;
    const src = columnsRaw[timeIndex];
    timeName = columns[timeIndex].name;

    let t0 = null;
    let last = 0;
    for (let i = 0; i < count; i++) {
      const p = src[i] ? parseWith(src[i], convention) : null;
      const v = p ? p.value * scale : last;
      if (t0 === null) t0 = v;
      last = v;
      time[i] = v - t0;
    }

    // A time axis that runs backwards means the wrong column was picked.
    let monotonic = true;
    for (let i = 1; i < count; i++) if (time[i] < time[i - 1]) { monotonic = false; break; }
    if (!monotonic) {
      for (let i = 0; i < count; i++) time[i] = i;
      timeName = null;
    }
  } else {
    for (let i = 0; i < count; i++) time[i] = i;
  }

  // --- stats --------------------------------------------------------------
  const durationSec = count > 1 ? time[count - 1] - time[0] : 0;
  let medianDtSec = 0;
  let maxGapSec = 0;
  if (count > 1) {
    const dts = new Float64Array(count - 1);
    for (let i = 1; i < count; i++) {
      const dt = time[i] - time[i - 1];
      dts[i - 1] = dt;
      if (dt > maxGapSec) maxGapSec = dt;
    }
    medianDtSec = Float64Array.from(dts).sort()[(count - 1) >> 1];
  }

  return {
    source: 'csv',
    index: 0,
    header: {
      craftName: meta.name || 'CSV import',
      firmware: `CSV · ${convention === 'de' ? 'German' : 'English'} numbers · ${
        analysis.delimiter === '\t' ? 'tab' : analysis.delimiter
      }-separated`,
      raw: {},
    },
    headerLines: [],
    fields,
    columns: columnsOut,
    raw,
    time,
    count,
    events: [],
    slow: { names: [], times: [], columns: [] },
    csv: {
      convention,
      delimiter: analysis.delimiter,
      timeColumn: timeName,
      timeUnit: timeName ? timeUnit : null,
      unparsedCells,
      skippedColumns: columns.filter((c) => !c.numeric).map((c) => c.name),
    },
    stats: {
      frames: count,
      durationSec,
      sampleRateHz: medianDtSec > 0 ? 1 / medianDtSec : 0,
      avgRateHz: durationSec > 0 ? (count - 1) / durationSec : 0,
      medianDtSec,
      maxGapSec,
      iFrames: 0,
      pFrames: 0,
      corrupt: unparsedCells,
      byteLength: 0,
    },
  };
}

/** True if the file looks like CSV rather than a binary blackbox log. */
export function looksLikeCsv(name, bytes) {
  if (/\.(csv|tsv|txt)$/i.test(name)) {
    // A blackbox log can also be .txt, so check for its magic header.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64));
    return !head.startsWith('H Product:Blackbox');
  }
  return false;
}

export { DELIMITERS };
