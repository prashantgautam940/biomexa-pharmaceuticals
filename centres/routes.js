// Biomexa for Hospitals & IVF Centres — onboarding module.
// Mounted from server.js with mount(app, deps), the same way IVF Care is; it keeps its own
// collections and /api/centres routes and only borrows the existing logins, models and senders.
//
// Flow:
//   1. A hospital or IVF centre applies on centre-signup.html  -> status "pending"
//   2. Biomexa admin checks its registration and approves it in admin.html -> "verified"
//      (the centre gets a WhatsApp message and a join code)
//   3. The centre logs in on centre.html, adds its doctors and shares its join code / QR
//   4. A patient opens join-centre.html?code=XXXX, logs in and agrees -> the centre can now see
//      that patient's adherence, vitals and alerts (and nothing about any other patient).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const CENTRE_TYPES = { hospital: 'Hospital / clinic', ivf: 'IVF / fertility centre' };
const STATUS_MESSAGES = {
  pending: 'Your centre is awaiting verification by Biomexa — usually within 24 hours. We will message you on WhatsApp once it is approved.',
  rejected: 'Your centre application was not approved. Please contact Biomexa support.',
  suspended: 'Your centre account has been suspended. Please contact Biomexa support.'
};
const CONSENT_TEXT = 'I agree that this centre and its doctors may see my Biomexa medicines, dose history (taken / missed), vitals readings and health alerts, to monitor my treatment. I can leave the centre at any time from my dashboard, which stops this sharing.';

const centreSchema = new mongoose.Schema({
  type: { type: String, enum: Object.keys(CENTRE_TYPES), default: 'hospital' },
  name: String,
  registrationNumber: String, // Clinical Establishment reg. no. / ART clinic reg. no. (ART Act 2021)
  city: String,
  state: String,
  address: String,
  pincode: String,
  website: String,
  specialties: [String],
  doctorCount: Number, // as stated on the application
  contactName: String,
  contactRole: String,
  phone: { type: String, unique: true }, // contact's WhatsApp number — also the login
  email: String,
  password: String,
  joinCode: { type: String, unique: true },
  // pending (applied) | verified (approved — full access) | rejected | suspended
  status: { type: String, default: 'pending' },
  reviewNote: String,
  reviewedAt: Date,
  reviewedBy: String,
  // Doctors the centre has added (by WhatsApp number). Linked to a Biomexa doctor account when
  // one exists with that number; otherwise shown as "invited" until the doctor signs up.
  doctors: [{ phone: String, name: String, role: String, addedAt: { type: Date, default: Date.now } }],
  createdAt: { type: Date, default: Date.now }
}, { collection: 'centres' });

// Which patients have chosen to share their data with which centre.
const centrePatientSchema = new mongoose.Schema({
  centreId: { type: String, index: true },
  patientId: String,
  patientPhone: String,
  status: { type: String, default: 'active' }, // active | left (patient) | removed (centre)
  consentText: String,
  joinedAt: { type: Date, default: Date.now },
  endedAt: Date
}, { collection: 'centre_patients' });
centrePatientSchema.index({ centreId: 1, patientPhone: 1 }, { unique: true });

const Centre = mongoose.model('Centre', centreSchema);
const CentrePatient = mongoose.model('CentrePatient', centrePatientSchema);

// No 0/O/1/I/L so codes can be read out over the phone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
async function uniqueJoinCode() {
  for (let i = 0; i < 8; i++) {
    const c = makeCode();
    if (!(await Centre.exists({ joinCode: c }))) return c;
  }
  return makeCode(8);
}
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const publicCentre = (c) => ({
  id: c._id, type: c.type, typeLabel: CENTRE_TYPES[c.type], name: c.name, city: c.city, state: c.state,
  registrationNumber: c.registrationNumber, address: c.address, pincode: c.pincode, website: c.website,
  specialties: c.specialties, contactName: c.contactName, contactRole: c.contactRole, phone: c.phone,
  email: c.email, joinCode: c.status === 'verified' ? c.joinCode : undefined, status: c.status, createdAt: c.createdAt
});

