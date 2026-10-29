// ========== BIOMEXA — VITALS CALIBRATION ==========
// One place that decides whether a vital reading is believable, what unit it is in, and whether
// it is dangerous. Used by every entry path (WhatsApp, the patient's vitals form, the public quick
// tracker) and by every reader (doctor dashboard, treatment report, progress charts), so a number
// is judged the same way everywhere it appears.

// Readings outside these ranges are almost certainly typos (BP 280/130, temperature 110°F).
// Rejected at entry, and ignored in analysis for anything already stored. Very high but real
// values (sugar 580) pass — they're exactly what a report must flag, not hide.
const VITAL_LIMITS = {
  bpSystolic: { min: 60, max: 260, label: 'Top BP number', unit: 'mmHg', decimals: 0 },
  bpDiastolic: { min: 30, max: 160, label: 'Bottom BP number', unit: 'mmHg', decimals: 0 },
  temperature: { min: 90, max: 108, label: 'Temperature', unit: '°F', decimals: 1 },
  heartRate: { min: 25, max: 250, label: 'Pulse', unit: 'bpm', decimals: 0 },
  glucose: { min: 20, max: 700, label: 'Blood sugar', unit: 'mg/dL', decimals: 0 }
};

// Usual target ranges for an adult, used to shade the charts, count "readings in range" and judge
// whether a vital moved toward or away from target over the course. Not diagnostic thresholds —
// the danger rules below are what raise alerts.
const VITAL_TARGETS = {
  bpSystolic: { lo: 90, hi: 139, tolerance: 5 },
  bpDiastolic: { lo: 60, hi: 89, tolerance: 3 },
  temperature: { lo: 97, hi: 99.5, tolerance: 0.3 },
  heartRate: { lo: 60, hi: 100, tolerance: 5 },
  glucose: { lo: 70, hi: 180, tolerance: 10 }
};

const roundTo = (n, d) => { const f = Math.pow(10, d); return Math.round(n * f) / f; };

function cleanVitals(v) {
  const clean = {}, rejected = [];
  for (const [k, lim] of Object.entries(VITAL_LIMITS)) {
    const raw = v?.[k];
    const n = raw == null || raw === '' ? null : Number(raw);
    if (n == null || Number.isNaN(n)) continue;
    if (n < lim.min || n > lim.max) rejected.push(`${lim.label} ${n} ${lim.unit}`);
    else clean[k] = roundTo(n, lim.decimals);
  }
  // A BP reading is a pair. If one number is missing or impossible, neither is trusted — a lone
  // "top number" plotted on a chart reads as a full BP reading and skews every average.
  const hasS = clean.bpSystolic != null, hasD = clean.bpDiastolic != null;
  if (hasS !== hasD) {
    const otherGiven = hasS ? (v?.bpDiastolic != null && v.bpDiastolic !== '') : (v?.bpSystolic != null && v.bpSystolic !== '');
    if (!otherGiven) rejected.push(`BP ${hasS ? clean.bpSystolic + '/?' : '?/' + clean.bpDiastolic} (both BP numbers are needed, e.g. 120/80)`);
    delete clean.bpSystolic; delete clean.bpDiastolic;
  }
  if (clean.bpSystolic != null && clean.bpDiastolic != null && clean.bpDiastolic >= clean.bpSystolic) {
    rejected.push(`BP ${clean.bpSystolic}/${clean.bpDiastolic}`); delete clean.bpSystolic; delete clean.bpDiastolic;
  }
  return { clean, rejected };
}

// Body temperature in °F (what the platform stores), or null if the number can't be a body
// temperature. Unit 'f' / 'c' when the patient wrote one; otherwise 34–42 is read as °C.
function toFahrenheit(n, unit) {
  if (!Number.isFinite(n)) return null;
  const isF = x => x >= 93 && x <= 108;
  const isC = x => x >= 34 && x <= 42;
  const c2f = x => Math.round((x * 9 / 5 + 32) * 10) / 10;
  if (unit === 'f') return isF(n) ? n : null;
  if (unit === 'c') return isC(n) ? c2f(n) : null;
  if (isF(n)) return n;
  if (isC(n)) return c2f(n);
  return null;
}

// Form entry: a temperature typed in °C (37.2) is converted instead of rejected as "too low".
// Anything that isn't a body temperature in either unit is passed through unchanged so
// cleanVitals rejects it with a clear message.
function normaliseEntry(body) {
  const out = {};
  for (const k of Object.keys(VITAL_LIMITS)) {
    const raw = body?.[k];
    if (raw == null || raw === '') continue;
    out[k] = raw;
  }
  if (out.temperature != null) {
    const f = toFahrenheit(Number(out.temperature), '');
    if (f != null) out.temperature = f;
  }
  return out;
}

// Clinical thresholds for auto-flagging a reading as dangerous — deliberately conservative (err
// toward flagging): a false alarm costs a doctor a glance, a missed one costs a lot more.
function checkVitalsDanger(vitals) {
  const reasons = [];
  let severity = 'high';
  if (vitals.bpSystolic >= 180 || vitals.bpDiastolic >= 120) {
    reasons.push(`Hypertensive crisis: BP ${vitals.bpSystolic}/${vitals.bpDiastolic}`);
    severity = 'critical';
  } else if (vitals.bpSystolic && vitals.bpSystolic < 90) {
    reasons.push(`Low blood pressure: BP ${vitals.bpSystolic}/${vitals.bpDiastolic || '?'}`);
  }
  if (vitals.temperature >= 103) {
    reasons.push(`High fever: ${vitals.temperature}°F`);
    severity = 'critical';
  } else if (vitals.temperature && vitals.temperature <= 95) {
    reasons.push(`Low body temperature: ${vitals.temperature}°F`);
  }
  if (vitals.heartRate >= 120) {
    reasons.push(`High heart rate: ${vitals.heartRate} bpm`);
  } else if (vitals.heartRate && vitals.heartRate <= 45) {
    reasons.push(`Low heart rate: ${vitals.heartRate} bpm`);
    severity = 'critical';
  }
  if (vitals.glucose >= 250) {
    reasons.push(`Severe hyperglycemia: sugar ${vitals.glucose} mg/dL`);
    severity = 'critical';
  } else if (vitals.glucose && vitals.glucose <= 70) {
    reasons.push(`Hypoglycemia: sugar ${vitals.glucose} mg/dL`);
    severity = 'critical';
  } else if (vitals.glucose >= 180) {
    reasons.push(`High blood sugar: sugar ${vitals.glucose} mg/dL`);
  }
  return reasons.length ? { reason: reasons.join('; '), severity } : null;
}

module.exports = { VITAL_LIMITS, VITAL_TARGETS, cleanVitals, toFahrenheit, normaliseEntry, checkVitalsDanger };
