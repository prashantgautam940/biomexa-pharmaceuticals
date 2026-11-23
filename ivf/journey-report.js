// ========== BIOMEXA IVF CARE — TREATMENT JOURNEY REPORT (PDF) ==========
// A patient-friendly PDF of the whole IVF cycle: the stages she went through and when, the key
// dates, her injections and how many were confirmed, what her daily check-ins showed, her lab and
// scan values from reports her doctor reviewed, notes her doctor shared, and what comes next.
// Only information the patient can already see in her IVF portal goes in — doctor-only decision
// support (e.g. pregnancy viability checks) never does. It never predicts an outcome or gives
// medical advice; it always points back to the IVF centre.
const path = require('path');
const PDFDocument = require('pdfkit');
const { IVF_STAGES } = require('./models');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const LOGO = path.join(__dirname, '..', 'images', 'logo-invoice.png');
const NAVY = '#16336b', GREEN = '#1c9a55', RED = '#d0454c', AMBER = '#d48a10', MUTED = '#5b6b86', LINE = '#dfe5ef', TEXT = '#13213d', SOFT = '#f6f8fc', PINK = '#c2477a';

const STAGE_LABEL = Object.fromEntries(IVF_STAGES.map(s => [s.key, s.label]));
const STAGE_KEYS = IVF_STAGES.map(s => s.key);
const PROTOCOL_LABEL = {
  antagonist: 'Antagonist protocol', long_agonist: 'Long agonist protocol', short_agonist: 'Short agonist protocol',
  mild_stimulation: 'Mild stimulation', natural_cycle: 'Natural cycle', frozen_embryo_transfer: 'Frozen embryo transfer (FET)', iui: 'IUI', other: 'Other protocol'
};
const ROUTE_LABEL = { injection: 'Injection', oral: 'Tablet', vaginal: 'Vaginal', other: 'Other' };
// What each stage means, in plain words (shown next to the timeline).
const STAGE_MEANING = {
  consultation: 'First visit, tests and planning your treatment.',
  stimulation: 'Daily hormone injections to help several eggs grow.',
  trigger: 'The timed final injection that matures the eggs.',
  retrieval: 'The eggs were collected in a short procedure.',
  embryo_culture: 'Eggs were fertilised and embryos grew in the lab.',
  transfer: 'An embryo was placed in the womb.',
  two_week_wait: 'Waiting for the pregnancy test, with support medicines.',
  pregnancy_test: 'Blood test (beta-hCG) to check for pregnancy.',
  early_pregnancy: 'Early pregnancy scans and follow-up with your centre.',
  closed: 'This treatment cycle has been closed by your centre.'
};
const LAB_INFO = [
  ['amh', 'AMH', 'ng/mL', 'Egg reserve'],
  ['estradiol', 'Estradiol (E2)', 'pg/mL', 'Rises as follicles grow'],
  ['progesterone', 'Progesterone (P4)', 'ng/mL', 'Supports the womb lining'],
  ['lh', 'LH', 'mIU/mL', 'Ovulation hormone'],
  ['follicles', 'Follicle count', '', 'Both ovaries together'],
  ['leadFollicleMm', 'Lead follicle', 'mm', 'Size of the biggest follicle'],
  ['endometriumMm', 'Endometrium', 'mm', 'Womb lining thickness'],
  ['betaHcg', 'Beta-hCG', 'mIU/mL', 'Pregnancy hormone']
];

