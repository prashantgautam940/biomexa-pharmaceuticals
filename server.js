require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ========== CONFIG ==========
const JWT_SECRET = process.env.JWT_SECRET || 'biomexasecret';
const OTP_EXPIRY_MINUTES = 15;

// ========== TWILIO SETUP (Optional - paid fallback) ==========
let twilioClient = null;
let twilioPhone = null;
try {
  const twilio = require('twilio');
  if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_PHONE) {
    twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
    twilioPhone = process.env.TWILIO_PHONE;
    console.log('✅ Twilio configured (paid fallback)');
  }
} catch (e) {
  console.log('ℹ️ Twilio not configured - using free CallMeBot API');
}

// ========== PYTHON AI ENGINE (ai_engine.py — Flask microservice) ==========
// This repo already contains a real drug-effectiveness AI engine (ai_engine.py) — vital-sign
// trend analysis, symptom tracking, target-achievement scoring, clinical insights, and treatment
// recommendations. It was never actually deployed or called from here until now.
//
// It runs as its OWN separate service (Python/Flask, see requirements.txt), not inside this
// Node process. Deploy it as its own Render "Web Service" (Python runtime, start command
// `python ai_engine.py`, or better `gunicorn ai_engine:app`), then set AI_ENGINE_URL to that
// service's URL below. Until AI_ENGINE_URL is set, the endpoints that use it degrade gracefully
// and say so explicitly — they do not silently fall back to fake data.
const AI_ENGINE_URL = process.env.AI_ENGINE_URL || null;

