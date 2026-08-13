import fs from 'node:fs';
import { analyseCsv, buildCsvLog, sniffDelimiter, splitRows } from '../js/csv-parser.js';

let fail = 0, pass = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++; }
};
const read = f => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const near = (a,b,tol=1e-9) => Math.abs(a-b) < tol;

// ---- delimiter sniffing -----------------------------------------------------
eq('sniff en', sniffDelimiter(read('en.csv')), ',');
eq('sniff de', sniffDelimiter(read('de.csv')), ';');

// ---- quoted fields ----------------------------------------------------------
eq('quotes', splitRows('a,"b,c",d\n1,2,3', ','), [['a','b,c','d'],['1','2','3']]);
eq('esc quotes', splitRows('a,"say ""hi""",c', ','), [['a','say "hi"','c']]);

// ---- English ----------------------------------------------------------------
{
  const a = analyseCsv(read('en.csv'));
  eq('en convention', a.convention, 'en');
  eq('en time col', a.columns[a.timeIndex].name, 'time');
  eq('en units', a.columns.map(c => c.unit), ['','V','A','','']);
  const log = buildCsvLog(a, { name:'en.csv' });
  eq('en rows', log.count, 4);
  eq('en voltage', Array.from(log.columns.voltage), [22.34,22.31,22.28,22.20]);
  eq('en current', Array.from(log.columns.current), [10.23,11.05,12.40,15.02]);
  eq('en rpm', Array.from(log.columns.rpm), [1234,1567,1890,2345]);
  eq('en duration', near(log.stats.durationSec, 0.06), true);
  eq('en unit shown', log.fields.find(f=>f.name==='voltage').unit, 'V');
}

// ---- German -----------------------------------------------------------------
{
  const a = analyseCsv(read('de.csv'));
  eq('de convention', a.convention, 'de');
  eq('de delimiter', a.delimiter, ';');
  eq('de time col', a.columns[a.timeIndex].name, 'Zeit');
  const log = buildCsvLog(a, { name:'de.csv' });
  // Same physical numbers as the English file.
  eq('de Spannung', Array.from(log.columns.Spannung), [22.34,22.31,22.28,22.20]);
  eq('de Strom', Array.from(log.columns.Strom), [10.23,11.05,12.40,15.02]);
  eq('de Drehzahl (dot = thousands)', Array.from(log.columns.Drehzahl), [1234,1567,1890,2345]);
  eq('de duration', near(log.stats.durationSec, 0.06), true);
  eq('de units', [log.fields.find(f=>f.name==='Spannung').unit, log.fields.find(f=>f.name==='Strom').unit], ['V','A']);
}

// ---- German and English agree ----------------------------------------------
{
  const en = buildCsvLog(analyseCsv(read('en.csv')));
  const de = buildCsvLog(analyseCsv(read('de.csv')));
  eq('de==en voltage', Array.from(de.columns.Spannung), Array.from(en.columns.voltage));
  eq('de==en rpm', Array.from(de.columns.Drehzahl), Array.from(en.columns.rpm));
  eq('de==en time', Array.from(de.time), Array.from(en.time));
}

// ---- header units + ms time -------------------------------------------------
{
  const a = analyseCsv(read('units-header.csv'));
  const log = buildCsvLog(a);
  eq('hdr units', a.columns.map(c=>c.unit), ['ms','m','km/h','W']);
  eq('ms scaled to s', near(log.stats.durationSec, 0.3), true);
  eq('grouped power', Array.from(log.columns.power), [1500,1520,1610,1700]);
}

// ---- user override ----------------------------------------------------------
{
  // Force German on the English file: values stop parsing rather than corrupting.
  const a = analyseCsv(read('en.csv'), { convention:'de' });
  eq('forced de flagged', a.conventionForced, true);
  const v = a.columns.find(c=>c.name==='voltage');
  eq('forced de rejects', v.parsed, 0);
}


// ---- ragged rows are reported, not silently absorbed ------------------------
{
  const a = analyseCsv(read('ragged.csv'));
  eq('ragged detected', a.raggedRows, 2);
  eq('ragged widest', a.maxFields, 3);
  eq('clean file not ragged', analyseCsv(read('en.csv')).raggedRows, 0);
  eq('quoted grouping ok', analyseCsv(read('units-header.csv')).raggedRows, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
