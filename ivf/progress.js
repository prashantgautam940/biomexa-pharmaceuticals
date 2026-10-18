// ========== BIOMEXA IVF CARE — TREATMENT PROGRESS ==========
// Turns a cycle's raw records (daily check-ins, IVF doses, reviewed reports, stage history) into
// day-by-day series for the portal graphs, plus plain-language "what changed" insights. Shared by
// the patient portal, the IVF centre dashboard and the WhatsApp progress summaries, so every
// screen and message tells the same story.
const { IVF_STAGES, IvfDailyLog, IvfDose, IvfReport, IvfAlert } = require('./models');

const STAGE_LABEL = Object.fromEntries(IVF_STAGES.map(s => [s.key, s.label]));
const BLOAT = { none: 0, mild: 1, moderate: 2, severe: 3 };
const BLEED = { none: 0, spotting: 1, light: 2, heavy: 3 };
const MOOD = { very_low: 0, low: 1, okay: 2, good: 3 };

function dayStr(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const round1 = n => Math.round(n * 10) / 10;
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

async function buildProgress(cycle) {
  const id = String(cycle._id);
  const now = new Date();
  const [logs, doses, reports, openAlerts] = await Promise.all([
    IvfDailyLog.find({ cycleId: id }).sort({ createdAt: 1 }).lean(),
    IvfDose.find({ cycleId: id, scheduledAt: { $lte: now } }).sort({ scheduledAt: 1 }).lean(),
    IvfReport.find({ cycleId: id, reviewStatus: 'reviewed' }).select('-files').sort({ reviewedAt: 1 }).lean(),
    IvfAlert.countDocuments({ cycleId: id, acknowledged: false })
  ]);

  // ---- one point per day: the last check-in of that day wins ----
  const byDay = new Map();
  for (const l of logs) byDay.set(l.logDate || dayStr(l.createdAt), l);
  const days = [...byDay.keys()].sort();
  const pick = (fn) => days.map(d => { const l = byDay.get(d); const v = fn(l); return Number.isFinite(v) ? { date: d, v, flagged: (l.flags || []).length > 0, flags: (l.flags || []).map(f => f.message) } : null; }).filter(Boolean);
  const series = {
    weight: pick(l => l.vitals?.weightKg),
    girth: pick(l => l.vitals?.abdominalGirthCm),
    temperature: pick(l => l.vitals?.temperatureF),
    bpSystolic: pick(l => l.vitals?.bpSystolic),
    bpDiastolic: pick(l => l.vitals?.bpDiastolic),
    pulse: pick(l => l.vitals?.heartRate),
    pain: pick(l => l.symptoms?.painScore),
    bloating: pick(l => BLOAT[l.symptoms?.bloating]),
    bleeding: pick(l => BLEED[l.symptoms?.bleeding]),
    mood: pick(l => MOOD[l.symptoms?.mood])
  };

  // ---- medicine adherence per day (pending doses still inside their window are left out) ----
  const doseDays = new Map();
  for (const d of doses) {
    if (d.status === 'pending') continue;
    const k = d.scheduledDate || dayStr(d.scheduledAt);
    const e = doseDays.get(k) || { date: k, taken: 0, missed: 0, trigger: false };
    e[d.status === 'taken' ? 'taken' : 'missed']++;
    if (d.isTrigger) e.trigger = true;
    doseDays.set(k, e);
  }
  const adherence = [...doseDays.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map(e => ({ ...e, v: Math.round(100 * e.taken / (e.taken + e.missed)) }));

  // ---- lab and scan values from doctor-reviewed reports ----
  const labs = { estradiol: [], progesterone: [], lh: [], follicles: [], leadFollicleMm: [], endometriumMm: [], betaHcg: [], amh: [] };
  for (const r of reports) {
    const date = r.reportDate || dayStr(r.reviewedAt || r.uploadedAt);
    const v = r.values || {};
    for (const k of ['estradiol', 'progesterone', 'lh', 'leadFollicleMm', 'endometriumMm', 'betaHcg', 'amh']) {
      if (Number.isFinite(v[k])) labs[k].push({ date, v: v[k], report: r.title });
    }
    if (Number.isFinite(v.follicleCountLeft) || Number.isFinite(v.follicleCountRight)) {
      labs.follicles.push({ date, v: (v.follicleCountLeft || 0) + (v.follicleCountRight || 0), report: r.title });
    }
  }
  for (const k of Object.keys(labs)) labs[k].sort((a, b) => a.date.localeCompare(b.date));

  // ---- treatment stages as date ranges (for the shaded bands behind every graph) ----
  const hist = (cycle.stageHistory || []).filter(h => h.changedAt).sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));
  if (!hist.length) hist.push({ stage: cycle.stage, changedAt: cycle.createdAt });
  const stages = hist.map((h, i) => ({ stage: h.stage, label: STAGE_LABEL[h.stage] || h.stage, from: dayStr(h.changedAt), to: hist[i + 1] ? dayStr(hist[i + 1].changedAt) : dayStr(now) }))
    .filter((s, i, a) => !(a[i + 1] && a[i + 1].from === s.from)); // same-day changes: keep the later stage

  const start = [stages[0]?.from, days[0], adherence[0]?.date].filter(Boolean).sort()[0] || dayStr(cycle.createdAt);
  const range = { from: start, to: dayStr(now) };
  const dayNo = Math.max(1, Math.round((new Date(range.to) - new Date(range.from)) / 864e5) + 1);

  // ---- what changed ----
  const insights = [];
  const first = a => a[0], last = a => a[a.length - 1];
  const w = series.weight;
  const base = Number.isFinite(cycle.baselineWeightKg) ? cycle.baselineWeightKg : w[0]?.v;
  let weightChange = null;
  if (w.length && Number.isFinite(base)) {
    weightChange = round1(last(w).v - base);
    const recent = w.filter(p => new Date(last(w).date) - new Date(p.date) <= 3 * 864e5);
    const d3 = recent.length >= 2 ? round1(last(recent).v - first(recent).v) : 0;
    if (d3 >= 1) insights.push({ tone: 'bad', icon: '⬆', text: `Weight up ${d3} kg in the last ${Math.round((new Date(last(recent).date) - new Date(first(recent).date)) / 864e5) || 1} days. Fast gain can be an early OHSS sign.` });
    else if (Math.abs(weightChange) >= 0.1) insights.push({ tone: Math.abs(weightChange) >= 2 ? 'watch' : 'neutral', icon: weightChange > 0 ? '⬆' : '⬇', text: `Weight ${weightChange > 0 ? 'up' : 'down'} ${Math.abs(weightChange)} kg since the start of treatment.` });
    else insights.push({ tone: 'good', icon: '✓', text: 'Weight steady since the start of treatment.' });
  }
  const p = series.pain;
  if (p.length >= 4) {
    const a = avg(p.slice(-3).map(x => x.v)), b = avg(p.slice(-6, -3).map(x => x.v));
    if (b !== null && a - b >= 1.5) insights.push({ tone: 'watch', icon: '⬆', text: `Pain rising: average ${round1(b)} → ${round1(a)} out of 10 over the last few days.` });
    else if (b !== null && b - a >= 1.5) insights.push({ tone: 'good', icon: '⬇', text: `Pain easing: average ${round1(b)} → ${round1(a)} out of 10.` });
  }
  const bl = series.bloating;
  if (bl.length && last(bl).v >= 2) insights.push({ tone: last(bl).v === 3 ? 'bad' : 'watch', icon: '●', text: `Latest bloating is ${last(bl).v === 3 ? 'severe' : 'moderate'}.` });
  const taken = adherence.reduce((s, d) => s + d.taken, 0), missed = adherence.reduce((s, d) => s + d.missed, 0);
  const adherencePct = taken + missed ? Math.round(100 * taken / (taken + missed)) : null;
  if (adherencePct !== null) insights.push({ tone: adherencePct >= 90 ? 'good' : adherencePct >= 70 ? 'watch' : 'bad', icon: adherencePct >= 90 ? '✓' : '!', text: `${adherencePct}% of IVF medicine doses confirmed taken (${taken} of ${taken + missed}).` });
  for (const [k, label, unit] of [['estradiol', 'Estradiol (E2)', ' pg/mL'], ['follicles', 'Follicle count', ''], ['endometriumMm', 'Endometrium', ' mm'], ['betaHcg', 'Beta-hCG', ' mIU/mL']]) {
    const s = labs[k];
    if (s.length >= 2) insights.push({ tone: 'neutral', icon: last(s).v >= s[s.length - 2].v ? '⬆' : '⬇', text: `${label}: ${s[s.length - 2].v} → ${last(s).v}${unit} (latest report).` });
    else if (s.length === 1) insights.push({ tone: 'neutral', icon: '•', text: `${label}: ${s[0].v}${unit} (latest report).` });
  }
  const last7 = new Set(days.filter(d => new Date(range.to) - new Date(d) < 7 * 864e5));
  const checkinDays7 = last7.size, expected7 = Math.min(7, dayNo);
  insights.push({ tone: checkinDays7 >= expected7 - 1 ? 'good' : 'watch', icon: '📋', text: `${checkinDays7} of the last ${expected7} days checked in.` });

  return {
    range, dayNo, stage: { key: cycle.stage, label: STAGE_LABEL[cycle.stage] || cycle.stage }, stages,
    series, adherence, labs, insights, openAlerts,
    summary: {
      weightChange, latestWeight: w.length ? last(w).v : null, baselineWeight: Number.isFinite(base) ? base : null,
      latestPain: p.length ? last(p).v : null, adherencePct, checkinDays7, expected7, totalCheckins: days.length,
      lastCheckin: days.length ? last(days) : null
    }
  };
}

module.exports = { buildProgress, dayStr };