async function callAiEngine(path, payload) {
  if (!AI_ENGINE_URL) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch(`${AI_ENGINE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (!res.ok || !data.success) return { ok: false, reason: 'engine_error', detail: data.error || `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
}

// ========== MSG91 WHATSAPP — TWO-WAY DOSE CONFIRMATION & VITALS CAPTURE ==========
// Unlike CallMeBot (send-only, one key per recipient), MSG91 is a real WhatsApp Business
// Solution Provider: one business number, real webhooks for inbound replies, and quick-reply
// buttons — which is what makes "patient taps Taken/Not Taken, then texts their BP" possible.
//
// Setup required on your end before this does anything (see .env.example for full steps):
// 1. Get WhatsApp Business API access in your MSG91 dashboard (control.msg91.com).
// 2. Create + get Meta approval for a template with two quick-reply buttons, e.g.:
//      Body: "Time for your {{1}} dose ({{2}}). Did you take it?"
//      Buttons: "Taken" / "Not Taken"
// 3. Set MSG91_AUTH_KEY, MSG91_INTEGRATED_NUMBER, MSG91_DOSE_TEMPLATE_NAME,
//    MSG91_TEMPLATE_NAMESPACE below.
// 4. In MSG91 dashboard → Settings → Webhooks, point the inbound WhatsApp webhook at:
//      https://<your-render-url>/api/webhooks/msg91-whatsapp
//
// Until these are set, sendDoseReminderTemplate() logs a clear "not configured" message and
// falls back to the existing plain-text WhatsApp reminder (CallMeBot/Twilio) — nothing breaks.
const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || null;
const MSG91_INTEGRATED_NUMBER = process.env.MSG91_INTEGRATED_NUMBER || null;
const MSG91_DOSE_TEMPLATE_NAME = process.env.MSG91_DOSE_TEMPLATE_NAME || 'dose_reminder';
const MSG91_TEMPLATE_NAMESPACE = process.env.MSG91_TEMPLATE_NAMESPACE || '';
const MSG91_TEMPLATE_LANG = process.env.MSG91_TEMPLATE_LANG || 'en';
const MSG91_CONFIGURED = !!(MSG91_AUTH_KEY && MSG91_INTEGRATED_NUMBER);

// Sends the dose reminder as a real WhatsApp template message with Taken/Not Taken quick-reply
// buttons. Returns { success, provider } same shape as sendWhatsAppFree, so callers can fall
// back the same way. NOTE: exact button component naming (button_1 vs quick_reply_1 etc.) can
// vary by how you defined the template in MSG91's dashboard — check the request MSG91 shows you
// there and adjust the `components` object below if delivery fails with a template-mismatch error.
async function sendDoseReminderTemplate(phone, medicineName, dosage) {
  if (!MSG91_CONFIGURED) {
    return { success: false, provider: 'msg91_not_configured' };
  }
  try {
    const res = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
      body: JSON.stringify({
        integrated_number: MSG91_INTEGRATED_NUMBER,
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp',
          type: 'template',
          template: {
            name: MSG91_DOSE_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: medicineName },
                body_2: { type: 'text', value: dosage }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 template send failed:', JSON.stringify(data).substring(0, 200));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 WhatsApp template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Parses free-text vitals like "BP 120/80, temp 98.6, pulse 72" — deliberately permissive since
// real patients won't format this consistently. Returns only the fields it actually found.
function parseVitalsFromText(text) {
  const result = {};
  const bpMatch = text.match(/(\d{2,3})\s*\/\s*(\d{2,3})/); // "120/80" anywhere in the message
  if (bpMatch) {
    result.bpSystolic = parseInt(bpMatch[1], 10);
    result.bpDiastolic = parseInt(bpMatch[2], 10);
  }
  const tempMatch = text.match(/temp(?:erature)?[:\s]*([\d.]+)/i) || text.match(/([\d.]{3,5})\s*(?:f|°f|degrees)/i);
  if (tempMatch) result.temperature = parseFloat(tempMatch[1]);
  const hrMatch = text.match(/(?:pulse|hr|heart\s*rate)[:\s]*(\d{2,3})/i);
  if (hrMatch) result.heartRate = parseInt(hrMatch[1], 10);
  return result;
}

// ========== EMAIL SETUP (fallback for password reset — doesn't depend on WhatsApp opt-in) ==========
// Uses Gmail SMTP with an App Password (not your normal Gmail password — generate one free at
// https://myaccount.google.com/apppasswords). This exists because WhatsApp reset OTPs only reach
// patients/doctors who've connected their own CallMeBot key; email works for everyone with an
// email on file, so it's the dependable path when WhatsApp isn't set up yet.
const nodemailer = require('nodemailer');
let emailTransport = null;
if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
  emailTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
  });
  console.log('✅ Email fallback configured (' + process.env.EMAIL_USER + ')');
} else {
  console.log('ℹ️ Email fallback not configured — set EMAIL_USER and EMAIL_APP_PASSWORD to enable it');
}

async function sendResetEmail(toEmail, otp, name) {
  if (!emailTransport || !toEmail) return { success: false };
  try {
    await emailTransport.sendMail({
      from: `"Biomexa Pharmaceuticals" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: 'Your Biomexa password reset code',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#0d7377;">Biomexa Password Reset</h2>
        <p>Hi ${name || 'there'},</p>
        <p>Your one-time reset code is:</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:4px;color:#0d7377;">${otp}</p>
        <p>This code expires in ${OTP_EXPIRY_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>
        <p style="color:#888;font-size:13px;">— Biomexa Team</p>
      </div>`
    });
    console.log('✅ Reset email sent to', toEmail);
    return { success: true };
  } catch (err) {
    console.log('⚠️ Email send failed:', err.message);
    return { success: false };
  }
}

// ========== CALLMEBOT FREE WHATSAPP API ==========
// IMPORTANT — how CallMeBot actually works (this is the #1 reason WhatsApp messages silently
// don't arrive): a CallMeBot API key is tied to ONE phone number — the number that messaged
// CallMeBot and got the key back. That key can only be used to send messages TO that same
// number. A single global CALLMEBOT_API_KEY can therefore only ever message one phone — it
// CANNOT be used to message arbitrary patients or doctors.
//
// The fix: every patient and doctor who wants WhatsApp messages gets their OWN key (free, one
// minute to set up — see the signup forms) and stores it on their account. sendWhatsAppFree
// always prefers that per-user key. CALLMEBOT_API_KEY (env var) is kept only as a fallback for
// a single admin/testing number, and Twilio (if configured) as a paid fallback that can message
// any number once it has opted into your Twilio sandbox/business number.
// Sends a plain free-text message via MSG91 (no template/approval needed) — but WhatsApp's own
// rules mean this only delivers if the recipient has messaged your business number within the
// last 24 hours (an open "session"). For someone who has never messaged you, use
// sendDoseReminderTemplate instead (the approved template works regardless of session state).
async function sendMsg91Text(phone, message) {
  if (!MSG91_CONFIGURED) return { success: false, provider: 'msg91_not_configured' };
  try {
    const res = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
      body: JSON.stringify({
        integrated_number: MSG91_INTEGRATED_NUMBER,
        content_type: 'text',
        payload: {
          messaging_product: 'whatsapp',
          type: 'text',
          text: { body: message },
          to: phone.replace(/\D/g, '')
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 text send failed:', JSON.stringify(data).substring(0, 200));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 WhatsApp text sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 text send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

const CALLMEBOT_API_KEY = process.env.CALLMEBOT_API_KEY || null;

async function sendWhatsAppFree(phone, message, userApiKey) {
  const cleanPhone = phone.replace(/\D/g, '');

  // Try MSG91 first — it's the real business-number channel and needs no per-patient setup.
  // Only actually delivers if the recipient has an open 24h session (messaged your number
  // recently) — for a guaranteed-delivery first contact, use sendDoseReminderTemplate instead.
  if (MSG91_CONFIGURED) {
    const msg91Result = await sendMsg91Text(phone, message);
    if (msg91Result.success) return msg91Result;
  }

  const keyToUse = userApiKey || CALLMEBOT_API_KEY;

  if (keyToUse) {
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodeURIComponent(message)}&apikey=${keyToUse}`;
      await new Promise((resolve, reject) => {
        https.get(url, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              console.log('✅ CallMeBot WhatsApp sent to', phone);
              resolve(data);
            } else {
              reject(new Error(`CallMeBot status ${res.statusCode}: ${data}`));
            }
          });
        }).on('error', reject);
      });
      return { success: true, provider: 'callmebot' };
    } catch (err) {
      console.log('⚠️ CallMeBot failed for', phone, ':', err.message);
      if (!userApiKey) {
        console.log('   (No personal WhatsApp key on file for this number — this is expected unless it matches CALLMEBOT_API_KEY\'s own number.)');
      }
    }
  } else if (!MSG91_CONFIGURED) {
    console.log('⚠️ No CallMeBot key available for', phone, '— they have not connected their own WhatsApp key yet.');
  }

  // Fallback to Twilio if configured
  if (twilioClient && twilioPhone) {
    try {
      await twilioClient.messages.create({
        from: `whatsapp:+${twilioPhone}`,
        to: `whatsapp:${phone}`,
        body: message
      });
      console.log('✅ Twilio WhatsApp sent to', phone);
      return { success: true, provider: 'twilio' };
    } catch (err) {
      console.log('⚠️ Twilio failed:', err.message);
    }
  }

  console.log('❌ No WhatsApp provider could deliver to', phone);
  console.log('   Message was:', message.substring(0, 80) + '...');
  return { success: false, provider: 'none' };
}

// ========== MONGODB SETUP ==========
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/biomexa')
  .then(async () => {
    console.log('✅ MongoDB connected');
    await bootstrapAdmin();
  })
  .catch(err => console.log('❌ MongoDB connection error:', err.message));

// Creates the one admin account from ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_EMAIL env vars if no
// admin account exists yet in the database. Runs once per deploy — if an admin already exists,
// this does nothing, so it's always safe to leave in place.
async function bootstrapAdmin() {
  try {
    const existing = await Admin.findOne();
    if (existing) return;

    const username = process.env.ADMIN_USERNAME || 'biomexadmin';
    const password = process.env.ADMIN_PASSWORD || 'BiomexaAdmin@2026';
    const email = process.env.ADMIN_EMAIL || 'biomexapharmaceuticals@gmail.com';
    const hashed = await bcrypt.hash(password, 10);
    await Admin.create({ username, password: hashed, email });
    console.log(`✅ Bootstrapped admin account "${username}" — set ADMIN_USERNAME/ADMIN_PASSWORD env vars to change the starting credentials before this runs.`);
  } catch (err) {
    console.log('⚠️ Admin bootstrap failed:', err.message);
  }
}

// ========== SCHEMAS ==========
const patientSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true },
  email: String,
  password: String,
  whatsappApiKey: String, // patient's own CallMeBot key — required for THEM to receive WhatsApp messages, see note below
  baselineVitals: {
    bpSystolic: Number,
    bpDiastolic: Number,
    glucose: Number,
    temperature: Number
  },
  medicalHistory: [String],
  medicines: [{
    name: String,
    dosage: String,
    time: String,
    frequency: String,
    foodNote: String,
    active: { type: Boolean, default: true }
  }],
  createdAt: { type: Date, default: Date.now }
});

const doseSchema = new mongoose.Schema({
  patientPhone: String,
  medicineName: String,
  dosage: String,
  scheduledTime: String,
  scheduledDate: String,
  status: { type: String, default: 'pending' },
  foodNote: String,
  sentReminder: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const otpSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  role: { type: String, default: 'patient' }, // 'patient' | 'doctor' — which account this OTP resets
  otp: { type: String, required: true },
  resetToken: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Doctor account — real signup/login for the doctor connect portal
const doctorSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, unique: true }, // WhatsApp number, used for connect alerts
  password: String,
  whatsappApiKey: String, // doctor's own CallMeBot key — required for THEM to receive WhatsApp messages
  specialty: { type: String, default: 'General Physician' },
  licenseNumber: String,
  experienceYears: { type: Number, default: 0 },
  bio: String,
  available: { type: Boolean, default: true }, // toggled by doctor from dashboard
  status: { type: String, default: 'pending' }, // pending | verified (admin can flip later)
  createdAt: { type: Date, default: Date.now }
});

// Logs every "Connect me with a doctor" request from the home page / patient portal
const connectRequestSchema = new mongoose.Schema({
  doctorId: String,
  doctorName: String,
  patientName: String,
  patientPhone: String,
  urgency: { type: String, default: 'normal' }, // normal | high — set when the patient's risk score is high
  message: String,
  status: { type: String, default: 'sent' },
  createdAt: { type: Date, default: Date.now }
});

// Real vitals captured from the WhatsApp dose/vitals flow (MSG91 webhook) — a proper time-series
// log, not just the single baseline snapshot. This is what makes the AI engine's effectiveness
// analysis genuinely accurate over time instead of approximated from one baseline reading.
const vitalsLogSchema = new mongoose.Schema({
  patientPhone: String,
  bpSystolic: Number,
  bpDiastolic: Number,
  temperature: Number,
  heartRate: Number,
  source: { type: String, default: 'whatsapp' }, // whatsapp | manual | doctor
  recordedAt: { type: Date, default: Date.now }
});

// Tracks what we're waiting for next from a patient on WhatsApp — dose confirmation, then vitals,
// then nothing. This is what lets the inbound webhook interpret a short reply like "Taken" or
// "120/80" correctly, based on where the conversation currently is.
const conversationStateSchema = new mongoose.Schema({
  patientPhone: { type: String, unique: true },
  state: { type: String, default: null }, // 'awaiting_dose_confirm' | 'awaiting_vitals' | null
  doseId: String,
  updatedAt: { type: Date, default: Date.now }
});

// Auto-triggered whenever a WhatsApp-logged vital reading falls into a dangerous range — this is
// what powers the "risk alert" system end to end: patient logs vitals → this fires → doctor gets
// notified on WhatsApp → shows up on both dashboards until a doctor acknowledges it.
const riskAlertSchema = new mongoose.Schema({
  patientPhone: String,
  patientName: String,
  reason: String, // human-readable, e.g. "Hypertensive crisis: BP 185/122"
  vitals: {
    bpSystolic: Number,
    bpDiastolic: Number,
    temperature: Number,
    heartRate: Number
  },
  severity: { type: String, default: 'high' }, // high | critical
  notifiedDoctorPhone: String,
  acknowledged: { type: Boolean, default: false },
  acknowledgedBy: String,
  createdAt: { type: Date, default: Date.now }
});

// Real admin account — replaces the old single hardcoded env-var credential. Bootstrapped
// automatically on server startup from ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_EMAIL if no admin
// account exists yet in the database, so no manual database access is ever needed to set one up.
const adminSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  email: String,
  password: String,
  createdAt: { type: Date, default: Date.now }
});

const Patient = mongoose.model('Patient', patientSchema);
const Dose = mongoose.model('Dose', doseSchema);
const Otp = mongoose.model('Otp', otpSchema);
const Doctor = mongoose.model('Doctor', doctorSchema);
const ConnectRequest = mongoose.model('ConnectRequest', connectRequestSchema);
const VitalsLog = mongoose.model('VitalsLog', vitalsLogSchema);
const ConversationState = mongoose.model('ConversationState', conversationStateSchema);
const RiskAlert = mongoose.model('RiskAlert', riskAlertSchema);
const Admin = mongoose.model('Admin', adminSchema);

// Clinical thresholds for auto-flagging a logged vital reading as dangerous. These are
// deliberately conservative (err toward flagging) since a false alarm costs a doctor a glance,
// but a missed one costs a lot more. Returns null if nothing is concerning, or a reason string.
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

  return reasons.length ? { reason: reasons.join('; '), severity } : null;
}

// Fires a real risk alert: saves it, notifies an available doctor on WhatsApp, and warns the
// patient too. Called from the MSG91 webhook right after vitals are logged.
async function triggerRiskAlert(patient, vitals) {
  const danger = checkVitalsDanger(vitals);
  if (!danger) return null;

  const availableDoctor = await Doctor.findOne({ available: true }).sort({ createdAt: -1 });

  const alert = await RiskAlert.create({
    patientPhone: patient.phone,
    patientName: patient.name,
    reason: danger.reason,
    vitals,
    severity: danger.severity,
    notifiedDoctorPhone: availableDoctor?.phone || null
  });

  if (availableDoctor) {
    const doctorMsg = `🚨 *RISK ALERT — ${danger.severity.toUpperCase()}*\n\nPatient: ${patient.name}\nPhone: ${patient.phone}\nIssue: ${danger.reason}\n\nLogged via Biomexa WhatsApp vitals capture. Please reach out as soon as possible.\n\n- Biomexa Team`;
    sendWhatsAppFree(availableDoctor.phone, doctorMsg, availableDoctor.whatsappApiKey);
  }

  sendWhatsAppFree(
    patient.phone,
    `⚠️ Your recent reading (${danger.reason}) is outside the normal range. A doctor has been notified and may reach out. If you feel unwell, please seek medical attention now.`,
    patient.whatsappApiKey
  );

  return alert;
}

// ========== AUTH MIDDLEWARE ==========
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// ========== UTILITY FUNCTIONS ==========
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateResetToken() {
  return jwt.sign({ random: Math.random() }, JWT_SECRET, { expiresIn: '1h' });
}

// ========== AUTH ROUTES ==========

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, email, password, whatsappApiKey } = req.body;
    const existing = await Patient.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'Phone number already registered. Please login.' });

    const hashed = await bcrypt.hash(password, 10);
    const patient = new Patient({ name, phone, email, password: hashed, whatsappApiKey });
    await patient.save();

    const token = jwt.sign({ id: patient._id, phone }, JWT_SECRET);

    // Welcome message — tries MSG91 first (works if a session happens to be open), then
    // CallMeBot (if whatsappApiKey given) or Twilio. Note: a brand-new contact who has never
    // messaged your business number won't receive free-text via MSG91 until they message you
    // first (WhatsApp's 24h session rule) — this is a platform limitation, not a bug. Once they
    // add a medicine, that reminder still fires correctly via the approved template regardless.
    const welcomeMsg = `🎉 Welcome to Biomexa, ${name}!\n\nYour WhatsApp dose reminders are now active. We'll notify you when it's time to take your medicine.\n\nReply CONFIRM after each dose to track your adherence.\n\n- Biomexa Team`;
    const waResult = await sendWhatsAppFree(phone, welcomeMsg, whatsappApiKey);

    res.json({ message: 'Registered successfully', token, patient: { name, phone }, whatsappConnected: waResult.success });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Quick reminder setup — the low-friction path used on product pages (Telmexa AM, Diabmexa M).
// A visitor just browsing a product page can set a reminder for THAT medicine in one step, no
// password to type. If MSG91 is active, this works immediately with zero WhatsApp setup on their
// end. Under the hood this still creates a real Patient account (random password) so the same
// person can later log in properly via "Forgot password" if they want the full dashboard.
app.post('/api/quick-reminder', async (req, res) => {
  try {
    const { name, phone, medicineName, dosage, time, foodNote } = req.body;
    if (!name || !phone || !medicineName || !time) {
      return res.status(400).json({ message: 'Name, phone, medicine, and time are required.' });
    }
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(time)) {
      return res.status(400).json({ message: 'Time must be in 24-hour format (HH:MM), e.g. 09:00' });
    }

    let patient = await Patient.findOne({ phone });
    let isNewAccount = false;

    if (!patient) {
      isNewAccount = true;
      const randomPassword = crypto.randomBytes(12).toString('hex');
      const hashed = await bcrypt.hash(randomPassword, 10);
      patient = await Patient.create({ name, phone, password: hashed, medicines: [] });
    }

    patient.medicines.push({ name: medicineName, dosage: dosage || '', time, frequency: 'daily', foodNote: foodNote || '', active: true });
    await patient.save();

    const today = new Date().toISOString().split('T')[0];
    await Dose.create({
      patientPhone: phone,
      medicineName,
      dosage: dosage || '',
      scheduledTime: time,
      scheduledDate: today,
      foodNote: foodNote || '',
      status: 'pending'
    });

    const msg = isNewAccount
      ? `🎉 Hi ${name}! Your reminder for *${medicineName}* is set for ${time} daily.\n\nWe've also created your Biomexa account with this number — use "Forgot password" on the login page anytime if you want full dashboard access.\n\n- Biomexa Team`
      : `✅ Added a new reminder for *${medicineName}* at ${time} daily to your existing Biomexa account.\n\n- Biomexa Team`;

    // A brand-new contact hasn't messaged your business number yet, so MSG91 free-text delivery
    // isn't guaranteed (WhatsApp only allows that within an open 24h session). The approved
    // template works regardless of session state, so try that first for new accounts — existing
    // patients have likely already messaged in before, so plain text is fine for them.
    let waResult;
    if (isNewAccount && MSG91_CONFIGURED) {
      waResult = await sendDoseReminderTemplate(phone, medicineName, dosage || '');
      if (!waResult.success) waResult = await sendWhatsAppFree(phone, msg, patient.whatsappApiKey);
    } else {
      waResult = await sendWhatsAppFree(phone, msg, patient.whatsappApiKey);
    }

    res.json({
      message: isNewAccount ? 'Reminder set and account created!' : 'Reminder added to your existing account!',
      isNewAccount,
      whatsappSent: waResult.success
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const patient = await Patient.findOne({ phone });
    if (!patient) return res.status(400).json({ message: 'User not found' });

    const match = await bcrypt.compare(password, patient.password);
    if (!match) return res.status(400).json({ message: 'Invalid password' });

    const token = jwt.sign({ id: patient._id, phone }, JWT_SECRET);

    // Get today's doses for the welcome message
    const today = new Date().toISOString().split('T')[0];
    const todayDoses = await Dose.find({
      patientPhone: phone,
      scheduledDate: today,
      status: 'pending'
    }).sort({ scheduledTime: 1 });

    let loginMsg = `👋 Welcome back, ${patient.name}!\n\nYou've successfully logged in to Biomexa.`;
    if (todayDoses.length > 0) {
      const nextDose = todayDoses[0];
      loginMsg += `\n\n💊 Your next dose:\n*${nextDose.medicineName}* — ${nextDose.dosage}\n⏰ ${nextDose.scheduledTime}`;
      if (nextDose.foodNote) loginMsg += `\n🍽️ ${nextDose.foodNote}`;
    } else {
      loginMsg += `\n\n✅ No pending doses for today. Great job!`;
    }
    loginMsg += `\n\n- Biomexa Team`;

    sendWhatsAppFree(phone, loginMsg, patient.whatsappApiKey);

    res.json({
      token,
      user: {
        name: patient.name,
        phone: patient.phone,
        baselineVitals: patient.baselineVitals,
        medicalHistory: patient.medicalHistory
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== FORGOT PASSWORD (patients & doctors, WhatsApp + email) ==========
// Tries WhatsApp first (only works if the account has a personal CallMeBot key on file),
// then email (works for anyone with an email on file, once EMAIL_USER/EMAIL_APP_PASSWORD are set).
// Succeeds if EITHER channel delivers — the response tells the frontend which ones worked.
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { phone, role } = req.body;
    const isDoctor = role === 'doctor';
    const isAdmin = role === 'admin';

    // Admin has no phone number — the frontend sends the admin's username in the same field.
    // The Otp collection's "phone" field doubles as that identifier for the admin role.
    const account = isAdmin
      ? await Admin.findOne({ username: phone })
      : isDoctor ? await Doctor.findOne({ phone }) : await Patient.findOne({ phone });
    if (!account) return res.status(400).json({ message: `No ${isAdmin ? 'admin' : isDoctor ? 'doctor' : 'patient'} account found${isAdmin ? ' with this username' : ' with this phone number'}` });

    const roleKey = isAdmin ? 'admin' : isDoctor ? 'doctor' : 'patient';
    const identifier = isAdmin ? account.username : phone;

    const otp = generateOTP();
    const resetToken = generateResetToken();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await Otp.updateMany({ phone: identifier, role: roleKey, used: false }, { used: true });
    await Otp.create({ phone: identifier, role: roleKey, otp, resetToken, expiresAt });

    const otpMsg = `🔐 *Biomexa Password Reset*\n\nYour OTP code is: *${otp}*\n\nThis code will expire in ${OTP_EXPIRY_MINUTES} minutes.\n\nIf you didn't request this, please ignore this message.\n\n- Biomexa Team`;

    // Admin has no WhatsApp number tied to the account — email only.
    const waResult = isAdmin ? { success: false } : await sendWhatsAppFree(phone, otpMsg, account.whatsappApiKey);
    const emailResult = await sendResetEmail(account.email, otp, account.name || account.username);

    if (!waResult.success && !emailResult.success) {
      return res.status(500).json({
        message: isAdmin
          ? 'Could not deliver the code by email. Make sure EMAIL_USER/EMAIL_APP_PASSWORD are configured on the server.'
          : account.whatsappApiKey || account.email
            ? 'Could not deliver the code over WhatsApp or email. Please try again in a moment.'
            : 'This account has no WhatsApp key or email on file to send a reset code to. Please contact support.'
      });
    }

    const channels = [waResult.success && 'WhatsApp', emailResult.success && 'email'].filter(Boolean).join(' and ');
    res.json({ message: `OTP sent via ${channels}`, sentVia: { whatsapp: waResult.success, email: emailResult.success } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp, role } = req.body;
    const roleKey = role === 'admin' ? 'admin' : role === 'doctor' ? 'doctor' : 'patient';

    const otpRecord = await Otp.findOne({
      phone,
      otp,
      role: roleKey,
      used: false,
      expiresAt: { $gt: new Date() }
    });

    if (!otpRecord) {
      return res.status(400).json({ message: 'Invalid or expired OTP. Please request a new one.' });
    }

    res.json({ message: 'OTP verified', resetToken: otpRecord.resetToken });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, resetToken, newPassword, role } = req.body;
    const isDoctor = role === 'doctor';
    const isAdmin = role === 'admin';
    const roleKey = isAdmin ? 'admin' : isDoctor ? 'doctor' : 'patient';

    const otpRecord = await Otp.findOne({
      phone,
      resetToken,
      role: roleKey,
      used: false,
      expiresAt: { $gt: new Date() }
    });

    if (!otpRecord) {
      return res.status(400).json({ message: 'Invalid or expired reset token. Please start over.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    if (isAdmin) {
      await Admin.findOneAndUpdate({ username: phone }, { password: hashed });
    } else if (isDoctor) {
      await Doctor.findOneAndUpdate({ phone }, { password: hashed });
    } else {
      await Patient.findOneAndUpdate({ phone }, { password: hashed });
    }

    otpRecord.used = true;
    await otpRecord.save();

    if (!isAdmin) {
      const confirmMsg = `✅ *Password Reset Successful*\n\nYour Biomexa password has been reset successfully.\n\nIf you didn't do this, please contact support immediately.\n\n- Biomexa Team`;
      const account = isDoctor ? await Doctor.findOne({ phone }) : await Patient.findOne({ phone });
      sendWhatsAppFree(phone, confirmMsg, account?.whatsappApiKey);
    }

    res.json({ message: 'Password reset successful. Please login with your new password.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get Patient Profile
app.get('/api/patient/profile', auth, async (req, res) => {
  try {
    const patient = await Patient.findOne({ phone: req.user.phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });
    res.json(patient);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Connect / update a patient's own CallMeBot key after signup — this is what actually turns
// reminders on for accounts created before the key was collected, or after they lose/regenerate it.
app.patch('/api/patient/whatsapp-key', auth, async (req, res) => {
  try {
    const { whatsappApiKey } = req.body;
    await Patient.findOneAndUpdate({ phone: req.user.phone }, { whatsappApiKey });
    res.json({ message: 'WhatsApp key saved' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Sends one real WhatsApp message right now, so a patient can immediately confirm their
// key actually works instead of waiting for the next scheduled dose reminder.
app.post('/api/patient/test-whatsapp', auth, async (req, res) => {
  try {
    const patient = await Patient.findOne({ phone: req.user.phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });
    if (!patient.whatsappApiKey) return res.status(400).json({ message: 'No WhatsApp key saved on your account yet.' });

    const result = await sendWhatsAppFree(patient.phone, `🧪 *Test message from Biomexa*\n\nIf you're reading this on WhatsApp, your reminders are connected and working.\n\n- Biomexa Team`, patient.whatsappApiKey);
    if (!result.success) return res.status(500).json({ message: 'Could not deliver a test message. Double check the key you pasted matches the one CallMeBot sent you.' });
    res.json({ message: 'Test message sent — check your WhatsApp.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ========== MEDICINE ROUTES ==========

// Add Medicine
app.post('/api/medicines', auth, async (req, res) => {
  try {
    const { name, dosage, time, frequency, foodNote } = req.body;

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(time)) {
      return res.status(400).json({ message: 'Time must be in 24-hour format (HH:MM), e.g. 14:30' });
    }

    const patient = await Patient.findOneAndUpdate(
      { phone: req.user.phone },
      { $push: { medicines: { name, dosage, time, frequency, foodNote, active: true } } },
      { new: true }
    );

    const today = new Date().toISOString().split('T')[0];
    await Dose.create({
      patientPhone: req.user.phone,
      medicineName: name,
      dosage,
      scheduledTime: time,
      scheduledDate: today,
      foodNote: foodNote || '',
      status: 'pending'
    });

    // Send confirmation WhatsApp
    const confirmMsg = `💊 *Medicine Added*\n\n${name} — ${dosage}\n⏰ ${time}\n${foodNote ? '🍽️ ' + foodNote + '\n' : ''}\nYou'll receive a WhatsApp reminder when it's time to take it.\n\n- Biomexa Team`;
    sendWhatsAppFree(req.user.phone, confirmMsg, patient.whatsappApiKey);

    res.json({ message: 'Medicine added and dose scheduled for today', medicines: patient.medicines });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get Medicines
app.get('/api/medicines', auth, async (req, res) => {
  try {
    const patient = await Patient.findOne({ phone: req.user.phone });
    res.json(patient?.medicines || []);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== DOSE ROUTES ==========

// Get Today's Doses
app.get('/api/doses/today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const doses = await Dose.find({
      patientPhone: req.user.phone,
      scheduledDate: today
    }).sort({ scheduledTime: 1 });
    res.json(doses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Confirm Dose
app.post('/api/doses/:id/confirm', auth, async (req, res) => {
  try {
    const dose = await Dose.findOneAndUpdate(
      { _id: req.params.id, patientPhone: req.user.phone },
      { status: 'taken' },
      { new: true }
    );
    if (!dose) return res.status(404).json({ message: 'Dose not found' });

    // Send confirmation WhatsApp
    const patient = await Patient.findOne({ phone: req.user.phone });
    const confirmMsg = `✅ *Dose Confirmed*\n\n${dose.medicineName} — ${dose.dosage}\n⏰ Taken at ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}\n\nGreat job staying on track! 💪\n\n- Biomexa Team`;
    sendWhatsAppFree(req.user.phone, confirmMsg, patient?.whatsappApiKey);

    res.json({ message: 'Dose confirmed', dose });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== WHATSAPP REMINDER CRON ==========
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toISOString().split('T')[0];

  console.log(`⏰ [${currentTime}] Checking for pending doses...`);

  try {
    const pendingDoses = await Dose.find({
      scheduledDate: today,
      scheduledTime: currentTime,
      status: 'pending',
      sentReminder: false
    });

    console.log(`📋 Found ${pendingDoses.length} doses scheduled for ${currentTime}`);

    for (const dose of pendingDoses) {
      const patient = await Patient.findOne({ phone: dose.patientPhone });
      if (!patient) {
        console.log(`⚠️ Patient not found for ${dose.patientPhone}`);
        continue;
      }

      // Prefer MSG91's real two-way template (Taken/Not Taken buttons) when configured —
      // this is what lets the webhook below capture a structured reply instead of parsing
      // free text like "CONFIRM". Falls back to the plain-text CallMeBot/Twilio reminder.
      let sentVia = null;
      if (MSG91_CONFIGURED) {
        const msg91Result = await sendDoseReminderTemplate(dose.patientPhone, dose.medicineName, dose.dosage);
        if (msg91Result.success) {
          sentVia = 'msg91';
          await ConversationState.findOneAndUpdate(
            { patientPhone: dose.patientPhone },
            { state: 'awaiting_dose_confirm', doseId: dose._id.toString(), updatedAt: new Date() },
            { upsert: true }
          );
        }
      }

      if (!sentVia) {
        const message = `⏰ *Dose Reminder*\n\nHello ${patient.name},\n\nIt's time to take your medicine:\n*${dose.medicineName}* — ${dose.dosage}\n\n${dose.foodNote ? '🍽️ ' + dose.foodNote + '\n\n' : ''}Reply CONFIRM once you've taken it.\n\n- Biomexa Team`;
        const result = await sendWhatsAppFree(dose.patientPhone, message, patient.whatsappApiKey);
        if (result.success) sentVia = 'fallback';
      }

      if (sentVia) {
        await Dose.findByIdAndUpdate(dose._id, { sentReminder: true });
        console.log(`✅ Reminder sent to ${dose.patientPhone} for ${dose.medicineName} at ${currentTime} via ${sentVia}`);
      } else {
        console.log(`❌ Failed to send reminder to ${dose.patientPhone}`);
      }
    }
  } catch (err) {
    console.error('❌ Cron error:', err.message);
  }
});

// ========== MSG91 WHATSAPP WEBHOOK — inbound dose confirmation & vitals ==========
// This is the endpoint you point MSG91's inbound WhatsApp webhook at (see setup notes above
// sendDoseReminderTemplate). It's intentionally defensive about field names — MSG91's exact
// inbound JSON shape can vary slightly by how your webhook's "Customize Data Parameters" is
// configured in their dashboard. If replies aren't being matched, log the raw req.body (already
// done below) and adjust the field names pulled out here to match what you actually receive.
app.post('/api/webhooks/msg91-whatsapp', async (req, res) => {
  // Acknowledge immediately — MSG91 (like most WhatsApp BSPs) expects a fast 200 response
  // and will retry on timeout, which could cause duplicate processing otherwise.
  res.status(200).json({ received: true });

  try {
    console.log('📩 MSG91 webhook payload:', JSON.stringify(req.body).substring(0, 500));
    const body = req.body || {};
    const payload = body.payload || body; // some MSG91 webhook configs nest under "payload"

    // Only handle genuinely inbound messages when a "direction" field is present — the
    // "On Inbound Request Received" event (what this endpoint is meant for) doesn't send one
    // at all since the event itself only fires for inbound messages, so this is just a safety
    // check in case a different/broader event ever gets pointed at this same URL by mistake.
    if (payload.direction !== undefined && String(payload.direction) !== '0') return;

    // Confirmed field name from MSG91's "On Inbound Request Received" payload picker: customerNumber.
    // Older guesses kept as fallback in case this ever changes or a different event type is used.
    const rawPhone = payload.customerNumber || payload.mobile || payload.msisdn
      || (payload.user && payload.user.msisdn) || payload.from;
    if (!rawPhone) { console.log('⚠️ Could not find sender phone in MSG91 webhook payload'); return; }
    const phone = '+' + rawPhone.replace(/\D/g, '');

    // Button reply — confirmed as a flat top-level "button" field, not nested. Its own value can
    // still be a JSON string like {"payload":"Taken","text":"Taken"} depending on message type,
    // so this handles both a plain string and that JSON-string shape.
    let buttonText = null;
    if (payload.button) {
      try {
        const btn = typeof payload.button === 'string' && payload.button.trim().startsWith('{')
          ? JSON.parse(payload.button) : payload.button;
        buttonText = typeof btn === 'string' ? btn.toLowerCase() : (btn.text || btn.payload || '').toLowerCase();
      } catch { buttonText = String(payload.button).toLowerCase(); }
    }

    // Free text — confirmed as a flat top-level "text" field (not nested under "content" as
    // originally assumed). Kept payload.content as a fallback in case that ever appears instead.
    let freeText = '';
    if (payload.text) {
      freeText = String(payload.text).trim();
    } else if (payload.content) {
      try {
        const c = typeof payload.content === 'string' ? JSON.parse(payload.content) : payload.content;
        freeText = (c.text || '').trim();
      } catch { freeText = String(payload.content).trim(); }
    }

    const convo = await ConversationState.findOne({ patientPhone: phone });
    const patient = await Patient.findOne({ phone });

    if (convo && convo.state === 'awaiting_dose_confirm') {
      const reply = buttonText || freeText.toLowerCase();
      const took = /taken|yes|confirm/.test(reply) && !/not\s*taken|no\b/.test(reply);
      const explicitlyMissed = /not\s*taken|missed|no\b/.test(reply);

      if (took || explicitlyMissed) {
        await Dose.findByIdAndUpdate(convo.doseId, { status: took ? 'taken' : 'missed' });

        if (took) {
          await sendWhatsAppFree(phone, `✅ Great, logged as taken! Quick check-in — reply with your BP, temperature and pulse if you have them handy (e.g. "BP 120/80, temp 98.6, pulse 72"). Or just reply "skip".`, patient?.whatsappApiKey);
          await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: 'awaiting_vitals', updatedAt: new Date() });
        } else {
          await sendWhatsAppFree(phone, `Noted — marked as not taken. Please try to take it as soon as possible, or reach out to your doctor via the Biomexa app if you're having trouble with this medicine.`, patient?.whatsappApiKey);
          await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: null, doseId: null, updatedAt: new Date() });
        }
      }
      return;
    }

    if (convo && convo.state === 'awaiting_vitals') {
      if (/^skip$/i.test(freeText.trim())) {
        await sendWhatsAppFree(phone, `No problem — see you at the next dose! 💪`, patient?.whatsappApiKey);
        await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: null, updatedAt: new Date() });
        return;
      }

      const vitals = parseVitalsFromText(freeText);
      if (Object.keys(vitals).length === 0) {
        await sendWhatsAppFree(phone, `Sorry, I couldn't read any vitals from that. Try a format like "BP 120/80, temp 98.6, pulse 72" — or reply "skip".`, patient?.whatsappApiKey);
        return;
      }

      await VitalsLog.create({ patientPhone: phone, ...vitals, source: 'whatsapp' });

      // Keep the patient's baseline snapshot current too, so anywhere that reads baselineVitals
      // (dashboards, the AI engine fallback) reflects their latest reading.
      const baselineUpdate = {};
      if (vitals.bpSystolic) baselineUpdate['baselineVitals.bpSystolic'] = vitals.bpSystolic;
      if (vitals.bpDiastolic) baselineUpdate['baselineVitals.bpDiastolic'] = vitals.bpDiastolic;
      if (vitals.temperature) baselineUpdate['baselineVitals.temperature'] = vitals.temperature;
      if (Object.keys(baselineUpdate).length) await Patient.findOneAndUpdate({ phone }, baselineUpdate);

      const summary = [
        vitals.bpSystolic && `BP ${vitals.bpSystolic}/${vitals.bpDiastolic}`,
        vitals.temperature && `Temp ${vitals.temperature}°F`,
        vitals.heartRate && `Pulse ${vitals.heartRate}`
      ].filter(Boolean).join(', ');

      // Risk check — if this reading is dangerous, triggerRiskAlert handles notifying both the
      // patient and an available doctor. The "logged" confirmation still goes out either way.
      const alert = patient ? await triggerRiskAlert(patient, vitals) : null;
      if (!alert) {
        await sendWhatsAppFree(phone, `📊 Logged: ${summary}. Thanks — this is saved to your Biomexa dashboard now.`, patient?.whatsappApiKey);
      }
      await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: null, doseId: null, updatedAt: new Date() });
      return;
    }

    // No active conversation state — unsolicited message, just acknowledge quietly in logs.
    console.log(`ℹ️ Unsolicited WhatsApp message from ${phone}, no active flow: "${freeText || buttonText}"`);
  } catch (err) {
    console.error('❌ MSG91 webhook processing error:', err.message);
  }
});

// ========== DOCTOR ROUTES (Mock login kept for the legacy staff dashboard) ==========
app.get('/api/doctor/login', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ message: 'Basic auth required' });
  }
  const creds = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (creds[0] === 'drsharma' && creds[1] === 'biomexa2026') {
    return res.json({ message: 'Doctor authenticated' });
  }
  res.status(401).json({ message: 'Invalid credentials' });
});

// ========== DOCTOR SIGNUP / LOGIN / AVAILABILITY (real accounts) ==========
const doctorAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'doctor') return res.status(403).json({ message: 'Doctor account required' });
    req.doctor = decoded;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Doctor signup — creates a real doctor account for the "Connect with a Doctor" portal
app.post('/api/doctors/register', async (req, res) => {
  try {
    const { name, email, phone, password, specialty, licenseNumber, experienceYears, bio, whatsappApiKey } = req.body;
    if (!name || !phone || !password || !licenseNumber) {
      return res.status(400).json({ message: 'Name, WhatsApp number, password and license number are required' });
    }
    const existing = await Doctor.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'A doctor account already exists with this phone number' });

    const hashed = await bcrypt.hash(password, 10);
    const doctor = new Doctor({ name, email, phone, password: hashed, whatsappApiKey, specialty, licenseNumber, experienceYears, bio, available: true });
    await doctor.save();

    const token = jwt.sign({ id: doctor._id, phone, role: 'doctor' }, JWT_SECRET);

    const welcomeMsg = `👨‍⚕️ *Welcome to Biomexa, Dr. ${name}!*\n\nYour doctor profile is now live on the Biomexa Connect network. Patients with a high risk score can reach you instantly via WhatsApp.\n\nYou're marked *Available* by default — toggle this anytime from your dashboard.\n\n- Biomexa Team`;
    sendWhatsAppFree(phone, welcomeMsg, whatsappApiKey);

    res.json({ message: 'Doctor registered successfully', token, doctor: { id: doctor._id, name, phone, specialty: doctor.specialty, available: doctor.available } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Doctor login (real accounts)
app.post('/api/doctors/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const doctor = await Doctor.findOne({ phone });
    if (!doctor) return res.status(400).json({ message: 'No doctor account found with this number' });

    const match = await bcrypt.compare(password, doctor.password);
    if (!match) return res.status(400).json({ message: 'Invalid password' });

    const token = jwt.sign({ id: doctor._id, phone, role: 'doctor' }, JWT_SECRET);
    res.json({ token, doctor: { id: doctor._id, name: doctor.name, phone: doctor.phone, specialty: doctor.specialty, available: doctor.available, experienceYears: doctor.experienceYears } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Toggle / set availability — shown live on the home page & patient portal
app.patch('/api/doctors/availability', doctorAuth, async (req, res) => {
  try {
    const { available } = req.body;
    const doctor = await Doctor.findByIdAndUpdate(req.doctor.id, { available: !!available }, { new: true });
    res.json({ message: 'Availability updated', available: doctor.available });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Doctor's own profile
app.get('/api/doctors/me', doctorAuth, async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.doctor.id).select('-password');
    res.json(doctor);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Connect / update a doctor's own CallMeBot key — needed to actually receive patient connect alerts.
app.patch('/api/doctors/whatsapp-key', doctorAuth, async (req, res) => {
  try {
    const { whatsappApiKey } = req.body;
    await Doctor.findByIdAndUpdate(req.doctor.id, { whatsappApiKey });
    res.json({ message: 'WhatsApp key saved' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/doctors/test-whatsapp', doctorAuth, async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.doctor.id);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found' });
    if (!doctor.whatsappApiKey) return res.status(400).json({ message: 'No WhatsApp key saved on your account yet.' });

    const result = await sendWhatsAppFree(doctor.phone, `🧪 *Test message from Biomexa*\n\nIf you're reading this on WhatsApp, patient connect alerts will reach you.\n\n- Biomexa Team`, doctor.whatsappApiKey);
    if (!result.success) return res.status(500).json({ message: 'Could not deliver a test message. Double check the key you pasted matches the one CallMeBot sent you.' });
    res.json({ message: 'Test message sent — check your WhatsApp.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Public list of doctors — powers the "Doctors Available" section on the home page & patient portal
app.get('/api/doctors', async (req, res) => {
  try {
    const doctors = await Doctor.find().select('-password').sort({ available: -1, createdAt: -1 }).limit(50);
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// "Connect me now" — fired from the home page or patient portal when a patient wants a doctor urgently.
// Notifies the doctor over WhatsApp with the patient's details and urgency level.
app.post('/api/doctors/:id/connect', async (req, res) => {
  try {
    const { patientName, patientPhone, urgency, message } = req.body;
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found' });

    const flag = urgency === 'high' ? '🚨 *HIGH RISK PATIENT — PLEASE RESPOND PROMPTLY*' : '📩 *New Patient Connect Request*';
    const doctorMsg = `${flag}\n\nPatient: ${patientName || 'Anonymous'}\nContact: ${patientPhone || 'Not shared'}\n${message ? 'Note: ' + message + '\n' : ''}\nvia Biomexa Connect\n- Biomexa Team`;
    const result = await sendWhatsAppFree(doctor.phone, doctorMsg, doctor.whatsappApiKey);

    await ConnectRequest.create({
      doctorId: doctor._id, doctorName: doctor.name, patientName, patientPhone,
      urgency: urgency || 'normal', message
    });

    res.json({
      message: result.success ? 'Doctor has been notified on WhatsApp' : 'Request logged, but WhatsApp alert could not be sent',
      doctorPhone: doctor.phone,
      doctorName: doctor.name
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== MEDICINE CATALOG (links doctor view to the products already on the site) ==========
const MEDICINE_CATALOG = {
  'Telmexa AM': { slug: 'telmexa-am', dosage: '40mg/5mg', category: 'BP Management', url: '/products/telmexa-am.html' },
  'Diabmexa M 500': { slug: 'diabmexa-m-500', dosage: '500mg', category: 'Diabetes Care', url: '/products/diabmexa-m-500.html' }
};
const CATALOG_NAMES = Object.keys(MEDICINE_CATALOG);

app.get('/api/patients', async (req, res) => {
  // Uses the trained AI risk model (Admin panel → AI Risk Engine) when one exists.
  // Falls back to a deterministic adherence-based heuristic — never random — if no model has
  // been trained yet. BP figures remain baseline/simulated until real vitals logging is wired up.
  try {
    const model = await TrainedModel.findOne().sort({ trainedAt: -1 });
    const patients = await Patient.find().limit(50);
    const data = [];
    for (let i = 0; i < patients.length; i++) {
      const p = patients[i];
      const medName = p.medicines[0]?.name || CATALOG_NAMES[i % CATALOG_NAMES.length];
      const catalogEntry = MEDICINE_CATALOG[medName] || null;
      const bpBaseSys = p.baselineVitals?.bpSystolic || (115 + Math.floor(Math.random() * 30));
      const bpBaseDia = p.baselineVitals?.bpDiastolic || (75 + Math.floor(Math.random() * 15));

      const { features, adherence, missed } = await computePatientFeatures(p);
      let riskProb;
      if (model) {
        const norm = features.map((v, j) => (v - model.featureMeans[j]) / model.featureStds[j]);
        const z = norm.reduce((s, v, j) => s + v * model.weights[j], 0) + model.bias;
        riskProb = sigmoid(z);
      } else {
        riskProb = Math.max(0, Math.min(1, 1 - adherence));
      }
      const label = riskProb > 0.66 ? 'Critical' : riskProb > 0.33 ? 'High' : 'Low';

      data.push({
        id: i + 1,
        name: p.name,
        phone: p.phone,
        medicine: medName,
        medicineInfo: catalogEntry,
        adherence_score: Math.round(adherence * 100),
        bpSystolic: bpBaseSys,
        bpDiastolic: bpBaseDia,
        bpStatus: bpBaseSys >= 140 || bpBaseDia >= 90 ? 'high' : bpBaseSys < 100 ? 'low' : 'normal',
        risk_score: riskProb,
        ai_risk_label: label,
        ai_prediction: riskProb,
        missed_doses: missed,
        next_dose: new Date(Date.now() + Math.random() * 86400000),
        sentiment: adherence > 0.8 ? 'positive' : adherence < 0.5 ? 'negative' : 'neutral'
      });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 7-day adherence + BP trend for one patient — powers the "View Trends" panel in the doctor dashboard
app.get('/api/doctor/patient/:phone/vitals', async (req, res) => {
  try {
    const phone = req.params.phone;
    const patient = await Patient.findOne({ phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    const today = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      const dayDoses = await Dose.find({ patientPhone: phone, scheduledDate: dateStr });
      const taken = dayDoses.filter(x => x.status === 'taken').length;
      const adherence = dayDoses.length ? Math.round((taken / dayDoses.length) * 100) : null;

      days.push({
        date: dateStr,
        label: d.toLocaleDateString('en-IN', { weekday: 'short' }),
        adherence: adherence === null ? Math.floor(60 + Math.random() * 40) : adherence, // fallback demo value if no doses logged yet
        bpSystolic: (patient.baselineVitals?.bpSystolic || 120) + Math.floor(Math.random() * 10 - 5),
        bpDiastolic: (patient.baselineVitals?.bpDiastolic || 80) + Math.floor(Math.random() * 8 - 4)
      });
    }
    res.json({ patient: { name: patient.name, phone: patient.phone, baselineVitals: patient.baselineVitals }, days });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Full effectiveness analysis via the Python AI engine (ai_engine.py) — real vital-trend
// analysis, adherence scoring, clinical insights and treatment recommendations, computed from
// this patient's actual dose history. Note: since this platform doesn't yet log per-dose vitals
// or symptoms separately, those fields are approximated from the patient's baseline vitals —
// the adherence-driven parts of the analysis are fully real, the vital-trend parts are limited
// until per-dose vitals logging is added.
app.get('/api/doctor/patient/:phone/effectiveness', async (req, res) => {
  try {
    const phone = req.params.phone;
    const patient = await Patient.findOne({ phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    const doses = await Dose.find({ patientPhone: phone }).sort({ scheduledDate: 1 });
    if (!doses.length) {
      return res.status(400).json({ message: 'No dose history yet for this patient — nothing to analyze.' });
    }

    // Real vitals logged via the WhatsApp flow, if any — grouped by calendar day so each dose
    // can use the vitals actually recorded closest to that day instead of a flat baseline.
    const vitalsLogs = await VitalsLog.find({ patientPhone: phone }).sort({ recordedAt: 1 });
    const vitalsByDay = {};
    for (const v of vitalsLogs) {
      const day = v.recordedAt.toISOString().split('T')[0];
      vitalsByDay[day] = v; // last log of the day wins if there are several
    }
    const usedRealVitals = vitalsLogs.length > 0;

    const primaryMed = patient.medicines?.[0] || { name: doses[0].medicineName, dosage: doses[0].dosage, time: doses[0].scheduledTime };
    const schedule = [...new Set(patient.medicines?.map(m => m.time) || [doses[0].scheduledTime])];

    const dose_history = doses
      .filter(d => d.status !== 'pending') // only doses that have actually happened
      .map(d => {
        const dayLog = vitalsByDay[d.scheduledDate];
        return {
          date: d.scheduledDate,
          status: d.status === 'taken' ? 'taken' : 'not_taken',
          vitals: {
            bp_systolic: dayLog?.bpSystolic || patient.baselineVitals?.bpSystolic || 130,
            bp_diastolic: dayLog?.bpDiastolic || patient.baselineVitals?.bpDiastolic || 85,
            glucose: patient.baselineVitals?.glucose || 110,
            temperature: dayLog?.temperature || patient.baselineVitals?.temperature || 98.6
          },
          symptoms: []
        };
      });

    if (!dose_history.length) {
      return res.status(400).json({ message: 'All doses for this patient are still pending — nothing to analyze yet.' });
    }

    const payload = {
      patient: {
        id: patient.phone,
        drug_name: primaryMed.name || 'Unknown',
        drug_dose: primaryMed.dosage || '',
        schedule: schedule.length ? schedule : ['08:00'],
        baseline_bp: [patient.baselineVitals?.bpSystolic || 140, patient.baselineVitals?.bpDiastolic || 90],
        baseline_glucose: patient.baselineVitals?.glucose || 110,
        baseline_temp: patient.baselineVitals?.temperature || 98.6,
        history: patient.medicalHistory || [],
        baseline_blood_test: {}
      },
      dose_history,
      indication: req.query.indication || 'hypertension'
    };

    const result = await callAiEngine('/analyze', payload);
    if (!result.ok) {
      const messages = {
        not_configured: 'The AI engine (ai_engine.py) isn\'t deployed yet — set AI_ENGINE_URL in your environment once it is. See .env.example for deployment steps.',
        unreachable: 'Could not reach the AI engine service: ' + result.detail,
        engine_error: 'The AI engine returned an error: ' + result.detail
      };
      return res.status(503).json({ message: messages[result.reason] || 'AI engine unavailable', reason: result.reason });
    }

    res.json({ ...result.data, usedRealVitals });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Recent risk alerts — powers the alert banner on the doctor dashboard. Open (not doctorAuth-gated)
// to match the existing pattern of /api/doctors and /api/doctor/patient/:phone/vitals, since any
// doctor viewing the dashboard should see active alerts regardless of which patients are "theirs."
app.get('/api/doctor/alerts', async (req, res) => {
  try {
    const alerts = await RiskAlert.find({ acknowledged: false }).sort({ createdAt: -1 }).limit(50);
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/doctor/alerts/:id/acknowledge', async (req, res) => {
  try {
    const { doctorName } = req.body;
    await RiskAlert.findByIdAndUpdate(req.params.id, { acknowledged: true, acknowledgedBy: doctorName || 'Doctor' });
    res.json({ message: 'Alert acknowledged' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// A patient's own most recent risk alert (if any, and if still unacknowledged) — powers the
// urgent state on their "Talk to a Doctor" card, same treatment as low-adherence urgency.
app.get('/api/patient/latest-alert', auth, async (req, res) => {
  try {
    const alert = await RiskAlert.findOne({ patientPhone: req.user.phone, acknowledged: false }).sort({ createdAt: -1 });
    res.json(alert || null);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/export/patients', async (req, res) => {
  try {
    const patients = await Patient.find();
    let csv = 'Name,Phone,Medicines,AdherenceBaselineBP,RegisteredAt\n';
    patients.forEach(p => {
      const meds = (p.medicines || []).map(m => m.name).join('; ');
      const bp = p.baselineVitals?.bpSystolic ? `${p.baselineVitals.bpSystolic}/${p.baselineVitals.bpDiastolic || ''}` : '';
      csv += `"${p.name}","${p.phone}","${meds}","${bp}","${p.createdAt || ''}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="biomexa-patients.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== ADMIN AUTH + AI ENGINE ==========
// Checks the real Admin database record (bcrypt-hashed), not a static env-var string —
// this is what makes a real forgot-password flow possible below.
async function adminAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      return res.status(401).json({ message: 'Admin login required' });
    }
    const [u, p] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    const admin = await Admin.findOne({ username: u });
    if (!admin) return res.status(401).json({ message: 'Invalid admin username or password' });
    const match = await bcrypt.compare(p, admin.password);
    if (!match) return res.status(401).json({ message: 'Invalid admin username or password' });
    req.admin = admin;
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

app.get('/api/admin/login', adminAuth, (req, res) => {
  res.json({ message: 'Admin authenticated' });
});

// Admin's own password reset — updates the real database record. Reuses the same OTP flow
// as patients/doctors (see /api/auth/forgot-password below with role: 'admin'), delivered to
// the admin account's stored email since there's no WhatsApp number tied to a shared admin login.
app.patch('/api/admin/change-password', adminAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await Admin.findByIdAndUpdate(req.admin._id, { password: hashed });
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// A trained risk model — retrained from real patient/dose data via the Admin AI Engine panel
const trainedModelSchema = new mongoose.Schema({
  weights: [Number],
  bias: Number,
  featureMeans: [Number],
  featureStds: [Number],
  accuracy: Number,
  sampleSize: Number,
  trainedAt: { type: Date, default: Date.now }
});
const TrainedModel = mongoose.model('TrainedModel', trainedModelSchema);

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// Turns one patient's real Dose history into a feature vector for the risk model.
// Features deliberately exclude adherence itself (that's the training label) to avoid circularity —
// they capture regimen complexity and history instead: how many medicines, how many missed doses
// logged, how long they've been on the platform, and how often doses are scheduled per day.
async function computePatientFeatures(patient) {
  const doses = await Dose.find({ patientPhone: patient.phone });
  const total = doses.length;
  const missed = doses.filter(d => d.status === 'missed').length;
  const taken = doses.filter(d => d.status === 'taken').length;
  const adherence = total ? taken / total : 1;
  const daysSince = patient.createdAt ? Math.max(1, Math.floor((Date.now() - new Date(patient.createdAt)) / 86400000)) : 1;
  const numMedicines = (patient.medicines || []).length || 1;
  const doseFreq = total / daysSince;
  return { features: [numMedicines, missed, daysSince, doseFreq], adherence, missed, total };
}

// Trains a logistic-regression risk model from whatever real patient + dose data exists right now.
// Re-run this from the Admin panel any time new patient data comes in — it always retrains from scratch
// on the current data rather than incrementally updating, which keeps the model simple and reproducible.
app.post('/api/admin/train-ai', adminAuth, async (req, res) => {
  try {
    const patients = await Patient.find();
    const rows = [];
    for (const p of patients) {
      const { features, adherence, total } = await computePatientFeatures(p);
      if (total === 0) continue; // needs logged dose history to be useful training data
      rows.push({ features, label: adherence < 0.7 ? 1 : 0 });
    }
    if (rows.length < 3) {
      return res.status(400).json({ message: `Need at least 3 patients with logged dose history to train. Currently have ${rows.length}.` });
    }

    const nFeat = rows[0].features.length;
    const means = new Array(nFeat).fill(0);
    const stds = new Array(nFeat).fill(1);
    for (let j = 0; j < nFeat; j++) {
      const vals = rows.map(r => r.features[j]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      means[j] = mean;
      stds[j] = Math.sqrt(variance) || 1;
    }
    const X = rows.map(r => r.features.map((v, j) => (v - means[j]) / stds[j]));
    const y = rows.map(r => r.label);

    let w = new Array(nFeat).fill(0);
    let b = 0;
    const lr = 0.15;
    const epochs = 600;
    for (let e = 0; e < epochs; e++) {
      const gradW = new Array(nFeat).fill(0);
      let gradB = 0;
      for (let i = 0; i < X.length; i++) {
        const z = X[i].reduce((s, v, j) => s + v * w[j], 0) + b;
        const err = sigmoid(z) - y[i];
        for (let j = 0; j < nFeat; j++) gradW[j] += err * X[i][j];
        gradB += err;
      }
      for (let j = 0; j < nFeat; j++) w[j] -= lr * gradW[j] / X.length;
      b -= lr * gradB / X.length;
    }

    let correct = 0;
    for (let i = 0; i < X.length; i++) {
      const z = X[i].reduce((s, v, j) => s + v * w[j], 0) + b;
      if ((sigmoid(z) >= 0.5 ? 1 : 0) === y[i]) correct++;
    }
    const accuracy = correct / X.length;

    await TrainedModel.deleteMany({});
    const model = await TrainedModel.create({ weights: w, bias: b, featureMeans: means, featureStds: stds, accuracy, sampleSize: rows.length });

    res.json({
      message: 'Model trained successfully on real patient data',
      accuracy: (accuracy * 100).toFixed(1) + '%',
      sampleSize: rows.length,
      trainedAt: model.trainedAt
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/model', adminAuth, async (req, res) => {
  const model = await TrainedModel.findOne().sort({ trainedAt: -1 });
  if (!model) return res.json({ trained: false });
  res.json({ trained: true, accuracy: (model.accuracy * 100).toFixed(1) + '%', sampleSize: model.sampleSize, trainedAt: model.trainedAt });
});

// Admin's patient view — risk scores come from the trained model when one exists,
// and fall back to a deterministic adherence-based heuristic (never random) otherwise.
app.get('/api/admin/patients', adminAuth, async (req, res) => {
  try {
    const model = await TrainedModel.findOne().sort({ trainedAt: -1 });
    const patients = await Patient.find().limit(200);
    const data = [];
    for (let i = 0; i < patients.length; i++) {
      const p = patients[i];
      const { features, adherence, missed, total } = await computePatientFeatures(p);
      let riskProb;
      if (model) {
        const norm = features.map((v, j) => (v - model.featureMeans[j]) / model.featureStds[j]);
        const z = norm.reduce((s, v, j) => s + v * model.weights[j], 0) + model.bias;
        riskProb = sigmoid(z);
      } else {
        riskProb = Math.max(0, Math.min(1, 1 - adherence));
      }
      const label = riskProb > 0.66 ? 'Critical' : riskProb > 0.33 ? 'High' : 'Low';
      data.push({
        id: i + 1,
        name: p.name,
        phone: p.phone,
        medicine: p.medicines[0]?.name || 'None',
        adherence_score: Math.round(adherence * 100),
        risk_score: riskProb,
        ai_risk_label: label,
        ai_prediction: riskProb,
        missed_doses: missed,
        sentiment: total === 0 ? 'neutral' : (adherence > 0.8 ? 'positive' : adherence < 0.5 ? 'negative' : 'neutral')
      });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const patients = await Patient.find();
    const total = patients.length;
    let sumAdh = 0, highRisk = 0, counted = 0;
    for (const p of patients) {
      const { adherence, total: t } = await computePatientFeatures(p);
      if (t > 0) { sumAdh += adherence; counted++; if (adherence < 0.6) highRisk++; }
    }
    const avgAdh = counted ? Math.round((sumAdh / counted) * 100) : 0;
    const doseCount = await Dose.countDocuments();
    res.json({ total_patients: total, high_risk_patients: highRisk, average_adherence: avgAdh, total_interactions: doseCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/export/patients', adminAuth, async (req, res) => {
  try {
    const patients = await Patient.find();
    let csv = 'Name,Phone,Medicines,RegisteredAt\n';
    patients.forEach(p => {
      const meds = (p.medicines || []).map(m => m.name).join('; ');
      csv += `"${p.name}","${p.phone}","${meds}","${p.createdAt || ''}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="biomexa-patients.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== ADMIN ROUTES (legacy mock, kept for backward compatibility) ==========
app.get('/stats', async (req, res) => {
  const total = await Patient.countDocuments();
  res.json({
    total_patients: total,
    high_risk_patients: Math.floor(total * 0.2),
    average_adherence: Math.floor(70 + Math.random() * 25),
    total_interactions: Math.floor(total * 10 + Math.random() * 100)
  });
});

// Public status check — lets the frontend know whether reminders go out automatically via
// MSG91 (business number, no patient setup needed) or whether the platform is still relying
// on each patient/doctor connecting their own CallMeBot key. No auth needed — this is not
// sensitive, just a feature-availability flag.
app.get('/api/whatsapp-status', (req, res) => {
  res.json({ msg91Configured: MSG91_CONFIGURED });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Biomexa Server running on port ${PORT}`);
  console.log(`📱 WhatsApp reminders active (checking every minute)`);
  console.log(`🔐 Password reset via WhatsApp OTP enabled`);
  if (!CALLMEBOT_API_KEY) {
    console.log(`\n⚠️  WARNING: CALLMEBOT_API_KEY not set!`);
    console.log(`   WhatsApp messages will NOT be sent.`);
    console.log(`   Get your free API key at: https://www.callmebot.com/blog/free-api-whatsapp-messages/`);
    console.log(`   Then set CALLMEBOT_API_KEY in your environment variables.\n`);
  }
});
