/*
 * numbers.js — locale-tolerant numeric parsing with unit suffixes.
 *
 * The hard part is that "1,234" is genuinely ambiguous: German reads 1.234,
 * English reads 1234. Guessing per value is unsafe, because the same column
 * would then parse inconsistently — "1,234" as 1234 on one row and "10,23" as
 * 10.23 on the next implies two different conventions in one column, which no
 * real exporter produces.
 *
 * So convention is decided per *column*. Most columns contain at least one
 * value that settles it:
 *
 *   "1.234,56"  both separators  -> the last one is the decimal   (German)
 *   "1,234.56"  both separators  -> the last one is the decimal   (English)
 *   "10,23"     one, 2 trailing  -> not a thousands group         (German)
 *   "1.5"       one, 1 trailing  -> not a thousands group         (English)
 *   "1.234.567" repeated         -> that separator groups         (German)
 *   "1,234"     one, 3 trailing  -> ambiguous, no evidence
 *
 * Only when every value in a column is ambiguous does the fallback apply.
 */

/** Decimal conventions. */
export const CONVENTION = {
  AUTO: 'auto',
  GERMAN: 'de', // 1.234,56
  ENGLISH: 'en', // 1,234.56
};

/** What an all-ambiguous column defaults to. */
export const AMBIGUOUS_AS = {
  THOUSANDS: 'thousands', // "1,234" -> 1234
  DECIMAL: 'decimal', // "1,234" -> 1.234
};

