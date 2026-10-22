// ========== BIOMEXA IVF CARE — API, REMINDERS & WHATSAPP ==========
// A self-contained module: its own collections (see ./models), its own routes under /api/ivf,
// its own once-a-minute scheduler, and one small hook into the shared MSG91 webhook. It reuses
// only the platform's accounts (patient + verified doctor logins) and its WhatsApp senders, which
// server.js passes in through mount(app, deps) — nothing in the existing features is changed.
//
// Patient side  : enrol with an IVF centre, daily symptom/vitals check-in, IVF medicine + trigger
//                 shot reminders, report uploads, virtual follow-up requests, secure messages.
// Doctor side   : IVF centre profile, accept patients, manage stage/dates/medicines, analyse
//                 uploaded reports, schedule video/audio follow-ups, red-flag alert queue.
const crypto = require('crypto');
const mongoose = require('mongoose');
const cron = require('node-cron');
const {
  IVF_STAGES, STAGE_KEYS, PROTOCOLS, REPORT_CATEGORIES,
  IvfCenter, IvfCycle, IvfMedication, IvfDose, IvfDailyLog, IvfReport, IvfConsult, IvfMessage, IvfAlert, IvfPregnancy
} = require('./models');
const { evaluateDailyLog, SEVERITY_RANK, maxSeverity } = require('./redflags');
const { buildProgress } = require('./progress');
const { evaluatePregnancy, gaLabel: pregGaLabel, gaOn: pregGaOn } = require('./pregnancy');

const STAGE_LABEL = Object.fromEntries(IVF_STAGES.map(s => [s.key, s.label]));
const CONSENT_TEXT = 'I agree that Biomexa and my chosen IVF centre may store and use my treatment, symptom, vitals and report information to monitor my IVF treatment and contact me on WhatsApp. I understand this monitoring supports, but does not replace, in-person care and emergency services.';

let D = null; // dependencies injected by server.js

