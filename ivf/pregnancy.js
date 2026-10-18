// ========== BIOMEXA IVF CARE — EARLY PREGNANCY VIABILITY (doctor decision support) ==========
// After a positive pregnancy test, the IVF doctor records beta-hCG results and early scans. This
// module checks each value against PUBLISHED reference criteria and lists which ones are met.
//
// It does NOT diagnose and does NOT predict an outcome. Every finding names its source so the
// doctor can judge it; the doctor decides what is shared with the patient.
//
// References used (kept deliberately few and well established):
//  [ACOG]   ACOG Committee Opinion No. 700, Methods for Estimating the Due Date (2017):
//           ART pregnancies are dated from embryo age and transfer date (EDD = transfer + 266 − embryo age)
//           and are not redated; CRL discrepancy thresholds > 5 days before 9w0d, > 7 days 9w0d–13w6d.
//  [SRU]    Doubilet PM et al. Diagnostic Criteria for Nonviable Pregnancy Early in the First Trimester.
//           N Engl J Med 2013;369:1443-51 (Society of Radiologists in Ultrasound consensus, Table 2).
//  [HCG]    Barnhart KT et al. Obstet Gynecol 2016: minimum 48-hour hCG rise in a viable intrauterine
//           pregnancy of 49% / 40% / 33% for initial values < 1,500 / 1,500–3,000 / > 3,000 mIU/mL.
//  [FHR]    Doubilet PM, Benson CB. J Ultrasound Med 1995;14:431-4 (slow rate < 100 bpm at ≤ 6w2d,
//           < 120 bpm at 6w3d–7w0d); Rodgers SK et al. Radiographics 2015 (≤ 85 bpm suspicious).
//  [CRL]    Robinson HP, Fleming JE. Br J Obstet Gynaecol 1975;82:702-10: GA(days) = 8.052·√CRL(mm) + 23.73.

const REFS = {
  ACOG: 'ACOG Committee Opinion 700 (2017)',
  SRU: 'SRU consensus, Doubilet et al., NEJM 2013',
  HCG: 'Barnhart et al., Obstet Gynecol 2016',
  FHR: 'Doubilet & Benson, J Ultrasound Med 1995',
  FHR85: 'Rodgers et al., Radiographics 2015',
  CRL: 'Robinson & Fleming, BJOG 1975'
};
const LEVEL_RANK = { info: 0, good: 1, watch: 2, suspicious: 3, diagnostic: 4, urgent: 5 };

function parseDay(d) {
  let s = typeof d === 'string' ? d.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) s = dayStr(new Date(d)); // Date objects from the database
  const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd);
}
function dayStr(d) { d = new Date(d); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 864e5);
const addDays = (d, n) => { const x = parseDay(d); x.setDate(x.getDate() + n); return dayStr(x); };
const gaLabel = days => (days === null || days === undefined) ? '—' : `${Math.floor(days / 7)}w${days % 7}d`;
const round1 = n => Math.round(n * 10) / 10;

// Gestational age in days on a given date, from the transfer date and embryo age [ACOG].
function gaOn(preg, date) {
  if (!preg || !preg.transferDate) return null;
  return daysBetween(preg.transferDate, date) + (preg.embryoAgeDays || 5) + 14;
}
const crlToGaDays = crl => 8.052 * Math.sqrt(crl) + 23.73;                 // [CRL]
const expectedCrlForGa = ga => ga > 23.73 ? Math.pow((ga - 23.73) / 8.052, 2) : 0;
function minRiseFor(initial) { return initial < 1500 ? 49 : initial <= 3000 ? 40 : 33; }   // [HCG]

