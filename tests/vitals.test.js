// Calibration tests for the vitals charts and end-of-treatment report.
// Run: TZ=Asia/Kolkata node --test tests/
// Every expected number below was worked out by hand from the records in the fixture, so the
// test proves the charts and report show exactly what was logged — no more, no less.
process.env.TZ = 'Asia/Kolkata';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanVitals, normaliseEntry, checkVitalsDanger } = require('../vitals/calibration');
const { buildVitalsProgress } = require('../vitals/progress');

const at = s => new Date(s + '+05:30');

test('cleanVitals: typos rejected, BP only as a full pair, values rounded', () => {
  assert.deepEqual(cleanVitals({ bpSystolic: 120.6, bpDiastolic: '80', glucose: '110', heartRate: 72, temperature: 98.64 }).clean,
    { bpSystolic: 121, bpDiastolic: 80, glucose: 110, heartRate: 72, temperature: 98.6 });
  let r = cleanVitals({ bpSystolic: 280, bpDiastolic: 130 });
  assert.deepEqual(r.clean, {}); assert.deepEqual(r.rejected, ['Top BP number 280 mmHg']);
  r = cleanVitals({ bpSystolic: 125 });
  assert.deepEqual(r.clean, {}); assert.match(r.rejected[0], /both BP numbers/);
  r = cleanVitals({ bpDiastolic: 80 });
  assert.deepEqual(r.clean, {}); assert.equal(r.rejected.length, 1);
  r = cleanVitals({ bpSystolic: 80, bpDiastolic: 90 });
  assert.deepEqual(r.clean, {}); assert.deepEqual(r.rejected, ['BP 80/90']);
  r = cleanVitals({ glucose: 'abc', temperature: '', heartRate: null });
  assert.deepEqual(r, { clean: {}, rejected: [] });
  assert.deepEqual(cleanVitals({ glucose: 580 }).clean, { glucose: 580 }, 'very high but real sugar is kept');
  assert.deepEqual(cleanVitals({ glucose: 701 }).rejected, ['Blood sugar 701 mg/dL']);
  // Mongoose documents carry extra fields — only vitals are read
  assert.deepEqual(cleanVitals({ _id: 'x', patientPhone: '+91', glucose: 99, source: 'whatsapp' }).clean, { glucose: 99 });
});

test('normaliseEntry: °C typed in the form is converted, nonsense is left for rejection', () => {
  assert.equal(normaliseEntry({ temperature: '37.2' }).temperature, 99);
  assert.equal(normaliseEntry({ temperature: '98.6' }).temperature, 98.6);
  assert.equal(normaliseEntry({ temperature: '38.5' }).temperature, 101.3);
  assert.equal(normaliseEntry({ temperature: '60' }).temperature, '60');
  assert.deepEqual(cleanVitals(normaliseEntry({ temperature: '60' })).rejected, ['Temperature 60 °F']);
  assert.deepEqual(normaliseEntry({ glucose: '', bpSystolic: undefined, heartRate: '70' }), { heartRate: '70' });
});

test('danger rules', () => {
  assert.equal(checkVitalsDanger({ bpSystolic: 182, bpDiastolic: 100 }).severity, 'critical');
  assert.equal(checkVitalsDanger({ glucose: 190 }).severity, 'high');
  assert.equal(checkVitalsDanger({ glucose: 120, bpSystolic: 130, bpDiastolic: 85 }), null);
});

