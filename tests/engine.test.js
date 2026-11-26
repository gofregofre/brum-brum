// Temporary TDD suite for carpool-engine.js (NOT committed to repo).
// Run: node --test engine.test.js  (ENGINE_PATH env points to the module)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require(process.env.ENGINE_PATH || require('path').join(__dirname,'..','carpool-engine.js'));

const T = (date, dir, driver, passengers, price = 600) => ({
  trip_key: `${date}_${dir}`, week_id: E.isoWeekId(date), trip_date: date,
  direction: dir, driver, passengers, price_cents: price,
});
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const applyTransfers = (bal, tr) => {
  const b = { ...bal };
  for (const t of tr) { b[t.from] += t.cents; b[t.to] -= t.cents; }
  return b;
};

// ---------- ISO weeks ----------
test('isoWeekId: known dates incl. year boundaries', () => {
  assert.equal(E.isoWeekId('2026-11-23'), '2026-W48'); // Monday
  assert.equal(E.isoWeekId('2026-11-29'), '2026-W48'); // Sunday same week
  assert.equal(E.isoWeekId('2026-11-30'), '2026-W49');
  assert.equal(E.isoWeekId('2021-01-03'), '2020-W53'); // belongs to previous ISO year
  assert.equal(E.isoWeekId('2024-12-30'), '2025-W01'); // belongs to next ISO year
  assert.equal(E.isoWeekId('2026-01-01'), '2026-W01');
});
test('weekDates: Monday..Sunday, roundtrip', () => {
  const d = E.weekDates('2026-W48');
  assert.deepEqual(d, ['2026-11-23','2026-11-24','2026-11-25','2026-11-26','2026-11-27','2026-11-28','2026-11-29']);
  assert.deepEqual(E.weekDates('2025-W01')[0], '2024-12-30');
  assert.deepEqual(E.weekDates('2020-W53')[6], '2021-01-03');
  for (const w of ['2020-W53','2025-W01','2026-W01','2026-W52']) {
    for (const day of E.weekDates(w)) assert.equal(E.isoWeekId(day), w);
  }
});
test('shiftWeek across year boundary', () => {
  assert.equal(E.shiftWeek('2026-W48', 1), '2026-W49');
  assert.equal(E.shiftWeek('2026-W01', -1), '2025-W52');
  assert.equal(E.shiftWeek('2020-W53', 1), '2021-W01');
});
test('weekRangeLabel in Catalan', () => {
  assert.equal(E.weekRangeLabel('2026-W48'), '23 – 27 nov');
  assert.equal(E.weekRangeLabel('2026-W53'), '28 des – 1 gen'); // crosses month
  assert.equal(E.weekRangeLabel('2026-W48', { includeWeekend: true }), '23 – 29 nov');
});
test('adversarial: invalid dates / week ids throw', () => {
  for (const bad of ['2026-02-30', '2026-13-01', 'abc', '', null, '2026-1-1']) {
    assert.throws(() => E.isoWeekId(bad));
  }
  for (const bad of ['2026-W00', '2026-W54', '2025-W53', '2026W48', null]) {
    assert.throws(() => E.weekDates(bad));
  }
});
test('tripKey format and validation', () => {
  assert.equal(E.tripKey('2026-11-23', 'anada'), '2026-11-23_anada');
  assert.throws(() => E.tripKey('2026-11-23', 'ida'));
});

// ---------- formatting ----------
test('formatCents', () => {
  assert.equal(E.formatCents(0), '0,00 €');
  assert.equal(E.formatCents(600), '6,00 €');
  assert.equal(E.formatCents(-150), '-1,50 €');
  assert.equal(E.formatCents(5), '0,05 €');
  assert.equal(E.formatCents(123456), '1.234,56 €');
  assert.equal(E.formatCents(-0), '0,00 €');
});

// ---------- required case a ----------
test('a) driver alone in the car -> 0,00 €', () => {
  const r = E.computeBalances([T('2026-11-23', 'anada', 'J', ['J'])]);
  for (const m of E.MEMBERS) assert.equal(r[m], 0);
  assert.equal(E.formatCents(r.J), '0,00 €');
  assert.deepEqual(E.minimalTransfers(r), []);
});
test('a-bis) no driver -> 0; empty car -> 0', () => {
  const r = E.computeBalances([T('2026-11-23', 'anada', null, ['A','J','M']), T('2026-11-23','tornada',null,[])]);
  assert.equal(sum(r), 0);
  for (const m of E.MEMBERS) assert.equal(r[m], 0);
});