// A number, optionally signed, optionally with grouping/decimal separators,
// optionally followed by a unit. Also accepts exponent notation.
const VALUE_RE =
  /^\s*([+-]?)\s*((?:\d[\d.,  ' ]*)?\d|\d)\s*(?:[eE]([+-]?\d+))?\s*([^\s\d].*?)?\s*$/;

// Separators some exporters use for grouping that are never decimal points.
const GROUPING_ONLY = /[  ' ]/g;

/**
 * Split a raw cell into its numeric text, exponent and unit.
 * @returns {{ digits: string, sign: number, exp: number, unit: string } | null}
 */
export function splitValue(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const m = VALUE_RE.exec(s);
  if (!m) return null;

  const sign = m[1] === '-' ? -1 : 1;
  const digits = m[2].replace(GROUPING_ONLY, '');
  const exp = m[3] ? parseInt(m[3], 10) : 0;
  const unit = (m[4] || '').trim();

  if (!/\d/.test(digits)) return null;
  return { digits, sign, exp, unit };
}

/**
 * Inspect one numeric string and report what it proves about the convention.
 * @returns {'de'|'en'|'ambiguous'|'none'}
 */
export function evidenceOf(digits) {
  const dot = digits.lastIndexOf('.');
  const comma = digits.lastIndexOf(',');

  // Both separators present: whichever comes last is the decimal point.
  if (dot >= 0 && comma >= 0) return comma > dot ? 'de' : 'en';

  const sep = dot >= 0 ? '.' : comma >= 0 ? ',' : null;
  if (!sep) return 'none';

  const parts = digits.split(sep);

  // Repeated separator can only be grouping: "1.234.567".
  if (parts.length > 2) return sep === '.' ? 'de' : 'en';

  const tail = parts[1];

  // A grouping separator is always followed by exactly three digits. Anything
  // else settles it as a decimal point.
  if (tail.length !== 3) return sep === ',' ? 'de' : 'en';

  // Leading zero in the group ("1,024") is still a legal thousands group, and
  // a leading zero after a decimal point is equally normal, so no evidence.
  return 'ambiguous';
}

/**
 * Decide a column's convention from all of its values.
 * @param {string[]} rawValues
 * @param {string} fallback  AMBIGUOUS_AS.*
 * @returns {{ convention: 'de'|'en', confident: boolean, votes: {de:number,en:number,ambiguous:number}, conflict: boolean }}
 */
export function inferConvention(rawValues, fallback = AMBIGUOUS_AS.THOUSANDS) {
  const votes = { de: 0, en: 0, ambiguous: 0 };
  let ambiguousSep = null;

  for (const raw of rawValues) {
    const parts = splitValue(raw);
    if (!parts) continue;
    const ev = evidenceOf(parts.digits);
    if (ev === 'de' || ev === 'en') votes[ev]++;
    else if (ev === 'ambiguous') {
      votes.ambiguous++;
      if (!ambiguousSep) ambiguousSep = parts.digits.includes(',') ? ',' : '.';
    }
  }

  const decided = votes.de > 0 || votes.en > 0;
  if (decided) {
    return {
      convention: votes.de >= votes.en ? 'de' : 'en',
      confident: true,
      votes,
      // Both conventions "proven" in one column means the file is inconsistent.
      conflict: votes.de > 0 && votes.en > 0,
    };
  }

  // No evidence anywhere. Interpret the ambiguous separator per the fallback:
  // treating "1,234" as thousands means comma groups, i.e. English.
  let convention = 'en';
  if (ambiguousSep === ',') convention = fallback === AMBIGUOUS_AS.THOUSANDS ? 'en' : 'de';
  else if (ambiguousSep === '.') convention = fallback === AMBIGUOUS_AS.THOUSANDS ? 'de' : 'en';

  return { convention, confident: false, votes, conflict: false };
}

/**
 * Is `digits` well formed under the given convention?
 *
 * This has to be strict. Merely stripping the grouping separator and hoping the
 * result parses will happily turn the German "1.234,56" into 1.23456 when told
 * to read it as English — a silently wrong number, which is worse than no
 * number at all. Rejecting instead lets the caller surface the mismatch.
 */
export function isWellFormed(digits, convention) {
  const decimalSep = convention === 'de' ? ',' : '.';
  const groupSep = convention === 'de' ? '.' : ',';

  const parts = digits.split(decimalSep);
  if (parts.length > 2) return false; // more than one decimal point

  const [intPart, fracPart] = parts;

  // The fractional part may not contain any separator at all.
  if (fracPart !== undefined && !/^\d+$/.test(fracPart)) return false;

  if (intPart.includes(groupSep)) {
    const groups = intPart.split(groupSep);
    // Leading group is 1-3 digits, every later group exactly 3.
    if (!/^\d{1,3}$/.test(groups[0])) return false;
    for (let i = 1; i < groups.length; i++) {
      if (!/^\d{3}$/.test(groups[i])) return false;
    }
  } else if (!/^\d*$/.test(intPart)) {
    return false;
  }

  return /\d/.test(digits);
}

/**
 * Parse a single value using a known convention.
 * Returns null when the value does not conform, rather than guessing.
 * @param {string} raw
 * @param {'de'|'en'} convention
 * @returns {{ value: number, unit: string } | null}
 */
export function parseWith(raw, convention) {
  const parts = splitValue(raw);
  if (!parts) return null;
  if (!isWellFormed(parts.digits, convention)) return null;

  const decimalSep = convention === 'de' ? ',' : '.';
  const groupSep = convention === 'de' ? '.' : ',';

  let d = parts.digits.split(groupSep).join('');
  if (decimalSep !== '.') d = d.split(decimalSep).join('.');

  let value = parseFloat(d);
  if (!Number.isFinite(value)) return null;
  if (parts.exp) value *= Math.pow(10, parts.exp);

  return { value: parts.sign * value, unit: parts.unit };
}

/**
 * Convenience: parse a standalone value, inferring the convention from it alone.
 * Used for one-off parsing where no column context exists.
 */
export function parseLoose(raw, fallback = AMBIGUOUS_AS.THOUSANDS) {
  const { convention } = inferConvention([raw], fallback);
  return parseWith(raw, convention);
}

/**
 * Pick the representative unit for a column: the most common non-empty suffix.
 * @param {string[]} units
 * @returns {{ unit: string, mixed: boolean }}
 */
export function dominantUnit(units) {
  const counts = new Map();
  for (const u of units) {
    if (!u) continue;
    counts.set(u, (counts.get(u) || 0) + 1);
  }
  if (!counts.size) return { unit: '', mixed: false };

  let best = '';
  let bestN = 0;
  for (const [u, n] of counts) {
    if (n > bestN) {
      best = u;
      bestN = n;
    }
  }
  return { unit: best, mixed: counts.size > 1 };
}

/**
 * Pull a unit out of a column header like "voltage (V)", "current [A]",
 * "speed m/s" or "temp_degC".
 * @returns {{ name: string, unit: string }}
 */
export function unitFromHeader(header) {
  const s = String(header).trim();

  // "voltage (V)" / "current [A]" — but not "gyroADC[0]" or "motor[3]", where
  // the brackets hold an axis index that belongs to the field name.
  let m = /^(.*?)[\s_]*[([{]\s*([^)\]}]+?)\s*[)\]}]\s*$/.exec(s);
  if (m && m[1].trim() && !/^\d+$/.test(m[2].trim())) {
    return { name: m[1].trim(), unit: m[2].trim() };
  }

  // Trailing unit after a space, e.g. "altitude m" — only when it looks like a
  // unit rather than another word.
  m = /^(.*\S)\s+([°µ%]?[A-Za-z]{1,4}(?:\/[A-Za-z]{1,3})?|%|°[CF])$/.exec(s);
  if (m && /^(m|km|cm|mm|s|ms|us|min|h|A|mA|V|mV|W|kW|Wh|mAh|Hz|kHz|rpm|g|kg|N|Pa|hPa|bar|%|°C|°F|deg|rad|m\/s|km\/h|deg\/s)$/i.test(m[2])) {
    return { name: m[1].trim(), unit: m[2] };
  }

  return { name: s, unit: '' };
}

/** Seconds-per-unit for common time units. */
export const TIME_UNIT_SCALE = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  sekunde: 1,
  sekunden: 1,
  ms: 1e-3,
  msec: 1e-3,
  millis: 1e-3,
  millisecond: 1e-3,
  milliseconds: 1e-3,
  millisekunden: 1e-3,
  us: 1e-6,
  'µs': 1e-6,
  microsecond: 1e-6,
  microseconds: 1e-6,
  mikrosekunden: 1e-6,
  ns: 1e-9,
  min: 60,
  minute: 60,
  minutes: 60,
  minuten: 60,
  h: 3600,
  hr: 3600,
  hour: 3600,
  hours: 3600,
  stunden: 3600,
};