// ---------- full-course fixture ----------
const patient = {
  name: 'Test Patient', phone: '+919999900000', createdAt: at('2026-10-01T10:00:00'),
  medicines: [{ name: 'Telmexa AM', dosage: '40mg/5mg', active: true, durationDays: 10, startDate: at('2026-10-05T09:00:00'), endDate: at('2026-10-15T09:00:00') }]
};
const L = (iso, v, source = 'whatsapp') => ({ recordedAt: at(iso), source, ...v });
const vitalsLogs = [
  L('2026-10-02T08:00:00', { bpSystolic: 152, bpDiastolic: 96, glucose: 190 }),
  L('2026-10-03T08:00:00', { bpSystolic: 150, bpDiastolic: 95 }),
  L('2026-10-06T08:00:00', { bpSystolic: 148, bpDiastolic: 94, temperature: 98.6 }, 'manual'),
  L('2026-10-08T20:30:00', { glucose: 160 }),           // stored out of order on purpose
  L('2026-10-08T07:10:00', { glucose: 280 }),
  L('2026-10-10T08:00:00', { bpSystolic: 138, bpDiastolic: 88, heartRate: 76 }),
  L('2026-10-12T08:00:00', { bpSystolic: 280, bpDiastolic: 130, glucose: 150 }), // BP typo, sugar fine
  L('2026-10-13T08:00:00', { bpSystolic: 132, bpDiastolic: 84 }),
  L('2026-10-14T08:00:00', { bpSystolic: 128, bpDiastolic: 82 }),
  L('2026-10-14T09:00:00', { bpSystolic: 125 }),          // half a BP reading
  L('2026-10-17T08:00:00', { bpSystolic: 126, bpDiastolic: 80 }),
  L('2026-10-25T08:00:00', { bpSystolic: 200, bpDiastolic: 110 }) // after "now" — must be ignored
];
const doses = [];
for (let d = 5; d <= 14; d++) {
  const date = `2026-10-${String(d).padStart(2, '0')}`;
  doses.push({ scheduledDate: date, scheduledTime: '09:00', medicineName: 'Telmexa AM', status: d === 8 || d === 11 ? 'missed' : 'taken' });
}
doses.push({ scheduledDate: '2026-10-20', scheduledTime: '09:00', medicineName: 'Telmexa AM', status: 'pending' });
const now = at('2026-10-20T12:00:00');
const pr = buildVitalsProgress({ patient, doses, vitalsLogs, now });

test('charts: one point per day, every reading kept, gaps not filled', () => {
  assert.deepEqual(pr.series.bpSystolic.map(p => [p.date, p.v]), [
    ['2026-10-02', 152], ['2026-10-03', 150], ['2026-10-06', 148], ['2026-10-10', 138], ['2026-10-13', 132], ['2026-10-14', 128], ['2026-10-17', 126]]);
  assert.deepEqual(pr.series.bpDiastolic.map(p => p.v), [96, 95, 94, 88, 84, 82, 80]);
  const sugar = pr.series.glucose;
  assert.deepEqual(sugar.map(p => [p.date, p.v]), [['2026-10-02', 190], ['2026-10-08', 160], ['2026-10-12', 150]]);
  const oct8 = sugar[1];
  assert.equal(oct8.n, 2);
  assert.deepEqual(oct8.readings.map(r => [r.time, r.v]), [['07:10', 280], ['20:30', 160]]);
  assert.equal(oct8.flagged, true, 'the 280 in the morning flags the day even though the last reading was 160');
  assert.match(oct8.flags.join(), /Severe hyperglycemia: sugar 280/);
  assert.equal(sugar[2].flagged, false);
  assert.deepEqual(pr.series.temperature.map(p => p.v), [98.6]);
  assert.deepEqual(pr.series.heartRate.map(p => p.v), [76]);
  assert.ok(!pr.series.bpSystolic.some(p => p.date === '2026-10-25'), 'future reading ignored');
  assert.ok(!pr.series.bpSystolic.some(p => p.date === '2026-10-12'), 'typo BP not plotted');
});