// ---------- required case b ----------
test('b) outbound 4 people (J drives) + return 2 people (A drives)', () => {
  const trips = [
    T('2026-11-23', 'anada', 'J', ['A','J','M','Q']),  // 600/4 = 150 each
    T('2026-11-23', 'tornada', 'A', ['A','R']),         // 600/2 = 300
  ];
  const r = E.computeBalances(trips);
  // A: owes J 150, receives 300 from R -> +150
  assert.deepEqual(r, { A: 150, J: 450, M: -150, Q: -150, R: -300 });
  assert.equal(sum(r), 0);
  const tr = E.minimalTransfers(r);
  const after = applyTransfers(r, tr);
  for (const m of E.MEMBERS) assert.equal(after[m], 0);
  assert.ok(tr.length <= 3);
});

// ---------- required case c ----------
test('c) 700 cents / 3 -> net balances sum exactly 0', () => {
  const r = E.computeBalances([T('2026-11-24', 'anada', 'M', ['A','M','R'], 700)]);
  assert.equal(sum(r), 0);
  for (const v of Object.values(r)) assert.ok(Number.isInteger(v));
  // exact share 233.33: passengers each owe 233 or 234, driver gets 466 or 467
  assert.ok(r.A <= -233 && r.A >= -234);
  assert.ok(r.R <= -233 && r.R >= -234);
  assert.equal(r.M, -(r.A + r.R));
});
test('c-bis) many periodic splits accumulate exactly (no per-trip rounding drift)', () => {
  // 3 trips of 100c split in 3 with M driving: exact debt = 66.666.. each trip for M’s passengers
  const trips = ['2026-11-23','2026-11-24','2026-11-25'].map(d => T(d, 'anada', 'M', ['A','M','R'], 100));
  const r = E.computeBalances(trips);
  // exact: A owes 3 * 33.333 = 100.000 -> exactly 100
  assert.deepEqual(r, { A: -100, J: 0, M: 200, Q: 0, R: -100 });
});
test('c-ter) fuzz: random weeks always sum to 0 and transfers clear everything', () => {
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2000; i++) {
    const trips = [];
    const n = 1 + Math.floor(rnd() * 14);
    for (let k = 0; k < n; k++) {
      const occ = E.MEMBERS.filter(() => rnd() < 0.6);
      const driver = occ.length && rnd() < 0.9 ? occ[Math.floor(rnd() * occ.length)] : null;
      trips.push(T(E.weekDates('2026-W48')[k % 7], k % 2 ? 'anada' : 'tornada', driver, occ, 1 + Math.floor(rnd() * 2000)));
    }
    const r = E.computeBalances(trips);
    assert.equal(sum(r), 0);
    const tr = E.minimalTransfers(r);
    const after = applyTransfers(r, tr);
    for (const m of E.MEMBERS) assert.equal(after[m], 0);
    for (const t of tr) assert.ok(t.cents > 0 && Number.isInteger(t.cents) && t.from !== t.to);
    assert.ok(tr.length <= 4);
  }
});

// ---------- required case d ----------
test('d) circular debt A→J→M→A cancels to zero Bizums', () => {
  const trips = [
    T('2026-11-23', 'anada', 'J', ['A','J']),   // A owes J 300
    T('2026-11-23', 'tornada', 'M', ['J','M']), // J owes M 300
    T('2026-11-24', 'anada', 'A', ['M','A']),   // M owes A 300
  ];
  const r = E.computeBalances(trips);
  for (const m of E.MEMBERS) assert.equal(r[m], 0);
  assert.deepEqual(E.minimalTransfers(r), []);
});
test('d-bis) unbalanced circle collapses to a single Bizum', () => {
  const trips = [
    T('2026-11-23', 'anada', 'J', ['A','J'], 1000), // A owes J 500
    T('2026-11-23', 'tornada', 'M', ['J','M']),     // J owes M 300
    T('2026-11-24', 'anada', 'A', ['M','A']),       // M owes A 300
  ];
  const r = E.computeBalances(trips);
  assert.deepEqual(r, { A: -200, J: 200, M: 0, Q: 0, R: 0 });
  assert.deepEqual(E.minimalTransfers(r), [{ from: 'A', to: 'J', cents: 200 }]);
});