function evaluateHcg(tests) {
  const pts = (tests || []).filter(t => t && t.date && Number.isFinite(t.value) && t.value > 0)
    .map(t => ({ date: dayStr(t.date), value: t.value, id: t._id ? String(t._id) : undefined }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const rises = [], findings = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], days = daysBetween(a.date, b.date);
    if (days < 1 || days > 7) continue;               // only compare tests 1–7 days apart
    const ratio = b.value / a.value;
    const rise48 = (Math.pow(ratio, 2 / days) - 1) * 100;
    const min = minRiseFor(a.value);
    const doubling = ratio > 1 ? round1((days * 24 * Math.LN2) / Math.log(ratio)) : null;
    const r = { from: a.date, to: b.date, fromValue: a.value, toValue: b.value, days, rise48: Math.round(rise48), minExpected: min, doublingHours: doubling };
    if (ratio < 1) { r.level = 'suspicious'; r.text = `hCG fell from ${a.value} to ${b.value} mIU/mL in ${days} day(s).`; }
    else if (rise48 < min) { r.level = 'watch'; r.text = `hCG rose ${Math.round(rise48)}% per 48 h (${a.value} → ${b.value}), below the ${min}% minimum expected for a viable intrauterine pregnancy at this starting level.`; }
    else { r.level = 'good'; r.text = `hCG rose ${Math.round(rise48)}% per 48 h (${a.value} → ${b.value}), at or above the ${min}% minimum expected.`; }
    r.ref = REFS.HCG;
    rises.push(r);
  }
  const lastRise = rises[rises.length - 1];
  if (lastRise) {
    findings.push({ level: lastRise.level, text: lastRise.text + (lastRise.level === 'watch' ? ' Consider a repeat hCG and/or ultrasound; slower rises are also seen in some viable IVF pregnancies.' : lastRise.level === 'suspicious' ? ' A falling level suggests a non-progressing pregnancy; correlate with ultrasound.' : ''), ref: REFS.HCG });
  } else if (pts.length === 1) {
    findings.push({ level: 'info', text: `One hCG result recorded (${pts[0].value} mIU/mL). A second test about 48 hours later shows the rate of rise.`, ref: REFS.HCG });
  }
  return { points: pts, rises, findings };
}

