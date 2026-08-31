require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const twilio = require('twilio');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// ========== TWILIO SETUP ==========
const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE; // e.g. 17372212163
const client = twilio(accountSid, authToken);

// ========== MONGODB SETUP ==========
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected to Atlas'))
  .catch(err => console.log('❌ MongoDB connection error:', err.message));

// ========== SCHEMAS ==========
const patientSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true },
  email: String,
  password: String,
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
    time: String,        // HH:MM (24-hour)
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
  scheduledTime: String,   // HH:MM (24-hour)
  scheduledDate: String,   // YYYY-MM-DD
  status: { type: String, default: 'pending' }, // pending, taken, missed
  foodNote: String,
  sentReminder: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Patient = mongoose.model('Patient', patientSchema);
const Dose = mongoose.model('Dose', doseSchema);

// ========== AUTH MIDDLEWARE ==========
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'biomexasecret');
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// ========== AUTH ROUTES ==========

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    const existing = await Patient.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'Phone number already registered. Please login.' });

    const hashed = await bcrypt.hash(password, 10);
    const patient = new Patient({ name, phone, email, password: hashed });
    await patient.save();

    // Send welcome WhatsApp
    try {
      await client.messages.create({
        from: `whatsapp:+${twilioPhone}`,
        to: `whatsapp:${phone}`,
        body: `🎉 Welcome to Biomexa, ${name}!\n\nYour WhatsApp dose reminders are now active. We'll notify you when it's time to take your medicine.\n\nReply CONFIRM after each dose to track your adherence.`
      });
      console.log('✅ Welcome WhatsApp sent to', phone);
    } catch (twilioErr) {
      console.log('⚠️ Twilio welcome error:', twilioErr.message);
    }

    const token = jwt.sign({ id: patient._id, phone }, process.env.JWT_SECRET || 'biomexasecret');
    res.json({ message: 'Registered successfully', token, patient: { name, phone } });
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

    const token = jwt.sign({ id: patient._id, phone }, process.env.JWT_SECRET || 'biomexasecret');
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

// ========== MEDICINE ROUTES ==========

// Add Medicine
app.post('/api/medicines', auth, async (req, res) => {
  try {
    const { name, dosage, time, frequency, foodNote } = req.body;

    // Validate time format (must be HH:MM 24-hour)
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(time)) {
      return res.status(400).json({ message: 'Time must be in 24-hour format (HH:MM), e.g. 14:30' });
    }

    // Add medicine to patient profile
    const patient = await Patient.findOneAndUpdate(
      { phone: req.user.phone },
      { $push: { medicines: { name, dosage, time, frequency, foodNote, active: true } } },
      { new: true }
    );

    // Create dose for TODAY
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

    console.log(`💊 Medicine added: ${name} at ${time} for ${req.user.phone}`);
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
    res.json({ message: 'Dose confirmed', dose });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== WHATSAPP REMINDER CRON ==========
// Runs every minute

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

      const message = `⏰ *Dose Reminder*\n\nHello ${patient.name},\n\nIt's time to take your medicine:\n*${dose.medicineName}* — ${dose.dosage}\n\n${dose.foodNote ? `🍽️ ${dose.foodNote}\n\n` : ''}Reply CONFIRM once you've taken it.`;

      try {
        await client.messages.create({
          from: `whatsapp:+${twilioPhone}`,
          to: `whatsapp:${dose.patientPhone}`,
          body: message
        });

        await Dose.findByIdAndUpdate(dose._id, { sentReminder: true });
        console.log(`✅ Reminder sent to ${dose.patientPhone} for ${dose.medicineName} at ${currentTime}`);
      } catch (err) {
        console.error(`❌ Twilio error for ${dose.patientPhone}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Cron error:', err.message);
  }
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp reminders active (checking every minute)`);
});
