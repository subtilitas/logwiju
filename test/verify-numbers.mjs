import {
  splitValue, evidenceOf, inferConvention, parseWith, parseLoose,
  dominantUnit, unitFromHeader, AMBIGUOUS_AS,
} from '../js/numbers.js';

let fail = 0, pass = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++; }
};

// ---- unit + value splitting -------------------------------------------------
eq('10.23A',    splitValue('10.23A'),   { digits:'10.23', sign:1, exp:0, unit:'A' });
eq('22,34V',    splitValue('22,34V'),   { digits:'22,34', sign:1, exp:0, unit:'V' });
eq('-3,5 °C',   splitValue('-3,5 °C'),  { digits:'3,5',  sign:-1, exp:0, unit:'°C' });
eq('12 %',      splitValue('12 %'),     { digits:'12',   sign:1, exp:0, unit:'%' });
eq('1.5e3 m/s', splitValue('1.5e3 m/s'),{ digits:'1.5',  sign:1, exp:3, unit:'m/s' });
eq('blank',     splitValue('   '),      null);
eq('non-num',   splitValue('n/a'),      null);

// ---- evidence ---------------------------------------------------------------
eq('ev 1.234,56', evidenceOf('1.234,56'), 'de');
eq('ev 1,234.56', evidenceOf('1,234.56'), 'en');
eq('ev 10,23',    evidenceOf('10,23'),    'de');
eq('ev 1.5',      evidenceOf('1.5'),      'en');
eq('ev 1.234.567',evidenceOf('1.234.567'),'de');
eq('ev 1,234,567',evidenceOf('1,234,567'),'en');
eq('ev 1,234',    evidenceOf('1,234'),    'ambiguous');
eq('ev 1.234',    evidenceOf('1.234'),    'ambiguous');
eq('ev 42',       evidenceOf('42'),       'none');

// ---- the headline case: one value settles the whole column ------------------
// "10,23" proves comma-decimal, so "1,234" must read 1.234 not 1234.
{
  const col = ['1,234', '10,23', '5,678'];
  const { convention, confident } = inferConvention(col);
  eq('col de conv', [convention, confident], ['de', true]);
  eq('col de vals', col.map(v => parseWith(v, convention).value), [1.234, 10.23, 5.678]);
}
// Same digits, but English evidence present.
{
  const col = ['1,234', '10.23', '5,678'];
  const { convention } = inferConvention(col);
  eq('col en conv', convention, 'en');
  eq('col en vals', col.map(v => parseWith(v, convention).value), [1234, 10.23, 5678]);
}
// Wholly ambiguous column -> fallback decides.
{
  const col = ['1,234', '5,678'];
  eq('amb thousands', inferConvention(col, AMBIGUOUS_AS.THOUSANDS).convention, 'en');
  eq('amb decimal',   inferConvention(col, AMBIGUOUS_AS.DECIMAL).convention,   'de');
  eq('amb th vals', col.map(v => parseWith(v,'en').value), [1234, 5678]);
  eq('amb dc vals', col.map(v => parseWith(v,'de').value), [1.234, 5.678]);
  eq('amb not confident', inferConvention(col).confident, false);
}
// Conflicting evidence is reported rather than silently resolved.
eq('conflict', inferConvention(['10,23', '10.23']).conflict, true);

// ---- full parses ------------------------------------------------------------
eq('de 1.234,56', parseWith('1.234,56','de'), { value:1234.56, unit:'' });
eq('en 1,234.56', parseWith('1,234.56','en'), { value:1234.56, unit:'' });
eq('de 22,34V',   parseWith('22,34V','de'),   { value:22.34, unit:'V' });
eq('en 10.23A',   parseWith('10.23A','en'),   { value:10.23, unit:'A' });
eq('neg de',      parseWith('-1.234,5','de'), { value:-1234.5, unit:'' });
eq('mismatch',    parseWith('1.234,56','en'), null);  // wrong convention -> reject, don't corrupt
eq('space group', parseWith('1 234,56','de'), { value:1234.56, unit:'' });
eq('loose 10,23', parseLoose('10,23').value, 10.23);

// ---- units ------------------------------------------------------------------
eq('dominant',  dominantUnit(['A','A','']),       { unit:'A', mixed:false });
eq('mixed',     dominantUnit(['A','V','A']),      { unit:'A', mixed:true });
eq('hdr paren', unitFromHeader('voltage (V)'),    { name:'voltage', unit:'V' });
eq('hdr brack', unitFromHeader('current [A]'),    { name:'current', unit:'A' });
eq('hdr space', unitFromHeader('altitude m'),     { name:'altitude', unit:'m' });
eq('hdr index kept', unitFromHeader('gyroADC[0]'), { name:'gyroADC[0]', unit:'' });
eq('hdr none',  unitFromHeader('motor'),          { name:'motor', unit:'' });


// ---- strict rejection: never silently mis-parse under the wrong convention --
eq('de-as-en rejected', parseWith('1.234,56','en'), null);
eq('en-as-de rejected', parseWith('1,234.56','de'), null);
eq('bad group size',    parseWith('1,23,456','en'), null);
eq('two decimals',      parseWith('1.2.3','en'),    null);
eq('10,23 as en',       parseWith('10,23','en'),    null);
eq('10.23 as de',       parseWith('10.23','de'),    null);
eq('plain int either',  [parseWith('42','de').value, parseWith('42','en').value], [42,42]);
eq('grouped ok en',     parseWith('12,345,678','en').value, 12345678);
eq('grouped ok de',     parseWith('12.345.678','de').value, 12345678);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