// ---------- minimality (adversarial vs plain greedy) ----------
test('minimalTransfers finds optimum where plain greedy is suboptimal', () => {
  // zero-sum subgroups {A,J} and {M,Q,R}: optimum = 1 + 2 = 3 transfers
  const bal = { A: 700, J: -700, M: 500, Q: -300, R: -200 };
  const tr = E.minimalTransfers(bal);
  assert.equal(tr.length, 3);
  const after = applyTransfers(bal, tr);
  for (const m of E.MEMBERS) assert.equal(after[m], 0);
});
test('minimalTransfers: brute-force optimum check (n - max zero-sum groups)', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 3000; i++) {
    const vals = E.MEMBERS.map(() => Math.floor(rnd() * 7 - 3) * 100);
    vals[4] = -vals.slice(0, 4).reduce((a, b) => a + b, 0);
    const bal = Object.fromEntries(E.MEMBERS.map((m, k) => [m, vals[k]]));
    // brute force max number of disjoint zero-sum non-empty groups among non-zero members
    const nz = E.MEMBERS.filter(m => bal[m] !== 0);
    const n = nz.length; const full = (1 << n) - 1;
    const s = new Array(1 << n).fill(0);
    for (let mask = 1; mask <= full; mask++) { const low = mask & -mask; s[mask] = s[mask ^ low] + bal[nz[Math.log2(low)]]; }
    const dp = new Array(1 << n).fill(-1); dp[0] = 0;
    for (let mask = 1; mask <= full; mask++) {
      if (s[mask] !== 0) continue;
      for (let sub = mask; sub; sub = (sub - 1) & mask) if (s[sub] === 0 && dp[mask ^ sub] >= 0) dp[mask] = Math.max(dp[mask], dp[mask ^ sub] + 1);
    }
    const optimum = n - (n ? dp[full] : 0);
    assert.equal(E.minimalTransfers(bal).length, optimum, JSON.stringify(bal));
  }
});
test('minimalTransfers rejects non-zero-sum or non-integer input', () => {
  assert.throws(() => E.minimalTransfers({ A: 1, J: 0, M: 0, Q: 0, R: 0 }));
  assert.throws(() => E.minimalTransfers({ A: 0.5, J: -0.5, M: 0, Q: 0, R: 0 }));
});
test('minimalTransfers deterministic regardless of key order', () => {
  const b1 = { A: 300, J: -100, M: -200, Q: 0, R: 0 };
  const b2 = { R: 0, Q: 0, M: -200, J: -100, A: 300 };
  assert.deepEqual(E.minimalTransfers(b1), E.minimalTransfers(b2));
});

// ---------- required case e ----------
test('e) settled weeks excluded from pending accumulated total', () => {
  const trips = [
    T('2026-11-16', 'anada', 'J', ['A','J']),  // W47: A owes J 300
    T('2026-11-23', 'anada', 'J', ['M','J']),  // W48: M owes J 300
    T('2026-11-30', 'anada', 'A', ['A','Q']),  // W49 (no weeks row => pending)
  ];
  const weeks = [{ week_id: '2026-W47', settled: true }, { week_id: '2026-W48', settled: false }];
  const p = E.pendingBalances(trips, weeks);
  assert.deepEqual(p, { A: 300, J: 300, M: -300, Q: -300, R: 0 });
  assert.equal(sum(p), 0);
  assert.deepEqual(E.weekBalances(trips, '2026-W47'), { A: -300, J: 300, M: 0, Q: 0, R: 0 });
  // all settled -> nothing pending
  const all = ['2026-W47','2026-W48','2026-W49'].map(w => ({ week_id: w, settled: true }));
  for (const v of Object.values(E.pendingBalances(trips, all))) assert.equal(v, 0);
  assert.deepEqual(E.pendingWeekIds(trips, weeks), ['2026-W48', '2026-W49']);
});

