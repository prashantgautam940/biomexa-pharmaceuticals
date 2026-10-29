// ========== BIOMEXA — VITALS PROGRESS & END-OF-TREATMENT ANALYSIS ==========
// Turns a patient's raw records (every logged vital reading, every scheduled dose, their medicine
// courses) into one chart per vital, day-by-day medicine adherence, and an end-of-treatment
// analysis report. Same idea and output shape as ivf/progress.js, so the patient portal and the
// doctor dashboard can draw it with the same chart code the IVF portal uses — and both of them
// read the exact same numbers.
//
// Calibration rules (why the numbers can be trusted):
//  • every stored reading goes through cleanVitals — impossible values (typos) are dropped and
//    counted, never averaged in; a half BP reading is dropped too
//  • statistics (first, latest, lowest, highest, average, % in target) use EVERY reading, so two
//    readings on one day both count
//  • a chart has one point per day (the day's last reading), but the tooltip and table list every
//    reading of that day, and the point is flagged if ANY reading that day was dangerous — a 580
//    sugar in the morning can never hide behind a 150 in the evening
//  • days without a reading are gaps, never filled in
//  • baseline = the first real reading (same rule as the AI treatment report)
const { VITAL_TARGETS, cleanVitals, checkVitalsDanger } = require('./calibration');

