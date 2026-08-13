/*
 * app.js — wiring: file loading, field list, readouts, renderer + controller.
 *
 * Everything about the UI adapts to whatever the log actually contains: the
 * field list, the groups, the units and the default selection are all derived
 * from the decoded header, never hard-coded.
 */

import { parseBlackbox } from './bbl-parser.js';
import { BlackboxRenderer, colorForIndex, formatValue } from './renderer.js';
import { ViewController } from './interaction.js';

const $ = (sel) => document.querySelector(sel);

const canvas = $('#chart');
const renderer = new BlackboxRenderer(canvas);
const controller = new ViewController(renderer, canvas, $('#scrollbar'), updateReadout);

let logs = [];
let log = null;
let series = [];

// ---------------------------------------------------------------------------
// Default field selection
// ---------------------------------------------------------------------------

/**
 * Choose a sensible initial set of lanes for an arbitrary log. We prefer the
 * classic tuning fields when present, otherwise fall back to whatever the log
 * has that actually varies.
 */
function defaultSelection(fields) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const preferred = [
    'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]',
    'motor[0]', 'motor[1]', 'motor[2]', 'motor[3]',
    'rcCommand[3]',
    'eRPM[0]', 'eRPM[1]', 'eRPM[2]', 'eRPM[3]',
    'vbatLatest', 'vbatEdt', 'amperageLatest', 'amperageEdt',
    'escTemperature[0]',
  ];

  const picked = [];
  for (const name of preferred) {
    const f = byName.get(name);
    if (f && !f.constant) picked.push(name);
    if (picked.length >= 6) break;
  }
  if (picked.length) return new Set(picked);

  // Nothing familiar — take the first few non-constant, non-meta fields.
  return new Set(
    fields
      .filter((f) => f.group !== 'Meta' && !f.constant)
      .slice(0, 5)
      .map((f) => f.name)
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadFile(file) {
  setStatus(`Reading ${file.name}…`);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const t0 = performance.now();
    logs = parseBlackbox(buf);
    const ms = performance.now() - t0;

    $('#file-name').textContent = file.name;
    buildSessionPicker();
    selectSession(0);
    setStatus(
      `${logs.length} session${logs.length > 1 ? 's' : ''} decoded in ${ms.toFixed(0)} ms`,
      'ok'
    );
    document.body.classList.add('has-log');
  } catch (err) {
    console.error(err);
    setStatus(err.message, 'error');
  }
}

