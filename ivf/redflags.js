// ========== BIOMEXA IVF CARE — RED-FLAG RULES ==========
// Checks one daily check-in (plus the previous few) for warning signs the IVF centre should
// see quickly. These are TRIAGE flags, not a diagnosis: they decide who the doctor looks at
// first and when the patient is told to call the centre. Thresholds are deliberately on the
// cautious side — a false alarm costs the doctor a glance, a missed one can cost far more.
//
// Main concern during stimulation and just after egg retrieval is OHSS (ovarian
// hyperstimulation syndrome): fast weight gain, worsening bloating, less urine, breathlessness,
// vomiting. After retrieval/transfer: fever (infection) and heavy bleeding.

const SEVERITY_RANK = { watch: 1, high: 2, critical: 3 };
const maxSeverity = (a, b) => (SEVERITY_RANK[b] || 0) > (SEVERITY_RANK[a] || 0) ? b : a;

// Stages where OHSS is the main risk to watch for.
const OHSS_STAGES = ['stimulation', 'trigger', 'retrieval', 'embryo_culture', 'transfer', 'two_week_wait'];

/**
 * @param {object} log      the new check-in ({ vitals, symptoms, stage })
 * @param {object[]} recent previous check-ins for the same cycle, newest first
 * @param {object} cycle    the IVF cycle (for baseline weight)
 * @returns {{ flags: {code,message,severity}[], severity: string|null }}
 */
function evaluateDailyLog(log, recent = [], cycle = {}) {
  const v = log.vitals || {};
  const s = log.symptoms || {};
  const stage = log.stage || cycle.stage;
  const flags = [];
  const add = (code, message, severity) => flags.push({ code, message, severity });

  // --- Weight gain (OHSS) ---
  if (v.weightKg) {
    const prev = recent.find(r => r.vitals && r.vitals.weightKg);
    if (prev) {
      const hours = (new Date(log.createdAt || Date.now()) - new Date(prev.createdAt)) / 36e5;
      const gain = +(v.weightKg - prev.vitals.weightKg).toFixed(1);
      if (gain >= 1 && hours <= 36) add('rapid_weight_gain', `Weight up ${gain} kg since last check-in${hours >= 2 ? ` (${Math.round(hours)}h ago)` : ''}`, 'high');
    }
    const threeDaysAgo = recent.find(r => r.vitals && r.vitals.weightKg && (Date.now() - new Date(r.createdAt)) / 36e5 >= 60);
    if (threeDaysAgo) {
      const gain3 = +(v.weightKg - threeDaysAgo.vitals.weightKg).toFixed(1);
      if (gain3 >= 2 && !flags.some(f => f.code === 'rapid_weight_gain')) add('weight_gain_3d', `Weight up ${gain3} kg over the last few days`, 'high');
    }
    if (cycle.baselineWeightKg && v.weightKg - cycle.baselineWeightKg >= 3) {
      add('weight_above_baseline', `Weight ${(v.weightKg - cycle.baselineWeightKg).toFixed(1)} kg above starting weight`, 'watch');
    }
  }

  // --- Abdominal girth trend ---
  if (v.abdominalGirthCm) {
    const prevG = recent.find(r => r.vitals && r.vitals.abdominalGirthCm);
    if (prevG && v.abdominalGirthCm - prevG.vitals.abdominalGirthCm >= 3) {
      add('girth_increase', `Abdominal girth up ${(v.abdominalGirthCm - prevG.vitals.abdominalGirthCm).toFixed(1)} cm`, 'high');
    }
  }

  // --- Breathing, urine, vomiting, bloating (OHSS cluster) ---
  if (s.breathlessness) add('breathlessness', 'Shortness of breath reported', 'critical');
  if (s.reducedUrine) add('reduced_urine', 'Passing less urine than usual', 'high');
  if (s.nausea === 'vomiting') add('vomiting', 'Vomiting reported', 'high');
  if (s.bloating === 'severe') add('severe_bloating', 'Severe abdominal bloating', 'high');
  else if (s.bloating === 'moderate' && OHSS_STAGES.includes(stage)) add('moderate_bloating', 'Moderate bloating', 'watch');

  const ohssSigns = ['rapid_weight_gain', 'weight_gain_3d', 'girth_increase', 'reduced_urine', 'vomiting', 'severe_bloating', 'breathlessness']
    .filter(c => flags.some(f => f.code === c)).length;
  if (ohssSigns >= 2 && OHSS_STAGES.includes(stage)) add('possible_ohss', `${ohssSigns} OHSS warning signs together — needs same-day review`, 'critical');

  // --- Pain ---
  if (typeof s.painScore === 'number') {
    if (s.painScore >= 8) add('severe_pain', `Severe pain (${s.painScore}/10)`, 'critical');
    else if (s.painScore >= 6) add('significant_pain', `Significant pain (${s.painScore}/10)`, 'high');
  }

  // --- Fever ---
  if (v.temperatureF) {
    if (v.temperatureF >= 102) add('high_fever', `High fever ${v.temperatureF}°F`, 'critical');
    else if (v.temperatureF >= 100.4) add('fever', `Fever ${v.temperatureF}°F`, 'high');
  }

  // --- Bleeding ---
  if (s.bleeding === 'heavy') add('heavy_bleeding', 'Heavy bleeding reported', 'critical');
  else if (s.bleeding === 'light' && ['two_week_wait', 'pregnancy_test', 'early_pregnancy'].includes(stage)) add('bleeding_after_transfer', 'Light bleeding after transfer', 'watch');

  // --- Blood pressure / pulse ---
  if (v.bpSystolic || v.bpDiastolic) {
    if (v.bpSystolic >= 160 || v.bpDiastolic >= 110) add('very_high_bp', `Very high BP ${v.bpSystolic}/${v.bpDiastolic}`, 'critical');
    else if (v.bpSystolic >= 140 || v.bpDiastolic >= 90) add('high_bp', `High BP ${v.bpSystolic}/${v.bpDiastolic}`, 'high');
    else if (v.bpSystolic && v.bpSystolic < 90) add('low_bp', `Low BP ${v.bpSystolic}/${v.bpDiastolic || '?'}`, 'high');
  }
  if (v.heartRate >= 120) add('fast_pulse', `Fast pulse ${v.heartRate} bpm`, 'high');

  // --- Emotional wellbeing ---
  if (s.mood === 'very_low') add('low_mood', 'Feeling very low — consider a counselling check-in', 'watch');

  const severity = flags.reduce((acc, f) => maxSeverity(acc, f.severity), null);
  return { flags, severity };
}

module.exports = { evaluateDailyLog, SEVERITY_RANK, maxSeverity };
