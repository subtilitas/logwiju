/*
 * import-dialog.js — CSV import options with a live preview.
 *
 * The decimal convention is the one setting that can silently corrupt data, so
 * it is never applied without showing its effect first: the preview re-parses
 * on every change and marks cells that fail to read under the current
 * settings. Detection picks the defaults; the user has the final say.
 */

import { analyseCsv } from './csv-parser.js';
import { CONVENTION, TIME_UNIT_SCALE, parseWith, splitValue } from './numbers.js';

const TIME_UNITS = ['s', 'ms', 'us', 'min'];

export class ImportDialog {
  constructor(root) {
    this.root = root;
    this.text = '';
    this.fileName = '';
    this.analysis = null;
    this.resolve = null;

    this.el = {
      delimiter: root.querySelector('#imp-delimiter'),
      convention: root.querySelector('#imp-convention'),
      ambiguous: root.querySelector('#imp-ambiguous'),
      timeCol: root.querySelector('#imp-timecol'),
      timeUnit: root.querySelector('#imp-timeunit'),
      preview: root.querySelector('#imp-preview'),
      notes: root.querySelector('#imp-notes'),
      title: root.querySelector('#imp-title'),
      ok: root.querySelector('#imp-ok'),
      cancel: root.querySelector('#imp-cancel'),
    };

    for (const key of ['delimiter', 'convention', 'ambiguous', 'timeCol', 'timeUnit']) {
      this.el[key].addEventListener('change', () => this.reanalyse());
    }

    this.el.cancel.addEventListener('click', () => this.close(null));
    this.el.ok.addEventListener('click', () => this.close(this.analysis));
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) this.close(null);
    });
    window.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') this.close(null);
      else if (e.key === 'Enter') this.close(this.analysis);
    });
  }

  /**
   * Show the dialog for some CSV text.
   * @returns {Promise<object|null>} the chosen analysis, or null if cancelled
   */
  open(text, fileName) {
    this.text = text;
    this.fileName = fileName;
    this.el.title.textContent = `Import ${fileName}`;

    // First pass: everything auto-detected.
    const first = analyseCsv(text);
    this.el.delimiter.value = first.delimiter;
    this.el.convention.value = CONVENTION.AUTO;
    this.el.ambiguous.value = first.ambiguousAs;

    // Time column list, rebuilt for this file.
    this.el.timeCol.innerHTML = '<option value="-1">None — use row number</option>';
    first.columns.forEach((c) => {
      const o = document.createElement('option');
      o.value = String(c.index);
      o.textContent = c.name + (c.numeric ? '' : '  (not numeric)');
      o.disabled = !c.numeric;
      this.el.timeCol.appendChild(o);
    });
    this.el.timeCol.value = String(first.timeIndex);

    this.el.timeUnit.innerHTML = TIME_UNITS.map(
      (u) => `<option value="${u}">${u === 'us' ? 'µs' : u}</option>`
    ).join('');
    this.el.timeUnit.value = first.timeUnit;

    this.reanalyse();
    this.root.hidden = false;
    this.el.ok.focus();

    return new Promise((res) => {
      this.resolve = res;
    });
  }

  close(result) {
    this.root.hidden = true;
    const r = this.resolve;
    this.resolve = null;
    if (r) r(result);
  }

  /** Re-run analysis with the current control values and redraw the preview. */
  reanalyse() {
    const timeIndex = Number(this.el.timeCol.value);
    try {
      this.analysis = analyseCsv(this.text, {
        delimiter: this.el.delimiter.value === 'auto' ? undefined : this.el.delimiter.value,
        convention: this.el.convention.value,
        ambiguousAs: this.el.ambiguous.value,
        timeIndex: timeIndex >= 0 ? timeIndex : -1,
        timeUnit: this.el.timeUnit.value,
      });
    } catch (err) {
      this.analysis = null;
      this.el.preview.innerHTML = `<div class="imp-error">${escapeHtml(err.message)}</div>`;
      this.el.notes.innerHTML = '';
      this.el.ok.disabled = true;
      return;
    }

    // Keep the time-unit control meaningful only when a time column is chosen.
    this.el.timeUnit.disabled = timeIndex < 0;
    this.el.ambiguous.disabled = this.el.convention.value !== CONVENTION.AUTO;

    this.renderPreview();
    this.renderNotes();
    this.el.ok.disabled = !this.analysis.columns.some((c) => c.numeric);
  }

  renderPreview() {
    const a = this.analysis;
    const cols = a.columns;
    const rows = Math.min(5, a.rowCount);

    let html = '<table class="imp-table"><thead><tr>';
    for (const c of cols) {
      const cls = c.numeric ? '' : ' class="skipped"';
      const unit = c.unit ? `<span class="u">${escapeHtml(c.unit)}</span>` : '';
      const time = c.index === a.timeIndex ? '<span class="t">time</span>' : '';
      html += `<th${cls}>${escapeHtml(c.name)}${unit}${time}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (const c of cols) {
        const rawVal = a.columnsRaw[c.index][r] ?? '';

        if (!rawVal) {
          html += '<td class="empty">—</td>';
          continue;
        }

        const p = parseWith(rawVal, a.convention);
        if (p) {
          const shown = formatPreview(p.value);
          html += `<td${shown !== rawVal ? ' class="conv"' : ''}>${escapeHtml(shown)}</td>`;
          continue;
        }

        // Distinguish a genuinely textual column from one that looks numeric
        // but cannot be read under the current settings. Collapsing the two
        // would hide the exact mistake this preview exists to catch.
        const looksNumeric = splitValue(rawVal) !== null;
        html += looksNumeric
          ? `<td class="bad" title="Cannot be read as ${
              a.convention === 'de' ? 'German' : 'English'
            } — check the decimal setting">${escapeHtml(rawVal)}</td>`
          : `<td class="skipped" title="Not numeric, will be ignored">${escapeHtml(rawVal)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    this.el.preview.innerHTML = html;
  }

  renderNotes() {
    const a = this.analysis;
    const notes = [];

    notes.push({
      kind: 'info',
      text: `${a.rowCount.toLocaleString()} rows · ${
        a.columns.filter((c) => c.numeric).length
      } numeric of ${a.columns.length} columns · reading numbers as ${
        a.convention === 'de' ? 'German (1.234,56)' : 'English (1,234.56)'
      }`,
    });

    if (!a.conventionForced && !a.conventionConfident) {
      notes.push({
        kind: 'warn',
        text:
          'No value in this file settles German vs English — every separator could be either. ' +
          'Check the preview, and set the convention explicitly if it looks wrong.',
      });
    }
    if (a.conventionConflict) {
      notes.push({
        kind: 'warn',
        text: 'This file contains both German and English numbers. Some values will not parse.',
      });
    }
    if (a.raggedRows) {
      notes.push({
        kind: 'warn',
        text: `${a.raggedRows} row(s) have a different column count than the header (up to ${a.maxFields} fields). Usually the delimiter is wrong, or grouped numbers like 1,520 were written unquoted.`,
      });
    }

    // A column whose values look numeric but parse nowhere near completely is
    // the clearest sign the decimal convention is wrong. Note that parseRate
    // can be exactly 0 — that is the worst case, not a case to skip.
    const numericish = (c) =>
      c.nonEmpty > 0 && a.columnsRaw[c.index].some((v) => v && splitValue(v) !== null);
    const badCols = a.columns.filter((c) => numericish(c) && c.parseRate < 0.8);

    if (badCols.length) {
      const dead = badCols.filter((c) => c.parseRate === 0);
      notes.push({
        kind: 'warn',
        text:
          (dead.length === badCols.length
            ? `Not readable at all as ${a.convention === 'de' ? 'German' : 'English'}: `
            : 'Mostly unreadable: ') +
          badCols.map((c) => `${c.name} (${Math.round(c.parseRate * 100)}%)`).join(', ') +
          '. These columns will be dropped — switch the decimal setting to recover them.',
      });
    }

    const mixed = a.columns.filter((c) => c.numeric && c.mixedUnits);
    if (mixed.length) {
      notes.push({
        kind: 'warn',
        text: `Mixed units within a column: ${mixed.map((c) => c.name).join(', ')}. The most common unit is used for the axis label.`,
      });
    }

    const skipped = a.columns.filter((c) => !c.numeric);
    if (skipped.length) {
      notes.push({
        kind: 'info',
        text: `Not plottable, will be ignored: ${skipped.map((c) => c.name).join(', ')}`,
      });
    }

    if (a.timeIndex >= 0) {
      const scale = TIME_UNIT_SCALE[a.timeUnit] ?? 1;
      const col = a.columns[a.timeIndex];
      const first = parseWith(a.columnsRaw[a.timeIndex][0] || '0', a.convention);
      const last = parseWith(a.columnsRaw[a.timeIndex][a.rowCount - 1] || '0', a.convention);
      if (first && last) {
        const dur = (last.value - first.value) * scale;
        notes.push({
          kind: dur > 0 ? 'info' : 'warn',
          text:
            dur > 0
              ? `Time from "${col.name}" in ${a.timeUnit === 'us' ? 'µs' : a.timeUnit}: ${dur.toFixed(3)} s total`
              : `"${col.name}" does not increase — it is probably not a time column.`,
        });
      }
    }

    this.el.notes.innerHTML = notes
      .map((n) => `<div class="note ${n.kind}">${escapeHtml(n.text)}</div>`)
      .join('');
  }
}

function formatPreview(v) {
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e6) / 1e6);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