// ---------- adversarial data hygiene ----------
test('adversarial: driver not among passengers -> treated as included (driver implies occupant)', () => {
  const r = E.computeBalances([T('2026-11-23', 'anada', 'J', ['A','M'])]);
  assert.deepEqual(r, { A: -200, J: 400, M: -200, Q: 0, R: 0 });
});
test('adversarial: duplicates, unknown members, full names ignored', () => {
  const r = E.computeBalances([T('2026-11-23', 'anada', 'J', ['J','A','A','X','Joan','a'])]);
  assert.deepEqual(r, { A: -300, J: 300, M: 0, Q: 0, R: 0 });
});
test('adversarial: unknown driver -> no debt', () => {
  const r = E.computeBalances([T('2026-11-23', 'anada', 'Z', ['A','J'])]);
  for (const m of E.MEMBERS) assert.equal(r[m], 0);
});
test('adversarial: bad price values contribute 0, never NaN', () => {
  for (const p of [-600, NaN, '600', null, undefined, 1.5, Infinity, 0, 2 ** 60]) {
    const trip = { ...T('2026-11-23', 'anada', 'J', ['A','J']), price_cents: p };
    const r = E.computeBalances([trip]);
    for (const m of E.MEMBERS) assert.ok(Number.isInteger(r[m]) && r[m] === 0, `price ${p}`);
  }
});
test('adversarial: odd prices 1 cent and 1 cent/5', () => {
  const r = E.computeBalances([T('2026-11-23','anada','A',['A','J','M','Q','R'], 1)]);
  assert.equal(sum(r), 0);
  const r2 = E.computeBalances([T('2026-11-23','anada','A',['A','J'], 1)]);
  assert.equal(sum(r2), 0);
});
test('adversarial: null / garbage trips list', () => {
  assert.equal(sum(E.computeBalances(null)), 0);
  assert.equal(sum(E.computeBalances([null, 42, {}, { passengers: 'AJ' }])), 0);
});
test('normalizeTrip applies driver rules', () => {
  assert.deepEqual(E.normalizeTrip({ driver: 'J', passengers: ['A'] }).passengers, ['A','J']);
  assert.deepEqual(E.normalizeTrip({ driver: 'J', passengers: ['R','A','J'] }).passengers, ['A','J','R']);
  assert.equal(E.normalizeTrip({ driver: 'Z', passengers: ['A'] }).driver, null);
});
test('toggle/driver helpers', () => {
  let t = { driver: null, passengers: [] };
  t = E.togglePassenger(t, 'A'); assert.deepEqual(t.passengers, ['A']);
  t = E.setDriver(t, 'J'); assert.deepEqual(t, { driver: 'J', passengers: ['A','J'] });
  t = E.togglePassenger(t, 'J'); assert.deepEqual(t, { driver: null, passengers: ['A'] }); // removing driver nulls driver
  t = E.setDriver(t, 'A'); t = E.setDriver(t, 'A'); assert.deepEqual(t, { driver: null, passengers: ['A'] }); // toggle off keeps occupant
  assert.throws(() => E.setDriver(t, 'X'));
});

// ---------- WhatsApp summary ----------
test('whatsappSummary: only initials, contains transfers and amounts', () => {
  const trips = [
    T('2026-11-23', 'anada', 'J', ['A','J','M','Q']),
    T('2026-11-23', 'tornada', 'A', ['A','R']),
  ];
  const txt = E.whatsappSummary(trips, '2026-W48', []);
  assert.match(txt, /23 – 27 nov/);
  assert.match(txt, /Dl 23/);
  assert.match(txt, /Anada: J \(A, M, Q\)/);
  assert.match(txt, /Tornada: A \(R\)/);
  const bizumLines = txt.split('\n').filter(l => /→/.test(l));
  const expected = E.minimalTransfers(E.weekBalances(trips, '2026-W48')).map(x => `${x.from} → ${x.to} ${E.formatCents(x.cents)}`);
  assert.deepEqual(bizumLines, expected);
  assert.equal(bizumLines.length, 3);
  // transfers listed in alphabetical order of payer (stable, readable)
  assert.deepEqual(bizumLines.map(l => l[0]), [...bizumLines.map(l => l[0])].sort());
  // no uppercase word longer than 1 letter that could be a full name other than known labels
  const words = txt.match(/\b[A-Z][a-zà-ú]+\b/g) || [];
  const allowed = new Set(['Cotxe','Setmana','Anada','Tornada','Bizums','Dl','Dt','Dc','Dj','Dv','Ds','Dg','Liquidada','Saldos','Cap','Sense']);
  for (const w of words) assert.ok(allowed.has(w), `unexpected word ${w}`);
  assert.ok(!txt.includes('NaN') && !txt.includes('undefined'));
});
test('whatsappSummary: empty week and settled week flag', () => {
  const txt = E.whatsappSummary([], '2026-W48', [{ week_id: '2026-W48', settled: true }]);
  assert.match(txt, /Cap trajecte/);
  assert.match(txt, /Liquidada/);
});