// One sac/fetus on one scan. fetus: { label, msdMm, yolkSac, yolkSacMm, embryo, crlMm, heartbeat ('yes'|'no'|'na'), fhrBpm, emptyAmnion }
function evaluateFetus(f, ga, location) {
  const out = [];
  const add = (level, text, ref) => out.push({ level, text, ref });
  const hb = f.heartbeat === 'yes' ? true : f.heartbeat === 'no' ? false : null;
  const crl = Number.isFinite(f.crlMm) && f.crlMm > 0 ? f.crlMm : null;
  const msd = Number.isFinite(f.msdMm) && f.msdMm > 0 ? f.msdMm : null;
  const embryo = f.embryo === true || crl !== null;

  if (location === 'ectopic_suspected') add('urgent', 'Recorded as suspected ectopic or pregnancy of unknown location. Needs urgent clinical assessment.', 'Doctor-entered finding');
  // Diagnostic of pregnancy failure [SRU]
  if (crl !== null && crl >= 7 && hb === false) add('diagnostic', `CRL ${crl} mm with no heartbeat: meets the criterion "CRL ≥ 7 mm and no heartbeat".`, REFS.SRU);
  if (msd !== null && msd >= 25 && !embryo) add('diagnostic', `Mean sac diameter ${msd} mm with no embryo: meets the criterion "MSD ≥ 25 mm and no embryo".`, REFS.SRU);
  // Suspicious for pregnancy failure [SRU]
  if (crl !== null && crl < 7 && hb === false) add('suspicious', `CRL ${crl} mm with no heartbeat (suspicious criterion: CRL < 7 mm and no heartbeat).`, REFS.SRU);
  if (msd !== null && msd >= 16 && msd < 25 && !embryo) add('suspicious', `Mean sac diameter ${msd} mm with no embryo (suspicious criterion: MSD 16–24 mm, no embryo).`, REFS.SRU);
  if (f.emptyAmnion) add('suspicious', 'Empty amnion (amnion next to the yolk sac with no visible embryo).', REFS.SRU);
  if (Number.isFinite(f.yolkSacMm) && f.yolkSacMm > 7) add('suspicious', `Enlarged yolk sac (${f.yolkSacMm} mm, > 7 mm).`, REFS.SRU);
  if (msd !== null && crl !== null && msd - crl < 5) add('suspicious', `Small sac for embryo size (MSD − CRL = ${round1(msd - crl)} mm, < 5 mm).`, REFS.SRU);
  if (ga !== null && ga >= 42 && !embryo && location !== 'ectopic_suspected') add('suspicious', `No embryo seen at ${gaLabel(ga)} by IVF dates (suspicious criterion: no embryo ≥ 6 weeks).`, REFS.SRU);
  // Heart rate
  if (hb && Number.isFinite(f.fhrBpm)) {
    if (f.fhrBpm <= 85) add('suspicious', `Embryonic heart rate ${f.fhrBpm} bpm (≤ 85 bpm).`, REFS.FHR85);
    else if (ga !== null && ga <= 44 && f.fhrBpm < 100) add('watch', `Heart rate ${f.fhrBpm} bpm is slow for ${gaLabel(ga)} (< 100 bpm at ≤ 6w2d).`, REFS.FHR);
    else if (ga !== null && ga >= 45 && ga <= 49 && f.fhrBpm < 120) add('watch', `Heart rate ${f.fhrBpm} bpm is slow for ${gaLabel(ga)} (< 120 bpm at 6w3d–7w0d).`, REFS.FHR);
  }
  // Size vs IVF dates [CRL][ACOG]
  let crlGa = null, sizeDiff = null;
  if (crl !== null && ga !== null) {
    crlGa = Math.round(crlToGaDays(crl));
    sizeDiff = crlGa - ga;
    const limit = ga < 63 ? 5 : ga <= 97 ? 7 : null;
    if (limit !== null && sizeDiff < -limit) add('watch', `Embryo measures ${gaLabel(crlGa)} (CRL ${crl} mm), ${-sizeDiff} days smaller than ${gaLabel(ga)} by IVF dates (more than ${limit} days). IVF pregnancies are not redated; review growth.`, `${REFS.CRL}; ${REFS.ACOG}`);
    else if (limit !== null && sizeDiff > limit) add('info', `Embryo measures ${gaLabel(crlGa)}, ${sizeDiff} days larger than IVF dates.`, `${REFS.CRL}; ${REFS.ACOG}`);
  }
  if (hb && !out.some(o => LEVEL_RANK[o.level] >= LEVEL_RANK.watch)) {
    add('good', `Heartbeat seen${Number.isFinite(f.fhrBpm) ? ` (${f.fhrBpm} bpm)` : ''}${sizeDiff !== null ? `, size matches IVF dates (${sizeDiff >= 0 ? '+' : ''}${sizeDiff} days)` : ''}.`, crl !== null ? `${REFS.CRL}; ${REFS.ACOG}` : REFS.SRU);
  }
  return { findings: out, crlGa, sizeDiff, heartbeat: hb, embryo };
}

