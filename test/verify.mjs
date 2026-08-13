import fs from 'node:fs';
import { parseBlackbox } from '../js/bbl-parser.js';

const buf = fs.readFileSync(new URL('../exmple_log/LOG00015.BFL', import.meta.url));
const t0 = Date.now();
const logs = parseBlackbox(new Uint8Array(buf));
const ms = Date.now() - t0;

console.log(`sessions: ${logs.length}   decode time: ${ms} ms`);
const log = logs[0];
const s = log.stats;
console.log(`firmware : ${log.header.firmware}`);
console.log(`craft    : ${log.header.craftName}`);
console.log(`frames   : ${s.frames}  (I=${s.iFrames} P=${s.pFrames} corrupt=${s.corrupt})`);
console.log(`duration : ${s.durationSec.toFixed(6)} s`);
console.log(`rate     : ${s.sampleRateHz.toFixed(1)} Hz nominal, ${s.avgRateHz.toFixed(1)} Hz avg, max gap ${(s.maxGapSec*1000).toFixed(1)} ms`);
console.log(`events   : ${log.events.map(e => e.name).join(', ')}`);
console.log('');
for (const f of log.fields) {
  const r = log.raw[f.name];
  let mn = Infinity, mx = -Infinity;
  for (const v of r) { if (v < mn) mn = v; if (v > mx) mx = v; }
  console.log(`${f.name.padEnd(20)} raw[${String(mn).padStart(10)} .. ${String(mx).padStart(10)}]  scaled[${f.min.toFixed(2)} .. ${f.max.toFixed(2)}] ${f.unit}`);
}

// --- assertions against the independently written Python reference ---
const expect = {
  frames: 17125, durationSec: 57.724321, rate: 500,
  raw: {
    'loopIteration': [0, 17124], 'motor[0]': [0, 856], 'eRPM[0]': [0, 105313],
    'eRPMkiss[0]': [0, 0], 'vbatLatest': [0, 0], 'amperageLatest': [0, 0],
    'vbatEdt': [1375, 1525], 'amperageEdt': [0, 3600],
    'escTemperature[0]': [14, 38], 'escConsumption': [0, 0], 'escStress': [0, 0],
  },
};
let fail = 0;
const check = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-6;
  if (!ok) { console.log(`FAIL ${name}: got ${got}, want ${want}`); fail++; }
};
check('frames', log.stats.frames, expect.frames);
check('duration', +log.stats.durationSec.toFixed(6), expect.durationSec);
check("nominal rate", Math.round(log.stats.sampleRateHz), expect.rate);
check('corrupt', log.stats.corrupt, 0);
for (const [name, [wmn, wmx]] of Object.entries(expect.raw)) {
  const r = log.raw[name];
  if (!r) { console.log(`FAIL missing field ${name}`); fail++; continue; }
  let mn = Infinity, mx = -Infinity;
  for (const v of r) { if (v < mn) mn = v; if (v > mx) mx = v; }
  check(`${name}.min`, mn, wmn);
  check(`${name}.max`, mx, wmx);
}
// time must be monotonic
let mono = true;
for (let i = 1; i < log.count; i++) if (log.time[i] < log.time[i-1]) { mono = false; break; }
if (!mono) { console.log('FAIL time not monotonic'); fail++; }

console.log('');
console.log(fail === 0 ? '*** ALL CHECKS PASSED ***' : `*** ${fail} CHECK(S) FAILED ***`);
process.exit(fail === 0 ? 0 : 1);