test('statistics use every reading', () => {
  const s = pr.stats.bpSystolic;
  assert.equal(s.n, 7); assert.equal(s.first.v, 152); assert.equal(s.latest.v, 126);
  assert.equal(s.lowest.v, 126); assert.equal(s.highest.v, 152);
  assert.equal(s.average, 139.1); assert.equal(s.inTarget, 4); assert.equal(s.inTargetPct, 57);
  assert.equal(s.change, -26); assert.equal(s.verdict, 'improved');
  assert.deepEqual(s.byPhase, { before: { n: 2, avg: 151 }, on: { n: 4, avg: 136.5 }, after: { n: 1, avg: 126 } });
  const d = pr.stats.bpDiastolic;
  assert.equal(d.average, 88.4); assert.equal(d.inTargetPct, 57);
  const g = pr.stats.glucose;
  assert.equal(g.n, 4, 'both Oct 8 readings counted'); assert.equal(g.average, 195);
  assert.equal(g.highest.v, 280); assert.equal(g.highest.time, '07:10');
  assert.equal(g.inTargetPct, 50); assert.equal(g.flagged, 2); assert.equal(g.verdict, 'improved');
  assert.equal(pr.stats.temperature.n, 1); assert.equal(pr.stats.temperature.verdict, 'not_enough');
});

test('adherence: pending and future doses left out', () => {
  assert.equal(pr.summary.adherencePct, 80);
  assert.equal(pr.summary.taken, 8); assert.equal(pr.summary.missed, 2);
  assert.equal(pr.adherence.length, 10);
  const oct8 = pr.adherence.find(a => a.date === '2026-10-08');
  assert.equal(oct8.v, 0); assert.equal(oct8.flagged, true);
  assert.equal(pr.adherence.find(a => a.date === '2026-10-09').v, 100);
});

test('treatment phases and end-of-treatment report', () => {
  assert.deepEqual(pr.stages.map(s => [s.key, s.from, s.to]), [
    ['before', '2026-10-02', '2026-10-05'], ['on', '2026-10-05', '2026-10-15'], ['after', '2026-10-15', '2026-10-17']]);
  assert.deepEqual(pr.range, { from: '2026-10-02', to: '2026-10-17' });
  const R = pr.report;
  assert.equal(R.status, 'completed');
  assert.deepEqual(R.period, { from: '2026-10-05', to: '2026-10-15', days: 10 });
  assert.equal(R.medicines[0].status, 'completed');
  assert.deepEqual(R.adherence, { taken: 8, missed: 2, pct: 80 });
  assert.equal(R.totalReadings, 10);
  assert.equal(R.flaggedReadings.length, 2);
  assert.deepEqual(R.flaggedReadings.map(f => f.date), ['2026-10-02', '2026-10-08']);
  assert.equal(R.ignoredReadings.length, 2);
  assert.deepEqual(R.ignoredReadings.map(f => f.date), ['2026-10-12', '2026-10-14']);
  assert.ok(R.summary.some(l => /^Improved: blood pressure, blood sugar\.$/.test(l)), R.summary.join(' | '));
  assert.ok(R.summary.some(l => /2 readings were in a dangerous range/.test(l)));
  assert.equal(pr.readings[0].date, '2026-10-17', 'readings list is newest first');
});

test('ongoing treatment, no readings yet', () => {
  const p = buildVitalsProgress({ patient: { ...patient, medicines: [{ name: 'Diabmexa M 500', active: true, startDate: at('2026-10-18T08:00:00') }] },
    doses: [{ scheduledDate: '2026-10-19', status: 'taken' }, { scheduledDate: '2026-10-20', status: 'pending' }], vitalsLogs: [], now });
  assert.equal(p.report.status, 'ongoing');
  assert.equal(p.dayNo, 3);
  assert.deepEqual(p.range, { from: '2026-10-18', to: '2026-10-20' });
  assert.equal(p.summary.totalReadings, 0);
  assert.ok(Object.values(p.series).every(s => s.length === 0));
  assert.equal(p.summary.adherencePct, 100);
  assert.match(p.report.summary[0], /Not enough readings/);
});

test('worsening is reported, not hidden', () => {
  const logs = [140, 150, 160, 170, 175, 178].map((v, i) => L(`2026-10-1${i}T08:00:00`, { glucose: v + 60 }));
  const p = buildVitalsProgress({ patient: { ...patient, medicines: [] }, doses: [], vitalsLogs: logs, now });
  assert.equal(p.stats.glucose.verdict, 'worsened');
  assert.ok(p.report.summary.some(l => /Needs attention: blood sugar/.test(l)));
});
