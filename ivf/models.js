// ========== BIOMEXA IVF CARE — DATA MODELS ==========
// Everything IVF lives in its own collections (all prefixed "ivf_") so the IVF program stays
// completely separate from the existing adherence / doctor-connect features. Patients and
// doctors still sign in with their existing Biomexa accounts — only the data is separate.
const mongoose = require('mongoose');

// Treatment stages, in order. Each cycle moves forward through these; the patient tab shows
// a progress bar from this list and the daily check-in asks stage-specific questions.
const IVF_STAGES = [
  { key: 'consultation', label: 'Consultation & tests' },
  { key: 'stimulation', label: 'Ovarian stimulation' },
  { key: 'trigger', label: 'Trigger shot' },
  { key: 'retrieval', label: 'Egg retrieval' },
  { key: 'embryo_culture', label: 'Embryo culture' },
  { key: 'transfer', label: 'Embryo transfer' },
  { key: 'two_week_wait', label: 'Two-week wait' },
  { key: 'pregnancy_test', label: 'Pregnancy test (beta-hCG)' },
  { key: 'early_pregnancy', label: 'Early pregnancy follow-up' },
  { key: 'closed', label: 'Cycle closed' }
];
const STAGE_KEYS = IVF_STAGES.map(s => s.key);

const PROTOCOLS = ['antagonist', 'long_agonist', 'short_agonist', 'mild_stimulation', 'natural_cycle', 'frozen_embryo_transfer', 'iui', 'other'];

const REPORT_CATEGORIES = {
  hormone_blood_test: 'Hormone blood test (AMH, FSH, LH, E2, P4)',
  ultrasound_scan: 'Ultrasound / follicle scan',
  semen_analysis: 'Semen analysis',
  embryology_report: 'Embryology report',
  beta_hcg: 'Beta-hCG pregnancy test',
  infection_screening: 'Infection screening / pre-IVF tests',
  prescription: 'Prescription',
  other: 'Other report'
};

// An IVF centre profile, attached to an existing (admin-verified) Biomexa doctor account.
// A doctor only appears in the patient's "choose your IVF centre" list once this exists.
const ivfCenterSchema = new mongoose.Schema({
  doctorId: { type: String, unique: true },
  centerName: String,
  city: String,
  address: String,
  registrationNumber: String, // ART clinic registration number (ART Regulation Act, 2021)
  consultationModes: { type: [String], default: ['video', 'audio', 'chat'] },
  about: String,
  acceptingPatients: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'ivf_centers' });

// One IVF treatment cycle for one patient at one centre.
const ivfCycleSchema = new mongoose.Schema({
  patientPhone: { type: String, index: true },
  patientName: String,
  patientAge: Number,
  partnerName: String,
  doctorId: { type: String, index: true },
  centerName: String,
  // pending (patient asked to join, centre hasn't accepted) | active | declined | completed
  status: { type: String, default: 'pending' },
  protocol: { type: String, default: 'antagonist' },
  stage: { type: String, default: 'consultation' },
  cycleNumber: { type: Number, default: 1 },
  baselineWeightKg: Number,
  // Key dates the centre sets as the plan firms up
  dates: {
    stimulationStart: Date,
    triggerAt: Date, // exact date AND time — the trigger shot is time-critical
    retrievalAt: Date,
    transferAt: Date,
    betaHcgTestAt: Date
  },
  patientNotes: String, // what the patient wrote when enrolling
  doctorPlanNotes: String, // plan / instructions visible to the patient
  outcome: String, // e.g. "positive", "negative", "cancelled", free text
  consent: {
    accepted: { type: Boolean, default: false },
    acceptedAt: Date,
    text: String
  },
  stageHistory: [{ stage: String, changedAt: Date, by: String }],
  riskLevel: { type: String, default: 'normal' }, // normal | watch | high | critical (latest)
  lastCheckInAt: Date,
  lastNudgeDate: String, // YYYY-MM-DD of the last "please do today's check-in" WhatsApp nudge
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'ivf_cycles' });

// IVF medicines (stimulation injections, antagonist, trigger, progesterone support...). Kept
// separate from Patient.medicines so the existing reminder engine is never touched.
const ivfMedicationSchema = new mongoose.Schema({
  cycleId: { type: String, index: true },
  patientPhone: String,
  name: String,
  dosage: String,
  route: { type: String, default: 'injection' }, // injection | oral | vaginal | other
  times: [String], // HH:MM for daily medicines
  startDate: String, // YYYY-MM-DD
  endDate: String, // YYYY-MM-DD, optional
  isTrigger: { type: Boolean, default: false }, // one-off, exact time from triggerAt
  triggerAt: Date,
  instructions: String,
  active: { type: Boolean, default: true },
  addedBy: String,
  createdAt: { type: Date, default: Date.now }
}, { collection: 'ivf_medications' });

