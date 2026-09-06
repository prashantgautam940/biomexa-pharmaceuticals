/**
 * seed-demo-data.js
 * ---------------------------------------------------------------
 * Populates a handful of realistic demo patients + dose history so you
 * can click "Train Model Now" on the Admin panel today, instead of
 * waiting for real patients to accumulate dose history.
 *
 * All demo patients use phone numbers starting with +91900000000X so
 * they're easy to find and delete later once you have real data.
 *
 * Usage:
 *   node seed-demo-data.js
 *
 * Requires the same MONGO_URI your server uses (reads from .env).
 * Safe to run more than once — it clears only its own demo patients
 * (by phone prefix) before re-seeding, never touches real patient data.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const DEMO_PHONE_PREFIX = '+919000000';

const patientSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, unique: true },
  email: String,
  password: String,
  whatsappApiKey: String,
  baselineVitals: { bpSystolic: Number, bpDiastolic: Number, glucose: Number, temperature: Number },
  medicalHistory: [String],
  medicines: [{ name: String, dosage: String, time: String, frequency: String, foodNote: String, active: Boolean }],
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

const Patient = mongoose.model('Patient', patientSchema);
const Dose = mongoose.model('Dose', doseSchema);

// [name, num medicines, adherence rate to simulate (0-1), days of history, days since registration]
const DEMO_PROFILES = [
  { name: 'Demo — Ramesh Gupta', medCount: 1, adherence: 0.95, days: 30, regDays: 45 },
  { name: 'Demo — Sunita Rao', medCount: 3, adherence: 0.35, days: 21, regDays: 30 },
  { name: 'Demo — Farhan Ali', medCount: 2, adherence: 0.65, days: 25, regDays: 40 },
  { name: 'Demo — Priya Nair', medCount: 1, adherence: 0.88, days: 18, regDays: 20 },
  { name: 'Demo — Vikram Singh', medCount: 4, adherence: 0.42, days: 28, regDays: 35 },
  { name: 'Demo — Anjali Mehta', medCount: 2, adherence: 0.78, days: 15, regDays: 15 },
  { name: 'Demo — Karan Kapoor', medCount: 3, adherence: 0.55, days: 22, regDays: 28 },
  { name: 'Demo — Neha Verma', medCount: 1, adherence: 0.91, days: 12, regDays: 12 }
];

const MEDICINE_NAMES = ['Telmexa AM', 'Diabmexa M 500', 'Amlodipine', 'Metformin', 'Atorvastatin'];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/biomexa');
  console.log('✅ Connected to MongoDB');

  const existingDemo = await Patient.find({ phone: new RegExp('^' + DEMO_PHONE_PREFIX) });
  if (existingDemo.length) {
    const phones = existingDemo.map(p => p.phone);
    await Patient.deleteMany({ phone: { $in: phones } });
    await Dose.deleteMany({ patientPhone: { $in: phones } });
    console.log(`🧹 Cleared ${existingDemo.length} previous demo patients`);
  }

  let seeded = 0;
  for (let i = 0; i < DEMO_PROFILES.length; i++) {
    const profile = DEMO_PROFILES[i];
    const phone = `${DEMO_PHONE_PREFIX}${i}`;
    const hashed = await bcrypt.hash('demopassword123', 10);
    const createdAt = new Date(Date.now() - profile.regDays * 86400000);

    const medicines = [];
    for (let m = 0; m < profile.medCount; m++) {
      medicines.push({
        name: MEDICINE_NAMES[m % MEDICINE_NAMES.length],
        dosage: '1 tablet',
        time: ['08:00', '14:00', '20:00'][m % 3],
        frequency: 'daily',
        foodNote: 'Take after food',
        active: true
      });
    }

    const patient = await Patient.create({
      name: profile.name,
      phone,
      email: '',
      password: hashed,
      baselineVitals: { bpSystolic: 118 + Math.floor(Math.random() * 20), bpDiastolic: 76 + Math.floor(Math.random() * 10) },
      medicalHistory: [],
      medicines,
      createdAt
    });

    // Generate dose history for the last `days` days, one dose per medicine per day,
    // randomly taken/missed according to the target adherence rate for this profile.
    const doses = [];
    for (let d = profile.days; d >= 0; d--) {
      const date = new Date(Date.now() - d * 86400000);
      const dateStr = date.toISOString().split('T')[0];
      for (const med of medicines) {
        const taken = Math.random() < profile.adherence;
        doses.push({
          patientPhone: phone,
          medicineName: med.name,
          dosage: med.dosage,
          scheduledTime: med.time,
          scheduledDate: dateStr,
          status: taken ? 'taken' : 'missed',
          foodNote: med.foodNote,
          sentReminder: true
        });
      }
    }
    await Dose.insertMany(doses);
    seeded++;
    console.log(`  ✓ ${profile.name} — ${medicines.length} medicine(s), ${doses.length} dose records, ~${Math.round(profile.adherence * 100)}% adherence`);
  }

  console.log(`\n✅ Seeded ${seeded} demo patients with realistic dose history.`);
  console.log('   Now log into /admin.html and click "Train Model Now".');
  console.log(`   (Demo patients all use phone numbers starting with ${DEMO_PHONE_PREFIX} — delete them from MongoDB anytime once you have real patients.)`);

  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('❌ Seeding failed:', err.message);
  process.exit(1);
});
