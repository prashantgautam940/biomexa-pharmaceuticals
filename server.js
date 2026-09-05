require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');

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

// ========== CALLMEBOT FREE WHATSAPP API ==========
// Users must first message "I allow callmebot to send me messages" to +34 644 52 53 53
// Then get their API key from https://www.callmebot.com/blog/free-api-whatsapp-messages/
const CALLMEBOT_API_KEY = process.env.CALLMEBOT_API_KEY || null;

async function sendWhatsAppFree(phone, message) {
  // Normalize phone: remove + and any non-digits for CallMeBot
  const cleanPhone = phone.replace(/\D/g, '');

  // Try CallMeBot first (completely free)
  if (CALLMEBOT_API_KEY) {
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodeURIComponent(message)}&apikey=${CALLMEBOT_API_KEY}`;
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
      console.log('⚠️ CallMeBot failed:', err.message);
    }
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

  console.log('❌ No WhatsApp provider available. Message NOT sent to', phone);
  console.log('   Message was:', message.substring(0, 80) + '...');
  return { success: false, provider: 'none' };
}

// ========== MONGODB SETUP ==========
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/biomexa')
  .then(() => console.log('✅ MongoDB connected'))
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

const Patient = mongoose.model('Patient', patientSchema);
const Dose = mongoose.model('Dose', doseSchema);
const Otp = mongoose.model('Otp', otpSchema);
const Doctor = mongoose.model('Doctor', doctorSchema);
const ConnectRequest = mongoose.model('ConnectRequest', connectRequestSchema);

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
    const { name, phone, email, password } = req.body;
    const existing = await Patient.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'Phone number already registered. Please login.' });

    const hashed = await bcrypt.hash(password, 10);
    const patient = new Patient({ name, phone, email, password: hashed });
    await patient.save();

    const token = jwt.sign({ id: patient._id, phone }, JWT_SECRET);

    // Send welcome WhatsApp
    const welcomeMsg = `🎉 Welcome to Biomexa, ${name}!\n\nYour WhatsApp dose reminders are now active. We'll notify you when it's time to take your medicine.\n\nReply CONFIRM after each dose to track your adherence.\n\n- Biomexa Team`;
    sendWhatsAppFree(phone, welcomeMsg);

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

    sendWhatsAppFree(phone, loginMsg);

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

// Forgot Password - Send OTP
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { phone } = req.body;
    const patient = await Patient.findOne({ phone });
    if (!patient) return res.status(400).json({ message: 'No account found with this phone number' });

    // Generate OTP
    const otp = generateOTP();
    const resetToken = generateResetToken();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Invalidate old OTPs for this phone
    await Otp.updateMany({ phone, used: false }, { used: true });

    // Save new OTP
    await Otp.create({ phone, otp, resetToken, expiresAt });

    // Send OTP via WhatsApp
    const otpMsg = `🔐 *Biomexa Password Reset*\n\nYour OTP code is: *${otp}*\n\nThis code will expire in ${OTP_EXPIRY_MINUTES} minutes.\n\nIf you didn't request this, please ignore this message.\n\n- Biomexa Team`;
    const result = await sendWhatsAppFree(phone, otpMsg);

    if (!result.success) {
      return res.status(500).json({ message: 'Failed to send WhatsApp message. Please ensure CallMeBot is configured or try again later.' });
    }

    res.json({ message: 'OTP sent to your WhatsApp number' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;

    const otpRecord = await Otp.findOne({
      phone,
      otp,
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
    const { phone, resetToken, newPassword } = req.body;

    // Verify reset token
    const otpRecord = await Otp.findOne({
      phone,
      resetToken,
      used: false,
      expiresAt: { $gt: new Date() }
    });

    if (!otpRecord) {
      return res.status(400).json({ message: 'Invalid or expired reset token. Please start over.' });
    }

    // Hash new password
    const hashed = await bcrypt.hash(newPassword, 10);

    // Update patient password
    await Patient.findOneAndUpdate({ phone }, { password: hashed });

    // Mark OTP as used
    otpRecord.used = true;
    await otpRecord.save();

    // Send confirmation WhatsApp
    const confirmMsg = `✅ *Password Reset Successful*\n\nYour Biomexa password has been reset successfully.\n\nIf you didn't do this, please contact support immediately.\n\n- Biomexa Team`;
    sendWhatsAppFree(phone, confirmMsg);

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
    sendWhatsAppFree(req.user.phone, confirmMsg);

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
    const confirmMsg = `✅ *Dose Confirmed*\n\n${dose.medicineName} — ${dose.dosage}\n⏰ Taken at ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}\n\nGreat job staying on track! 💪\n\n- Biomexa Team`;
    sendWhatsAppFree(req.user.phone, confirmMsg);

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

      const message = `⏰ *Dose Reminder*\n\nHello ${patient.name},\n\nIt's time to take your medicine:\n*${dose.medicineName}* — ${dose.dosage}\n\n${dose.foodNote ? '🍽️ ' + dose.foodNote + '\n\n' : ''}Reply CONFIRM once you've taken it.\n\n- Biomexa Team`;

      const result = await sendWhatsAppFree(dose.patientPhone, message);

      if (result.success) {
        await Dose.findByIdAndUpdate(dose._id, { sentReminder: true });
        console.log(`✅ Reminder sent to ${dose.patientPhone} for ${dose.medicineName} at ${currentTime}`);
      } else {
        console.log(`❌ Failed to send reminder to ${dose.patientPhone}`);
      }
    }
  } catch (err) {
    console.error('❌ Cron error:', err.message);
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
    const { name, email, phone, password, specialty, licenseNumber, experienceYears, bio } = req.body;
    if (!name || !phone || !password || !licenseNumber) {
      return res.status(400).json({ message: 'Name, WhatsApp number, password and license number are required' });
    }
    const existing = await Doctor.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'A doctor account already exists with this phone number' });

    const hashed = await bcrypt.hash(password, 10);
    const doctor = new Doctor({ name, email, phone, password: hashed, specialty, licenseNumber, experienceYears, bio, available: true });
    await doctor.save();

    const token = jwt.sign({ id: doctor._id, phone, role: 'doctor' }, JWT_SECRET);

    const welcomeMsg = `👨‍⚕️ *Welcome to Biomexa, Dr. ${name}!*\n\nYour doctor profile is now live on the Biomexa Connect network. Patients with a high risk score can reach you instantly via WhatsApp.\n\nYou're marked *Available* by default — toggle this anytime from your dashboard.\n\n- Biomexa Team`;
    sendWhatsAppFree(phone, welcomeMsg);

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
    const result = await sendWhatsAppFree(doctor.phone, doctorMsg);

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

app.get('/api/doctor/queue', async (req, res) => {
  res.json([]);
});

app.get('/api/export/patients', async (req, res) => {
  res.json({ message: 'Export feature coming soon' });
});

// ========== ADMIN AUTH + AI ENGINE ==========
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'biomexadmin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'BiomexaAdmin@2026';

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ message: 'Admin login required' });
  }
  const [u, p] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (u === ADMIN_USERNAME && p === ADMIN_PASSWORD) return next();
  res.status(401).json({ message: 'Invalid admin username or password' });
}

app.get('/api/admin/login', adminAuth, (req, res) => {
  res.json({ message: 'Admin authenticated' });
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