// One scheduled dose of an IVF medicine. Generated daily from ivf_medications.
const ivfDoseSchema = new mongoose.Schema({
  cycleId: { type: String, index: true },
  medicationId: String,
  patientPhone: String,
  medicineName: String,
  dosage: String,
  scheduledAt: Date,
  scheduledDate: String,
  isTrigger: { type: Boolean, default: false },
  status: { type: String, default: 'pending' }, // pending | taken | missed
  remindersSent: { type: [String], default: [] }, // e.g. ["t-120", "t-30", "t0", "escalated"]
  takenAt: Date,
  createdAt: { type: Date, default: Date.now }
}, { collection: 'ivf_doses' });
ivfDoseSchema.index({ medicationId: 1, scheduledAt: 1 }, { unique: true });

// Daily symptom + vitals check-in from the patient.
const ivfDailyLogSchema = new mongoose.Schema({
  cycleId: { type: String, index: true },
  patientPhone: String,
  stage: String,
  logDate: String, // YYYY-MM-DD
  vitals: {
    weightKg: Number,
    temperatureF: Number,
    bpSystolic: Number,
    bpDiastolic: Number,
    heartRate: Number,
    abdominalGirthCm: Number
  },
  symptoms: {
    painScore: Number, // 0-10
    bloating: String, // none | mild | moderate | severe
    nausea: String, // none | mild | vomiting
    breathlessness: Boolean,
    reducedUrine: Boolean,
    bleeding: String, // none | spotting | light | heavy
    headache: Boolean,
    injectionSiteReaction: Boolean,
    mood: String // good | okay | low | very_low
  },
  notes: String,
  flags: [{ code: String, message: String, severity: String }],
  source: { type: String, default: 'web' },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'ivf_daily_logs' });

// Reports the patient uploads for the IVF centre to analyse.
const ivfReportSchema = new mongoose.Schema({
  cycleId: { type: String, index: true },
  patientPhone: String,
  doctorId: String,
  category: { type: String, default: 'other' },
  title: String,
  reportDate: String,
  files: [{ fileName: String, fileType: String, fileData: String }],
  patientNote: String,
  aiSummary: String, // optional AI draft — always shown as unverified until the doctor reviews
  aiStatus: { type: String, default: 'skipped' }, // skipped | done | failed | not_configured
  // Doctor analysis
  reviewStatus: { type: String, default: 'awaiting_review' }, // awaiting_review | reviewed
  doctorFindings: String,
  doctorAdvice: String,
  values: {
    amh: Number, fsh: Number, lh: Number, estradiol: Number, progesterone: Number,
    betaHcg: Number, follicleCountLeft: Number, follicleCountRight: Number,
    leadFollicleMm: Number, endometriumMm: Number
  },
  needsFollowUp: { type: Boolean, default: false },
  reviewedBy: String,
  reviewedAt: Date,
  uploadedAt: { type: Date, default: Date.now }
}, { collection: 'ivf_reports' });

// Virtual follow-up consultations (video / audio / chat).
const ivfConsultSchema = new mongoose.Schema({
  cycleId: { type: String, index: true },
  patientPhone: String,
  doctorId: String,
  requestedBy: String, // patient | doctor
  mode: { type: String, default: 'video' }, // video | audio | chat
  reason: String,
  preferredSlot: String, // patient's free-text preference ("Tomorrow evening")
  scheduledAt: Date,
  durationMin: { type: Number, default: 15 },
  meetingLink: String,
  status: { type: String, default: 'requested' }, // requested | scheduled | completed | cancelled
  doctorSummary: String, // notes after the call, visible to patient
  remindersSent: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'ivf_consults' });

// Secure message thread between patient and IVF centre, per cycle.
const ivfMessageSchema = new mongoose.Schema({
  cycleId: { type: String, index: true },
  from: String, // patient | doctor
  senderName: String,
  text: String,
  readByOther: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'ivf_messages' });

// Red-flag alerts raised from daily check-ins (and missed trigger shots).
const ivfAlertSchema = new mongoose.Schema({
  cycleId: { type: String, index: true },
  patientPhone: String,
  patientName: String,
  doctorId: String,
  severity: { type: String, default: 'high' }, // watch | high | critical
  reasons: [String],
  source: { type: String, default: 'daily_log' },
  logId: String,
  acknowledged: { type: Boolean, default: false },
  acknowledgedBy: String,
  acknowledgedAt: Date,
  createdAt: { type: Date, default: Date.now }
}, { collection: 'ivf_alerts' });

module.exports = {
  IVF_STAGES, STAGE_KEYS, PROTOCOLS, REPORT_CATEGORIES,
  IvfCenter: mongoose.model('IvfCenter', ivfCenterSchema),
  IvfCycle: mongoose.model('IvfCycle', ivfCycleSchema),
  IvfMedication: mongoose.model('IvfMedication', ivfMedicationSchema),
  IvfDose: mongoose.model('IvfDose', ivfDoseSchema),
  IvfDailyLog: mongoose.model('IvfDailyLog', ivfDailyLogSchema),
  IvfReport: mongoose.model('IvfReport', ivfReportSchema),
  IvfConsult: mongoose.model('IvfConsult', ivfConsultSchema),
  IvfMessage: mongoose.model('IvfMessage', ivfMessageSchema),
  IvfAlert: mongoose.model('IvfAlert', ivfAlertSchema)
};