const fmtDate = d => d ? new Date(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00+05:30' : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';
const fmtDateTime = d => d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '—';
const pctOf = (a, b) => b ? Math.round(100 * a / b) : null;

// The outcome as the centre wrote it, read gently: positive / negative / cancelled / other.
function outcomeKind(o) {
  const s = String(o || '').toLowerCase();
  if (!s) return null;
  if (/cancel|stopp|abandon|freeze[- ]?all/.test(s)) return 'cancelled';
  if (/neg|not pregnant|no pregnan|unsuccess|failed/.test(s)) return 'negative';
  if (/pos|pregnan|success|heart ?beat|ongoing/.test(s)) return 'positive';
  return 'other';
}

// input: { cycle, center, doctorName, progress (buildProgress), medicines: [{name,dosage,route,isTrigger,triggerAt,startDate,endDate,taken,missed,due}],
//          reports: [{title, date, category, findings, advice}], consults: [{date, mode, summary}],
//          pregnancy: {gaLabel, edd, sharedNotes:[{text,at,by}]} | null }
function analyse(input) {
  const c = input.cycle, pr = input.progress || {};
  const stageIdx = STAGE_KEYS.indexOf(c.stage);
  const reached = {};
  for (const h of (c.stageHistory || [])) if (h.changedAt && !reached[h.stage]) reached[h.stage] = h.changedAt;
  if (!reached.consultation) reached.consultation = c.createdAt;
  const timeline = IVF_STAGES.filter(s => s.key !== 'closed' || c.stage === 'closed').map((s, i) => ({
    key: s.key, label: s.label, meaning: STAGE_MEANING[s.key] || '',
    state: s.key === c.stage ? (s.key === 'closed' ? 'done' : 'current') : (STAGE_KEYS.indexOf(s.key) < stageIdx ? (reached[s.key] ? 'done' : 'skipped') : 'next'),
    at: reached[s.key] || null
  }));
  const meds = input.medicines || [];
  const taken = meds.reduce((a, m) => a + (m.taken || 0), 0), missed = meds.reduce((a, m) => a + (m.missed || 0), 0);
  const adherence = pctOf(taken, taken + missed);
  const trigger = meds.find(m => m.isTrigger);
  const s = pr.series || {};
  const firstLast = arr => arr && arr.length ? { first: arr[0], last: arr[arr.length - 1], count: arr.length } : null;
  const weight = firstLast(s.weight), pain = s.pain || [];
  const painAvg = pain.length ? Math.round(10 * pain.reduce((a, p) => a + p.v, 0) / pain.length) / 10 : null;
  const painMax = pain.length ? Math.max(...pain.map(p => p.v)) : null;
  const bloatSevere = (s.bloating || []).filter(p => p.v >= 2).length;
  const bp = s.bpSystolic && s.bpSystolic.length ? { first: [s.bpSystolic[0].v, (s.bpDiastolic || [])[0]?.v], last: [s.bpSystolic[s.bpSystolic.length - 1].v, (s.bpDiastolic || [])[(s.bpDiastolic || []).length - 1]?.v], count: s.bpSystolic.length } : null;
  const flaggedDays = new Set([].concat(...Object.values(s).map(a => (a || []).filter(p => p.flagged).map(p => p.date)))).size;
  const labs = LAB_INFO.map(([k, label, unit, what]) => ({ k, label, unit, what, pts: (pr.labs || {})[k] || [] })).filter(l => l.pts.length);
  const days = pr.dayNo || Math.max(1, Math.round((Date.now() - new Date(c.createdAt)) / 864e5));
  return {
    timeline, stageIdx, taken, missed, adherence, trigger, weight, painAvg, painMax, bloatSevere, bp, flaggedDays, labs, days,
    checkins: pr.summary?.totalCheckins || 0, outcome: outcomeKind(c.outcome)
  };
}

function narrative(input, a) {
  const c = input.cycle;
  const first = String(c.patientName || 'there').trim().split(/\s+/)[0];
  const out = [];
  const protocol = PROTOCOL_LABEL[c.protocol] || 'IVF';
  out.push(`Dear ${first}, this report walks you through your IVF treatment with ${c.centerName || 'your IVF centre'}${input.doctorName ? ' (' + input.doctorName + ')' : ''} — cycle ${c.cycleNumber || 1}, ${protocol.toLowerCase()}. It started on ${fmtDate(c.createdAt)} and covers ${a.days} day${a.days === 1 ? '' : 's'} of your journey. ${c.stage === 'closed' || c.status === 'completed' ? 'Your centre has now closed this cycle.' : `You are currently in the ${STAGE_LABEL[c.stage] || c.stage} stage.`}`);
  const done = a.timeline.filter(t => t.state === 'done').map(t => t.label.toLowerCase());
  if (done.length) out.push(`So far you have been through ${done.length === 1 ? done[0] : done.slice(0, -1).join(', ') + ' and ' + done[done.length - 1]}. Each step is shown with its date on the timeline below.`);
  if (a.taken + a.missed) {
    const line = a.adherence >= 95 ? 'That is excellent — taking every IVF medicine on time gives your treatment its best chance.'
      : a.adherence >= 80 ? 'You took most of your medicines on time. If any dose was missed, your centre has this record and can guide you.'
      : 'Several doses were not confirmed. Please talk to your centre about them — some IVF medicines are very time-sensitive.';
    out.push(`You confirmed ${a.taken} of ${a.taken + a.missed} IVF medicine doses (${a.adherence}%). ${line}${a.trigger ? ` Your trigger shot (${a.trigger.name}) was planned for ${fmtDateTime(a.trigger.triggerAt)}${a.trigger.taken ? ' and you confirmed it.' : a.trigger.missed ? ' — it was not confirmed on Biomexa; your centre will have the details.' : '.'}` : ''}`);
  }
  if (a.checkins) {
    let t = `You did ${a.checkins} daily check-in${a.checkins === 1 ? '' : 's'}.`;
    if (a.weight) t += ` Your weight went from ${a.weight.first.v} kg to ${a.weight.last.v} kg.`;
    if (a.painAvg !== null) t += ` Your average pain score was ${a.painAvg} out of 10${a.painMax >= 6 ? ` (highest ${a.painMax})` : ''}.`;
    if (a.flaggedDays) t += ` On ${a.flaggedDays} day${a.flaggedDays === 1 ? '' : 's'} a symptom was flagged to your centre so they could check on you.`;
    out.push(t);
  } else out.push('No daily check-ins were recorded. Logging your weight, pain and symptoms each day helps your centre spot problems like OHSS early.');
  if (a.labs.length) out.push(`Your doctor reviewed ${input.reports.length} report${input.reports.length === 1 ? '' : 's'} during this cycle. The key values are listed in "Your test results" below.`);
  if (a.outcome === 'positive') out.push('Your centre has recorded a positive result. Congratulations — please keep following your centre\'s plan for medicines, scans and check-ups closely.');
  else if (a.outcome === 'negative') out.push('Your centre has recorded that this cycle did not result in a pregnancy. We know how hard this news is. A negative cycle does not mean the next one will be the same — your doctor can review what was learnt from this cycle and talk through your options. Please be gentle with yourself, and reach out to your centre or someone close to you for support.');
  else if (a.outcome === 'cancelled') out.push('Your centre has recorded that this cycle was stopped or changed. This is sometimes the safest choice for you. Your doctor will explain why and what the plan is next.');
  else if (c.outcome) out.push(`Your centre's note on the outcome: "${String(c.outcome).slice(0, 200)}".`);
  return out;
}

function nextSteps(input, a) {
  const c = input.cycle, st = [];
  const closed = c.stage === 'closed' || c.status === 'completed';
  if (!closed) {
    const nxt = a.timeline.find(t => t.state === 'next');
    if (nxt) st.push(`Next step: ${nxt.label} — ${nxt.meaning.charAt(0).toLowerCase() + nxt.meaning.slice(1)} Your centre will tell you the exact date.`);
    st.push('Keep taking every IVF medicine at the exact time and reply TAKEN to each WhatsApp reminder.');
    st.push('Do your daily check-in (weight, pain, bloating). Severe tummy swelling, breathlessness, very little urine or heavy bleeding need a same-day call to your centre.');
  } else if (a.outcome === 'positive') {
    st.push('Keep all your pregnancy medicines and scans exactly as your centre advised — do not stop progesterone or other support on your own.');
    st.push('Book your early pregnancy scans and follow-up visits on time.');
  } else {
    st.push('Book a follow-up consultation with your doctor to review this cycle and plan the next step.');
    st.push('Keep this report — it is useful at your next consultation or if you visit another specialist.');
  }
  st.push('Log in to your Biomexa IVF portal any time to see your graphs, reports and messages from your doctor: biomexapharmaceuticals.com/ivf-auth.html');
  return st;
}

function buildIvfJourneyPdf(input) {
  const a = analyse(input);
  const story = narrative(input, a);
  const steps = nextSteps(input, a);
  const c = input.cycle;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 0 }, info: { Title: 'Biomexa IVF treatment journey', Author: 'Biomexa IVF Care' } });
    const chunks = [];
    doc.on('data', x => chunks.push(x)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('R', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
    doc.registerFont('B', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
    const W = doc.page.width, H = doc.page.height, L = 40, R = W - 40, CW = R - L;
    const txt = (s, x, yy, o = {}) => {
      doc.font(o.bold ? 'B' : 'R').fontSize(o.size || 9.5).fillColor(o.color || TEXT);
      const w = doc.widthOfString(String(s));
      let cx = x;
      if (o.width && o.align === 'right') cx = x + o.width - w;
      if (o.width && o.align === 'center') cx = x + (o.width - w) / 2;
      doc.text(String(s), cx, yy, { lineBreak: false });
      return w;
    };
    const para = (s, x, yy, w, o = {}) => { doc.font(o.bold ? 'B' : 'R').fontSize(o.size || 10).fillColor(o.color || TEXT).text(String(s), x, yy, { width: w, lineGap: 2.5 }); return doc.y; };
    const hOf = (s, w, size = 10) => { doc.font('R').fontSize(size); return doc.heightOfString(String(s), { width: w, lineGap: 2.5 }); };
    let y = 0, pageNo = 1;
    function footer() {
      doc.font('R').fontSize(7.5).fillColor(MUTED).text('Made from the records in your Biomexa IVF Care portal (your check-ins, confirmed doses and reports reviewed by your doctor). It is not a diagnosis and does not predict the outcome of treatment — please discuss it with your IVF centre.  ·  biomexapharmaceuticals.com', L, H - 46, { width: CW - 40, lineGap: 1 });
      doc.text(`Page ${pageNo++}`, R - 40, H - 46, { width: 40, align: 'right', lineBreak: false });
    }
    const need = h => { if (y + h > H - 60) { footer(); doc.addPage(); y = 48; } };
    const section = title => { need(44); y += 8; txt(title, L, y, { bold: true, size: 13, color: NAVY }); y += 22; doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(1).stroke(); y += 10; };

    // ---- header
    doc.rect(0, 0, W, 6).fill(PINK);
    try { doc.image(LOGO, L, 22, { height: 40 }); } catch { txt('BIOMEXA', L, 30, { bold: true, size: 16, color: NAVY }); }
    txt('YOUR IVF TREATMENT JOURNEY', L, 24, { bold: true, size: 15, color: NAVY, width: CW, align: 'right' });
    txt(`Biomexa IVF Care  ·  made on ${fmtDate(new Date())}`, L, 46, { size: 8.5, color: MUTED, width: CW, align: 'right' });
    y = 80;
    doc.roundedRect(L, y, CW, 68, 8).fillAndStroke(SOFT, LINE);
    txt(c.patientName || 'Biomexa IVF patient', L + 14, y + 10, { bold: true, size: 13 });
    txt('+91 ' + String(c.patientPhone || '').replace(/\D/g, '').slice(-10) + (c.patientAge ? `  ·  ${c.patientAge} years` : '') + (c.partnerName ? `  ·  Partner: ${c.partnerName}` : ''), L + 14, y + 30, { size: 9, color: MUTED });
    txt(`${c.centerName || 'IVF centre'}${input.doctorName ? '  ·  ' + input.doctorName : ''}`, L + 14, y + 46, { bold: true, size: 10, color: NAVY });
    txt(`Cycle ${c.cycleNumber || 1}  ·  ${PROTOCOL_LABEL[c.protocol] || 'IVF'}`, L, y + 12, { size: 9.5, width: CW - 14, align: 'right' });
    txt(`Started ${fmtDate(c.createdAt)}`, L, y + 30, { size: 9, color: MUTED, width: CW - 14, align: 'right' });
    const closed = c.stage === 'closed' || c.status === 'completed';
    txt(closed ? 'Cycle closed' : `Now: ${STAGE_LABEL[c.stage] || c.stage}`, L, y + 46, { size: 9.5, bold: true, color: closed ? NAVY : PINK, width: CW - 14, align: 'right' });
    y += 84;

    // ---- tiles
    const tiles = [
      ['Days in treatment', String(a.days), NAVY, `since ${fmtDate(c.createdAt)}`],
      ['Medicines on time', a.adherence === null ? '—' : a.adherence + '%', a.adherence === null ? MUTED : a.adherence >= 90 ? GREEN : a.adherence >= 70 ? AMBER : RED, a.taken + a.missed ? `${a.taken} of ${a.taken + a.missed} doses` : 'no doses yet'],
      ['Daily check-ins', String(a.checkins), a.checkins ? GREEN : MUTED, a.flaggedDays ? `${a.flaggedDays} day(s) flagged` : 'no warning signs'],
      ['Reports reviewed', String(input.reports.length), NAVY, 'by your doctor']
    ];
    const tw = (CW - 30) / 4;
    tiles.forEach(([k, v, col, s], i) => {
      const x = L + i * (tw + 10);
      doc.roundedRect(x, y, tw, 66, 8).fillAndStroke('#ffffff', LINE);
      txt(k.toUpperCase(), x + 10, y + 9, { bold: true, size: 7.2, color: MUTED });
      txt(v, x + 10, y + 22, { bold: true, size: 20, color: col });
      txt(s, x + 10, y + 50, { size: 7.8, color: MUTED });
    });
    y += 80;

    // ---- story
    section('Your journey so far');
    for (const p of story) { need(hOf(p, CW) + 8); y = para(p, L, y, CW) + 8; }

    // ---- timeline
    section('Treatment stages');
    for (const t of a.timeline) {
      const rowH = 34; need(rowH);
      const col = t.state === 'done' ? GREEN : t.state === 'current' ? PINK : '#c4cddc';
      doc.circle(L + 9, y + 9, 7).fill(col);
      if (t.state === 'done') doc.moveTo(L + 5.5, y + 9).lineTo(L + 8, y + 11.5).lineTo(L + 12.5, y + 6.5).strokeColor('#ffffff').lineWidth(1.6).stroke();
      if (t !== a.timeline[a.timeline.length - 1]) doc.moveTo(L + 9, y + 17).lineTo(L + 9, y + rowH + 1).strokeColor('#dbe2ec').lineWidth(2).stroke();
      txt(t.label, L + 26, y + 1, { bold: true, size: 10, color: t.state === 'next' || t.state === 'skipped' ? MUTED : TEXT });
      txt(t.state === 'current' ? 'Current stage' + (t.at ? ' · since ' + fmtDate(t.at) : '') : t.state === 'done' ? (t.at ? fmtDate(t.at) : 'Done') : t.state === 'skipped' ? 'Not part of this cycle' : 'Coming up', L, y + 1, { size: 8.5, bold: t.state === 'current', color: t.state === 'current' ? PINK : MUTED, width: CW, align: 'right' });
      txt(t.meaning, L + 26, y + 15, { size: 8.5, color: MUTED });
      y += rowH;
    }

    // ---- key dates
    const kd = [['Stimulation started', c.dates?.stimulationStart, false], ['Trigger shot', c.dates?.triggerAt, true], ['Egg retrieval', c.dates?.retrievalAt, false], ['Embryo transfer', c.dates?.transferAt, false], ['Pregnancy test (beta-hCG)', c.dates?.betaHcgTestAt, false]].filter(r => r[1]);
    if (kd.length) {
      section('Key dates');
      for (const [k, d, withTime] of kd) { need(18); txt(k, L, y, { bold: true }); txt(withTime ? fmtDateTime(d) : fmtDate(d), L, y, { width: CW, align: 'right' }); y += 18; }
    }

    // ---- medicines
    if ((input.medicines || []).length) {
      section('Your IVF medicines');
      const cx = [L, L + 200, L + 290, L + 400];
      ['Medicine', 'How', 'Dates', 'Doses confirmed'].forEach((h, i) => txt(h, cx[i], y, { bold: true, size: 8.5, color: MUTED }));
      y += 16;
      for (const m of input.medicines) {
        need(30);
        txt(m.name + (m.isTrigger ? '  (trigger)' : ''), cx[0], y, { bold: true, size: 9.5 });
        if (m.dosage) txt(String(m.dosage).slice(0, 40), cx[0], y + 13, { size: 8, color: MUTED });
        txt(ROUTE_LABEL[m.route] || 'Medicine', cx[1], y, { size: 9 });
        txt(m.isTrigger ? fmtDateTime(m.triggerAt) : `${fmtDate(m.startDate)}${m.endDate ? ' – ' + fmtDate(m.endDate) : ''}`, cx[2], y, { size: 8.5 });
        const due = (m.taken || 0) + (m.missed || 0);
        txt(due ? `${m.taken} of ${due}` : '—', cx[3], y, { bold: true, size: 9.5, color: !due ? MUTED : m.missed ? AMBER : GREEN });
        y += 28;
      }
    }

    // ---- body check-ins
    if (a.checkins) {
      section('How your body responded');
      const rows = [];
      if (a.weight) rows.push(['Weight', `${a.weight.first.v} kg (${fmtDate(a.weight.first.date)})`, `${a.weight.last.v} kg (${fmtDate(a.weight.last.date)})`]);
      if (a.bp) rows.push(['Blood pressure', `${a.bp.first[0]}/${a.bp.first[1] ?? '—'}`, `${a.bp.last[0]}/${a.bp.last[1] ?? '—'}`]);
      if (a.painAvg !== null) rows.push(['Pain (0–10)', `average ${a.painAvg}`, `highest ${a.painMax}`]);
      if ((input.progress?.series?.bloating || []).length) rows.push(['Bloating', a.bloatSevere ? `moderate/severe on ${a.bloatSevere} day(s)` : 'none or mild', '']);
      const cx = [L, L + 150, L + 330];
      ['Reading', 'First / overall', 'Latest'].forEach((h, i) => txt(h, cx[i], y, { bold: true, size: 8.5, color: MUTED }));
      y += 16;
      for (const r of rows) { need(18); txt(r[0], cx[0], y, { bold: true }); txt(r[1], cx[1], y, { size: 9 }); txt(r[2], cx[2], y, { size: 9 }); y += 18; }
    }

    // ---- labs
    if (a.labs.length) {
      section('Your test results');
      txt('Values from reports your doctor reviewed. Only your doctor can say what they mean for you.', L, y, { size: 8.5, color: MUTED }); y += 16;
      const cx = [L, L + 150, L + 290, L + 400];
      ['Test', 'What it shows', 'First', 'Latest'].forEach((h, i) => txt(h, cx[i], y, { bold: true, size: 8.5, color: MUTED }));
      y += 16;
      for (const l of a.labs) {
        need(30);
        const f = l.pts[0], la = l.pts[l.pts.length - 1];
        txt(l.label, cx[0], y, { bold: true, size: 9.5 });
        txt(l.what, cx[1], y, { size: 8.5, color: MUTED });
        txt(`${f.v} ${l.unit}`, cx[2], y, { size: 9 }); txt(fmtDate(f.date), cx[2], y + 12, { size: 7.5, color: MUTED });
        if (l.pts.length > 1) { txt(`${la.v} ${l.unit}`, cx[3], y, { bold: true, size: 9 }); txt(fmtDate(la.date), cx[3], y + 12, { size: 7.5, color: MUTED }); }
        y += 28;
      }
    }

    // ---- doctor's reviews and notes
    const notes = [];
    for (const r of input.reports || []) if (r.findings || r.advice) notes.push({ head: `${r.title || 'Report'}  ·  ${fmtDate(r.date)}`, body: [r.findings && 'Findings: ' + r.findings, r.advice && 'Advice: ' + r.advice].filter(Boolean).join('\n') });
    for (const k of input.consults || []) if (k.summary) notes.push({ head: `Follow-up consultation  ·  ${fmtDate(k.date)}`, body: k.summary });
    for (const n of input.pregnancy?.sharedNotes || []) notes.push({ head: `Update from ${n.by || 'your doctor'}  ·  ${fmtDate(n.at)}`, body: n.text });
    if (notes.length) {
      section('What your doctor told you');
      for (const n of notes.slice(-10)) {
        const body = String(n.body).slice(0, 700);
        need(hOf(body, CW - 16, 9.5) + 30);
        doc.rect(L, y, 3, hOf(body, CW - 16, 9.5) + 18).fill(PINK);
        txt(n.head, L + 12, y, { bold: true, size: 9, color: NAVY });
        y = para(body, L + 12, y + 14, CW - 16, { size: 9.5 }) + 10;
      }
    }

    // ---- pregnancy dates (patient-visible only)
    if (input.pregnancy && (input.pregnancy.gaLabel || input.pregnancy.edd)) {
      section('Your pregnancy');
      if (input.pregnancy.gaLabel) { txt('Weeks of pregnancy today', L, y, { bold: true }); txt(input.pregnancy.gaLabel, L, y, { width: CW, align: 'right' }); y += 18; }
      if (input.pregnancy.edd) { txt('Expected due date', L, y, { bold: true }); txt(fmtDate(input.pregnancy.edd), L, y, { width: CW, align: 'right' }); y += 18; }
    }

    // ---- next
    section(closed ? 'What to do next' : 'What comes next');
    steps.forEach((s, i) => {
      need(hOf(s, CW - 24) + 10);
      doc.circle(L + 8, y + 7, 8).fill(NAVY);
      txt(String(i + 1), L, y + 1.5, { bold: true, size: 9, color: '#ffffff', width: 16, align: 'center' });
      y = para(s, L + 24, y, CW - 24) + 8;
    });

    footer();
    doc.end();
  });
}

module.exports = { buildIvfJourneyPdf, analyseIvfJourney: analyse, outcomeKind };
