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
const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE;
const client = twilio(accountSid, authToken);

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

    try {
      await client.messages.create({
        from: `whatsapp:${twilioPhone}`,
        to: `whatsapp:${phone}`,
        body: `Welcome to Biomexa, ${name}! 💊\nYour medicine reminder service is active. You will receive WhatsApp reminders for your scheduled doses.\nReply "YES" to confirm you took your medicine, or "NO" if you missed it.`
      });
    } catch (twilioErr) {
      console.log('Twilio welcome message failed:', twilioErr.message);
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
  const phone = From.replace('whatsapp:', '');
  const reply = Body.trim().toUpperCase();

  console.log(`📩 WhatsApp reply from ${phone}: "${Body}"`);

  try {
    const patient = await Patient.findOne({ phone });
    if (!patient) {
      await client.messages.create({
        from: `whatsapp:${twilioPhone}`,
        to: `whatsapp:${phone}`,
        body: 'Sorry, we could not find your account. Please register at Biomexa first.'
      });
      return res.status(200).send('OK');
    }

    const pendingDose = await Dose.findOne({
      patientId: patient._id,
      status: 'pending'
    }).sort({ reminderSentAt: -1 });

    if (!pendingDose) {
      await client.messages.create({
        from: `whatsapp:${twilioPhone}`,
        to: `whatsapp:${phone}`,
        body: `Hi ${patient.name}, you have no pending doses right now. Your next reminder will come at the scheduled time. 💊`
      });
      return res.status(200).send('OK');
    }

    if (reply === 'YES' || reply === 'Y' || reply.includes('TOOK') || reply.includes('TAKEN')) {
      pendingDose.status = 'taken';
      pendingDose.confirmedAt = new Date();
      pendingDose.confirmedVia = 'whatsapp';
      await pendingDose.save();

      await client.messages.create({
        from: `whatsapp:${twilioPhone}`,
        to: `whatsapp:${phone}`,
        body: `✅ Great job, ${patient.name}! Your dose of *${pendingDose.medicineName}* (${pendingDose.dosage}) has been recorded at ${new Date().toLocaleTimeString()}. Stay healthy! 💪`
      });
      console.log(`✅ Dose confirmed via WhatsApp for ${patient.name}`);
    } 
    else if (reply === 'NO' || reply === 'N' || reply.includes('MISSED')) {
      pendingDose.status = 'missed';
      pendingDose.confirmedAt = new Date();
      pendingDose.confirmedVia = 'whatsapp';
      await pendingDose.save();

      await client.messages.create({
        from: `whatsapp:${twilioPhone}`,
        to: `whatsapp:${phone}`,
        body: `⚠️ Noted, ${patient.name}. Your missed dose of *${pendingDose.medicineName}* has been recorded. Please take your next dose on time. If you need help, consult your doctor.`
      });
      console.log(`⚠️ Dose marked missed via WhatsApp for ${patient.name}`);
    }
    else {
      await client.messages.create({
        from: `whatsapp:${twilioPhone}`,
        to: `whatsapp:${phone}`,
        body: `Hi ${patient.name}, please reply with:
✅ *YES* - if you took the medicine
❌ *NO* - if you missed it
Your last reminder was for *${pendingDose.medicineName}* at ${pendingDose.scheduledTime}.`
      });
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
          const msg = await client.messages.create({
            from: `whatsapp:${twilioPhone}`,
            to: `whatsapp:${patient.phone}`,
            body: `⏰ *Medicine Reminder*\n\nHi ${patient.name}, it's time for your medicine!\n\n💊 *${med.name}*\n📋 Dosage: ${med.dosage}\n📝 ${med.foodNote || 'Take as directed'}\n\nReply *YES* if you took it, or *NO* if you missed it.`
          });

          dose.reminderSentAt = new Date();
          dose.reminderMessageSid = msg.sid;
          await dose.save();

          console.log(`✅ Reminder sent to ${patient.name} for ${med.name} at ${currentTime}`);
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
});