// ---------- small helpers ----------
const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error('❌ IVF route error:', err.message);
  res.status(500).json({ message: err.message });
});
const isId = id => mongoose.isValidObjectId(id);
function num(v, min, max) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}
function str(v, max = 1000) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : undefined;
}
function oneOf(v, list, fallback) { return list.includes(v) ? v : fallback; }
function date(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d) ? undefined : d;
}
const fire = p => { Promise.resolve(p).catch(err => console.log('⚠️ IVF notify failed:', err.message)); };
const fmtWhen = d => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// Video/audio follow-ups run on Google Meet. The doctor creates the meeting in their own Google
// account (so they are the host and can admit the patient) and pastes the link here.
// Returns the normalised link, '' for empty input, or null if it is not a Google Meet link.
function normaliseMeetLink(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  const m = t.match(/^(?:https?:\/\/)?meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[a-z0-9_-]{3,60})(?:[?#].*)?$/i);
  return m ? `https://meet.google.com/${m[1].toLowerCase()}` : null;
}
const isMeet = l => /^https:\/\/meet\.google\.com\//.test(l || '');
const ivfUrl = page => `${D.SITE_URL}/${page}`;

async function patientCycle(phone) {
  const phones = D.phoneVariants(phone);
  return (await IvfCycle.findOne({ patientPhone: { $in: phones }, status: { $in: ['active', 'pending'] } }).sort({ createdAt: -1 }))
    || IvfCycle.findOne({ patientPhone: { $in: phones } }).sort({ createdAt: -1 });
}
async function doctorCycle(req) {
  if (!isId(req.params.id)) return null;
  return IvfCycle.findOne({ _id: req.params.id, doctorId: String(req.doctor.id) });
}
async function doctorOf(cycle) {
  return cycle && cycle.doctorId && isId(cycle.doctorId) ? D.Doctor.findById(cycle.doctorId).select('name phone') : null;
}

// ---------- dose generation ----------
function datesFrom(todayStr, days) {
  const out = [];
  const d = new Date(`${todayStr}T00:00:00`);
  for (let i = 0; i < days; i++) { out.push(D.localDateStr(d)); d.setDate(d.getDate() + 1); }
  return out;
}
// Creates today's + tomorrow's doses for one medicine (idempotent — unique index on
// medicationId+scheduledAt means re-running never duplicates).
async function generateDosesFor(med) {
  if (!med.active) return;
  const base = { cycleId: med.cycleId, medicationId: String(med._id), patientPhone: med.patientPhone, medicineName: med.name, dosage: med.dosage };
  if (med.isTrigger) {
    if (!med.triggerAt) return;
    await IvfDose.updateOne(
      { medicationId: String(med._id), isTrigger: true },
      { $set: { scheduledAt: med.triggerAt, scheduledDate: D.localDateStr(med.triggerAt), medicineName: med.name, dosage: med.dosage }, $setOnInsert: { cycleId: med.cycleId, medicationId: String(med._id), patientPhone: med.patientPhone, isTrigger: true, status: 'pending', remindersSent: [] } },
      { upsert: true }
    );
    return;
  }
  for (const day of datesFrom(D.localDateStr(new Date()), 2)) {
    if (med.startDate && day < med.startDate) continue;
    if (med.endDate && day > med.endDate) continue;
    for (const t of med.times || []) {
      if (!/^\d{2}:\d{2}$/.test(t)) continue;
      const at = new Date(`${day}T${t}:00`);
      await IvfDose.updateOne(
        { medicationId: String(med._id), scheduledAt: at },
        { $setOnInsert: { ...base, scheduledAt: at, scheduledDate: day, isTrigger: false, status: 'pending', remindersSent: [] } },
        { upsert: true }
      );
    }
  }
}
async function generateAllDoses() {
  const activeCycles = await IvfCycle.find({ status: 'active' }).select('_id');
  const meds = await IvfMedication.find({ active: true, cycleId: { $in: activeCycles.map(c => String(c._id)) } });
  for (const med of meds) await generateDosesFor(med);
}

// ---------- alerts ----------
async function raiseAlert(cycle, severity, reasons, source, logId) {
  const alert = await IvfAlert.create({
    cycleId: String(cycle._id), patientPhone: cycle.patientPhone, patientName: cycle.patientName,
    doctorId: cycle.doctorId, severity, reasons, source, logId
  });
  if ((SEVERITY_RANK[severity] || 0) > (SEVERITY_RANK[cycle.riskLevel] || 0) || cycle.riskLevel === 'normal') {
    await IvfCycle.updateOne({ _id: cycle._id }, { riskLevel: severity, updatedAt: new Date() });
  }
  if (severity === 'watch') return alert; // shown on the dashboard, no WhatsApp ping
  const doctor = await doctorOf(cycle);
  const reasonText = `IVF (${STAGE_LABEL[cycle.stage] || cycle.stage}): ${reasons.join('; ')}`;
  if (doctor) fire(D.sendDoctorAlertMessage(doctor.phone, cycle.patientName || 'IVF patient', cycle.patientPhone, severity, reasonText));
  fire(sendPatientAlert(cycle, severity, reasons));
  return alert;
}
async function sendPatientAlert(cycle, severity, reasons) {
  const name = cycle.patientName || 'there';
  const level = severity === 'critical' ? 'Critical' : 'High';
  const t = await D.sendRiskAlertTemplate(cycle.patientPhone, name, level, reasons.join('; ')).catch(() => ({ success: false }));
  if (t && t.success) return t;
  const msg = `🚨 *Biomexa IVF Care*\n\nHi ${name}, your check-in shows warning signs:\n• ${reasons.join('\n• ')}\n\nYour IVF centre (${cycle.centerName || 'your doctor'}) has been alerted. ${severity === 'critical' ? '*Please call your IVF centre now. If you have severe pain, trouble breathing or heavy bleeding, go to the nearest emergency department.*' : 'Please call your IVF centre today to discuss this.'}\n\n- Biomexa IVF Care`;
  return D.sendWhatsAppFree(cycle.patientPhone, msg);
}

// ---------- WhatsApp sends for IVF doses ----------
async function sendIvfDoseReminder(dose, kind) {
  const label = dose.isTrigger ? `TRIGGER SHOT: ${dose.medicineName}` : `IVF: ${dose.medicineName}`;
  const when = fmtWhen(dose.scheduledAt);
  if (kind === 't0') {
    // The approved dose template carries the Taken / Remind later buttons; our webhook hook below
    // routes the reply back to this IVF dose via the shared conversation-state record.
    const t = await D.sendDoseReminderTemplate(dose.patientPhone, label, dose.dosage || '').catch(() => ({ success: false }));
    await D.ConversationState.findOneAndUpdate(
      { patientPhone: dose.patientPhone },
      { state: 'ivf_awaiting_dose', doseId: String(dose._id), updatedAt: new Date() },
      { upsert: true }
    );
    if (t && t.success) return t;
    return D.sendWhatsAppFree(dose.patientPhone, `💉 *${label}*\n${dose.dosage || ''}\n⏰ Due now (${when})\n\nReply *TAKEN* once done, or *LATER* to be reminded in 20 minutes.\n\n- Biomexa IVF Care`);
  }
  const lead = kind === 't-120' ? 'in 2 hours' : 'in 30 minutes';
  return D.sendWhatsAppFree(dose.patientPhone, `⏰ *Trigger shot ${lead}*\n\n${dose.medicineName} ${dose.dosage || ''}\nExact time: *${when}*\n\nThe timing of this injection matters for egg retrieval — please keep it ready. We'll remind you again at the exact time.\n\n- Biomexa IVF Care`);
}

// Called from the shared MSG91 webhook when the conversation state belongs to IVF.
async function activeCycleFor(phone) {
  return IvfCycle.findOne({ patientPhone: { $in: D.phoneVariants(phone) }, status: 'active' }).sort({ createdAt: -1 });
}
async function handleWhatsAppReply({ phone, convo, buttonText, freeText }) {
  const text = String(buttonText || freeText || '').trim();
  // "Hi Biomexa IVF Care" from the app's WhatsApp button — confirms updates are switched on.
  if (/biomexa\s*ivf/i.test(text) && text.length < 60) {
    const cycle = await activeCycleFor(phone);
    await D.sendWhatsAppFree(phone, cycle
      ? `✅ Hi ${cycle.patientName || ''}! WhatsApp updates for your IVF treatment are on.\n\nYou'll get medicine reminders, check-in prompts and your report updates here.\n\nReply *CHECKIN* any time to log how you feel, or *PROGRESS* for your summary.\n\n- Biomexa IVF Care`
      : `👋 Hi from Biomexa IVF Care! Join an IVF centre in the app to start getting reminders here: ${ivfUrl('ivf.html')}`);
    return true;
  }
  // Keywords work at any time for patients in an active IVF cycle.
  if (/^(check\s*-?\s*in|checkin|log|daily check\s*-?\s*in)$/i.test(text) || /^(progress|summary|my progress)$/i.test(text)) {
    const cycle = await activeCycleFor(phone);
    if (!cycle) return false;
    if (/progress|summary/i.test(text)) await sendPatientProgress(cycle);
    else await sendCheckinPrompt(cycle);
    return true;
  }
  if (convo && convo.state === 'ivf_awaiting_checkin') {
    const clear = () => D.ConversationState.findOneAndUpdate({ patientPhone: convo.patientPhone }, { state: null, doseId: null, updatedAt: new Date() });
    const cycle = await activeCycleFor(phone);
    if (!cycle) { await clear(); return false; }
    if (/^skip$/i.test(text)) { await clear(); await D.sendWhatsAppFree(phone, 'No problem. Reply *CHECKIN* when you are ready.'); return true; }
    const { vitals, symptoms } = parseCheckinText(freeText || buttonText);
    if (!hasCheckinData(vitals, symptoms)) {
      await D.sendWhatsAppFree(phone, "Sorry, I couldn't read that. Please reply like *61.5 kg, pain 3, bloating mild*, or *FINE* if you have no symptoms. Reply *SKIP* to do it later.");
      return true;
    }
    const r = await saveCheckin(cycle, vitals, symptoms, `WhatsApp: ${String(freeText || '').slice(0, 300)}`, 'whatsapp');
    await clear();
    const change = Number.isFinite(vitals.weightKg) && Number.isFinite(r.prevWeight) ? ` (${vitals.weightKg - r.prevWeight >= 0 ? '+' : ''}${(vitals.weightKg - r.prevWeight).toFixed(1)} kg since last check-in)` : '';
    // A warning-sign check-in already sent its own alert message through raiseAlert().
    if (!r.severity || r.severity === 'watch') {
      await D.sendWhatsAppFree(phone, `✅ Check-in saved: ${checkinSummaryLine(vitals, symptoms)}${change}.\n\n${CHECKIN_ADVICE[r.severity || 'none']}\n\nSee your graphs: ${ivfUrl('ivf.html')}`);
    }
    return true;
  }
  if (!convo || convo.state !== 'ivf_awaiting_dose') return false;
  const reply = (buttonText || freeText || '').toLowerCase();
  const dose = isId(convo.doseId) ? await IvfDose.findById(convo.doseId) : null;
  const clear = () => D.ConversationState.findOneAndUpdate({ patientPhone: convo.patientPhone }, { state: null, doseId: null, updatedAt: new Date() });
  if (!dose) { await clear(); return true; }

  if (/remind.*later|later|snooze/.test(reply)) {
    const nextAt = new Date(Date.now() + 20 * 60 * 1000);
    await IvfDose.updateOne({ _id: dose._id }, { scheduledAt: dose.isTrigger ? dose.scheduledAt : nextAt, $pull: { remindersSent: 't0' } });
    await D.sendWhatsAppFree(phone, dose.isTrigger
      ? '⚠️ The trigger shot is time-critical — please take it as close to the planned time as possible. We\'ll remind you again shortly.'
      : '⏰ No problem — we\'ll remind you again in about 20 minutes.');
    await clear();
    return true;
  }
  const took = /taken|done|yes|confirm/.test(reply) && !/not\s*taken|\bno\b/.test(reply);
  const missed = /not\s*taken|missed|\bno\b/.test(reply);
  if (took || missed) {
    await IvfDose.updateOne({ _id: dose._id }, took ? { status: 'taken', takenAt: new Date() } : { status: 'missed' });
    if (took) {
      await D.sendWhatsAppFree(phone, `✅ Logged: ${dose.medicineName} taken.\n\n📋 Don't forget today's IVF check-in (weight, pain, symptoms): ${ivfUrl('ivf.html')}`);
    } else {
      await D.sendWhatsAppFree(phone, `Noted — marked as not taken. ${dose.isTrigger ? '*Please call your IVF centre right away — the trigger shot timing is critical.*' : 'Please contact your IVF centre about what to do for this missed dose.'}`);
      if (dose.isTrigger) {
        const cycle = isId(dose.cycleId) ? await IvfCycle.findById(dose.cycleId) : null;
        if (cycle) await raiseAlert(cycle, 'critical', [`Trigger shot (${dose.medicineName}) reported NOT taken`], 'trigger_missed');
      }
    }
    await clear();
    return true;
  }
  await D.sendWhatsAppFree(phone, 'Please reply *TAKEN*, *NOT TAKEN* or *LATER* for your IVF medicine.');
  return true;
}

// ---------- daily check-in (shared by the web form and WhatsApp replies) ----------
function hasCheckinData(vitals, symptoms) {
  return Object.values(vitals).some(v => v !== undefined) || Object.values(symptoms).some(v => v !== undefined && v !== false);
}
async function saveCheckin(cycle, vitals, symptoms, notes, source = 'web') {
  const recent = await IvfDailyLog.find({ cycleId: String(cycle._id) }).sort({ createdAt: -1 }).limit(10);
  const draft = { vitals, symptoms, stage: cycle.stage, createdAt: new Date() };
  const { flags, severity } = evaluateDailyLog(draft, recent, cycle);
  const log = await IvfDailyLog.create({
    cycleId: String(cycle._id), patientPhone: cycle.patientPhone, stage: cycle.stage,
    logDate: D.localDateStr(new Date()), vitals, symptoms, notes, flags, source
  });
  const update = { lastCheckInAt: new Date(), updatedAt: new Date() };
  if (!severity && cycle.riskLevel !== 'normal') {
    // Clear an old risk level only once the centre has acknowledged every alert.
    const open = await IvfAlert.exists({ cycleId: String(cycle._id), acknowledged: false });
    if (!open) update.riskLevel = 'normal';
  }
  await IvfCycle.updateOne({ _id: cycle._id }, update);
  let alert = null;
  if (severity && cycle.status === 'active') alert = await raiseAlert(cycle, severity, flags.map(f => f.message), 'daily_log', String(log._id));
  else if (severity) alert = await IvfAlert.create({ cycleId: String(cycle._id), patientPhone: cycle.patientPhone, patientName: cycle.patientName, doctorId: cycle.doctorId, severity, reasons: flags.map(f => f.message), source: 'daily_log', logId: String(log._id) });
  const prev = recent.find(r => r.vitals && Number.isFinite(r.vitals.weightKg));
  return { log, flags, severity, alert, prevWeight: prev ? prev.vitals.weightKg : null };
}
const CHECKIN_ADVICE = {
  critical: 'Some of your answers need urgent attention. Please call your IVF centre now. If you have severe pain, trouble breathing or heavy bleeding, go to the nearest emergency department.',
  high: 'Your IVF centre has been alerted. Please call them today to discuss these symptoms.',
  watch: 'Saved. Your IVF centre will see a note about this on their dashboard.',
  none: 'Saved — thank you. Everything you reported is within the usual range.'
};

// Reads a free-text WhatsApp check-in such as
//   "61.5 kg, pain 3, bloating mild, temp 98.6"  or  "W 61.5 P3 BP 118/76"  or  "fine"
// Returns { vitals, symptoms } with only the fields the patient actually mentioned.
function parseCheckinText(raw) {
  // Hinglish words patients commonly type are mapped to English first (vajan 62, dard 4, bukhar 100, ulti...).
  const HI = [[/\b(?:vajan|wajan|vazan|wazan)\b/g, 'weight'], [/\bsir\s*(?:me\s*)?dard\b/g, 'headache'], [/\b(?:dard|dared)\b/g, 'pain'], [/\b(?:bukhar|bukhaar)\b/g, 'temp'],
    [/\b(?:ulti|ultee|vomting)\b/g, 'vomit'], [/\b(?:ji machal\w*|matli|ghabrahat)\b/g, 'nausea'], [/\bpet\s*(?:phool\w*|fool\w*)|\bpet me gas\b|\bgas\b/g, 'bloating'],
    [/\b(?:saans|sans)\s*(?:phool\w*|fool\w*|lene me (?:dikkat|taklif)|ki (?:dikkat|taklif))/g, 'breathless'], [/\b(?:peshab|pesab|urine)\s*(?:kam|kum)\b/g, 'less urine'],
    [/\bkhoon\b/g, 'bleeding'], [/\bthoda\b/g, 'mild'], [/\bbahut\b|\bjyada\b|\bzyada\b/g, 'severe'], [/\b(?:kamar|pet)\s*(?:ka|ki|ko|me)?\s*naap\b/g, 'waist'], [/\bnahi\b|\bnahin\b/g, 'no']];
  let src = String(raw || '').toLowerCase(); for (const [re, en] of HI) src = src.replace(re, en);
  const t = ' ' + src.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const n = (re, min, max) => { const m = t.match(re); if (!m) return undefined; const v = parseFloat(m[1]); return v >= min && v <= max ? v : undefined; };
  const vitals = {}, symptoms = {};
  vitals.weightKg = n(/\b(?:w|wt|weight)\s*[:=-]?\s*(\d{2,3}(?:\.\d+)?)/, 30, 200) ?? n(/(\d{2,3}(?:\.\d+)?)\s*kgs?\b/, 30, 200);
  let temp = n(/\b(?:t|temp|temperature|fever)\s*[:=-]?\s*(\d{2,3}(?:\.\d+)?)/, 30, 110) ?? n(/(\d{2,3}(?:\.\d+)?)\s*°?\s*(?:f|c)\b/, 30, 110);
  if (temp !== undefined && temp < 45) temp = +(temp * 9 / 5 + 32).toFixed(1);
  if (temp !== undefined && temp >= 90) vitals.temperatureF = temp;
  const bp = t.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (bp && +bp[1] >= 60 && +bp[1] <= 260 && +bp[2] >= 30 && +bp[2] <= 160) { vitals.bpSystolic = +bp[1]; vitals.bpDiastolic = +bp[2]; }
  vitals.heartRate = n(/\b(?:pulse|hr|heart rate)\s*[:=-]?\s*(\d{2,3})/, 30, 220);
  vitals.abdominalGirthCm = n(/\b(?:girth|waist|tummy|abdomen)\s*[:=-]?\s*(\d{2,3}(?:\.\d+)?)/, 40, 200);
  symptoms.painScore = n(/\b(?:pain|p)\s*[:=-]?\s*(\d{1,2})(?:\s*\/\s*10)?\b/, 0, 10);
  const bl = t.match(/\b(no|none|mild|moderate|severe|bad|heavy)\s+bloat/) || t.match(/\bbloat\w*\s*[:=-]?\s*(no|none|mild|moderate|severe|bad|heavy)\b/);
  if (bl) symptoms.bloating = { no: 'none', none: 'none', mild: 'mild', moderate: 'moderate', severe: 'severe', bad: 'severe', heavy: 'severe' }[bl[1]];
  else if (/\bbloat/.test(t)) symptoms.bloating = 'mild';
  if (/vomit/.test(t)) symptoms.nausea = 'vomiting'; else if (/\bnause|\bnausea/.test(t) && !/\bno nausea/.test(t)) symptoms.nausea = 'mild';
  if (/heavy (?:bleed|blood)|bleeding heavy/.test(t)) symptoms.bleeding = 'heavy';
  else if (/spotting/.test(t) && !/no spotting/.test(t)) symptoms.bleeding = 'spotting';
  else if (/(?:light )?bleed/.test(t) && !/no bleed/.test(t)) symptoms.bleeding = 'light';
  if (/breath/.test(t) && !/\bno (?:short(?:ness)? of )?breath/.test(t)) symptoms.breathlessness = true;
  if (/(?:less|low|reduced|little|no) urine|not passing urine|urine (?:less|low|reduced)/.test(t)) symptoms.reducedUrine = true;
  if (/headache/.test(t) && !/no headache/.test(t)) symptoms.headache = true;
  if (/(?:injection|inj|shot)\s*(?:site|place|area|jagah)?\s*(?:is\s*)?(?:red|redness|swell|swollen|swelling|rash|lump|itch)|(?:red|redness|swelling|swollen|rash|lump)\s*(?:at|on|near)?\s*(?:the\s*)?(?:injection|inj)/.test(t)) symptoms.injectionSiteReaction = true;
  const mood = t.match(/\bmood\s*[:=-]?\s*(very low|good|okay|ok|low)\b/) || t.match(/\bfeeling\s+(very low|good|okay|ok|low)\b/);
  if (mood) symptoms.mood = { 'very low': 'very_low', good: 'good', okay: 'okay', ok: 'okay', low: 'low' }[mood[1]];
  // "fine" / "all good" / "no symptoms" on its own = nothing to report today
  if (/^\s*(fine|all good|all ok|ok|okay|good|normal|no symptoms|no problem|nothing)\s*[.!]?\s*$/.test(String(raw || '').toLowerCase())) {
    Object.assign(symptoms, { painScore: 0, bloating: 'none', bleeding: 'none', nausea: 'none', mood: symptoms.mood || 'good' });
  }
  for (const o of [vitals, symptoms]) for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return { vitals, symptoms };
}
function checkinSummaryLine(vitals, symptoms) {
  return [
    vitals.weightKg && `Weight ${vitals.weightKg} kg`, vitals.temperatureF && `Temp ${vitals.temperatureF}°F`,
    vitals.bpSystolic && `BP ${vitals.bpSystolic}/${vitals.bpDiastolic}`, vitals.heartRate && `Pulse ${vitals.heartRate}`,
    vitals.abdominalGirthCm && `Girth ${vitals.abdominalGirthCm} cm`, Number.isFinite(symptoms.painScore) && `Pain ${symptoms.painScore}/10`,
    symptoms.bloating && `Bloating ${symptoms.bloating}`, symptoms.nausea && symptoms.nausea !== 'none' && `Nausea: ${symptoms.nausea}`,
    symptoms.bleeding && symptoms.bleeding !== 'none' && `Bleeding: ${symptoms.bleeding}`, symptoms.breathlessness && 'Breathless',
    symptoms.reducedUrine && 'Less urine', symptoms.headache && 'Headache', symptoms.injectionSiteReaction && 'Injection-site reaction', symptoms.mood && `Mood ${symptoms.mood.replace('_', ' ')}`
  ].filter(Boolean).join(', ');
}
const CHECKIN_PROMPT = `📋 *IVF daily check-in*\n\nReply in one message with whatever you have, for example:\n\n*61.5 kg, pain 3, bloating mild, temp 98.6*\n\nYou can also add BP 118/76, pulse 80, waist 82 cm, nausea, vomiting, bleeding, breathless, less urine, headache, injection-site swelling, mood good/low.\nHindi bhi chalega: *vajan 61.5, dard 3, pet phoola*\nNo symptoms today? Reply *FINE*. Reply *SKIP* to do it later.`;
async function sendCheckinPrompt(cycle) {
  await D.ConversationState.findOneAndUpdate({ patientPhone: cycle.patientPhone }, { state: 'ivf_awaiting_checkin', doseId: null, updatedAt: new Date() }, { upsert: true });
  return D.sendWhatsAppFree(cycle.patientPhone, CHECKIN_PROMPT);
}

// ---------- WhatsApp progress messages ----------
function progressMessage(cycle, pr) {
  const s = pr.summary, lines = [];
  lines.push(`📈 *Your IVF progress* · Day ${pr.dayNo} · ${pr.stage.label}`);
  if (s.latestWeight !== null) lines.push(`⚖️ Weight ${s.latestWeight} kg${s.weightChange !== null ? ` (${s.weightChange > 0 ? '+' : ''}${s.weightChange} kg since start)` : ''}`);
  if (s.adherencePct !== null) lines.push(`💉 Medicines taken: ${s.adherencePct}%`);
  lines.push(`📋 Check-ins: ${s.checkinDays7} of the last ${s.expected7} days`);
  const notable = pr.insights.filter(i => i.tone === 'bad' || i.tone === 'watch').slice(0, 2);
  for (const i of notable) lines.push(`⚠️ ${i.text}`);
  const labs = pr.insights.filter(i => /latest report/.test(i.text)).slice(0, 2);
  for (const i of labs) lines.push(`🔬 ${i.text.replace(' (latest report).', '')}`);
  lines.push('', `See your graphs: ${ivfUrl('ivf.html')}`, 'Reply *CHECKIN* any time to log today, or *PROGRESS* for this summary.', '- Biomexa IVF Care');
  return lines.join('\n');
}
async function sendPatientProgress(cycle) {
  const pr = await buildProgress(cycle);
  return D.sendWhatsAppFree(cycle.patientPhone, progressMessage(cycle, pr));
}
async function sendDoctorDigest(center, today) {
  const doctor = isId(center.doctorId) ? await D.Doctor.findById(center.doctorId).select('name phone') : null;
  if (!doctor) return;
  const cycles = await IvfCycle.find({ doctorId: center.doctorId, status: 'active' }).limit(300);
  if (!cycles.length) return;
  const yesterday = D.localDateStr(new Date(Date.now() - 864e5));
  const ids = cycles.map(c => String(c._id));
  const [checked, alerts, reports, consults, pending] = await Promise.all([
    IvfDailyLog.distinct('cycleId', { cycleId: { $in: ids }, logDate: { $in: [yesterday, today] } }),
    IvfAlert.find({ doctorId: center.doctorId, acknowledged: false }).select('patientName severity'),
    IvfReport.countDocuments({ doctorId: center.doctorId, reviewStatus: 'awaiting_review' }),
    IvfConsult.countDocuments({ doctorId: center.doctorId, status: 'scheduled', scheduledAt: { $gte: new Date(`${today}T00:00:00`), $lt: new Date(`${today}T23:59:59`) } }),
    IvfCycle.countDocuments({ doctorId: center.doctorId, status: 'pending' })
  ]);
  const trends = [];
  for (const c of cycles) {
    if (trends.length >= 5) break;
    const pr = await buildProgress(c);
    const worst = pr.insights.find(i => i.tone === 'bad') || pr.insights.find(i => i.tone === 'watch' && !/checked in/.test(i.text));
    if (worst) trends.push(`• ${c.patientName || c.patientPhone}: ${worst.text}`);
  }
  const missing = cycles.filter(c => !checked.includes(String(c._id))).map(c => c.patientName || c.patientPhone);
  const lines = [`🩺 *IVF daily digest* · ${center.centerName}`, `Active patients: ${cycles.length} · Checked in (since yesterday): ${checked.length}`];
  if (alerts.length) lines.push(`🚨 Open alerts: ${alerts.length} (${[...new Set(alerts.map(a => a.patientName).filter(Boolean))].slice(0, 3).join(', ')})`);
  if (trends.length) lines.push('', '⚠️ *Trends to watch*', ...trends);
  if (missing.length) lines.push('', `📋 No check-in: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` +${missing.length - 5} more` : ''}`);
  // Early pregnancy follow-ups (doctor-only wording)
  const pregs = await IvfPregnancy.find({ cycleId: { $in: ids } }).lean();
  const pregLines = [];
  for (const p of pregs) {
    const ev = evaluatePregnancy(p), name = (cycles.find(c => String(c._id) === p.cycleId) || {}).patientName || p.patientPhone;
    if (ev.repeatScanDue && today >= ev.repeatScanDue.from) pregLines.push(`• ${name}: repeat scan due (${ev.status.label.toLowerCase()} on ${ev.latestSummary.date})`);
    else if (['diagnostic', 'urgent', 'watch'].includes(ev.status.level)) pregLines.push(`• ${name}: ${ev.status.label}`);
    if (p.nextHcgDate === today) pregLines.push(`• ${name}: hCG test today`);
    if (p.nextScanDate === today) pregLines.push(`• ${name}: scan today`);
  }
  if (pregLines.length) lines.push('', '🤰 *Early pregnancy*', ...pregLines.slice(0, 6));
  const todo = [reports && `${reports} report(s) to review`, consults && `${consults} follow-up(s) today`, pending && `${pending} new request(s)`].filter(Boolean);
  if (todo.length) lines.push(`📄 ${todo.join(' · ')}`);
  lines.push('', `Open dashboard: ${ivfUrl('ivf-doctor.html')}`);
  return D.sendWhatsAppFree(doctor.phone, lines.join('\n'));
}

// ---------- scheduler ----------
let lastIvfGenerationDate = null;
async function ivfTick() {
  const now = new Date();
  const today = D.localDateStr(now);
  if (lastIvfGenerationDate !== today) {
    lastIvfGenerationDate = today;
    await generateAllDoses();
  }

  // Daily medicine reminders (catch up anything due in the last 3 hours).
  const due = await IvfDose.find({ isTrigger: false, status: 'pending', scheduledAt: { $lte: now, $gte: new Date(now - 3 * 36e5) }, remindersSent: { $ne: 't0' } }).limit(200);
  for (const dose of due) {
    const claimed = await IvfDose.findOneAndUpdate({ _id: dose._id, remindersSent: { $ne: 't0' } }, { $push: { remindersSent: 't0' } });
    if (claimed) fire(sendIvfDoseReminder(dose, 't0'));
  }

  // Trigger shot: 2h before, 30 min before, on time, and escalate 30 min after if not confirmed.
  const triggers = await IvfDose.find({ isTrigger: true, status: 'pending', scheduledAt: { $gte: new Date(now - 6 * 36e5), $lte: new Date(+now + 2 * 36e5 + 60e3) } });
  for (const dose of triggers) {
    const mins = (dose.scheduledAt - now) / 60000;
    const step = mins <= -30 ? 'escalated' : mins <= 0 ? 't0' : mins <= 30 ? 't-30' : mins <= 120 ? 't-120' : null;
    if (!step || dose.remindersSent.includes(step)) continue;
    const claimed = await IvfDose.findOneAndUpdate({ _id: dose._id, remindersSent: { $ne: step } }, { $push: { remindersSent: step } });
    if (!claimed) continue;
    if (step === 'escalated') {
      const cycle = isId(dose.cycleId) ? await IvfCycle.findById(dose.cycleId) : null;
      if (cycle) fire(raiseAlert(cycle, 'critical', [`Trigger shot (${dose.medicineName}) due ${fmtWhen(dose.scheduledAt)} not confirmed after 30 min`], 'trigger_unconfirmed'));
    } else {
      fire(sendIvfDoseReminder(dose, step));
    }
  }

  // Mark long-overdue daily doses as missed so adherence stays honest.
  await IvfDose.updateMany({ isTrigger: false, status: 'pending', scheduledAt: { $lt: new Date(now - 12 * 36e5) } }, { status: 'missed' });

  // Virtual follow-up reminders, 15 minutes before.
  const soon = await IvfConsult.find({ status: 'scheduled', scheduledAt: { $gte: now, $lte: new Date(+now + 15 * 60e3) }, remindersSent: { $ne: 't-15' } });
  for (const c of soon) {
    const claimed = await IvfConsult.findOneAndUpdate({ _id: c._id, remindersSent: { $ne: 't-15' } }, { $push: { remindersSent: 't-15' } });
    if (!claimed) continue;
    const join = c.mode === 'chat' ? `Open your IVF messages: ${ivfUrl('ivf.html')}` : `${isMeet(c.meetingLink) ? 'Join on Google Meet' : 'Join here'}: ${c.meetingLink}`;
    fire(D.sendWhatsAppFree(c.patientPhone, `📅 *IVF follow-up in 15 minutes* (${c.mode})\n${fmtWhen(c.scheduledAt)}\n\n${join}\n\n- Biomexa IVF Care`));
    const cycle = isId(c.cycleId) ? await IvfCycle.findById(c.cycleId) : null;
    const doctor = await doctorOf(cycle);
    if (doctor) fire(D.sendWhatsAppFree(doctor.phone, `📅 IVF follow-up in 15 min with ${cycle.patientName || cycle.patientPhone} (${c.mode}). ${c.mode === 'chat' ? ivfUrl('ivf-doctor.html') : `Start on Google Meet and admit the patient: ${c.meetingLink}`}`));
  }

  // Evening nudge (7–9 PM) for anyone in an active cycle who hasn't checked in today.
  const hour = now.getHours();
  if (hour >= 19 && hour < 21) {
    const cycles = await IvfCycle.find({ status: 'active', lastNudgeDate: { $ne: today } }).limit(500);
    for (const cycle of cycles) {
      const logged = await IvfDailyLog.exists({ cycleId: String(cycle._id), logDate: today });
      const claimed = await IvfCycle.findOneAndUpdate({ _id: cycle._id, lastNudgeDate: { $ne: today } }, { lastNudgeDate: today });
      if (!claimed || logged) continue;
      fire((async () => {
        await D.ConversationState.findOneAndUpdate({ patientPhone: cycle.patientPhone }, { state: 'ivf_awaiting_checkin', doseId: null, updatedAt: new Date() }, { upsert: true });
        return D.sendWhatsAppFree(cycle.patientPhone, `🌙 Hi ${cycle.patientName || ''}, time for today's IVF check-in.\n\nJust reply here, for example:\n*61.5 kg, pain 3, bloating mild*\n(or *FINE* if you have no symptoms)\n\nOr use the app: ${ivfUrl('ivf.html')}\n\n- Biomexa IVF Care`);
      })());
    }
  }

  // Early pregnancy: remind the patient on the morning of a planned hCG test or scan (7–10 AM).
  if (hour >= 7 && hour < 10) {
    const pregs = await IvfPregnancy.find({ $or: [{ nextHcgDate: today }, { nextScanDate: today }] }).limit(300);
    for (const p of pregs) {
      for (const [kind, label] of [['hcg', 'beta-hCG blood test'], ['scan', 'pregnancy scan']]) {
        const due = kind === 'hcg' ? p.nextHcgDate : p.nextScanDate, key = `${kind}:${today}`;
        if (due !== today || (p.remindersSent || []).includes(key)) continue;
        const claimed = await IvfPregnancy.findOneAndUpdate({ _id: p._id, remindersSent: { $ne: key } }, { $push: { remindersSent: key } });
        if (claimed) fire(D.sendWhatsAppFree(p.patientPhone, `🗓️ *Reminder:* your ${label} is planned for today.\n\nPlease follow your IVF centre's instructions for the time and place. Your doctor will update you once the result is reviewed.\n\n- Biomexa IVF Care`));
      }
    }
  }

  // Weekly progress summary for each patient (10 AM–12 PM, once every 7 days).
  if (hour >= 10 && hour < 12) {
    const weekAgo = new Date(now - 7 * 864e5);
    const due = await IvfCycle.find({ status: 'active', createdAt: { $lte: weekAgo }, $or: [{ lastProgressSummaryAt: { $exists: false } }, { lastProgressSummaryAt: null }, { lastProgressSummaryAt: { $lte: weekAgo } }] }).limit(200);
    for (const cycle of due) {
      const claimed = await IvfCycle.findOneAndUpdate({ _id: cycle._id, $or: [{ lastProgressSummaryAt: { $exists: false } }, { lastProgressSummaryAt: null }, { lastProgressSummaryAt: { $lte: weekAgo } }] }, { lastProgressSummaryAt: now });
      if (claimed) fire(sendPatientProgress(cycle));
    }
  }

  // Daily digest for each IVF centre doctor (8–10 AM): alerts, worrying trends, missing check-ins.
  if (hour >= 8 && hour < 10) {
    const centers = await IvfCenter.find({ lastDigestDate: { $ne: today } }).limit(200);
    for (const c of centers) {
      const claimed = await IvfCenter.findOneAndUpdate({ _id: c._id, lastDigestDate: { $ne: today } }, { lastDigestDate: today });
      if (claimed) fire(sendDoctorDigest(c, today));
    }
  }
}

// ---------- serialisers ----------
function stageInfo(stage) {
  const idx = STAGE_KEYS.indexOf(stage);
  return { key: stage, label: STAGE_LABEL[stage] || stage, index: idx, total: STAGE_KEYS.length };
}
const reportListFields = '-files.fileData';

// =====================================================================================
// ---------- report results ----------
// Graph-linked values and their sane limits (anything outside is ignored for graphs).
const VALUE_LIMITS = { amh: [0, 50], fsh: [0, 200], lh: [0, 200], estradiol: [0, 20000], progesterone: [0, 500], betaHcg: [0, 500000], follicleCountLeft: [0, 60], follicleCountRight: [0, 60], leadFollicleMm: [0, 40], endometriumMm: [0, 30] };
const RESULT_KEYS = [
  ['fsh', /\bfsh\b|follicle[\s-]*stimulating/i],
  ['amh', /anti[\s-]*m[uü]ll|\bamh\b/i],
  ['lh', /\blh\b|luteini[sz]ing/i],
  ['estradiol', /estradiol|oestradiol|\be2\b/i],
  ['progesterone', /progesterone|\bp4\b/i],
  ['betaHcg', /\bhcg\b|chorionic/i],
  ['endometriumMm', /endometri/i],
  ['leadFollicleMm', /(lead|leading|dominant|largest)\s+follicle/i],
  ['follicleCountLeft', /\bleft\b.*\b(follicles?|afc)\b|\b(follicles?|afc)\b.*\bleft\b/i],
  ['follicleCountRight', /\bright\b.*\b(follicles?|afc)\b|\b(follicles?|afc)\b.*\bright\b/i]
];
const keyForTest = name => (RESULT_KEYS.find(([, re]) => re.test(name || '')) || [''])[0];
// Starting rows when the AI could not read the report (or for a blank report of that type).
const REPORT_TEMPLATES = {
  hormone_blood_test: [['AMH', 'ng/mL'], ['FSH', 'IU/L'], ['LH', 'IU/L'], ['Estradiol (E2)', 'pg/mL'], ['Progesterone (P4)', 'ng/mL'], ['TSH', 'µIU/mL'], ['Prolactin', 'ng/mL']],
  ultrasound_scan: [['Follicles - left ovary', 'count'], ['Follicles - right ovary', 'count'], ['Lead follicle', 'mm'], ['Endometrial thickness', 'mm']],
  semen_analysis: [['Volume', 'mL'], ['Sperm concentration', 'million/mL'], ['Total motility', '%'], ['Progressive motility', '%'], ['Normal morphology', '%']],
  embryology_report: [['Eggs retrieved', ''], ['Mature eggs (MII)', ''], ['Fertilised (2PN)', ''], ['Day-3 embryos', ''], ['Blastocysts', ''], ['Embryos frozen', '']],
  beta_hcg: [['Beta-hCG', 'mIU/mL']],
  infection_screening: [['HIV I & II', ''], ['HBsAg', ''], ['Anti-HCV', ''], ['VDRL', ''], ['Rubella IgG', 'IU/mL']],
  prescription: [], other: []
};
const templateRows = cat => (REPORT_TEMPLATES[cat] || []).map(([name, unit]) => ({ name, value: '', unit, refRange: '', flag: '', key: keyForTest(name) }));
function cleanResults(list) {
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return (Array.isArray(list) ? list : []).slice(0, 60).map(x => {
    const name = clip(x && x.name, 100);
    const key = keyForTest(name); // always from the name, so renaming a row re-links it correctly
    return { name, value: clip(x && x.value, 60), unit: clip(x && x.unit, 30), refRange: clip(x && x.refRange, 120),
      flag: ['high', 'low', 'abnormal', 'normal'].includes(x && x.flag) ? x.flag : '', key };
  }).filter(x => x.name && x.value);
}
function valuesFromResults(results) {
  const out = {};
  for (const r of results) {
    if (!r.key || out[r.key] !== undefined) continue;
    const m = String(r.value).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    const n = m ? Number(m[0]) : NaN; const [lo, hi] = VALUE_LIMITS[r.key];
    if (Number.isFinite(n) && n >= lo && n <= hi && (!/Count/.test(r.key) || Number.isInteger(n))) out[r.key] = n;
  }
  return out;
}
const resultLine = r => `${r.flag === 'high' ? '⬆️ ' : r.flag === 'low' ? '⬇️ ' : r.flag === 'abnormal' ? '⚠️ ' : '• '}${r.name}: ${r.value}${r.unit ? ' ' + r.unit : ''}${r.refRange ? ` (normal ${r.refRange})` : ''}`;
async function extractInto(reportId, files) {
  const ex = D.extractReportResults ? await D.extractReportResults(files).catch(() => ({ ok: false, reason: 'failed' })) : { ok: false, reason: 'not_configured' };
  const update = ex.ok && ex.tests && ex.tests.length
    ? { results: cleanResults(ex.tests.map(t => ({ ...t, key: undefined }))), detectedType: ex.reportType || '', resultsSource: 'ai', extractStatus: 'done' }
    : { extractStatus: ex.ok ? 'done' : (ex.reason === 'not_configured' ? 'not_configured' : 'failed') };
  await IvfReport.updateOne({ _id: reportId }, update);
  return update;
}

// ---------- WhatsApp delivery ----------
// Free text only reaches someone who messaged the Biomexa number in the last 24 hours; outside
// that window Meta silently drops it. So: free text inside the window, the approved IVF update
// template outside it (report-analysis template as a second choice for report messages).
function waTitleAndBody(text) {
  const clean = l => l.replace(/\*/g, '').replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '').trim();
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const title = clean(lines[0] || 'Update').replace(/[:\s]+$/, '');
  const body = lines.slice(1).filter(l => !/^-\s/.test(l)).map(clean).filter(Boolean).join(' · ');
  return { title, body: body || title };
}
async function smartSend(rawSend, phone, text, opts = {}) {
  if (!phone) return { success: false };
  const open = D.whatsappWindowOpen ? await D.whatsappWindowOpen(phone).catch(() => false) : true;
  if (open) return rawSend(phone, text);
  const { title, body } = waTitleAndBody(text);
  if (D.sendIvfUpdateTemplate) {
    const t = await D.sendIvfUpdateTemplate(phone, opts.title || title, opts.details || body).catch(() => ({ success: false }));
    if (t && t.success) return t;
  }
  if (opts.report && D.sendReportAnalysisTemplate) {
    const t = await D.sendReportAnalysisTemplate(phone, opts.report.name || 'IVF patient', opts.report.fileName || 'IVF report', opts.report.summary || body).catch(() => ({ success: false }));
    if (t && t.success) return t;
  }
  console.log(`⚠️ IVF WhatsApp to ${phone} is outside the 24h window and MSG91_IVF_UPDATE_TEMPLATE_NAME is not set — Meta will probably drop this free-text message`);
  return rawSend(phone, text);
}

function mount(app, deps) {
  const rawSend = deps.sendWhatsAppFree;
  D = { ...deps, sendWhatsAppFree: (phone, text, opts) => smartSend(rawSend, phone, text, opts) };
  const { auth, doctorAuth } = deps;
  const R = '/api/ivf';

  // ---------- public ----------
  app.get(`${R}/meta`, (req, res) => res.json({ stages: IVF_STAGES, protocols: PROTOCOLS, reportCategories: REPORT_CATEGORIES, consentText: CONSENT_TEXT, reportTemplates: Object.fromEntries(Object.keys(REPORT_TEMPLATES).map(k => [k, templateRows(k)])), graphKeys: Object.keys(VALUE_LIMITS) }));

  app.get(`${R}/centers`, wrap(async (req, res) => {
    const centers = await IvfCenter.find({ acceptingPatients: true }).lean();
    const doctors = await D.Doctor.find({ _id: { $in: centers.map(c => c.doctorId).filter(isId) }, status: 'verified' }).select('name specialty experienceYears available').lean();
    const byId = Object.fromEntries(doctors.map(d => [String(d._id), d]));
    res.json(centers.filter(c => byId[c.doctorId]).map(c => ({
      doctorId: c.doctorId, centerName: c.centerName, city: c.city, about: c.about, consultationModes: c.consultationModes,
      doctorName: byId[c.doctorId].name, specialty: byId[c.doctorId].specialty, experienceYears: byId[c.doctorId].experienceYears
    })));
  }));

  // ---------- patient ----------
  app.get(`${R}/me`, auth, wrap(async (req, res) => {
    const cycle = await patientCycle(req.user.phone);
    if (!cycle) return res.json({ cycle: null });
    const id = String(cycle._id);
    const today = D.localDateStr(new Date());
    const [meds, doses, todayLog, consults, unread, alerts, reportsAwaiting] = await Promise.all([
      IvfMedication.find({ cycleId: id, active: true }).sort({ isTrigger: -1, createdAt: 1 }),
      IvfDose.find({ cycleId: id, $or: [{ scheduledDate: today }, { isTrigger: true }] }).sort({ scheduledAt: 1 }),
      IvfDailyLog.findOne({ cycleId: id, logDate: today }).sort({ createdAt: -1 }),
      IvfConsult.find({ cycleId: id, status: { $in: ['requested', 'scheduled'] } }).sort({ scheduledAt: 1, createdAt: -1 }),
      IvfMessage.countDocuments({ cycleId: id, from: 'doctor', readByOther: false }),
      IvfAlert.find({ cycleId: id }).sort({ createdAt: -1 }).limit(3),
      IvfReport.countDocuments({ cycleId: id, reviewStatus: 'awaiting_review' })
    ]);
    const doctor = await doctorOf(cycle);
    res.json({
      cycle, stage: stageInfo(cycle.stage), doctorName: doctor?.name || null,
      medications: meds, doses, todayLog, consults, unreadMessages: unread, recentAlerts: alerts, reportsAwaiting
    });
  }));

  app.post(`${R}/enroll`, auth, wrap(async (req, res) => {
    const existing = await IvfCycle.findOne({ patientPhone: { $in: D.phoneVariants(req.user.phone) }, status: { $in: ['active', 'pending'] } });
    if (existing) return res.status(400).json({ message: 'You already have an IVF programme in progress.' });
    if (req.body.consent !== true) return res.status(400).json({ message: 'Please read and accept the consent to continue.' });
    const doctorId = String(req.body.doctorId || '');
    const center = isId(doctorId) ? await IvfCenter.findOne({ doctorId, acceptingPatients: true }) : null;
    const doctor = center ? await D.Doctor.findOne({ _id: doctorId, status: 'verified' }) : null;
    if (!center || !doctor) return res.status(400).json({ message: 'Please choose an IVF centre from the list.' });
    const patient = await D.Patient.findOne({ phone: { $in: D.phoneVariants(req.user.phone) } });
    const prevCycles = await IvfCycle.countDocuments({ patientPhone: { $in: D.phoneVariants(req.user.phone) } });

    const cycle = await IvfCycle.create({
      patientPhone: req.user.phone,
      patientName: patient?.name || str(req.body.patientName, 80),
      patientAge: num(req.body.patientAge, 18, 60),
      partnerName: str(req.body.partnerName, 80),
      doctorId, centerName: center.centerName,
      protocol: oneOf(req.body.protocol, PROTOCOLS, 'antagonist'),
      cycleNumber: num(req.body.cycleNumber, 1, 20) || prevCycles + 1,
      baselineWeightKg: num(req.body.baselineWeightKg, 30, 200),
      patientNotes: str(req.body.notes, 1500),
      consent: { accepted: true, acceptedAt: new Date(), text: CONSENT_TEXT },
      stageHistory: [{ stage: 'consultation', changedAt: new Date(), by: 'patient' }]
    });
    fire(D.sendWhatsAppFree(doctor.phone, `🆕 *New IVF patient request*\n\n${cycle.patientName || 'A patient'} (${cycle.patientPhone}) wants to join ${center.centerName} for IVF monitoring.\n\nReview and accept: ${ivfUrl('ivf-doctor.html')}\n\n- Biomexa IVF Care`));
    res.json({ message: 'Request sent to the IVF centre. You can start daily check-ins and uploads right away.', cycle });
  }));

  // All patient cycle-scoped routes below use the patient's current cycle.
  const withCycle = handler => wrap(async (req, res) => {
    const cycle = await patientCycle(req.user.phone);
    if (!cycle) return res.status(404).json({ message: 'You are not enrolled in an IVF programme yet.' });
    if (cycle.status === 'declined') return res.status(400).json({ message: 'This IVF centre declined the request. Please choose another centre.' });
    return handler(req, res, cycle);
  });

  app.post(`${R}/doses/:doseId/status`, auth, withCycle(async (req, res, cycle) => {
    const status = oneOf(req.body.status, ['taken', 'missed'], null);
    if (!status || !isId(req.params.doseId)) return res.status(400).json({ message: 'Invalid request.' });
    const dose = await IvfDose.findOneAndUpdate({ _id: req.params.doseId, cycleId: String(cycle._id) }, status === 'taken' ? { status, takenAt: new Date() } : { status }, { new: true });
    if (!dose) return res.status(404).json({ message: 'Dose not found.' });
    if (dose.isTrigger && status === 'missed') await raiseAlert(cycle, 'critical', [`Trigger shot (${dose.medicineName}) marked NOT taken`], 'trigger_missed');
    res.json({ message: status === 'taken' ? 'Marked as taken.' : 'Marked as missed — please tell your IVF centre.', dose });
  }));

  app.post(`${R}/logs`, auth, withCycle(async (req, res, cycle) => {
    const b = req.body || {};
    const vitals = {
      weightKg: num(b.weightKg, 30, 200), temperatureF: num(b.temperatureF, 90, 110),
      bpSystolic: num(b.bpSystolic, 60, 260), bpDiastolic: num(b.bpDiastolic, 30, 160),
      heartRate: num(b.heartRate, 30, 220), abdominalGirthCm: num(b.abdominalGirthCm, 40, 200)
    };
    // Accept °C as well — anything under 45 is clearly Celsius.
    if (!vitals.temperatureF && num(b.temperatureF, 30, 45)) vitals.temperatureF = +(Number(b.temperatureF) * 9 / 5 + 32).toFixed(1);
    const symptoms = {
      painScore: num(b.painScore, 0, 10),
      bloating: oneOf(b.bloating, ['none', 'mild', 'moderate', 'severe'], undefined),
      nausea: oneOf(b.nausea, ['none', 'mild', 'vomiting'], undefined),
      breathlessness: b.breathlessness === true,
      reducedUrine: b.reducedUrine === true,
      bleeding: oneOf(b.bleeding, ['none', 'spotting', 'light', 'heavy'], undefined),
      headache: b.headache === true,
      injectionSiteReaction: b.injectionSiteReaction === true,
      mood: oneOf(b.mood, ['good', 'okay', 'low', 'very_low'], undefined)
    };
    if (!hasCheckinData(vitals, symptoms)) return res.status(400).json({ message: 'Please fill in at least one reading or symptom.' });
    const { log, flags, severity, alert } = await saveCheckin(cycle, vitals, symptoms, str(b.notes, 1000), 'web');
    res.json({ message: CHECKIN_ADVICE[severity || 'none'], log, severity, flags, alertId: alert?._id || null });
  }));

  // Early pregnancy, patient view: dates, upcoming tests and the doctor's own notes only.
  app.get(`${R}/pregnancy`, auth, withCycle(async (req, res, cycle) => {
    const p = await IvfPregnancy.findOne({ cycleId: String(cycle._id) }).lean();
    if (!p) return res.json({ pregnancy: null });
    const today = D.localDateStr(new Date()), ga = pregGaOn(p, today);
    const ev = evaluatePregnancy(p);
    res.json({ pregnancy: { gaToday: ga, gaTodayLabel: pregGaLabel(ga), edd: ev.edd, nextHcgDate: p.nextHcgDate, nextScanDate: p.nextScanDate,
      hcgTests: (p.hcgTests || []).map(t => ({ date: t.date })), scanDates: (p.scans || []).map(s => s.date),
      sharedNotes: (p.sharedNotes || []).slice().reverse() } });
  }));

  // Treatment progress for the graphs (patient's own cycle).
  app.get(`${R}/progress`, auth, withCycle(async (req, res, cycle) => {
    res.json(await buildProgress(cycle));
  }));
  // Send my progress summary to my WhatsApp now.
  app.post(`${R}/progress/whatsapp`, auth, withCycle(async (req, res, cycle) => {
    const r = await sendPatientProgress(cycle);
    res.json({ message: r && r.success ? 'Progress summary sent to your WhatsApp.' : 'Could not send on WhatsApp right now. Message "Hi" to Biomexa on WhatsApp first, then try again.' });
  }));

  app.get(`${R}/logs`, auth, withCycle(async (req, res, cycle) => {
    res.json(await IvfDailyLog.find({ cycleId: String(cycle._id) }).sort({ createdAt: -1 }).limit(60));
  }));

  // Reports — same 3-file / 5MB limits as the rest of the platform.
  app.post(`${R}/reports`, auth, withCycle(async (req, res, cycle) => {
    const files = (Array.isArray(req.body.files) ? req.body.files : []).filter(f => f && f.fileName && f.fileType && f.fileData);
    if (!files.length) return res.status(400).json({ message: 'Please attach at least one file.' });
    if (files.length > D.MAX_FILES_PER_UPLOAD) return res.status(400).json({ message: `Up to ${D.MAX_FILES_PER_UPLOAD} files per report.` });
    for (const f of files) {
      if (!D.ALLOWED_DOCUMENT_TYPES.includes(f.fileType)) return res.status(400).json({ message: `"${f.fileName}" — only JPG, PNG, WEBP or PDF files are supported.` });
      if (String(f.fileData).length > D.MAX_DOCUMENT_BASE64_LENGTH) return res.status(400).json({ message: `"${f.fileName}" is too large — please keep each file under 5MB.` });
    }
    const category = oneOf(req.body.category, Object.keys(REPORT_CATEGORIES), 'other');
    const report = await IvfReport.create({
      cycleId: String(cycle._id), patientPhone: cycle.patientPhone, doctorId: cycle.doctorId, category,
      title: str(req.body.title, 120) || REPORT_CATEGORIES[category], reportDate: str(req.body.reportDate, 10),
      files: files.map(f => ({ fileName: str(f.fileName, 150), fileType: f.fileType, fileData: f.fileData })),
      patientNote: str(req.body.note, 1000), aiStatus: 'pending'
    });
    // AI draft reading runs in the background so the upload returns instantly. It is only a
    // starting point for the doctor and is labelled "unverified" everywhere it is shown.
    fire((async () => {
      const patient = await D.Patient.findOne({ phone: { $in: D.phoneVariants(cycle.patientPhone) } });
      const [result] = await Promise.all([D.analyzeDocument(files, 'English', 'prescription', 'patient', patient), extractInto(report._id, files)]);
      await IvfReport.updateOne({ _id: report._id }, result.ok
        ? { aiSummary: result.analysis, aiStatus: 'done' }
        : { aiStatus: result.reason === 'not_configured' ? 'not_configured' : 'failed' });
      if (result.ok && result.analysis) {
        const reading = String(result.analysis).slice(0, 1400);
        await D.sendWhatsAppFree(cycle.patientPhone, `📄 *Your IVF report: ${report.title}*\n\n*Quick AI reading (not yet checked by your doctor):*\n${reading}\n\nYour IVF doctor will review it and send you their findings.\n${ivfUrl('ivf.html')}\n- Biomexa IVF Care`,
          { title: `Your IVF report: ${report.title}`, details: `Quick AI reading, not yet checked by your doctor: ${reading.replace(/\*/g, '')} Your IVF doctor will review it and send you their findings.`,
            report: { name: cycle.patientName || 'IVF patient', fileName: report.title, summary: `Quick AI reading (not yet checked by your doctor): ${reading.replace(/\*/g, '')}` } });
      } else {
        await D.sendWhatsAppFree(cycle.patientPhone, `📄 *IVF report received: ${report.title}*\n\nYour IVF doctor will review it and send you their findings here.\n${ivfUrl('ivf.html')}\n- Biomexa IVF Care`);
      }
    })());
    const doctor = await doctorOf(cycle);
    if (doctor) fire(D.sendWhatsAppFree(doctor.phone, `📄 New IVF report from ${cycle.patientName || cycle.patientPhone}: ${report.title}.\nReview it: ${ivfUrl('ivf-doctor.html')}`));
    const out = report.toObject(); out.files = out.files.map(f => ({ fileName: f.fileName, fileType: f.fileType }));
    res.json({ message: 'Report uploaded — your IVF centre will review it.', report: out });
  }));

  app.get(`${R}/reports`, auth, withCycle(async (req, res, cycle) => {
    res.json(await IvfReport.find({ cycleId: String(cycle._id) }).select(reportListFields).sort({ uploadedAt: -1 }).limit(50));
  }));

  app.get(`${R}/reports/:rid/file/:idx`, auth, withCycle(async (req, res, cycle) => {
    if (!isId(req.params.rid)) return res.status(404).json({ message: 'Not found.' });
    const report = await IvfReport.findOne({ _id: req.params.rid, cycleId: String(cycle._id) });
    const f = report?.files?.[Number(req.params.idx)];
    if (!f) return res.status(404).json({ message: 'File not found.' });
    res.json({ fileName: f.fileName, fileType: f.fileType, fileData: f.fileData });
  }));

  app.delete(`${R}/reports/:rid`, auth, withCycle(async (req, res, cycle) => {
    if (!isId(req.params.rid)) return res.status(404).json({ message: 'Not found.' });
    const r = await IvfReport.findOneAndDelete({ _id: req.params.rid, cycleId: String(cycle._id), reviewStatus: 'awaiting_review' });
    if (!r) return res.status(400).json({ message: 'Only reports not yet reviewed by your doctor can be deleted.' });
    res.json({ message: 'Report deleted.' });
  }));

  // Virtual follow-ups
  app.get(`${R}/consults`, auth, withCycle(async (req, res, cycle) => {
    res.json(await IvfConsult.find({ cycleId: String(cycle._id) }).sort({ createdAt: -1 }).limit(30));
  }));
  app.post(`${R}/consults`, auth, withCycle(async (req, res, cycle) => {
    const open = await IvfConsult.countDocuments({ cycleId: String(cycle._id), status: 'requested' });
    if (open >= 2) return res.status(400).json({ message: 'You already have follow-up requests waiting for the centre.' });
    const c = await IvfConsult.create({
      cycleId: String(cycle._id), patientPhone: cycle.patientPhone, doctorId: cycle.doctorId, requestedBy: 'patient',
      mode: oneOf(req.body.mode, ['video', 'audio', 'chat'], 'video'),
      reason: str(req.body.reason, 600) || 'Follow-up', preferredSlot: str(req.body.preferredSlot, 120)
    });
    const doctor = await doctorOf(cycle);
    if (doctor) fire(D.sendWhatsAppFree(doctor.phone, `📅 ${cycle.patientName || cycle.patientPhone} requested a ${c.mode} follow-up${c.preferredSlot ? ` (${c.preferredSlot})` : ''}: ${c.reason}\nSchedule it: ${ivfUrl('ivf-doctor.html')}`));
    res.json({ message: 'Follow-up requested — the centre will confirm a time.', consult: c });
  }));
  app.post(`${R}/consults/:cid/cancel`, auth, withCycle(async (req, res, cycle) => {
    if (!isId(req.params.cid)) return res.status(404).json({ message: 'Not found.' });
    const c = await IvfConsult.findOneAndUpdate({ _id: req.params.cid, cycleId: String(cycle._id), status: { $in: ['requested', 'scheduled'] } }, { status: 'cancelled' }, { new: true });
    if (!c) return res.status(404).json({ message: 'Follow-up not found.' });
    res.json({ message: 'Follow-up cancelled.', consult: c });
  }));

  // Messages
  app.get(`${R}/messages`, auth, withCycle(async (req, res, cycle) => {
    const msgs = await IvfMessage.find({ cycleId: String(cycle._id) }).sort({ createdAt: -1 }).limit(100);
    await IvfMessage.updateMany({ cycleId: String(cycle._id), from: 'doctor', readByOther: false }, { readByOther: true });
    res.json(msgs.reverse());
  }));
  app.post(`${R}/messages`, auth, withCycle(async (req, res, cycle) => {
    const text = str(req.body.text, 2000);
    if (!text) return res.status(400).json({ message: 'Message is empty.' });
    const m = await IvfMessage.create({ cycleId: String(cycle._id), from: 'patient', senderName: cycle.patientName, text });
    const doctor = await doctorOf(cycle);
    if (doctor) fire(D.sendWhatsAppFree(doctor.phone, `💬 IVF message from ${cycle.patientName || cycle.patientPhone}: "${text.slice(0, 200)}"\nReply: ${ivfUrl('ivf-doctor.html')}`));
    res.json(m);
  }));

  app.get(`${R}/alerts`, auth, withCycle(async (req, res, cycle) => {
    res.json(await IvfAlert.find({ cycleId: String(cycle._id) }).sort({ createdAt: -1 }).limit(20));
  }));

  // ---------- doctor / IVF centre ----------
  const DR = `${R}/doctor`;

  app.get(`${DR}/center`, doctorAuth, wrap(async (req, res) => {
    const [center, doctor] = await Promise.all([
      IvfCenter.findOne({ doctorId: String(req.doctor.id) }),
      D.Doctor.findById(req.doctor.id).select('name phone specialty')
    ]);
    res.json({ center, doctor });
  }));
  app.put(`${DR}/center`, doctorAuth, wrap(async (req, res) => {
    const centerName = str(req.body.centerName, 120);
    if (!centerName) return res.status(400).json({ message: 'Please enter your IVF centre name.' });
    const modes = (Array.isArray(req.body.consultationModes) ? req.body.consultationModes : []).filter(m => ['video', 'audio', 'chat'].includes(m));
    const centerMeet = normaliseMeetLink(req.body.meetLink);
    if (centerMeet === null) return res.status(400).json({ message: 'Please paste a Google Meet link, like https://meet.google.com/abc-defg-hij' });
    const center = await IvfCenter.findOneAndUpdate(
      { doctorId: String(req.doctor.id) },
      {
        centerName, city: str(req.body.city, 80), address: str(req.body.address, 300),
        registrationNumber: str(req.body.registrationNumber, 60), about: str(req.body.about, 800),
        consultationModes: modes.length ? modes : ['video', 'audio', 'chat'],
        acceptingPatients: req.body.acceptingPatients !== false,
        meetLink: centerMeet || undefined
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ message: 'IVF centre profile saved.', center });
  }));

  app.get(`${DR}/overview`, doctorAuth, wrap(async (req, res) => {
    const doctorId = String(req.doctor.id);
    const cycleIds = (await IvfCycle.find({ doctorId, status: 'active' }).select('_id')).map(c => String(c._id));
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay); endOfDay.setDate(endOfDay.getDate() + 1);
    const [pending, openAlerts, reportsAwaiting, consultRequests, consultsToday, checkedInToday] = await Promise.all([
      IvfCycle.countDocuments({ doctorId, status: 'pending' }),
      IvfAlert.countDocuments({ doctorId, acknowledged: false }),
      IvfReport.countDocuments({ doctorId, reviewStatus: 'awaiting_review' }),
      IvfConsult.countDocuments({ doctorId, status: 'requested' }),
      IvfConsult.countDocuments({ doctorId, status: 'scheduled', scheduledAt: { $gte: startOfDay, $lt: endOfDay } }),
      IvfDailyLog.distinct('cycleId', { cycleId: { $in: cycleIds }, logDate: D.localDateStr(new Date()) })
    ]);
    res.json({ activeCycles: cycleIds.length, pendingRequests: pending, openAlerts, reportsAwaiting, consultRequests, consultsToday, checkedInToday: checkedInToday.length });
  }));

  app.get(`${DR}/cycles`, doctorAuth, wrap(async (req, res) => {
    const doctorId = String(req.doctor.id);
    const status = oneOf(req.query.status, ['pending', 'active', 'completed', 'declined', 'all'], 'all');
    const q = { doctorId }; if (status !== 'all') q.status = status;
    const cycles = await IvfCycle.find(q).sort({ updatedAt: -1 }).limit(200).lean();
    const ids = cycles.map(c => String(c._id));
    const [alerts, reports, unread] = await Promise.all([
      IvfAlert.aggregate([{ $match: { cycleId: { $in: ids }, acknowledged: false } }, { $group: { _id: '$cycleId', n: { $sum: 1 } } }]),
      IvfReport.aggregate([{ $match: { cycleId: { $in: ids }, reviewStatus: 'awaiting_review' } }, { $group: { _id: '$cycleId', n: { $sum: 1 } } }]),
      IvfMessage.aggregate([{ $match: { cycleId: { $in: ids }, from: 'patient', readByOther: false } }, { $group: { _id: '$cycleId', n: { $sum: 1 } } }])
    ]);
    const m = arr => Object.fromEntries(arr.map(a => [a._id, a.n]));
    const [a, r, u] = [m(alerts), m(reports), m(unread)];
    const rank = c => (c.status === 'pending' ? 10 : 0) + (a[String(c._id)] ? 5 + (SEVERITY_RANK[c.riskLevel] || 0) : 0);
    res.json(cycles.map(c => ({ ...c, stageLabel: STAGE_LABEL[c.stage], openAlerts: a[String(c._id)] || 0, reportsAwaiting: r[String(c._id)] || 0, unreadMessages: u[String(c._id)] || 0 }))
      .sort((x, y) => rank(y) - rank(x)));
  }));

  app.get(`${DR}/cycles/:id`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const id = String(cycle._id);
    const since = new Date(Date.now() - 14 * 864e5);
    const [meds, doses, logs, reports, consults, alerts] = await Promise.all([
      IvfMedication.find({ cycleId: id }).sort({ active: -1, isTrigger: -1, createdAt: 1 }),
      IvfDose.find({ cycleId: id, scheduledAt: { $gte: since, $lte: new Date(Date.now() + 864e5) } }).sort({ scheduledAt: -1 }),
      IvfDailyLog.find({ cycleId: id }).sort({ createdAt: -1 }).limit(45),
      IvfReport.find({ cycleId: id }).select(reportListFields).sort({ uploadedAt: -1 }),
      IvfConsult.find({ cycleId: id }).sort({ createdAt: -1 }).limit(20),
      IvfAlert.find({ cycleId: id }).sort({ createdAt: -1 }).limit(30)
    ]);
    const past = doses.filter(d => d.scheduledAt <= new Date() && d.status !== 'pending');
    const adherence = past.length ? Math.round(100 * past.filter(d => d.status === 'taken').length / past.length) : null;
    res.json({ cycle, stage: stageInfo(cycle.stage), medications: meds, doses, logs, reports, consults, alerts, adherence });
  }));

  app.get(`${DR}/cycles/:id/progress`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    res.json(await buildProgress(cycle));
  }));
  app.post(`${DR}/cycles/:id/progress/whatsapp`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const r = await sendPatientProgress(cycle);
    res.json({ message: r && r.success ? 'Progress summary sent to the patient on WhatsApp.' : 'WhatsApp could not deliver right now (the patient may need to message Biomexa first).' });
  }));
  app.post(`${DR}/cycles/:id/checkin-request`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const r = await sendCheckinPrompt(cycle);
    res.json({ message: r && r.success ? 'Check-in request sent on WhatsApp.' : 'WhatsApp could not deliver right now (the patient may need to message Biomexa first).' });
  }));

  // ---------- Early pregnancy viability (doctor decision support) ----------
  async function pregnancyFor(cycle, create) {
    let p = await IvfPregnancy.findOne({ cycleId: String(cycle._id) });
    if (!p && create) p = await IvfPregnancy.create({ cycleId: String(cycle._id), patientPhone: cycle.patientPhone, doctorId: cycle.doctorId, transferDate: cycle.dates?.transferAt || undefined });
    return p;
  }
  const pregPayload = p => ({ pregnancy: p, evaluation: evaluatePregnancy(p ? p.toObject() : null) });
  const dateOnly = v => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined; };

  app.get(`${DR}/cycles/:id/pregnancy`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const p = await pregnancyFor(cycle, false);
    res.json({ ...pregPayload(p), suggestedTransferDate: cycle.dates?.transferAt || null });
  }));
  app.put(`${DR}/cycles/:id/pregnancy`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const p = await pregnancyFor(cycle, true), b = req.body || {};
    if ('transferDate' in b) { const d = dateOnly(b.transferDate); if (!d) return res.status(400).json({ message: 'Please enter the embryo transfer date.' }); p.transferDate = new Date(`${d}T12:00:00`); }
    if ('embryoAgeDays' in b) p.embryoAgeDays = oneOf(Number(b.embryoAgeDays), [3, 5, 6], 5);
    if ('embryosTransferred' in b) p.embryosTransferred = num(b.embryosTransferred, 1, 4) || 1;
    if ('nextHcgDate' in b) p.nextHcgDate = dateOnly(b.nextHcgDate) || null;
    if ('nextScanDate' in b) p.nextScanDate = dateOnly(b.nextScanDate) || null;
    p.updatedAt = new Date(); await p.save();
    if (!['pregnancy_test', 'early_pregnancy', 'closed'].includes(cycle.stage)) {
      cycle.stage = 'early_pregnancy'; cycle.stageHistory.push({ stage: 'early_pregnancy', changedAt: new Date(), by: 'doctor' }); cycle.updatedAt = new Date(); await cycle.save();
    }
    res.json({ message: 'Pregnancy details saved.', ...pregPayload(p) });
  }));
  app.post(`${DR}/cycles/:id/pregnancy/hcg`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const d = dateOnly(req.body.date), v = num(req.body.value, 0.1, 1000000);
    if (!d || v === undefined) return res.status(400).json({ message: 'Enter the test date and the beta-hCG value (mIU/mL).' });
    const p = await pregnancyFor(cycle, true);
    p.hcgTests.push({ date: new Date(`${d}T12:00:00`), value: v, note: str(req.body.note, 200) });
    p.updatedAt = new Date(); await p.save();
    res.json({ message: 'hCG result added.', ...pregPayload(p) });
  }));
  app.delete(`${DR}/cycles/:id/pregnancy/hcg/:tid`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    const p = cycle && await pregnancyFor(cycle, false);
    if (!p) return res.status(404).json({ message: 'Not found.' });
    p.hcgTests = p.hcgTests.filter(t => String(t._id) !== req.params.tid); await p.save();
    res.json({ message: 'hCG result removed.', ...pregPayload(p) });
  }));
  app.post(`${DR}/cycles/:id/pregnancy/scans`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const b = req.body || {}, d = dateOnly(b.date);
    if (!d) return res.status(400).json({ message: 'Enter the scan date.' });
    const fetuses = (Array.isArray(b.fetuses) ? b.fetuses : []).slice(0, 4).map((f, i) => ({
      label: ['A', 'B', 'C', 'D'][i], msdMm: num(f.msdMm, 0.5, 100), yolkSac: f.yolkSac === true ? true : f.yolkSac === false ? false : undefined,
      yolkSacMm: num(f.yolkSacMm, 0.5, 20), embryo: f.embryo === true || num(f.crlMm, 0.5, 100) !== undefined, crlMm: num(f.crlMm, 0.5, 100),
      heartbeat: oneOf(f.heartbeat, ['yes', 'no', 'na'], 'na'), fhrBpm: num(f.fhrBpm, 20, 250), emptyAmnion: f.emptyAmnion === true
    }));
    const location = oneOf(b.location, ['intrauterine', 'unknown', 'ectopic_suspected'], 'intrauterine');
    if (!fetuses.length && location === 'intrauterine') return res.status(400).json({ message: 'Add at least one gestational sac.' });
    const p = await pregnancyFor(cycle, true);
    const doctor = await D.Doctor.findById(req.doctor.id).select('name');
    p.scans.push({ date: new Date(`${d}T12:00:00`), location, fetuses, notes: str(b.notes, 1000), addedBy: doctor?.name });
    p.updatedAt = new Date(); await p.save();
    const payload = pregPayload(p);
    // A suspicious or diagnostic result is added to the centre's alert queue (doctor-only).
    const lvl = payload.evaluation.status.level;
    if (['suspicious', 'diagnostic', 'urgent'].includes(lvl)) {
      await IvfAlert.create({ cycleId: String(cycle._id), patientPhone: cycle.patientPhone, patientName: cycle.patientName, doctorId: cycle.doctorId, severity: lvl === 'suspicious' ? 'watch' : 'high', reasons: [`Early pregnancy: ${payload.evaluation.status.label}`], source: 'pregnancy_scan' });
    }
    res.json({ message: 'Scan added.', ...payload });
  }));
  app.delete(`${DR}/cycles/:id/pregnancy/scans/:sid`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    const p = cycle && await pregnancyFor(cycle, false);
    if (!p) return res.status(404).json({ message: 'Not found.' });
    p.scans = p.scans.filter(t => String(t._id) !== req.params.sid); await p.save();
    res.json({ message: 'Scan removed.', ...pregPayload(p) });
  }));
  // The doctor writes what the patient should hear; nothing automatic is ever sent about viability.
  app.post(`${DR}/cycles/:id/pregnancy/share`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    const p = cycle && await pregnancyFor(cycle, true);
    if (!p) return res.status(404).json({ message: 'Patient not found.' });
    const text = str(req.body.text, 1500);
    if (!text) return res.status(400).json({ message: 'Write the update you want the patient to see.' });
    const doctor = await D.Doctor.findById(req.doctor.id).select('name');
    p.sharedNotes.push({ text, by: doctor?.name }); await p.save();
    fire(D.sendWhatsAppFree(cycle.patientPhone, `🤰 *Update from ${doctor?.name || 'your IVF doctor'}*\n\n${text.slice(0, 900)}\n\n${ivfUrl('ivf.html')}\n- ${cycle.centerName}`));
    res.json({ message: 'Update shared with the patient.', ...pregPayload(p) });
  }));

  app.post(`${DR}/cycles/:id/:decision(accept|decline)`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    if (cycle.status !== 'pending') return res.status(400).json({ message: 'This request was already handled.' });
    const accept = req.params.decision === 'accept';
    cycle.status = accept ? 'active' : 'declined';
    cycle.updatedAt = new Date();
    await cycle.save();
    if (accept) await generateAllDoses();
    fire(D.sendWhatsAppFree(cycle.patientPhone, accept
      ? `✅ *${cycle.centerName}* has accepted you into Biomexa IVF Care.\n\nYou'll get medicine reminders here, and can do daily check-ins, upload reports and book virtual follow-ups: ${ivfUrl('ivf.html')}\n\n- Biomexa IVF Care`
      : `${cycle.centerName} isn't able to take your IVF monitoring request right now. You can choose another centre here: ${ivfUrl('ivf.html')}`));
    res.json({ message: accept ? 'Patient accepted.' : 'Request declined.', cycle });
  }));

  app.patch(`${DR}/cycles/:id`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const b = req.body || {};
    const doctor = await D.Doctor.findById(req.doctor.id).select('name');
    let stageChanged = false;
    if (b.stage && STAGE_KEYS.includes(b.stage) && b.stage !== cycle.stage) {
      cycle.stage = b.stage; stageChanged = true;
      cycle.stageHistory.push({ stage: b.stage, changedAt: new Date(), by: doctor?.name || 'doctor' });
      if (b.stage === 'closed') cycle.status = 'completed';
    }
    if (b.protocol) cycle.protocol = oneOf(b.protocol, PROTOCOLS, cycle.protocol);
    if (b.status && ['active', 'completed'].includes(b.status)) cycle.status = b.status;
    if (b.dates && typeof b.dates === 'object') {
      for (const k of ['stimulationStart', 'triggerAt', 'retrievalAt', 'transferAt', 'betaHcgTestAt']) {
        if (k in b.dates) cycle.dates[k] = b.dates[k] ? date(b.dates[k]) : undefined;
      }
    }
    if ('doctorPlanNotes' in b) cycle.doctorPlanNotes = str(b.doctorPlanNotes, 3000);
    if ('outcome' in b) cycle.outcome = str(b.outcome, 200);
    if ('baselineWeightKg' in b) cycle.baselineWeightKg = num(b.baselineWeightKg, 30, 200);
    cycle.updatedAt = new Date();
    cycle.markModified('dates');
    await cycle.save();
    if (stageChanged && cycle.status !== 'pending') {
      fire(D.sendWhatsAppFree(cycle.patientPhone, `📍 *IVF update:* you're now in the *${STAGE_LABEL[cycle.stage]}* stage.${cycle.doctorPlanNotes ? `\n\nYour centre's plan: ${cycle.doctorPlanNotes.slice(0, 400)}` : ''}\n\n${ivfUrl('ivf.html')}`));
    }
    res.json({ message: 'Treatment plan updated.', cycle, stage: stageInfo(cycle.stage) });
  }));

  // Medicines
  app.post(`${DR}/cycles/:id/medications`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const b = req.body || {};
    const name = str(b.name, 100);
    if (!name) return res.status(400).json({ message: 'Medicine name is required.' });
    const isTrigger = b.isTrigger === true;
    const times = (Array.isArray(b.times) ? b.times : String(b.times || '').split(','))
      .map(t => String(t).trim()).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    const triggerAt = isTrigger ? date(b.triggerAt) : undefined;
    if (isTrigger && !triggerAt) return res.status(400).json({ message: 'Please set the exact date and time of the trigger shot.' });
    if (!isTrigger && !times.length) return res.status(400).json({ message: 'Add at least one time (HH:MM) for this medicine.' });
    const doctor = await D.Doctor.findById(req.doctor.id).select('name');
    const med = await IvfMedication.create({
      cycleId: String(cycle._id), patientPhone: cycle.patientPhone, name, dosage: str(b.dosage, 80),
      route: oneOf(b.route, ['injection', 'oral', 'vaginal', 'other'], 'injection'),
      times: isTrigger ? [] : times, startDate: str(b.startDate, 10) || D.localDateStr(new Date()), endDate: str(b.endDate, 10),
      isTrigger, triggerAt, instructions: str(b.instructions, 500), addedBy: doctor?.name
    });
    if (isTrigger) {
      cycle.dates.triggerAt = triggerAt; cycle.markModified('dates');
      if (STAGE_KEYS.indexOf(cycle.stage) < STAGE_KEYS.indexOf('trigger')) {
        cycle.stage = 'trigger'; cycle.stageHistory.push({ stage: 'trigger', changedAt: new Date(), by: doctor?.name || 'doctor' });
      }
      await cycle.save();
    }
    if (cycle.status === 'active') await generateDosesFor(med);
    fire(D.sendWhatsAppFree(cycle.patientPhone, isTrigger
      ? `💉 *Trigger shot scheduled*\n\n${name} ${med.dosage || ''}\nExact time: *${fmtWhen(triggerAt)}*\n${med.instructions ? `\n${med.instructions}\n` : ''}\nWe'll remind you 2 hours before, 30 minutes before and at the exact time.\n\n- Biomexa IVF Care`
      : `💊 *New IVF medicine added*\n\n${name} ${med.dosage || ''}\nTimes: ${times.join(', ')}${med.endDate ? ` until ${med.endDate}` : ''}\n${med.instructions ? `\n${med.instructions}\n` : ''}\nYou'll get a WhatsApp reminder at each time.\n\n- Biomexa IVF Care`));
    res.json({ message: isTrigger ? 'Trigger shot scheduled with timed reminders.' : 'Medicine added with reminders.', medication: med });
  }));

  app.delete(`${DR}/cycles/:id/medications/:medId`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle || !isId(req.params.medId)) return res.status(404).json({ message: 'Not found.' });
    const med = await IvfMedication.findOneAndUpdate({ _id: req.params.medId, cycleId: String(cycle._id) }, { active: false }, { new: true });
    if (!med) return res.status(404).json({ message: 'Medicine not found.' });
    await IvfDose.deleteMany({ medicationId: String(med._id), status: 'pending', scheduledAt: { $gt: new Date() } });
    fire(D.sendWhatsAppFree(cycle.patientPhone, `ℹ️ Your IVF centre has stopped *${med.name}*. You won't get further reminders for it.`));
    res.json({ message: 'Medicine stopped — future reminders removed.' });
  }));

  // Reports
  app.get(`${DR}/reports`, doctorAuth, wrap(async (req, res) => {
    const q = { doctorId: String(req.doctor.id) };
    if (req.query.status === 'awaiting_review') q.reviewStatus = 'awaiting_review';
    const reports = await IvfReport.find(q).select(reportListFields).sort({ uploadedAt: -1 }).limit(100).lean();
    const cycles = await IvfCycle.find({ _id: { $in: [...new Set(reports.map(r => r.cycleId))].filter(isId) } }).select('patientName stage').lean();
    const byId = Object.fromEntries(cycles.map(c => [String(c._id), c]));
    res.json(reports.map(r => ({ ...r, patientName: byId[r.cycleId]?.patientName, stage: byId[r.cycleId]?.stage })));
  }));
  app.get(`${DR}/reports/:rid/file/:idx`, doctorAuth, wrap(async (req, res) => {
    if (!isId(req.params.rid)) return res.status(404).json({ message: 'Not found.' });
    const report = await IvfReport.findOne({ _id: req.params.rid, doctorId: String(req.doctor.id) });
    const f = report?.files?.[Number(req.params.idx)];
    if (!f) return res.status(404).json({ message: 'File not found.' });
    res.json({ fileName: f.fileName, fileType: f.fileType, fileData: f.fileData });
  }));
  // Doctor: (re)read the result rows from the original file with AI.
  app.post(`${DR}/reports/:rid/extract`, doctorAuth, wrap(async (req, res) => {
    if (!isId(req.params.rid)) return res.status(404).json({ message: 'Not found.' });
    const report = await IvfReport.findOne({ _id: req.params.rid, doctorId: String(req.doctor.id) });
    if (!report) return res.status(404).json({ message: 'Report not found.' });
    const u = await extractInto(report._id, report.files);
    const fresh = await IvfReport.findById(report._id).select(reportListFields);
    res.json({ message: u.resultsSource === 'ai' ? `Read ${u.results.length} result(s) from the report — please check them against the original.` : (u.extractStatus === 'not_configured' ? 'AI reading is not set up on the server yet — please enter the results yourself.' : 'Could not read results from this file — please enter them yourself.'), report: fresh });
  }));
  app.patch(`${DR}/reports/:rid/review`, doctorAuth, wrap(async (req, res) => {
    if (!isId(req.params.rid)) return res.status(404).json({ message: 'Not found.' });
    const report = await IvfReport.findOne({ _id: req.params.rid, doctorId: String(req.doctor.id) });
    if (!report) return res.status(404).json({ message: 'Report not found.' });
    const findings = str(req.body.doctorFindings, 4000);
    if (!findings) return res.status(400).json({ message: 'Please write your findings before saving.' });
    const v = req.body.values || {};
    const results = Array.isArray(req.body.results) ? cleanResults(req.body.results) : (report.results || []);
    const values = valuesFromResults(results);
    for (const [k, [lo, hi]] of Object.entries(VALUE_LIMITS)) { const n = num(v[k], lo, hi); if (n !== undefined) values[k] = n; }
    const doctor = await D.Doctor.findById(req.doctor.id).select('name');
    const rCycle = isId(report.cycleId) ? await IvfCycle.findById(report.cycleId).select('patientName').lean() : null;
    Object.assign(report, {
      doctorFindings: findings, doctorAdvice: str(req.body.doctorAdvice, 2000), values, results,
      resultsSource: Array.isArray(req.body.results) ? 'doctor' : report.resultsSource,
      needsFollowUp: req.body.needsFollowUp === true, reviewStatus: 'reviewed', reviewedBy: doctor?.name, reviewedAt: new Date()
    });
    await report.save();
    fire(D.sendWhatsAppFree(report.patientPhone, `🩺 *Your IVF report has been reviewed*\n\n${report.title}${results.length ? `\n\n*Results:*\n${results.slice(0, 12).map(resultLine).join('\n')}${results.length > 12 ? `\n…and ${results.length - 12} more in the app` : ''}` : ''}\n\n*Findings:* ${findings.slice(0, 500)}${report.doctorAdvice ? `\n\n*Advice:* ${report.doctorAdvice.slice(0, 400)}` : ''}${report.needsFollowUp ? '\n\n📅 Your doctor would like a follow-up — please book one in the app.' : ''}${Object.keys(values).length ? '\n\n📈 Your graphs are updated with these values.' : ''}\n\n${ivfUrl('ivf.html')}\n- ${doctor?.name || 'Your IVF centre'}`,
      { title: `Your IVF report has been reviewed: ${report.title}`, details: `Findings: ${findings}${report.doctorAdvice ? ` Advice: ${report.doctorAdvice}` : ''}${report.needsFollowUp ? ' Your doctor would like a follow-up, please book one in the app.' : ''} - ${doctor?.name || 'Your IVF centre'}`,
        report: { name: rCycle?.patientName || 'IVF patient', fileName: report.title, summary: `Reviewed by ${doctor?.name || 'your doctor'}. Findings: ${findings}${report.doctorAdvice ? ` Advice: ${report.doctorAdvice}` : ''}` } }));
    const out = report.toObject(); out.files = out.files.map(f => ({ fileName: f.fileName, fileType: f.fileType }));
    res.json({ message: 'Analysis saved and shared with the patient.', report: out });
  }));

  // Virtual follow-ups
  app.post(`${DR}/cycles/:id/consults`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const scheduledAt = date(req.body.scheduledAt);
    if (!scheduledAt || scheduledAt < new Date(Date.now() - 5 * 60e3)) return res.status(400).json({ message: 'Please pick a future date and time.' });
    const mode = oneOf(req.body.mode, ['video', 'audio', 'chat'], 'video');
    let link;
    if (mode !== 'chat') {
      link = normaliseMeetLink(req.body.meetingLink);
      if (link === null) return res.status(400).json({ message: 'Please paste a Google Meet link, like https://meet.google.com/abc-defg-hij' });
      if (!link) link = (await IvfCenter.findOne({ doctorId: cycle.doctorId }).select('meetLink').lean())?.meetLink || '';
      if (!link) return res.status(400).json({ message: 'Add a Google Meet link: tap "Create Google Meet", copy the link and paste it here (or save your Meet room in your centre profile).' });
    }
    let consult;
    const fields = { scheduledAt, mode, durationMin: num(req.body.durationMin, 5, 120) || 15, status: 'scheduled', meetingLink: mode === 'chat' ? undefined : link, remindersSent: [] };
    if (req.body.consultId && isId(req.body.consultId)) {
      consult = await IvfConsult.findOneAndUpdate({ _id: req.body.consultId, cycleId: String(cycle._id) }, fields, { new: true });
    }
    if (!consult) consult = await IvfConsult.create({ cycleId: String(cycle._id), patientPhone: cycle.patientPhone, doctorId: cycle.doctorId, requestedBy: 'doctor', reason: str(req.body.reason, 600) || 'Follow-up', ...fields });
    fire(D.sendWhatsAppFree(cycle.patientPhone, `📅 *Virtual IVF follow-up booked*\n\n${fmtWhen(scheduledAt)} · ${mode} · ${consult.durationMin} min\n${consult.meetingLink ? `${isMeet(consult.meetingLink) ? 'Join on Google Meet' : 'Join'}: ${consult.meetingLink}${mode === 'audio' ? ' (you can keep your camera off)' : ''}` : `It will happen in your IVF messages: ${ivfUrl('ivf.html')}`}\n\nWe'll remind you 15 minutes before.\n- ${cycle.centerName}`));
    res.json({ message: 'Follow-up scheduled and shared with the patient.', consult });
  }));
  app.patch(`${DR}/consults/:cid`, doctorAuth, wrap(async (req, res) => {
    if (!isId(req.params.cid)) return res.status(404).json({ message: 'Not found.' });
    const consult = await IvfConsult.findOne({ _id: req.params.cid, doctorId: String(req.doctor.id) });
    if (!consult) return res.status(404).json({ message: 'Follow-up not found.' });
    const status = oneOf(req.body.status, ['completed', 'cancelled'], null);
    if (!status) return res.status(400).json({ message: 'status must be completed or cancelled.' });
    consult.status = status;
    if ('doctorSummary' in req.body) consult.doctorSummary = str(req.body.doctorSummary, 3000);
    await consult.save();
    if (status === 'completed' && consult.doctorSummary) fire(D.sendWhatsAppFree(consult.patientPhone, `📝 *Notes from your IVF follow-up*\n\n${consult.doctorSummary.slice(0, 900)}\n\n${ivfUrl('ivf.html')}`));
    if (status === 'cancelled') fire(D.sendWhatsAppFree(consult.patientPhone, `ℹ️ Your IVF follow-up${consult.scheduledAt ? ` on ${fmtWhen(consult.scheduledAt)}` : ''} was cancelled by the centre. They will contact you to rebook.`));
    res.json({ message: status === 'completed' ? 'Follow-up marked complete.' : 'Follow-up cancelled.', consult });
  }));

  // Messages
  app.get(`${DR}/cycles/:id/messages`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const msgs = await IvfMessage.find({ cycleId: String(cycle._id) }).sort({ createdAt: -1 }).limit(100);
    await IvfMessage.updateMany({ cycleId: String(cycle._id), from: 'patient', readByOther: false }, { readByOther: true });
    res.json(msgs.reverse());
  }));
  app.post(`${DR}/cycles/:id/messages`, doctorAuth, wrap(async (req, res) => {
    const cycle = await doctorCycle(req);
    if (!cycle) return res.status(404).json({ message: 'Patient not found.' });
    const text = str(req.body.text, 2000);
    if (!text) return res.status(400).json({ message: 'Message is empty.' });
    const doctor = await D.Doctor.findById(req.doctor.id).select('name');
    const m = await IvfMessage.create({ cycleId: String(cycle._id), from: 'doctor', senderName: doctor?.name, text });
    fire(D.sendWhatsAppFree(cycle.patientPhone, `💬 *Message from ${doctor?.name || cycle.centerName}*\n\n${text.slice(0, 900)}\n\nReply in the app: ${ivfUrl('ivf.html')}`));
    res.json(m);
  }));

  // Alerts
  app.get(`${DR}/alerts`, doctorAuth, wrap(async (req, res) => {
    const q = { doctorId: String(req.doctor.id) };
    if (req.query.all !== '1') q.acknowledged = false;
    res.json(await IvfAlert.find(q).sort({ acknowledged: 1, createdAt: -1 }).limit(100));
  }));
  app.patch(`${DR}/alerts/:aid/ack`, doctorAuth, wrap(async (req, res) => {
    if (!isId(req.params.aid)) return res.status(404).json({ message: 'Not found.' });
    const doctor = await D.Doctor.findById(req.doctor.id).select('name');
    const alert = await IvfAlert.findOneAndUpdate({ _id: req.params.aid, doctorId: String(req.doctor.id) }, { acknowledged: true, acknowledgedBy: doctor?.name, acknowledgedAt: new Date() }, { new: true });
    if (!alert) return res.status(404).json({ message: 'Alert not found.' });
    const open = await IvfAlert.find({ cycleId: alert.cycleId, acknowledged: false }).select('severity');
    await IvfCycle.updateOne({ _id: alert.cycleId }, { riskLevel: open.reduce((acc, a) => maxSeverity(acc, a.severity), null) || 'normal' });
    res.json({ message: 'Alert acknowledged.', alert });
  }));

  // ---------- scheduler ----------
  if (!deps.disableScheduler) {
    let running = false;
    cron.schedule('* * * * *', async () => {
      if (running) return; // never overlap ticks
      running = true;
      try { await ivfTick(); } catch (err) { console.error('❌ IVF scheduler error:', err.message); }
      finally { running = false; }
    });
  }
  console.log('🧬 Biomexa IVF Care module mounted at /api/ivf');
}

module.exports = { mount, handleWhatsAppReply, ivfTick, generateAllDoses, parseCheckinText, buildProgress, sendDoctorDigest, sendPatientProgress };
