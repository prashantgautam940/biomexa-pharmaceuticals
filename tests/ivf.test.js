// IVF Care calculations checked against the published reference values each one cites.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../ivf/pregnancy');
const { evaluateDailyLog } = require('../ivf/redflags');

test('gestational age from a day-5 transfer (ACOG): transfer day = 2w5d', () => {
  assert.strictEqual(P.gaOn({ transferDate: '2026-01-10', embryoAgeDays: 5 }, '2026-01-10'), 19);
  assert.strictEqual(P.gaLabel(19), '2w5d');
  assert.strictEqual(P.gaOn({ transferDate: '2026-01-10', embryoAgeDays: 3 }, '2026-01-24'), 31);
});

test('EDD = transfer + 266 − embryo age (ACOG)', () => {
  const r = P.evaluatePregnancy({ transferDate: '2026-01-10', embryoAgeDays: 5 }, new Date(2026, 0, 20));
  assert.strictEqual(r.edd, '2026-09-28'); // 10 Jan + 261 days
});

test('hCG minimum 48h rise by starting level (Barnhart 2016)', () => {
  assert.strictEqual(P.minRiseFor(1000), 49);
  assert.strictEqual(P.minRiseFor(2000), 40);
  assert.strictEqual(P.minRiseFor(5000), 33);
  const doubled = P.evaluateHcg([{ date: '2026-01-20', value: 100 }, { date: '2026-01-22', value: 200 }]);
  assert.strictEqual(doubled.rises[0].rise48, 100);
  assert.strictEqual(doubled.rises[0].doublingHours, 48);
  assert.strictEqual(doubled.rises[0].level, 'good');
  // over 3 days, 100 → 150 is ~31% per 48h → below 49%
  const slow = P.evaluateHcg([{ date: '2026-01-20', value: 100 }, { date: '2026-01-23', value: 150 }]);
  assert.strictEqual(slow.rises[0].rise48, 31);
  assert.strictEqual(slow.rises[0].level, 'watch');
  const fall = P.evaluateHcg([{ date: '2026-01-20', value: 300 }, { date: '2026-01-22', value: 200 }]);
  assert.strictEqual(fall.rises[0].level, 'suspicious');
});

test('CRL → GA (Robinson & Fleming): 10 mm ≈ 7w1d', () => {
  assert.strictEqual(Math.round(P.crlToGaDays(10)), 49);
  assert.ok(Math.abs(P.expectedCrlForGa(P.crlToGaDays(10)) - 10) < 1e-9);
});

test('SRU criteria for pregnancy failure', () => {
  const d = P.evaluateFetus({ crlMm: 7, heartbeat: 'no' }, 50, 'intrauterine');
  assert.ok(d.findings.some(f => f.level === 'diagnostic'));
  const s = P.evaluateFetus({ crlMm: 5, heartbeat: 'no' }, 45, 'intrauterine');
  assert.ok(s.findings.some(f => f.level === 'suspicious') && !s.findings.some(f => f.level === 'diagnostic'));
  const msd = P.evaluateFetus({ msdMm: 25 }, 45, 'intrauterine');
  assert.ok(msd.findings.some(f => f.level === 'diagnostic'));
  const ok = P.evaluateFetus({ crlMm: 10, heartbeat: 'yes', fhrBpm: 140 }, 49, 'intrauterine');
  assert.strictEqual(ok.findings[0].level, 'good');
});

test('follow-up scan: no heartbeat ≥ 11 days after yolk sac is diagnostic', () => {
  const r = P.evaluatePregnancy({
    transferDate: '2026-01-10', embryoAgeDays: 5,
    scans: [
      { date: '2026-02-01', location: 'intrauterine', fetuses: [{ label: 'A', msdMm: 10, yolkSac: true, heartbeat: 'na' }] },
      { date: '2026-02-12', location: 'intrauterine', fetuses: [{ label: 'A', msdMm: 14, yolkSac: true, heartbeat: 'na' }] }
    ]
  }, new Date(2026, 1, 12));
  assert.strictEqual(r.status.level, 'diagnostic');
});

test('heart-rate thresholds (Doubilet & Benson)', () => {
  assert.strictEqual(P.evaluateFetus({ crlMm: 4, heartbeat: 'yes', fhrBpm: 95 }, 44).findings[0].level, 'watch');
  assert.strictEqual(P.evaluateFetus({ crlMm: 6, heartbeat: 'yes', fhrBpm: 110 }, 47).findings[0].level, 'watch');
  assert.strictEqual(P.evaluateFetus({ crlMm: 6, heartbeat: 'yes', fhrBpm: 80 }, 47).findings[0].level, 'suspicious');
});

test('OHSS red flags', () => {
  const now = Date.now();
  const r = evaluateDailyLog(
    { createdAt: new Date(now), stage: 'stimulation', vitals: { weightKg: 61.5 }, symptoms: { reducedUrine: true } },
    [{ createdAt: new Date(now - 24 * 36e5), vitals: { weightKg: 60 } }],
    { baselineWeightKg: 60 }
  );
  const codes = r.flags.map(f => f.code);
  assert.ok(codes.includes('rapid_weight_gain') && codes.includes('reduced_urine') && codes.includes('possible_ohss'));
  assert.strictEqual(r.severity, 'critical');
  assert.strictEqual(evaluateDailyLog({ vitals: { temperatureF: 100.4 } }).severity, 'high');
  assert.strictEqual(evaluateDailyLog({ vitals: { bpSystolic: 85, bpDiastolic: 60 } }).flags[0].code, 'low_bp');
});
