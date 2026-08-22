require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const twilio = require('twilio');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========================
// TWILIO SETUP
// ========================
const accountSid = process.env.TWILIO_SID || process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_TOKEN || process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE || process.env.TWILIO_WHATSAPP_NUMBER;
const client = accountSid && authToken ? twilio(accountSid, authToken) : null;
const fromNumber = twilioPhone?.startsWith('whatsapp:') ? twilioPhone : `whatsapp:${twilioPhone}`;

function normalizePhoneNumber(value) {
  if (!value) return '';
  let phone = String(value).trim();
  if (phone.startsWith('whatsapp:')) phone = phone.replace(/^whatsapp:/, '');
  phone = phone.replace(/[()\s-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) phone = `+${phone}`;
  return phone;
}

function isTwilioConfigured() {
  return Boolean(accountSid && authToken && twilioPhone);
}

async function sendWhatsAppMessage(to, body) {
  if (!isTwilioConfigured()) {
    const reason = 'Twilio WhatsApp is not configured. Please set TWILIO_SID/TWILIO_ACCOUNT_SID, TWILIO_TOKEN/TWILIO_AUTH_TOKEN, and TWILIO_PHONE/TWILIO_WHATSAPP_NUMBER.';
    console.warn(`⚠️ ${reason}`);
    return { ok: false, reason };
  }

  const normalizedTo = `whatsapp:${normalizePhoneNumber(to)}`;

  try {
    const message = await client.messages.create({
      from: fromNumber,
      to: normalizedTo,
      body
    });
    return { ok: true, sid: message.sid };
  } catch (err) {
    console.error('❌ Twilio send failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ========================
// MONGODB SETUP (Atlas)
// ========================
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/biomexa';

mongoose.connect(mongoUri)
  .then(() => console.log('✅ MongoDB connected to Atlas'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  console.error('⚠️ MongoDB error:', err.message);
});

// ========================
// SCHEMAS
// ========================

const patientSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true },
  email: String,
  password: String,
  medicines: [{
    name: String,
    dosage: String,
    time: String,
    frequency: String,
    foodNote: String,
    active: { type: Boolean, default: true }
  }],
  baselineVitals: {
    bpSystolic: { type: Number, default: 140 },
    bpDiastolic: { type: Number, default: 90 },
    glucose: { type: Number, default: 110 },
    temperature: { type: Number, default: 98.6 }
  },
  medicalHistory: [String],
  createdAt: { type: Date, default: Date.now }
});

const doctorSchema = new mongoose.Schema({
  name: String,
  email: { type: String, sparse: true },
  phone: { type: String, unique: true, sparse: true },
  specialty: { type: String, default: 'General Medicine' },
  qualification: String,
  experienceYears: { type: Number, default: 5 },
  consultationFee: { type: Number, default: 200 },
  city: String,
  languages: [String],
  rating: { type: Number, default: 4.8 },
  isOnline: { type: Boolean, default: true },
  availableNow: { type: Boolean, default: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  profilePhoto: String,
  createdAt: { type: Date, default: Date.now }
});

const doctorAvailabilitySchema = new mongoose.Schema({
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  status: { type: String, enum: ['online', 'offline', 'busy'], default: 'online' },
  availableFrom: String,
  availableTo: String,
  maxPatients: { type: Number, default: 5 },
  active: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now }
});

const consultationSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
  consultationType: { type: String, enum: ['urgent', 'followup', 'subscription'], default: 'urgent' },
  riskScore: { type: Number, default: 0 },
  riskLevel: { type: String, enum: ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'], default: 'HIGH' },
  amount: { type: Number, default: 200 },
  status: { type: String, enum: ['requested', 'paid', 'accepted', 'in_progress', 'completed', 'cancelled'], default: 'requested' },
  paymentId: String,
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  requestReason: String,
  doctorNotes: String,
  followUpDate: Date,
  startedAt: Date,
  endedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const monitoringNoteSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  consultationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Consultation', required: true },
  vitalsSummary: mongoose.Schema.Types.Mixed,
  riskLevel: String,
  noteText: String,
  followUpDate: Date,
  createdAt: { type: Date, default: Date.now }
});

const doseSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  medicineName: String,
  dosage: String,
  scheduledTime: String,
  scheduledDate: Date,
  status: { type: String, enum: ['pending', 'taken', 'missed', 'snoozed'], default: 'pending' },
  confirmedAt: Date,
  confirmedVia: { type: String, enum: ['whatsapp', 'dashboard', 'auto'], default: 'pending' },
  reminderSentAt: Date,
  reminderMessageSid: String
});

const vitalLogSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  date: { type: Date, default: Date.now },
  bpSystolic: Number,
  bpDiastolic: Number,
  glucose: Number,
  temperature: Number,
  symptoms: [String],
  notes: String
});

const analysisSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  date: { type: Date, default: Date.now },
  effectivenessScore: Number,
  effectivenessCategory: String,
  riskLabel: String,
  riskColor: String,
  adherenceRate: Number,
  insights: [String],
  recommendations: [String],
  symptomTrend: String,
  adverseEventFlag: Boolean,
  vitalSummary: mongoose.Schema.Types.Mixed
});

const Patient = mongoose.model('Patient', patientSchema);
const Doctor = mongoose.model('Doctor', doctorSchema);
const DoctorAvailability = mongoose.model('DoctorAvailability', doctorAvailabilitySchema);
const Consultation = mongoose.model('Consultation', consultationSchema);
const MonitoringNote = mongoose.model('MonitoringNote', monitoringNoteSchema);
const Dose = mongoose.model('Dose', doseSchema);
const VitalLog = mongoose.model('VitalLog', vitalLogSchema);
const Analysis = mongoose.model('Analysis', analysisSchema);

// ========================
// AI ENGINE HELPER
// ========================
function callAIEngine(endpoint, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const options = {
      hostname: 'localhost',
      port: 5001,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON from AI Engine'));
        }
      });
    });

    req.on('error', (err) => {
      console.log('⚠️ AI Engine not running, using fallback calculation');
      // Fallback: simple calculation when AI engine is offline
      const adherence = data.dose_history ? 
        (data.dose_history.filter(d => d.status === 'taken').length / Math.max(data.dose_history.length, 1)) * 100 : 100;
      const score = Math.max(0, Math.min(100, adherence - (data.symptoms_count || 0) * 2));
      let risk = 'LOW RISK';
      let color = '#10b981';
      if (score < 40) { risk = 'HIGH RISK'; color = '#f39c12'; }
      else if (score < 65) { risk = 'MODERATE'; color = '#fbbf24'; }

      resolve({
        success: true,
        dashboard: {
          effectiveness_score: Math.round(score),
          effectiveness_category: score > 80 ? 'Highly Effective' : score > 60 ? 'Moderately Effective' : 'Partially Effective',
          risk_label: { label: risk, color: color },
          adherence_rate: Math.round(adherence),
          top_insights: ['AI Engine offline - using basic calculation'],
          top_recommendations: ['Please start the AI Engine for full analysis']
        }
      });
    });

    req.write(postData);
    req.end();
  });
}

// ========================
// MIDDLEWARE
// ========================
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};

const doctorAuthMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    return res.status(401).json({ message: 'Invalid doctor credentials' });
  }

  try {
    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const [username, password] = decoded.split(':');
    const expectedUser = process.env.DOCTOR_USERNAME || 'drsharma';
    const expectedPass = process.env.DOCTOR_PASSWORD || 'biomexa2026';

    if (username === expectedUser && password === expectedPass) {
      const doctorProfile = await Doctor.findOne({
        $or: [
          { email: { $regex: new RegExp(username, 'i') } },
          { name: { $regex: new RegExp(username, 'i') } },
          { phone: { $regex: new RegExp(username, 'i') } }
        ]
      });

      req.doctor = { username, doctorId: doctorProfile?._id || null, profile: doctorProfile || null };
      return next();
    }
  } catch {
    // fall through to invalid credentials
  }

  return res.status(401).json({ message: 'Invalid doctor credentials' });
};