function mount(app, deps) {
  const {
    JWT_SECRET, auth, adminAuth, signupLimiter, loginLimiter,
    Patient, Doctor, Dose, VitalsLog, RiskAlert,
    normalizePhone, phoneVariants, localDateStr, sendWhatsAppFree, SITE_URL
  } = deps;
  const R = '/api/centres';
  const joinLimiter = deps.rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many tries — please wait a few minutes.' });
  const notify = (phone, text) => sendWhatsAppFree(phone, text).catch(() => null);

  // ---------- auth for centre staff ----------
  async function centreAuth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Please log in.' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role !== 'centre' || !decoded.centreId) return res.status(401).json({ message: 'Please log in with your centre account.' });
      const centre = await Centre.findById(decoded.centreId);
      if (!centre) return res.status(401).json({ message: 'Centre account not found.' });
      if (centre.status !== 'verified') return res.status(403).json({ code: 'not_approved', status: centre.status, message: STATUS_MESSAGES[centre.status] || STATUS_MESSAGES.pending });
      req.centre = centre;
      next();
    } catch {
      res.status(401).json({ message: 'Your session has expired — please log in again.' });
    }
  }
  // Patient routes must not accept doctor/centre tokens (they share the same secret).
  const patientOnly = (req, res, next) => (req.user && !req.user.role && req.user.phone)
    ? next() : res.status(401).json({ message: 'Please log in with your patient account.' });

  // ---------- public ----------
  app.get(`${R}/meta`, (req, res) => res.json({ types: CENTRE_TYPES, consentText: CONSENT_TEXT }));

  app.post(`${R}/register`, signupLimiter, async (req, res) => {
    try {
      const b = req.body || {};
      const type = CENTRE_TYPES[b.type] ? b.type : null;
      const name = clean(b.name, 150), registrationNumber = clean(b.registrationNumber, 80), city = clean(b.city, 80);
      const contactName = clean(b.contactName, 100), phone = normalizePhone(b.phone), password = String(b.password || '');
      if (!type) return res.status(400).json({ message: 'Please choose Hospital or IVF centre.' });
      if (!name || !registrationNumber || !city || !contactName) return res.status(400).json({ message: 'Centre name, registration number, city and contact person are required.' });
      if (!/^\+\d{11,15}$/.test(phone)) return res.status(400).json({ message: 'Please enter a valid WhatsApp number.' });
      if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
      const email = clean(b.email, 120);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Please enter a valid email address.' });
      if (!b.agree) return res.status(400).json({ message: 'Please confirm the declaration to continue.' });
      if (await Centre.exists({ phone: { $in: phoneVariants(phone) } })) {
        return res.status(400).json({ message: 'A centre is already registered with this WhatsApp number. Please log in instead.' });
      }
      const specialties = (Array.isArray(b.specialties) ? b.specialties : String(b.specialties || '').split(','))
        .map(s => clean(s, 60)).filter(Boolean).slice(0, 15);
      const centre = await Centre.create({
        type, name, registrationNumber, city, state: clean(b.state, 60), address: clean(b.address, 300), pincode: clean(b.pincode, 10),
        website: clean(b.website, 150), specialties, doctorCount: Math.max(0, Math.min(5000, parseInt(b.doctorCount, 10) || 0)) || undefined,
        contactName, contactRole: clean(b.contactRole, 80), phone, email: email || undefined,
        password: await bcrypt.hash(password, 10), joinCode: await uniqueJoinCode(), status: 'pending'
      });
      console.log(`🏥 New ${type} centre application: ${name}, ${city} (${phone}), reg ${registrationNumber}`);
      notify(phone, `🏥 *Thank you for registering ${name} with Biomexa!*\n\nOur team is verifying your registration (${registrationNumber}). This usually takes up to 24 hours.\n\nWe'll message you here once it's approved — you can then log in, add your doctors and invite your patients:\n${SITE_URL}/centre.html\n\n- Biomexa Team`);
      res.json({ message: 'Application received — we will verify your centre and message you on WhatsApp.', pending: true, centre: { name, type } });
    } catch (err) {
      if (err.code === 11000) return res.status(400).json({ message: 'A centre is already registered with this WhatsApp number.' });
      res.status(500).json({ message: err.message });
    }
  });

  app.post(`${R}/login`, loginLimiter, async (req, res) => {
    try {
      const centre = await Centre.findOne({ phone: { $in: phoneVariants(req.body?.phone) } });
      if (!centre || !(await bcrypt.compare(String(req.body?.password || ''), centre.password || ''))) {
        return res.status(400).json({ message: 'Wrong WhatsApp number or password.' });
      }
      if (centre.status !== 'verified') return res.status(403).json({ code: 'not_approved', status: centre.status, message: STATUS_MESSAGES[centre.status] || STATUS_MESSAGES.pending });
      const token = jwt.sign({ centreId: String(centre._id), role: 'centre' }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, centre: publicCentre(centre) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // What a patient sees before joining (only approved centres can be joined).
  app.get(`${R}/join/:code`, joinLimiter, async (req, res) => {
    try {
      const c = await Centre.findOne({ joinCode: clean(req.params.code, 12).toUpperCase(), status: 'verified' });
      if (!c) return res.status(404).json({ message: 'No centre found with this code. Please check it with your hospital.' });
      res.json({ centre: { id: c._id, name: c.name, type: c.type, typeLabel: CENTRE_TYPES[c.type], city: c.city, state: c.state, specialties: c.specialties }, consentText: CONSENT_TEXT });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- patient ----------
  app.post(`${R}/join`, joinLimiter, auth, patientOnly, async (req, res) => {
    try {
      if (!req.body?.consent) return res.status(400).json({ message: 'Please agree to share your data with the centre.' });
      const centre = await Centre.findOne({ joinCode: clean(req.body.code, 12).toUpperCase(), status: 'verified' });
      if (!centre) return res.status(404).json({ message: 'No centre found with this code.' });
      const patient = await Patient.findOne({ phone: { $in: phoneVariants(req.user.phone) } }).select('name phone');
      if (!patient) return res.status(404).json({ message: 'Patient account not found.' });
      await CentrePatient.findOneAndUpdate(
        { centreId: String(centre._id), patientPhone: patient.phone },
        { $set: { patientId: String(patient._id), status: 'active', consentText: CONSENT_TEXT, joinedAt: new Date() }, $unset: { endedAt: 1 } },
        { upsert: true }
      );
      console.log(`🏥 ${patient.phone} joined centre ${centre.name}`);
      res.json({ message: `You're now connected with ${centre.name}.`, centre: { id: centre._id, name: centre.name, city: centre.city } });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get('/api/patient/centres', auth, patientOnly, async (req, res) => {
    try {
      const links = await CentrePatient.find({ patientPhone: { $in: phoneVariants(req.user.phone) }, status: 'active' });
      const centres = await Centre.find({ _id: { $in: links.map(l => l.centreId) } }).select('name type city state');
      res.json(links.map(l => {
        const c = centres.find(x => String(x._id) === l.centreId);
        return c && { id: c._id, name: c.name, type: c.type, typeLabel: CENTRE_TYPES[c.type], city: c.city, joinedAt: l.joinedAt };
      }).filter(Boolean));
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete('/api/patient/centres/:id', auth, patientOnly, async (req, res) => {
    try {
      const r = await CentrePatient.updateOne(
        { centreId: clean(req.params.id, 40), patientPhone: { $in: phoneVariants(req.user.phone) }, status: 'active' },
        { status: 'left', endedAt: new Date() }
      );
      if (!r.matchedCount) return res.status(404).json({ message: 'You are not connected with this centre.' });
      res.json({ message: 'You have left the centre. It can no longer see your data.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- centre dashboard ----------
  app.get(`${R}/me`, centreAuth, (req, res) => res.json({ centre: publicCentre(req.centre), consentText: CONSENT_TEXT }));

  app.patch(`${R}/me`, centreAuth, async (req, res) => {
    try {
      const b = req.body || {}, c = req.centre;
      for (const k of ['address', 'pincode', 'website', 'contactName', 'contactRole', 'state']) if (k in b) c[k] = clean(b[k], k === 'address' ? 300 : 150);
      if ('email' in b) c.email = clean(b.email, 120) || undefined;
      if ('specialties' in b) c.specialties = (Array.isArray(b.specialties) ? b.specialties : String(b.specialties).split(',')).map(s => clean(s, 60)).filter(Boolean).slice(0, 15);
      await c.save();
      res.json({ message: 'Profile updated.', centre: publicCentre(c) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post(`${R}/me/password`, loginLimiter, centreAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!(await bcrypt.compare(String(currentPassword || ''), req.centre.password))) return res.status(400).json({ message: 'Current password is wrong.' });
      if (String(newPassword || '').length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters.' });
      req.centre.password = await bcrypt.hash(String(newPassword), 10);
      await req.centre.save();
      res.json({ message: 'Password changed.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // New join code (e.g. if the old one was shared too widely). Existing patients stay connected.
  app.post(`${R}/me/join-code`, centreAuth, async (req, res) => {
    try {
      req.centre.joinCode = await uniqueJoinCode();
      await req.centre.save();
      res.json({ joinCode: req.centre.joinCode });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // Doctors
  async function doctorList(centre) {
    const phones = centre.doctors.map(d => d.phone);
    const accounts = phones.length ? await Doctor.find({ phone: { $in: phones.flatMap(phoneVariants) } }).select('name phone specialty status available') : [];
    return centre.doctors.map(d => {
      const v = phoneVariants(d.phone);
      const acc = accounts.find(a => v.includes(a.phone));
      return {
        phone: d.phone, role: d.role, addedAt: d.addedAt,
        name: acc ? `Dr. ${String(acc.name || '').replace(/^dr\.?\s+/i, '')}` : d.name,
        specialty: acc?.specialty,
        account: acc ? (acc.status === 'verified' ? 'verified' : 'awaiting_approval') : 'invited',
        available: !!acc?.available
      };
    });
  }
  app.get(`${R}/me/doctors`, centreAuth, async (req, res) => {
    try { res.json(await doctorList(req.centre)); } catch (err) { res.status(500).json({ message: err.message }); }
  });
  app.post(`${R}/me/doctors`, centreAuth, async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      const name = clean(req.body?.name, 100).replace(/^dr\.?\s+/i, '');
      if (!/^\+\d{11,15}$/.test(phone)) return res.status(400).json({ message: 'Please enter the doctor\'s WhatsApp number.' });
      if (req.centre.doctors.some(d => phoneVariants(d.phone).includes(phone))) return res.status(400).json({ message: 'This doctor is already added.' });
      if (req.centre.doctors.length >= 300) return res.status(400).json({ message: 'Doctor limit reached — please contact Biomexa.' });
      const acc = await Doctor.findOne({ phone: { $in: phoneVariants(phone) } }).select('name');
      if (!acc && !name) return res.status(400).json({ message: 'This number has no Biomexa doctor account yet — add the doctor\'s name so we can invite them.' });
      req.centre.doctors.push({ phone, name: name || acc.name, role: clean(req.body?.role, 60) || undefined });
      await req.centre.save();
      if (!acc) {
        notify(phone, `👨‍⚕️ Dr. ${name}, *${req.centre.name}* has added you as a doctor on Biomexa.\n\nCreate your free doctor account with this WhatsApp number to see your centre's patients:\n${SITE_URL}/doctor-signup.html\n\n- Biomexa Team`);
      }
      res.json({ message: acc ? 'Doctor added.' : 'Doctor added — we have sent them an invite to create their Biomexa account.', doctors: await doctorList(req.centre) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });
  app.delete(`${R}/me/doctors/:phone`, centreAuth, async (req, res) => {
    try {
      const v = phoneVariants(req.params.phone);
      const before = req.centre.doctors.length;
      req.centre.doctors = req.centre.doctors.filter(d => !v.includes(d.phone));
      if (req.centre.doctors.length === before) return res.status(404).json({ message: 'Doctor not found.' });
      await req.centre.save();
      res.json({ message: 'Doctor removed.', doctors: await doctorList(req.centre) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // Patients — only those who joined with this centre's code.
  app.get(`${R}/me/patients`, centreAuth, async (req, res) => {
    try {
      const links = await CentrePatient.find({ centreId: String(req.centre._id), status: 'active' }).sort({ joinedAt: -1 }).limit(1000);
      if (!links.length) return res.json({ patients: [], summary: { total: 0, needsAttention: 0, avgAdherence: null } });
      const phones = links.map(l => l.patientPhone);
      const allVariants = [...new Set(phones.flatMap(phoneVariants))];
      const since = new Date(Date.now() - 7 * 864e5);
      const sinceStr = localDateStr(since);
      const [patients, doses, vitals, alerts] = await Promise.all([
        Patient.find({ phone: { $in: allVariants } }).select('name phone medicines createdAt'),
        Dose.find({ patientPhone: { $in: allVariants }, scheduledDate: { $gte: sinceStr } }).select('patientPhone status'),
        // Readings from the last 90 days, newest first — the latest per patient is picked below.
        VitalsLog.find({ patientPhone: { $in: allVariants }, recordedAt: { $gte: new Date(Date.now() - 90 * 864e5) } })
          .sort({ recordedAt: -1 }).limit(5000).select('patientPhone bpSystolic bpDiastolic glucose heartRate recordedAt').lean(),
        RiskAlert.find({ patientPhone: { $in: allVariants }, acknowledged: false }).select('patientPhone severity reason createdAt').sort({ createdAt: -1 })
      ]);
      const key = (p) => String(p || '').replace(/\D/g, '').slice(-10);
      const rows = links.map(l => {
        const k = key(l.patientPhone);
        const p = patients.find(x => key(x.phone) === k);
        const ds = doses.filter(d => key(d.patientPhone) === k);
        const taken = ds.filter(d => d.status === 'taken').length;
        const missed = ds.filter(d => d.status === 'missed').length;
        const v = vitals.find(x => key(x.patientPhone) === k);
        const al = alerts.filter(a => key(a.patientPhone) === k);
        const adherence = taken + missed ? Math.round((taken / (taken + missed)) * 100) : null;
        return {
          name: p?.name || 'Patient', phone: l.patientPhone, joinedAt: l.joinedAt,
          medicines: (p?.medicines || []).filter(m => m.active !== false && !m.completedAt).map(m => m.name).filter(Boolean),
          adherence, taken, missed,
          lastVitals: v ? { bp: v.bpSystolic ? `${v.bpSystolic}/${v.bpDiastolic}` : null, glucose: v.glucose ?? null, heartRate: v.heartRate ?? null, at: v.recordedAt } : null,
          openAlerts: al.length, latestAlert: al[0] ? { severity: al[0].severity, reason: al[0].reason, at: al[0].createdAt } : null
        };
      });
      const withAdh = rows.filter(r => r.adherence !== null);
      res.json({
        patients: rows,
        summary: {
          total: rows.length,
          needsAttention: rows.filter(r => r.openAlerts || (r.adherence !== null && r.adherence < 70)).length,
          avgAdherence: withAdh.length ? Math.round(withAdh.reduce((s, r) => s + r.adherence, 0) / withAdh.length) : null
        }
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });
  app.delete(`${R}/me/patients/:phone`, centreAuth, async (req, res) => {
    try {
      const r = await CentrePatient.updateOne(
        { centreId: String(req.centre._id), patientPhone: { $in: phoneVariants(req.params.phone) }, status: 'active' },
        { status: 'removed', endedAt: new Date() }
      );
      if (!r.matchedCount) return res.status(404).json({ message: 'Patient not found.' });
      res.json({ message: 'Patient removed from your centre.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ---------- admin ----------
  app.get('/api/admin/centres', adminAuth, async (req, res) => {
    try {
      const centres = await Centre.find().select('-password').sort({ createdAt: -1 }).limit(300).lean();
      const counts = await CentrePatient.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$centreId', n: { $sum: 1 } } }]);
      res.json(centres.map(c => ({ ...c, typeLabel: CENTRE_TYPES[c.type], patientCount: counts.find(x => x._id === String(c._id))?.n || 0, doctorsAdded: (c.doctors || []).length })));
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });
  app.post('/api/admin/centres/:id/:action', adminAuth, async (req, res) => {
    try {
      const next = { approve: 'verified', reject: 'rejected', suspend: 'suspended' }[req.params.action];
      if (!next) return res.status(400).json({ message: 'Unknown action.' });
      const note = clean(req.body?.note, 300);
      if (next !== 'verified' && !note) return res.status(400).json({ message: 'Please add a short reason — it is sent to the centre.' });
      const centre = await Centre.findByIdAndUpdate(req.params.id,
        { status: next, reviewedAt: new Date(), reviewedBy: req.admin?.username || 'admin', reviewNote: note || undefined },
        { new: true });
      if (!centre) return res.status(404).json({ message: 'Centre not found.' });
      const msg = next === 'verified'
        ? `✅ *${centre.name} is approved on Biomexa!*\n\nLog in to add your doctors and invite patients:\n${SITE_URL}/centre.html\n\nYour patient join code: *${centre.joinCode}*\nPatients can join here: ${SITE_URL}/join-centre.html?code=${centre.joinCode}\n\n- Biomexa Team`
        : next === 'rejected'
          ? `We couldn't approve ${centre.name} on Biomexa.\n\nReason: ${note}\n\nIf you think this is a mistake, please reply with your details.\n\n- Biomexa Team`
          : `${centre.name}'s Biomexa account has been suspended.\n\nReason: ${note}\n\nPlease reply to this message if you have questions.\n\n- Biomexa Team`;
      const wa = await notify(centre.phone, msg);
      console.log(`🏥 Centre ${centre.name} -> ${next} by ${req.admin?.username || 'admin'}`);
      res.json({ message: `${centre.name} is now ${next === 'verified' ? 'approved' : next}.`, whatsappSent: !!wa?.success });
    } catch (err) {
      res.status(500).json({ message: err.name === 'CastError' ? 'Centre not found.' : err.message });
    }
  });
}

module.exports = { mount, Centre, CentrePatient, CENTRE_TYPES };