function dayStr(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function timeStr(d) {
  d = new Date(d);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const round1 = n => Math.round(n * 10) / 10;
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);

const VITALS = [
  { key: 'bpSystolic', label: 'Top BP (systolic)', unit: 'mmHg' },
  { key: 'bpDiastolic', label: 'Bottom BP (diastolic)', unit: 'mmHg' },
  { key: 'glucose', label: 'Blood sugar', unit: 'mg/dL' },
  { key: 'temperature', label: 'Temperature', unit: '°F' },
  { key: 'heartRate', label: 'Pulse', unit: 'bpm' }
];
const LABEL = Object.fromEntries(VITALS.map(v => [v.key, v]));

// Danger reasons that belong to one vital (BP flags both BP series).
function flagsFor(key, clean) {
  if (key === 'bpSystolic' || key === 'bpDiastolic') {
    const d = checkVitalsDanger({ bpSystolic: clean.bpSystolic, bpDiastolic: clean.bpDiastolic });
    return d ? d.reason.split('; ') : [];
  }
  const d = checkVitalsDanger({ [key]: clean[key] });
  return d ? d.reason.split('; ') : [];
}

// Distance outside the target range (0 when inside it).
function offTarget(key, v) {
  const t = VITAL_TARGETS[key];
  return v < t.lo ? t.lo - v : v > t.hi ? v - t.hi : 0;
}

function verdictFor(key, values) {
  if (values.length < 2) return { verdict: 'not_enough', text: 'Not enough readings to judge a change.' };
  const third = Math.max(1, Math.floor(values.length / 3));
  const early = values.slice(0, third), late = values.slice(-third);
  const eAvg = avg(early), lAvg = avg(late);
  const eOff = avg(early.map(v => offTarget(key, v))), lOff = avg(late.map(v => offTarget(key, v)));
  const tol = VITAL_TARGETS[key].tolerance;
  if (eOff === 0 && lOff === 0) return { verdict: 'in_range', text: 'Stayed within the target range.', earlyAvg: round1(eAvg), lateAvg: round1(lAvg) };
  if (lOff <= eOff - tol) return { verdict: 'improved', text: lOff === 0 ? 'Moved into the target range.' : 'Moved closer to the target range.', earlyAvg: round1(eAvg), lateAvg: round1(lAvg) };
  if (lOff >= eOff + tol) return { verdict: 'worsened', text: 'Moved further outside the target range.', earlyAvg: round1(eAvg), lateAvg: round1(lAvg) };
  return { verdict: 'unchanged', text: lOff === 0 ? 'Mostly within target, little change.' : 'Little change; still outside the target range.', earlyAvg: round1(eAvg), lateAvg: round1(lAvg) };
}

function treatmentWindow(patient, doses, now) {
  const meds = patient.medicines || [];
  const starts = [...meds.map(m => m.startDate).filter(Boolean).map(dayStr), ...doses.map(d => d.scheduledDate).filter(Boolean)].sort();
  const start = starts[0] || null;
  const ongoing = meds.some(m => m.active && (!m.endDate || new Date(m.endDate) > now));
  const ends = meds.map(m => m.endDate || m.completedAt).filter(Boolean).map(d => new Date(d));
  const completed = meds.length > 0 && !ongoing && ends.length > 0;
  const end = completed ? dayStr(new Date(Math.max(...ends))) : null;
  const medicines = meds.map(m => ({
    name: m.name, dosage: m.dosage || '', durationDays: m.durationDays || null,
    startDate: m.startDate ? dayStr(m.startDate) : null,
    endDate: m.endDate ? dayStr(m.endDate) : null,
    status: m.active && (!m.endDate || new Date(m.endDate) > now) ? 'ongoing' : m.stoppedByPatient ? 'stopped' : 'completed'
  }));
  return { start, end, completed, medicines };
}

function buildVitalsProgress({ patient, doses = [], vitalsLogs = [], now = new Date() }) {
  const today = dayStr(now);

  // ---- calibrate every stored reading ----
  const readings = [], ignored = [];
  for (const log of [...vitalsLogs].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt))) {
    if (!log.recordedAt || new Date(log.recordedAt) > now) continue;
    const { clean, rejected } = cleanVitals(log);
    const at = new Date(log.recordedAt);
    for (const r of rejected) ignored.push({ date: dayStr(at), time: timeStr(at), reading: r, source: log.source || 'whatsapp' });
    if (Object.keys(clean).length) readings.push({ at, date: dayStr(at), time: timeStr(at), source: log.source || 'whatsapp', vitals: clean });
  }

  // ---- one series per vital: one point per day, every reading kept on the point ----
  const series = {};
  for (const { key } of VITALS) {
    const byDay = new Map();
    for (const r of readings) {
      if (r.vitals[key] == null) continue;
      const e = byDay.get(r.date) || { date: r.date, readings: [], flags: [] };
      e.readings.push({ time: r.time, v: r.vitals[key], source: r.source });
      e.flags.push(...flagsFor(key, r.vitals));
      e.v = r.vitals[key]; // last reading of the day
      byDay.set(r.date, e);
    }
    series[key] = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
      .map(e => ({ ...e, flags: [...new Set(e.flags)], flagged: e.flags.length > 0, n: e.readings.length }));
  }

  // ---- medicine adherence per day (pending doses and future days left out) ----
  const doseDays = new Map();
  let taken = 0, missed = 0;
  for (const d of doses) {
    if (!d.scheduledDate || d.scheduledDate > today || d.status === 'pending') continue;
    const e = doseDays.get(d.scheduledDate) || { date: d.scheduledDate, taken: 0, missed: 0, missedList: [] };
    if (d.status === 'taken') { e.taken++; taken++; } else { e.missed++; missed++; e.missedList.push(`${d.medicineName || 'Dose'}${d.scheduledTime ? ' ' + d.scheduledTime : ''}`); }
    doseDays.set(d.scheduledDate, e);
  }
  const adherence = [...doseDays.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map(e => ({ ...e, v: Math.round(100 * e.taken / (e.taken + e.missed)), flagged: e.missed > 0, flags: e.missedList.length ? ['Missed: ' + e.missedList.join(', ')] : [] }));
  const adherencePct = taken + missed ? Math.round(100 * taken / (taken + missed)) : null;

  // ---- treatment phases (shaded bands behind every chart) ----
  const tw = treatmentWindow(patient, doses, now);
  const firstDay = [readings[0]?.date, adherence[0]?.date, tw.start].filter(Boolean).sort()[0] || dayStr(patient.createdAt || now);
  const lastData = [readings[readings.length - 1]?.date, adherence[adherence.length - 1]?.date, tw.end].filter(Boolean).sort().pop() || today;
  const range = { from: firstDay, to: tw.completed ? (lastData > today ? today : lastData) : today };
  const stages = [];
  if (tw.start && firstDay < tw.start) stages.push({ key: 'before', label: 'Before treatment', from: firstDay });
  stages.push({ key: 'on', label: tw.completed ? 'Treatment' : 'On treatment', from: tw.start && tw.start > firstDay ? tw.start : firstDay });
  if (tw.completed && tw.end && tw.end < range.to) stages.push({ key: 'after', label: 'After treatment', from: tw.end });
  stages.forEach((s, i) => { s.to = stages[i + 1] ? stages[i + 1].from : range.to; });
  const phaseOf = date => [...stages].reverse().find(s => date >= s.from)?.key || 'on';

  // ---- per-vital statistics over EVERY reading ----
  const stats = {};
  for (const { key, label, unit } of VITALS) {
    const all = readings.filter(r => r.vitals[key] != null).map(r => ({ date: r.date, time: r.time, v: r.vitals[key] }));
    if (!all.length) { stats[key] = { key, label, unit, n: 0 }; continue; }
    const vals = all.map(x => x.v);
    const t = VITAL_TARGETS[key];
    const inTarget = vals.filter(v => v >= t.lo && v <= t.hi).length;
    const flagged = readings.filter(r => r.vitals[key] != null && flagsFor(key, r.vitals).length).length;
    const lowI = vals.indexOf(Math.min(...vals)), highI = vals.indexOf(Math.max(...vals));
    const byPhase = {};
    for (const p of ['before', 'on', 'after']) { const pv = all.filter(x => phaseOf(x.date) === p).map(x => x.v); if (pv.length) byPhase[p] = { n: pv.length, avg: round1(avg(pv)) }; }
    stats[key] = {
      key, label, unit, n: vals.length, days: series[key].length,
      first: all[0], latest: all[all.length - 1],
      lowest: all[lowI], highest: all[highI], average: round1(avg(vals)),
      change: round1(all[all.length - 1].v - all[0].v),
      target: { lo: t.lo, hi: t.hi }, inTarget, inTargetPct: Math.round(100 * inTarget / vals.length),
      flagged, byPhase, ...verdictFor(key, vals)
    };
  }

  // ---- plain-language "what changed" ----
  const insights = [];
  const s = stats, bpN = Math.min(s.bpSystolic.n, s.bpDiastolic.n);
  if (bpN) {
    const v = s.bpSystolic;
    insights.push({
      tone: v.verdict === 'worsened' || s.bpSystolic.flagged ? 'bad' : v.verdict === 'improved' || v.verdict === 'in_range' ? 'good' : 'watch',
      icon: v.change > 0 ? '⬆' : v.change < 0 ? '⬇' : '•',
      text: bpN === 1
        ? `Blood pressure: one reading so far, ${v.first.v}/${s.bpDiastolic.first.v} mmHg.`
        : `Blood pressure: ${v.first.v}/${s.bpDiastolic.first.v} → ${v.latest.v}/${s.bpDiastolic.latest.v} mmHg (first → latest). ${Math.min(v.inTarget, s.bpDiastolic.inTarget)} of ${bpN} readings in target. ${v.text}`
    });
  }
  for (const key of ['glucose', 'temperature', 'heartRate']) {
    const v = s[key]; if (!v.n) continue;
    const unit = v.unit === '°F' ? '°F' : ' ' + v.unit;
    insights.push({
      tone: v.flagged ? 'bad' : v.verdict === 'worsened' ? 'bad' : v.verdict === 'improved' || v.verdict === 'in_range' ? 'good' : 'watch',
      icon: v.change > 0 ? '⬆' : v.change < 0 ? '⬇' : '•',
      text: v.n === 1
        ? `${v.label}: one reading so far, ${v.first.v}${unit}.`
        : `${v.label}: ${v.first.v} → ${v.latest.v}${unit} (first → latest), average ${v.average}${unit}, ${v.inTargetPct}% of ${v.n} readings in target.${v.flagged ? ` ${v.flagged} reading${v.flagged === 1 ? ' was' : 's were'} flagged as dangerous.` : ''}`
    });
  }
  if (adherencePct !== null) insights.push({ tone: adherencePct >= 90 ? 'good' : adherencePct >= 70 ? 'watch' : 'bad', icon: adherencePct >= 90 ? '✓' : '!', text: `${adherencePct}% of medicine doses confirmed taken (${taken} of ${taken + missed}).` });
  if (ignored.length) insights.push({ tone: 'watch', icon: '!', text: `${ignored.length} reading${ignored.length === 1 ? ' looked like a typo and was' : 's looked like typos and were'} left out of the charts (e.g. ${ignored[ignored.length - 1].reading}).` });

  // ---- end-of-treatment analysis report ----
  const dayNo = Math.max(1, daysBetween(tw.start || range.from, tw.completed && tw.end ? tw.end : today) + (tw.completed ? 0 : 1));
  const flaggedReadings = readings.filter(r => checkVitalsDanger(r.vitals)).map(r => ({ date: r.date, time: r.time, reason: checkVitalsDanger(r.vitals).reason }));
  const verdicts = VITALS.map(v => s[v.key]).filter(v => v.n >= 2);
  const summaryLines = [];
  const named = k => k === 'bpSystolic' || k === 'bpDiastolic' ? 'blood pressure' : LABEL[k].label.toLowerCase();
  const group = vd => [...new Set(verdicts.filter(v => v.verdict === vd).map(v => named(v.key)))];
  if (group('improved').length) summaryLines.push(`Improved: ${group('improved').join(', ')}.`);
  if (group('in_range').length) summaryLines.push(`Stayed in target: ${group('in_range').join(', ')}.`);
  if (group('unchanged').length) summaryLines.push(`Little change: ${group('unchanged').join(', ')}.`);
  if (group('worsened').length) summaryLines.push(`Needs attention: ${group('worsened').join(', ')}.`);
  if (!verdicts.length) summaryLines.push('Not enough readings yet to judge how the vitals changed — log readings regularly during treatment.');
  if (adherencePct !== null && adherencePct < 80) summaryLines.push(`Only ${adherencePct}% of doses were confirmed taken, so changes may not reflect the medicine's full effect.`);
  if (flaggedReadings.length) summaryLines.push(`${flaggedReadings.length} reading${flaggedReadings.length === 1 ? ' was' : 's were'} in a dangerous range during the period.`);

  const report = {
    status: tw.completed ? 'completed' : 'ongoing',
    title: tw.completed ? 'End-of-treatment analysis' : 'Treatment analysis so far',
    period: { from: tw.start || range.from, to: tw.completed && tw.end ? tw.end : today, days: dayNo },
    medicines: tw.medicines,
    adherence: { taken, missed, pct: adherencePct },
    vitals: VITALS.map(v => s[v.key]),
    flaggedReadings, ignoredReadings: ignored,
    totalReadings: readings.length,
    summary: summaryLines,
    generatedAt: now.toISOString(),
    note: 'Targets are usual adult ranges for reference. This summary is built from the readings logged on Biomexa and does not replace your doctor\'s assessment.'
  };

  const last7 = new Set(readings.filter(r => daysBetween(r.date, today) < 7).map(r => r.date));
  return {
    range, dayNo, stages, series, adherence, stats, insights, report,
    readings: readings.map(r => ({ date: r.date, time: r.time, source: r.source, ...r.vitals, flag: checkVitalsDanger(r.vitals)?.reason || null })).reverse(),
    summary: {
      treatmentStatus: report.status, adherencePct, taken, missed, totalReadings: readings.length,
      readingDays7: last7.size, flaggedCount: flaggedReadings.length, ignoredCount: ignored.length,
      lastReading: readings.length ? readings[readings.length - 1].date : null
    }
  };
}

module.exports = { buildVitalsProgress, dayStr, VITALS };
