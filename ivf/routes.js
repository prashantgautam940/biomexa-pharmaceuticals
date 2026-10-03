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
  IvfCenter, IvfCycle, IvfMedication, IvfDose, IvfDailyLog, IvfReport, IvfConsult, IvfMessage, IvfAlert
} = require('./models');
const { evaluateDailyLog, SEVERITY_RANK, maxSeverity } = require('./redflags');

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
const meetingLink = () => `https://meet.jit.si/BiomexaIVF-${crypto.randomBytes(8).toString('hex')}`;
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
async function handleWhatsAppReply({ phone, convo, buttonText, freeText }) {
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
    const join = c.mode === 'chat' ? `Open your IVF messages: ${ivfUrl('ivf.html')}` : `Join here: ${c.meetingLink}`;
    fire(D.sendWhatsAppFree(c.patientPhone, `📅 *IVF follow-up in 15 minutes* (${c.mode})\n${fmtWhen(c.scheduledAt)}\n\n${join}\n\n- Biomexa IVF Care`));
    const cycle = isId(c.cycleId) ? await IvfCycle.findById(c.cycleId) : null;
    const doctor = await doctorOf(cycle);
    if (doctor) fire(D.sendWhatsAppFree(doctor.phone, `📅 IVF follow-up in 15 min with ${cycle.patientName || cycle.patientPhone} (${c.mode}). ${c.mode === 'chat' ? ivfUrl('ivf-doctor.html') : c.meetingLink}`));
  }

  // Evening nudge (7–9 PM) for anyone in an active cycle who hasn't checked in today.
  const hour = now.getHours();
  if (hour >= 19 && hour < 21) {
    const cycles = await IvfCycle.find({ status: 'active', lastNudgeDate: { $ne: today } }).limit(500);
    for (const cycle of cycles) {
      const logged = await IvfDailyLog.exists({ cycleId: String(cycle._id), logDate: today });
      const claimed = await IvfCycle.findOneAndUpdate({ _id: cycle._id, lastNudgeDate: { $ne: today } }, { lastNudgeDate: today });
      if (!claimed || logged) continue;
      fire(D.sendWhatsAppFree(cycle.patientPhone, `🌙 Hi ${cycle.patientName || ''}, time for today's IVF check-in (takes 1 minute): weight, pain, bloating and any symptoms.\n\n${ivfUrl('ivf.html')}\n\n- Biomexa IVF Care`));
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
function mount(app, deps) {
  D = deps;
  const { auth, doctorAuth } = deps;
  const R = '/api/ivf';

  // ---------- public ----------
  app.get(`${R}/meta`, (req, res) => res.json({ stages: IVF_STAGES, protocols: PROTOCOLS, reportCategories: REPORT_CATEGORIES, consentText: CONSENT_TEXT }));

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
    const hasData = Object.values(vitals).some(v => v !== undefined) || Object.values(symptoms).some(v => v !== undefined && v !== false);
    if (!hasData) return res.status(400).json({ message: 'Please fill in at least one reading or symptom.' });

    const recent = await IvfDailyLog.find({ cycleId: String(cycle._id) }).sort({ createdAt: -1 }).limit(10);
    const draft = { vitals, symptoms, stage: cycle.stage, createdAt: new Date() };
    const { flags, severity } = evaluateDailyLog(draft, recent, cycle);
    const log = await IvfDailyLog.create({
      cycleId: String(cycle._id), patientPhone: cycle.patientPhone, stage: cycle.stage,
      logDate: D.localDateStr(new Date()), vitals, symptoms, notes: str(b.notes, 1000), flags
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

    const advice = severity === 'critical'
      ? 'Some of your answers need urgent attention. Please call your IVF centre now. If you have severe pain, trouble breathing or heavy bleeding, go to the nearest emergency department.'
      : severity === 'high'
        ? 'Your IVF centre has been alerted. Please call them today to discuss these symptoms.'
        : severity === 'watch'
          ? 'Saved. Your IVF centre will see a note about this on their dashboard.'
          : 'Saved — thank you. Everything you reported is within the usual range.';
    res.json({ message: advice, log, severity, flags, alertId: alert?._id || null });
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
      const result = await D.analyzeDocument(files, 'English', 'prescription', 'patient', patient);
      await IvfReport.updateOne({ _id: report._id }, result.ok
        ? { aiSummary: result.analysis, aiStatus: 'done' }
        : { aiStatus: result.reason === 'not_configured' ? 'not_configured' : 'failed' });
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
    const center = await IvfCenter.findOneAndUpdate(
      { doctorId: String(req.doctor.id) },
      {
        centerName, city: str(req.body.city, 80), address: str(req.body.address, 300),
        registrationNumber: str(req.body.registrationNumber, 60), about: str(req.body.about, 800),
        consultationModes: modes.length ? modes : ['video', 'audio', 'chat'],
        acceptingPatients: req.body.acceptingPatients !== false
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
  app.patch(`${DR}/reports/:rid/review`, doctorAuth, wrap(async (req, res) => {
    if (!isId(req.params.rid)) return res.status(404).json({ message: 'Not found.' });
    const report = await IvfReport.findOne({ _id: req.params.rid, doctorId: String(req.doctor.id) });
    if (!report) return res.status(404).json({ message: 'Report not found.' });
    const findings = str(req.body.doctorFindings, 4000);
    if (!findings) return res.status(400).json({ message: 'Please write your findings before saving.' });
    const v = req.body.values || {};
    const lim = { amh: [0, 50], fsh: [0, 200], lh: [0, 200], estradiol: [0, 20000], progesterone: [0, 500], betaHcg: [0, 500000], follicleCountLeft: [0, 60], follicleCountRight: [0, 60], leadFollicleMm: [0, 40], endometriumMm: [0, 30] };
    const values = {};
    for (const [k, [lo, hi]] of Object.entries(lim)) { const n = num(v[k], lo, hi); if (n !== undefined) values[k] = n; }
    const doctor = await D.Doctor.findById(req.doctor.id).select('name');
    Object.assign(report, {
      doctorFindings: findings, doctorAdvice: str(req.body.doctorAdvice, 2000), values,
      needsFollowUp: req.body.needsFollowUp === true, reviewStatus: 'reviewed', reviewedBy: doctor?.name, reviewedAt: new Date()
    });
    await report.save();
    fire(D.sendWhatsAppFree(report.patientPhone, `🩺 *Your IVF report has been reviewed*\n\n${report.title}\n\n*Findings:* ${findings.slice(0, 500)}${report.doctorAdvice ? `\n\n*Advice:* ${report.doctorAdvice.slice(0, 400)}` : ''}${report.needsFollowUp ? '\n\n📅 Your doctor would like a follow-up — please book one in the app.' : ''}\n\n${ivfUrl('ivf.html')}\n- ${doctor?.name || 'Your IVF centre'}`));
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
    let consult;
    const fields = { scheduledAt, mode, durationMin: num(req.body.durationMin, 5, 120) || 15, status: 'scheduled', meetingLink: mode === 'chat' ? undefined : (str(req.body.meetingLink, 300) || meetingLink()), remindersSent: [] };
    if (req.body.consultId && isId(req.body.consultId)) {
      consult = await IvfConsult.findOneAndUpdate({ _id: req.body.consultId, cycleId: String(cycle._id) }, fields, { new: true });
    }
    if (!consult) consult = await IvfConsult.create({ cycleId: String(cycle._id), patientPhone: cycle.patientPhone, doctorId: cycle.doctorId, requestedBy: 'doctor', reason: str(req.body.reason, 600) || 'Follow-up', ...fields });
    fire(D.sendWhatsAppFree(cycle.patientPhone, `📅 *Virtual IVF follow-up booked*\n\n${fmtWhen(scheduledAt)} · ${mode} · ${consult.durationMin} min\n${consult.meetingLink ? `Join: ${consult.meetingLink}` : `It will happen in your IVF messages: ${ivfUrl('ivf.html')}`}\n\nWe'll remind you 15 minutes before.\n- ${cycle.centerName}`));
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

module.exports = { mount, handleWhatsAppReply, ivfTick, generateAllDoses };