function buildSessionPicker() {
  const sel = $('#session');
  sel.innerHTML = '';
  logs.forEach((l, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Session ${i + 1} — ${l.stats.durationSec.toFixed(1)}s, ${l.count.toLocaleString()} frames`;
    sel.appendChild(opt);
  });
  sel.style.display = logs.length > 1 ? '' : 'none';
}

function selectSession(i) {
  log = logs[i];
  renderer.setLog(log);

  const selected = defaultSelection(log.fields);
  buildSeries(selected);
  buildFieldList(selected);
  buildInfoPanel();
  controller.fit();
}

function buildSeries(selectedNames) {
  const names = [...selectedNames];
  series = log.fields
    .filter((f) => selectedNames.has(f.name))
    .map((f) => ({
      name: f.name,
      unit: f.unit,
      group: f.group,
      data: log.columns[f.name],
      color: colorForIndex(names.indexOf(f.name)),
      visible: true,
    }));
  renderer.setSeries(series);
}

// ---------------------------------------------------------------------------
// Field list (grouped, adapts to the log)
// ---------------------------------------------------------------------------

function buildFieldList(selected) {
  const host = $('#fields');
  host.innerHTML = '';

  const groups = new Map();
  for (const f of log.fields) {
    if (f.name === 'time' || f.name === 'loopIteration') continue;
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }

  for (const [groupName, fields] of groups) {
    const details = document.createElement('details');
    // Open groups that contain something selected, or that have live data.
    details.open = fields.some((f) => selected.has(f.name)) || fields.some((f) => !f.constant);

    const summary = document.createElement('summary');
    const live = fields.filter((f) => !f.constant).length;
    summary.innerHTML = `<span>${groupName}</span><span class="count">${live}/${fields.length}</span>`;
    details.appendChild(summary);

    for (const f of fields) {
      const row = document.createElement('label');
      row.className = 'field' + (f.constant ? ' constant' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(f.name);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(f.name);
        else selected.delete(f.name);
        buildSeries(selected);
        refreshSwatches();
        controller.requestRender();
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.name;

      const range = document.createElement('span');
      range.className = 'range';
      range.textContent = f.constant
        ? `= ${formatValue(f.min, 1)}`
        : `${formatValue(f.min, f.max - f.min)} … ${formatValue(f.max, f.max - f.min)}${f.unit ? ' ' + f.unit : ''}`;

      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.dataset.field = f.name;

      row.append(cb, sw, name, range);
      details.appendChild(row);
    }
    host.appendChild(details);
  }
  refreshSwatches();
}

function refreshSwatches() {
  const byName = new Map(series.map((s) => [s.name, s]));
  document.querySelectorAll('.swatch').forEach((el) => {
    const s = byName.get(el.dataset.field);
    el.style.background = s ? s.color : 'transparent';
    el.style.borderColor = s ? s.color : 'var(--line)';
  });
}

// ---------------------------------------------------------------------------
// Info panel
// ---------------------------------------------------------------------------

function buildInfoPanel() {
  const s = log.stats;
  const h = log.header;
  const rows = [
    ['Craft', h.craftName || '—'],
    ['Firmware', h.firmware],
    ['Frames', `${s.frames.toLocaleString()} (${s.iFrames} I / ${s.pFrames} P)`],
    ['Duration', `${s.durationSec.toFixed(2)} s`],
    ['Rate', `${s.sampleRateHz.toFixed(0)} Hz nominal · ${s.avgRateHz.toFixed(0)} Hz avg`],
    ['Largest gap', `${(s.maxGapSec * 1000).toFixed(1)} ms`],
    ['Fields', String(log.fields.length)],
  ];
  if (s.corrupt) rows.push(['Corrupt frames', String(s.corrupt)]);
  if (log.events.length) {
    rows.push(['Events', log.events.map((e) => e.name).join(', ')]);
  }

  $('#info').innerHTML = rows
    .map(([k, v]) => `<div class="row"><span>${k}</span><b>${escapeHtml(String(v))}</b></div>`)
    .join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Readout under the cursor
// ---------------------------------------------------------------------------

function updateReadout() {
  const el = $('#readout');
  if (!log) {
    el.textContent = '';
    return;
  }
  const { t0, t1 } = renderer.view;
  const span = t1 - t0;
  let txt = `window ${t0.toFixed(3)}–${t1.toFixed(3)} s  (${span < 1 ? (span * 1000).toFixed(1) + ' ms' : span.toFixed(2) + ' s'})`;

  if (renderer.cursor) {
    const i = renderer.indexAtX(renderer.cursor.x);
    if (i >= 0) {
      txt += `   ·   t=${log.time[i].toFixed(4)} s   frame ${i.toLocaleString()}`;
    }
  }
  el.textContent = txt;
}

// ---------------------------------------------------------------------------
// File input + drag & drop
// ---------------------------------------------------------------------------

const drop = $('#drop');

$('#file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
});

$('#pick').addEventListener('click', () => $('#file').click());
$('#pick-empty').addEventListener('click', () => $('#file').click());

['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('active');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    drop.classList.remove('active');
  })
);
window.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

$('#session').addEventListener('change', (e) => selectSession(Number(e.target.value)));

// Toolbar buttons
$('#zoom-in').addEventListener('click', () => controller.zoom(1.6));
$('#zoom-out').addEventListener('click', () => controller.zoom(1 / 1.6));
$('#zoom-fit').addEventListener('click', () => controller.fit());
$('#clear-fields').addEventListener('click', () => {
  document.querySelectorAll('#fields input[type=checkbox]').forEach((cb) => {
    if (cb.checked) cb.click();
  });
});

function setStatus(msg, kind = '') {
  const el = $('#status');
  el.textContent = msg;
  el.className = kind;
}

// Initial paint (empty state)
controller.requestRender();

// Signals to the boot check in index.html that the modules loaded successfully.
window.__logwijuLoaded = true;