// ========================
// AUTH ROUTES
// ========================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    const existing = await Patient.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'Phone number already registered.' });

    const hashed = await bcrypt.hash(password, 10);
    const patient = new Patient({ name, phone, email, password: hashed });
    await patient.save();

    const normalizedPhone = normalizePhoneNumber(phone);
    const welcomeResult = await sendWhatsAppMessage(normalizedPhone, `Welcome to Biomexa, ${name}! 💊\nYour medicine reminder service is active. You will receive WhatsApp reminders for your scheduled doses.\nReply "YES" to confirm you took your medicine, or "NO" if you missed it.`);
    if (!welcomeResult.ok) {
      console.log('Twilio welcome message skipped:', welcomeResult.reason);
    }

    const token = jwt.sign({ id: patient._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Registered successfully', token, patient: { name, phone, email } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const patient = await Patient.findOne({ phone });
    if (!patient) return res.status(400).json({ message: 'User not found' });

    const match = await bcrypt.compare(password, patient.password);
    if (!match) return res.status(400).json({ message: 'Invalid password' });

    const token = jwt.sign({ id: patient._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, patient: { name: patient.name, phone: patient.phone, medicines: patient.medicines } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/doctors/onboard', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      specialty,
      qualification,
      experienceYears,
      consultationFee,
      city,
      languages,
      rating,
      isOnline,
      availableNow
    } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ message: 'Doctor name and phone are required.' });
    }

    const doctor = await Doctor.findOneAndUpdate(
      { phone },
      {
        name,
        email,
        phone,
        specialty: specialty || 'General Medicine',
        qualification: qualification || 'MD',
        experienceYears: experienceYears || 5,
        consultationFee: consultationFee || 200,
        city: city || 'India',
        languages: languages || ['English', 'Hindi'],
        rating: rating || 4.8,
        isOnline: isOnline !== undefined ? isOnline : true,
        availableNow: availableNow !== undefined ? availableNow : true,
        status: 'approved'
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await DoctorAvailability.findOneAndUpdate(
      { doctorId: doctor._id },
      {
        doctorId: doctor._id,
        status: doctor.availableNow ? 'online' : 'offline',
        availableFrom: '09:00',
        availableTo: '21:00',
        maxPatients: 5,
        active: true
      },
      { upsert: true, new: true }
    );

    res.status(201).json({ message: 'Doctor onboarded successfully', doctor });
  } catch (err) {
    console.error('Doctor onboarding error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/doctors/online', async (req, res) => {
  try {
    const doctors = await Doctor.find({ status: 'approved', availableNow: true, isOnline: true }).sort({ rating: -1 });
    res.json(doctors);
  } catch (err) {
    console.error('Doctor list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.all(['/doctor/login', '/api/doctor/login'], doctorAuthMiddleware, async (req, res) => {
  const doctor = req.doctor?.profile || await Doctor.findOne({ name: { $regex: new RegExp((req.doctor?.username || ''), 'i') } });
  res.json({
    message: 'Doctor authenticated',
    doctor: {
      username: req.doctor.username,
      doctorId: doctor?._id || null,
      specialty: doctor?.specialty || 'General Medicine',
      consultationFee: doctor?.consultationFee || 200,
      availableNow: doctor?.availableNow !== false
    }
  });
});

app.get(['/api/doctor/queue', '/doctor/queue'], doctorAuthMiddleware, async (req, res) => {
  try {
    const doctorId = req.doctor.doctorId;
    const consultations = await Consultation.find({
      doctorId: doctorId || { $exists: true },
      status: { $in: ['requested', 'paid', 'accepted', 'in_progress'] }
    }).sort({ createdAt: -1 });

    const patientDetails = await Promise.all(consultations.map(async (consult) => {
      const patient = await Patient.findById(consult.patientId).select('-password');
      return {
        ...consult.toObject(),
        patient: patient ? { name: patient.name, phone: patient.phone, email: patient.email } : null
      };
    }));

    res.json(patientDetails);
  } catch (err) {
    console.error('Doctor queue error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/consultations/request', authMiddleware, async (req, res) => {
  try {
    const patientId = req.userId;
    const { doctorId, riskScore, riskLevel, consultationType, requestReason } = req.body;

    const doctor = doctorId ? await Doctor.findById(doctorId) : await Doctor.findOne({ availableNow: true, isOnline: true, status: 'approved' }).sort({ rating: -1 });

    const consultation = new Consultation({
      patientId,
      doctorId: doctor?._id || null,
      riskScore: riskScore || 0,
      riskLevel: riskLevel || 'HIGH',
      consultationType: consultationType || 'urgent',
      amount: doctor?.consultationFee || 200,
      requestReason: requestReason || 'High-risk patient needs urgent consultation.',
      status: 'requested'
    });

    await consultation.save();

    res.status(201).json({ message: 'Consultation requested successfully', consultation });
  } catch (err) {
    console.error('Consultation request error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/consultations/:id/pay', authMiddleware, async (req, res) => {
  try {
    const consultation = await Consultation.findOne({ _id: req.params.id, patientId: req.userId });
    if (!consultation) return res.status(404).json({ message: 'Consultation not found' });

    consultation.status = 'paid';
    consultation.paymentStatus = 'paid';
    consultation.paymentId = req.body.paymentId || `manual_${Date.now()}`;
    await consultation.save();

    res.json({ message: 'Consultation payment received', consultation });
  } catch (err) {
    console.error('Consultation payment error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/consultations/:id/accept', doctorAuthMiddleware, async (req, res) => {
  try {
    const consultation = await Consultation.findById(req.params.id);
    if (!consultation) return res.status(404).json({ message: 'Consultation not found' });

    consultation.doctorId = req.doctor.doctorId || consultation.doctorId;
    consultation.status = 'accepted';
    await consultation.save();

    res.json({ message: 'Consultation accepted', consultation });
  } catch (err) {
    console.error('Accept consultation error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/consultations/:id/start', doctorAuthMiddleware, async (req, res) => {
  try {
    const consultation = await Consultation.findById(req.params.id);
    if (!consultation) return res.status(404).json({ message: 'Consultation not found' });

    consultation.doctorId = req.doctor.doctorId || consultation.doctorId;
    consultation.status = 'in_progress';
    consultation.startedAt = consultation.startedAt || new Date();
    await consultation.save();

    res.json({ message: 'Consultation started', consultation });
  } catch (err) {
    console.error('Start consultation error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/consultations/:id/complete', doctorAuthMiddleware, async (req, res) => {
  try {
    const consultation = await Consultation.findById(req.params.id);
    if (!consultation) return res.status(404).json({ message: 'Consultation not found' });

    consultation.doctorId = req.doctor.doctorId || consultation.doctorId;
    consultation.status = 'completed';
    consultation.endedAt = new Date();
    await consultation.save();

    res.json({ message: 'Consultation completed', consultation });
  } catch (err) {
    console.error('Complete consultation error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/patient/consultations', authMiddleware, async (req, res) => {
  try {
    const consultations = await Consultation.find({ patientId: req.userId }).sort({ createdAt: -1 });
    res.json(consultations);
  } catch (err) {
    console.error('Patient consultation list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/doctor/monitoring-note', doctorAuthMiddleware, async (req, res) => {
  try {
    const { consultationId, patientId, vitalsSummary, riskLevel, noteText, followUpDate } = req.body;
    const note = new MonitoringNote({
      patientId,
      doctorId: req.doctor.doctorId,
      consultationId,
      vitalsSummary,
      riskLevel,
      noteText,
      followUpDate
    });

    await note.save();
    res.status(201).json({ message: 'Monitoring note saved', note });
  } catch (err) {
    console.error('Monitoring note error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get(['/patients', '/api/patients'], doctorAuthMiddleware, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json([]);
    }

    const patients = await Patient.find({}).select('-password');

    const summaries = await Promise.all(patients.map(async (patient) => {
      const doses = await Dose.find({ patientId: patient._id }).sort({ scheduledDate: -1 });
      const latestAnalysis = await Analysis.findOne({ patientId: patient._id }).sort({ date: -1 });
      const taken = doses.filter(d => d.status === 'taken').length;
      const missed = doses.filter(d => d.status === 'missed').length;
      const pending = doses.filter(d => d.status === 'pending').length;
      const total = doses.length || 1;
      const adherenceScore = Math.round((taken / total) * 100);
      const riskScore = Math.min(1, Math.max(0, ((missed + pending) / total) * 0.7 + (latestAnalysis && latestAnalysis.effectivenessScore < 60 ? 0.3 : 0)));
      const aiPrediction = Math.min(1, Math.max(0, riskScore));
      const aiRiskLabel = riskScore > 0.75 ? 'Critical' : riskScore > 0.5 ? 'High' : 'Low';
      const nextDose = doses.find(d => d.status === 'pending' || d.status === 'snoozed')?.scheduledDate || null;

      return {
        name: patient.name,
        phone: patient.phone,
        medicine: patient.medicines?.find(m => m.active)?.name || patient.medicines?.[0]?.name || 'N/A',
        adherence_score: adherenceScore,
        risk_score: riskScore,
        ai_prediction: aiPrediction,
        ai_risk_label: aiRiskLabel,
        missed_doses: missed,
        next_dose: nextDose
      };
    }));

    res.json(summaries);
  } catch (err) {
    console.error('Doctor patients error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get(['/export/patients', '/api/export/patients'], doctorAuthMiddleware, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="patients.csv"');
      return res.send('Name,Phone,Medicine,Adherence,Risk,AI Risk,Missed,Next Dose\n');
    }

    const patients = await Patient.find({}).select('-password');
    const rows = [['Name', 'Phone', 'Medicine', 'Adherence', 'Risk', 'AI Risk', 'Missed', 'Next Dose']];

    for (const patient of patients) {
      const doses = await Dose.find({ patientId: patient._id }).sort({ scheduledDate: -1 });
      const taken = doses.filter(d => d.status === 'taken').length;
      const missed = doses.filter(d => d.status === 'missed').length;
      const total = doses.length || 1;
      const adherenceScore = Math.round((taken / total) * 100);
      const medicine = patient.medicines?.find(m => m.active)?.name || patient.medicines?.[0]?.name || 'N/A';
      const nextDose = doses.find(d => d.status === 'pending' || d.status === 'snoozed')?.scheduledDate || '';
      rows.push([patient.name, patient.phone, medicine, adherenceScore, '', '', missed, nextDose]);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="patients.csv"');
    res.send(rows.map(row => row.join(',')).join('\n'));
  } catch (err) {
    console.error('Doctor export error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ========================
// PATIENT ROUTES
// ========================

app.get('/api/patient/me', authMiddleware, async (req, res) => {
  try {
    const patient = await Patient.findById(req.userId).select('-password');
    if (!patient) return res.status(404).json({ message: 'Patient not found' });
    res.json(patient);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/patient/baseline', authMiddleware, async (req, res) => {
  try {
    const patient = await Patient.findByIdAndUpdate(
      req.userId,
      { baselineVitals: req.body },
      { new: true }
    );
    res.json({ message: 'Baseline vitals updated', baselineVitals: patient.baselineVitals });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/patient/medicines', authMiddleware, async (req, res) => {
  try {
    const patient = await Patient.findById(req.userId);
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    patient.medicines.push(req.body);
    await patient.save();
    res.json({ message: 'Medicine added', medicines: patient.medicines });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/patient/medicines/:medIndex', authMiddleware, async (req, res) => {
  try {
    const patient = await Patient.findById(req.userId);
    patient.medicines.splice(req.params.medIndex, 1);
    await patient.save();
    res.json({ message: 'Medicine removed', medicines: patient.medicines });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ========================
// VITALS ROUTES
// ========================

app.post('/api/vitals', authMiddleware, async (req, res) => {
  try {
    const vitalLog = new VitalLog({ patientId: req.userId, ...req.body });
    await vitalLog.save();
    res.json({ message: 'Vitals logged', vitalLog });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/vitals', authMiddleware, async (req, res) => {
  try {
    const logs = await VitalLog.find({ patientId: req.userId })
      .sort({ date: -1 })
      .limit(30);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ========================
// DOSE TRACKING ROUTES
// ========================

app.get('/api/doses', authMiddleware, async (req, res) => {
  try {
    const doses = await Dose.find({ patientId: req.userId })
      .sort({ scheduledDate: -1 })
      .limit(50);
    res.json(doses);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/doses/today', authMiddleware, async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const doses = await Dose.find({
      patientId: req.userId,
      scheduledDate: { $gte: startOfDay, $lte: endOfDay }
    }).sort({ scheduledTime: 1 });

    res.json(doses);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/doses/:doseId/confirm', authMiddleware, async (req, res) => {
  try {
    const dose = await Dose.findOne({ _id: req.params.doseId, patientId: req.userId });
    if (!dose) return res.status(404).json({ message: 'Dose not found' });

    dose.status = 'taken';
    dose.confirmedAt = new Date();
    dose.confirmedVia = 'dashboard';
    await dose.save();

    res.json({ message: 'Dose confirmed', dose });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ========================
// AI ANALYSIS ROUTES
// ========================

app.get('/api/analysis', authMiddleware, async (req, res) => {
  try {
    const patient = await Patient.findById(req.userId);
    const doses = await Dose.find({ patientId: req.userId }).sort({ scheduledDate: -1 }).limit(30);
    const vitals = await VitalLog.find({ patientId: req.userId }).sort({ date: -1 }).limit(15);

    // Build dose history for AI
    const doseHistory = doses.map(d => ({
      date: d.scheduledDate.toISOString().split('T')[0],
      status: d.status,
      vitals: {},
      symptoms: []
    }));

    // Add vital data to corresponding days
    vitals.forEach(v => {
      const dateStr = v.date.toISOString().split('T')[0];
      const doseEntry = doseHistory.find(d => d.date === dateStr);
      if (doseEntry) {
        doseEntry.vitals = {
          bp_systolic: v.bpSystolic,
          bp_diastolic: v.bpDiastolic,
          glucose: v.glucose,
          temperature: v.temperature
        };
        doseEntry.symptoms = v.symptoms || [];
      }
    });

    const aiData = {
      patient: {
        id: patient._id.toString(),
        drug_name: patient.medicines[0]?.name || 'Unknown',
        drug_dose: patient.medicines[0]?.dosage || '5mg',
        schedule: patient.medicines.map(m => m.time).filter(Boolean),
        baseline_bp: [patient.baselineVitals?.bpSystolic || 140, patient.baselineVitals?.bpDiastolic || 90],
        baseline_glucose: patient.baselineVitals?.glucose || 110,
        baseline_temp: patient.baselineVitals?.temperature || 98.6,
        history: patient.medicalHistory || []
      },
      dose_history: doseHistory,
      symptoms_count: vitals.reduce((sum, v) => sum + (v.symptoms?.length || 0), 0),
      indication: 'hypertension'
    };

    const aiResult = await callAIEngine('/analyze', aiData);

    if (aiResult.success) {
      // Save analysis to DB
      const analysis = new Analysis({
        patientId: req.userId,
        effectivenessScore: aiResult.dashboard.effectiveness_score,
        effectivenessCategory: aiResult.dashboard.effectiveness_category,
        riskLabel: aiResult.dashboard.risk_label.label,
        riskColor: aiResult.dashboard.risk_label.color,
        adherenceRate: aiResult.dashboard.adherence_rate,
        insights: aiResult.dashboard.top_insights,
        recommendations: aiResult.dashboard.top_recommendations,
        symptomTrend: aiResult.dashboard.symptom_trend,
        adverseEventFlag: aiResult.dashboard.adverse_event_flag,
        vitalSummary: aiResult.dashboard.vital_summary
      });
      await analysis.save();

      res.json(aiResult.dashboard);
    } else {
      res.status(500).json({ message: 'AI analysis failed' });
    }
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/analysis/history', authMiddleware, async (req, res) => {
  try {
    const history = await Analysis.find({ patientId: req.userId })
      .sort({ date: -1 })
      .limit(10);
    res.json(history);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ========================
// TWILIO WEBHOOK
// ========================
app.post('/webhook/whatsapp', async (req, res) => {
  const { From, Body, MessageSid } = req.body;
  const phone = normalizePhoneNumber(From);
  const reply = (Body || '').trim().toUpperCase();

  console.log(`📩 WhatsApp reply from ${phone}: "${Body}"`);

  try {
    const patient = await Patient.findOne({ phone });
    if (!patient) {
      await sendWhatsAppMessage(phone, 'Sorry, we could not find your account. Please register at Biomexa first.');
      return res.status(200).send('OK');
    }

    const pendingDose = await Dose.findOne({
      patientId: patient._id,
      status: 'pending'
    }).sort({ reminderSentAt: -1 });

    if (!pendingDose) {
      await sendWhatsAppMessage(phone, `Hi ${patient.name}, you have no pending doses right now. Your next reminder will come at the scheduled time. 💊`);
      return res.status(200).send('OK');
    }

    if (reply === 'YES' || reply === 'Y' || reply.includes('TOOK') || reply.includes('TAKEN')) {
      pendingDose.status = 'taken';
      pendingDose.confirmedAt = new Date();
      pendingDose.confirmedVia = 'whatsapp';
      await pendingDose.save();

      await sendWhatsAppMessage(phone, `✅ Great job, ${patient.name}! Your dose of *${pendingDose.medicineName}* (${pendingDose.dosage}) has been recorded at ${new Date().toLocaleTimeString()}. Stay healthy! 💪`);
      console.log(`✅ Dose confirmed via WhatsApp for ${patient.name}`);
    } 
    else if (reply === 'NO' || reply === 'N' || reply.includes('MISSED')) {
      pendingDose.status = 'missed';
      pendingDose.confirmedAt = new Date();
      pendingDose.confirmedVia = 'whatsapp';
      await pendingDose.save();

      await sendWhatsAppMessage(phone, `⚠️ Noted, ${patient.name}. Your missed dose of *${pendingDose.medicineName}* has been recorded. Please take your next dose on time. If you need help, consult your doctor.`);
      console.log(`⚠️ Dose marked missed via WhatsApp for ${patient.name}`);
    }
    else {
      await sendWhatsAppMessage(phone, `Hi ${patient.name}, please reply with:
✅ *YES* - if you took the medicine
❌ *NO* - if you missed it
Your last reminder was for *${pendingDose.medicineName}* at ${pendingDose.scheduledTime}.`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('OK');
  }
});

// ========================
// CRON JOB
// ========================
cron.schedule('* * * * *', async () => {
  if (mongoose.connection.readyState !== 1) {
    console.log('⏭️ MongoDB not connected, skipping cron job...');
    return;
  }

  try {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const patients = await Patient.find({ 'medicines.active': true });

    for (const patient of patients) {
      const dueMeds = patient.medicines.filter(m => 
        m.time === currentTime && 
        m.active && 
        (m.frequency === 'daily' || m.frequency === 'Daily')
      );

      for (const med of dueMeds) {
        const existingDose = await Dose.findOne({
          patientId: patient._id,
          medicineName: med.name,
          scheduledDate: today,
          scheduledTime: med.time
        });

        if (existingDose) continue;

        const dose = new Dose({
          patientId: patient._id,
          medicineName: med.name,
          dosage: med.dosage,
          scheduledTime: med.time,
          scheduledDate: today,
          status: 'pending'
        });

        try {
          const msg = await sendWhatsAppMessage(patient.phone, `⏰ *Medicine Reminder*\n\nHi ${patient.name}, it's time for your medicine!\n\n💊 *${med.name}*\n📋 Dosage: ${med.dosage}\n📝 ${med.foodNote || 'Take as directed'}\n\nReply *YES* if you took it, or *NO* if you missed it.`);

          if (msg.ok) {
            dose.reminderSentAt = new Date();
            dose.reminderMessageSid = msg.sid;
            await dose.save();
            console.log(`✅ Reminder sent to ${patient.name} for ${med.name} at ${currentTime}`);
          } else {
            console.error(`❌ Twilio error for ${patient.phone}:`, msg.reason);
          }
        } catch (twilioErr) {
          console.error(`❌ Twilio error for ${patient.phone}:`, twilioErr.message);
        }
      }
    }
  } catch (err) {
    console.error('❌ Cron job error:', err.message);
  }
});

// ========================
// STATS
// ========================
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const patient = await Patient.findById(req.userId);
    const totalDoses = await Dose.countDocuments({ patientId: req.userId });
    const takenDoses = await Dose.countDocuments({ patientId: req.userId, status: 'taken' });
    const missedDoses = await Dose.countDocuments({ patientId: req.userId, status: 'missed' });
    const pendingDoses = await Dose.countDocuments({ patientId: req.userId, status: 'pending' });

    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    const weekDoses = await Dose.find({
      patientId: req.userId,
      scheduledDate: { $gte: lastWeek },
      status: { $in: ['taken', 'missed'] }
    });

    const adherenceRate = weekDoses.length > 0 
      ? Math.round((weekDoses.filter(d => d.status === 'taken').length / weekDoses.length) * 100)
      : 0;

    // Get latest AI analysis
    const latestAnalysis = await Analysis.findOne({ patientId: req.userId }).sort({ date: -1 });

    res.json({
      totalDoses,
      takenDoses,
      missedDoses,
      pendingDoses,
      adherenceRate,
      activeMedicines: patient.medicines.filter(m => m.active).length,
      latestAnalysis: latestAnalysis ? {
        effectivenessScore: latestAnalysis.effectivenessScore,
        riskLabel: latestAnalysis.riskLabel,
        riskColor: latestAnalysis.riskColor,
        date: latestAnalysis.date
      } : null
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ========================
// HEALTH CHECK
// ========================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    dbConnected: mongoose.connection.readyState === 1,
    timestamp: new Date().toISOString()
  });
});

// ========================
// START SERVER
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`🧠 AI Engine: http://localhost:5001`);
});// ========================
// DOCTOR ADMIN ROUTES
// ========================

// Get all doctors (for admin panel)
app.get('/api/doctors/all', doctorAuthMiddleware, async (req, res) => {
  try {
    const doctors = await Doctor.find({}).sort({ createdAt: -1 });
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update doctor approval status
app.put('/api/doctors/:id/status', doctorAuthMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const doctor = await Doctor.findByIdAndUpdate(
      req.params.id,
      { status, availableNow: status === 'approved', isOnline: status === 'approved' },
      { new: true }
    );
    if (status === 'approved') {
      await DoctorAvailability.findOneAndUpdate(
        { doctorId: doctor._id },
        { doctorId: doctor._id, status: 'online', availableFrom: '09:00', availableTo: '21:00', active: true },
        { upsert: true }
      );
    }
    res.json({ message: 'Doctor status updated', doctor });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Toggle doctor online/availability
app.put('/api/doctors/:id/online', doctorAuthMiddleware, async (req, res) => {
  try {
    const { isOnline, availableNow } = req.body;
    const doctor = await Doctor.findByIdAndUpdate(
      req.params.id,
      { isOnline, availableNow: availableNow !== undefined ? availableNow : isOnline },
      { new: true }
    );
    await DoctorAvailability.findOneAndUpdate(
      { doctorId: doctor._id },
      { status: isOnline ? 'online' : 'offline', updatedAt: new Date() },
      { upsert: true }
    );
    res.json({ message: 'Availability updated', doctor });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Doctor views patient vitals
app.get('/api/doctor/patients/:patientId/vitals', doctorAuthMiddleware, async (req, res) => {
  try {
    const vitals = await VitalLog.find({ patientId: req.params.patientId })
      .sort({ date: -1 }).limit(30);
    res.json(vitals);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Doctor views patient doses
app.get('/api/doctor/patients/:patientId/doses', doctorAuthMiddleware, async (req, res) => {
  try {
    const doses = await Dose.find({ patientId: req.params.patientId })
      .sort({ scheduledDate: -1 }).limit(50);
    res.json(doses);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Doctor views patient AI analysis
app.get('/api/doctor/patients/:patientId/analysis', doctorAuthMiddleware, async (req, res) => {
  try {
    const analysis = await Analysis.find({ patientId: req.params.patientId })
      .sort({ date: -1 }).limit(10);
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get patient's latest stats for doctor view
app.get('/api/doctor/patients/:patientId/stats', doctorAuthMiddleware, async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.patientId).select('-password');
    const doses = await Dose.find({ patientId: req.params.patientId });
    const taken = doses.filter(d => d.status === 'taken').length;
    const total = doses.length || 1;
    const adherence = Math.round((taken / total) * 100);
    
    const latestAnalysis = await Analysis.findOne({ patientId: req.params.patientId })
      .sort({ date: -1 });
    
    res.json({
      patient,
      adherenceRate: adherence,
      totalDoses: doses.length,
      latestAnalysis: latestAnalysis || null
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