function evaluatePregnancy(preg, asOf = new Date()) {
  const today = dayStr(asOf);
  const ga = gaOn(preg, today);
  const edd = preg && preg.transferDate ? addDays(dayStr(preg.transferDate), 266 - (preg.embryoAgeDays || 5)) : null;   // [ACOG]
  const hcg = evaluateHcg(preg?.hcgTests);
  const scans = (preg?.scans || []).map(s => ({ ...s, date: dayStr(s.date) })).sort((a, b) => a.date.localeCompare(b.date));

  const evaluated = scans.map((s, si) => {
    const sga = gaOn(preg, s.date);
    const fetuses = (s.fetuses || []).map(f => {
      const e = evaluateFetus(f, sga, s.location);
      // Follow-up criteria comparing with an earlier scan of the same sac [SRU]
      if (!(e.embryo && e.heartbeat)) {
        for (let pi = si - 1; pi >= 0; pi--) {
          const prev = (scans[pi].fetuses || []).find(p => (p.label || 'A') === (f.label || 'A'));
          if (!prev) continue;
          const prevHasEmbryoHb = (prev.embryo || Number.isFinite(prev.crlMm)) && prev.heartbeat === 'yes';
          if (prevHasEmbryoHb) break;
          const gap = daysBetween(scans[pi].date, s.date);
          if (prev.yolkSac === true) {
            if (gap >= 11) e.findings.push({ level: 'diagnostic', text: `No embryo with heartbeat ${gap} days after a scan showing a sac with yolk sac (criterion: ≥ 11 days).`, ref: REFS.SRU });
            else if (gap >= 7) e.findings.push({ level: 'suspicious', text: `No embryo with heartbeat ${gap} days after a scan showing a sac with yolk sac (suspicious: 7–10 days).`, ref: REFS.SRU });
          } else if (prev.yolkSac === false) {
            if (gap >= 14) e.findings.push({ level: 'diagnostic', text: `No embryo with heartbeat ${gap} days after a scan showing a sac without yolk sac (criterion: ≥ 2 weeks).`, ref: REFS.SRU });
            else if (gap >= 7) e.findings.push({ level: 'suspicious', text: `No embryo with heartbeat ${gap} days after a scan showing a sac without yolk sac (suspicious: 7–13 days).`, ref: REFS.SRU });
          }
          break;
        }
      }
      e.findings.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
      const worst = e.findings[0]?.level || 'info';
      return { ...f, ...e, worst };
    });
    const worst = fetuses.reduce((w, f) => LEVEL_RANK[f.worst] > LEVEL_RANK[w] ? f.worst : w, 'info');
    return { ...s, ga: sga, gaLabel: gaLabel(sga), fetuses, worst };
  });

  const latest = evaluated[evaluated.length - 1];
  const levels = [latest?.worst, hcg.findings[0]?.level].filter(Boolean);
  const worst = levels.reduce((w, l) => LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w, 'info');
  const STATUS = {
    urgent: { label: 'Urgent review', text: 'A finding recorded on the latest scan needs urgent clinical assessment.' },
    diagnostic: { label: 'Meets failure criteria', text: 'The latest findings meet a published criterion for pregnancy failure. Confirm clinically before any decision.' },
    suspicious: { label: 'Suspicious findings', text: 'The latest findings are suspicious but not diagnostic. The SRU guideline suggests follow-up ultrasound in 7–10 days.' },
    watch: { label: 'Needs review', text: 'One or more values are outside the usual range. Review and consider a repeat test or scan.' },
    good: { label: 'Developing as expected', text: 'The latest results are within the published reference ranges for IVF dates.' },
    info: { label: preg && (hcg.points.length || evaluated.length) ? 'Awaiting more results' : 'No results yet', text: 'Add hCG results and early scans to see the checks.' }
  };
  let repeatScanDue = null;
  if (latest && latest.worst === 'suspicious') repeatScanDue = { from: addDays(latest.date, 7), to: addDays(latest.date, 10) };
  const sacs = latest ? (latest.fetuses || []).length : 0;
  const heartbeats = latest ? latest.fetuses.filter(f => f.heartbeat === true).length : 0;
  return {
    today, gaToday: ga, gaTodayLabel: gaLabel(ga), edd, embryoAgeDays: preg?.embryoAgeDays || 5,
    status: { level: worst, ...STATUS[worst] }, hcg, scans: evaluated, repeatScanDue,
    latestSummary: latest ? { date: latest.date, ga: latest.gaLabel, sacs, heartbeats } : null,
    // series for graphs (calendar dates, like the treatment graphs)
    crlSeries: evaluated.flatMap(s => s.fetuses.filter(f => Number.isFinite(f.crlMm) && f.crlMm > 0).map(f => ({ date: s.date, label: f.label || 'A', v: f.crlMm, expected: s.ga ? round1(expectedCrlForGa(s.ga)) : null }))),
    fhrSeries: evaluated.flatMap(s => s.fetuses.filter(f => Number.isFinite(f.fhrBpm)).map(f => ({ date: s.date, label: f.label || 'A', v: f.fhrBpm }))),
    refs: REFS,
    disclaimer: 'Decision support only. Checks recorded values against published reference criteria; it does not diagnose or predict the outcome of the pregnancy. Interpret with the full clinical picture.'
  };
}

module.exports = { evaluatePregnancy, evaluateHcg, evaluateFetus, gaOn, gaLabel, crlToGaDays, expectedCrlForGa, minRiseFor, REFS };
