const test = require('node:test');
const assert = require('node:assert');
const { summarizeAdherence, doseOutcome } = require('../vitals/adherence');

const now = new Date('2026-11-15T12:00:00+05:30');
const D = (date, time, status, extra = {}) => ({ medicineName: 'Rabitop DSR', scheduledDate: date, scheduledTime: time, status, ...extra });

test('a past dose never confirmed counts as missed, even if no reminder went out', () => {
  assert.strictEqual(doseOutcome(D('2026-11-12', '08:30', 'pending', { sentReminder: false }), now), 'missed');
});

test('doses later today or inside the grace period are not counted yet', () => {
  assert.strictEqual(doseOutcome(D('2026-11-15', '20:00', 'pending'), now), 'upcoming');
  assert.strictEqual(doseOutcome(D('2026-11-15', '10:30', 'pending'), now), 'upcoming'); // 1.5h ago < 3h grace
  assert.strictEqual(doseOutcome(D('2026-11-15', '08:30', 'pending'), now), 'missed');   // 3.5h ago
});

test('adherence = taken ÷ due, stale pending doses included', () => {
  const doses = [
    D('2026-11-09', '08:30', 'taken'), D('2026-11-10', '08:30', 'taken'), D('2026-11-11', '08:30', 'taken'),
    D('2026-11-12', '08:30', 'pending'),           // never answered → missed
    D('2026-11-13', '08:30', 'missed'), D('2026-11-14', '08:30', 'taken'),
    D('2026-11-15', '20:00', 'pending')            // upcoming → ignored
  ];
  const a = summarizeAdherence(doses, now);
  assert.deepStrictEqual([a.taken, a.missed, a.due, a.upcoming, a.pct], [4, 2, 6, 1, 67]);
});

test('the same dose stored under two phone formats counts once (best outcome kept)', () => {
  const doses = [
    D('2026-11-10', '08:30', 'pending', { patientPhone: '+91 9876543210' }),
    D('2026-11-10', '08:30', 'taken', { patientPhone: '919876543210' })
  ];
  const a = summarizeAdherence(doses, now);
  assert.deepStrictEqual([a.taken, a.missed, a.pct], [1, 0, 100]);
});
