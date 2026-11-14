// ========== BIOMEXA — ONE ADHERENCE RULE FOR EVERY SCREEN ==========
// Adherence = doses confirmed taken ÷ doses that were DUE.
//
// A dose is "due" once its scheduled time has passed by the grace period (DOSE_MISSED_AFTER_HOURS,
// default 3h). A due dose that was never confirmed counts as missed — whether or not a reminder
// went out. Before this, a dose whose reminder never fired (server asleep at that minute, a
// failed send, a day the reminder cron skipped) stayed "pending" forever and was silently left
// out of every rate, so patients looked more adherent than they were. Doses still inside the
// grace window, or in the future, are "upcoming" and don't count either way.
//
// The same dose can be stored twice under two formats of one phone number ("+91 98…" and
// "9198…"); duplicates (same medicine, date and time) are merged, keeping the best outcome, so a
// single dose is never counted twice.
//
// Used by the patient portal + doctor analysis (vitals/progress.js), the risk score, the 7-day
// trends panel and the end-of-course summary, so every screen shows the same number.

const GRACE_HOURS = Math.max(1, parseFloat(process.env.DOSE_MISSED_AFTER_HOURS) || 3);

function pad(n) { return String(n).padStart(2, '0'); }
function localDate(d) { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localTime(d) { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// 'taken' | 'missed' | 'upcoming'
function doseOutcome(dose, now = new Date(), graceHours = GRACE_HOURS) {
  if (!dose) return 'upcoming';
  if (dose.status === 'taken') return 'taken';
  if (dose.status && dose.status !== 'pending') return 'missed'; // missed, skipped, not_taken …
  if (!dose.scheduledDate) return 'upcoming';
  const cutoff = new Date(new Date(now).getTime() - graceHours * 3600e3);
  const cutDate = localDate(cutoff), cutTime = localTime(cutoff);
  const time = /^\d{1,2}:\d{2}$/.test(dose.scheduledTime || '') ? dose.scheduledTime.padStart(5, '0') : '23:59';
  if (dose.scheduledDate < cutDate || (dose.scheduledDate === cutDate && time <= cutTime)) return 'missed';
  return 'upcoming';
}

const RANK = { taken: 2, missed: 1, upcoming: 0 };

// One row per real dose (medicine + date + time), each with its outcome.
function dedupeDoses(doses, now = new Date(), graceHours = GRACE_HOURS) {
  const byKey = new Map();
  for (const d of doses || []) {
    const outcome = doseOutcome(d, now, graceHours);
    const key = `${String(d.medicineName || '').trim().toLowerCase()}|${d.scheduledDate || ''}|${d.scheduledTime || ''}`;
    const prev = byKey.get(key);
    if (!prev || RANK[outcome] > RANK[prev.outcome]) byKey.set(key, { dose: d, outcome });
  }
  return [...byKey.values()];
}

// { taken, missed, due, upcoming, pct (0–100 or null), rate (0–1 or null), rows }
function summarizeAdherence(doses, now = new Date(), graceHours = GRACE_HOURS) {
  const rows = dedupeDoses(doses, now, graceHours);
  let taken = 0, missed = 0, upcoming = 0;
  for (const r of rows) { if (r.outcome === 'taken') taken++; else if (r.outcome === 'missed') missed++; else upcoming++; }
  const due = taken + missed;
  return { taken, missed, due, upcoming, rate: due ? taken / due : null, pct: due ? Math.round(100 * taken / due) : null, rows };
}

module.exports = { doseOutcome, dedupeDoses, summarizeAdherence, GRACE_HOURS };
