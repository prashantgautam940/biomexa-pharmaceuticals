require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render sits behind a reverse proxy — without this, req.ip returns
                            // the proxy's address for every request, not the real client IP,
                            // which would make the rate limiter below treat all users as one.
app.use(cors());
app.use(express.json({ limit: '8mb' })); // default is 100kb — a base64-encoded 5MB upload needs headroom

// ========== RATE LIMITING ==========
// Simple in-memory limiter — appropriate for a single-instance deployment (no Redis needed).
// Protects against brute-force password guessing, OTP spam, and unlimited account creation
// (which also burns real MSG91 message credits). Keyed by IP + route, sliding window.
const rateLimitStore = new Map();
function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const entry = rateLimitStore.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count++;
    rateLimitStore.set(key, entry);
    if (entry.count > max) {
      return res.status(429).json({ message: message || 'Too many attempts. Please try again later.' });
    }
    next();
  };
}
// Periodically clear stale entries so this Map doesn't grow unbounded over a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}, 10 * 60 * 1000);

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: 'Too many login attempts. Please wait 15 minutes and try again.' });
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many reset requests. Please wait 15 minutes and try again.' });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many signup attempts from this connection. Please try again in an hour.' });

// ========== CONFIG ==========
const JWT_SECRET = process.env.JWT_SECRET || 'biomexasecret';
const OTP_EXPIRY_MINUTES = 15;

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

// Render's free tier puts the AI engine to sleep after inactivity — the first request after
// that can take 30-60s to wake it back up, which is what "not working" often actually is
// (a timeout, not a real failure). This gives it real room, and retries once on a timeout
// specifically (not on a genuine error response) since a cold-start request sometimes drops
// before the engine finishes booting but succeeds cleanly on the very next try.
async function callAiEngine(path, payload, isRetry = false) {
  if (!AI_ENGINE_URL) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch(`${AI_ENGINE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(50000)
    });
    const data = await res.json();
    if (!res.ok || !data.success) return { ok: false, reason: 'engine_error', detail: data.error || `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (err) {
    if (!isRetry) return callAiEngine(path, payload, true);
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
}

// ========== PRESCRIPTION / LAB REPORT ANALYSIS (Claude vision API) ==========
// Reads an uploaded prescription or lab report image/PDF and extracts the key factors —
// medicines, dosages, abnormal lab values, anything worth flagging. Uses Anthropic's Claude API
// directly (a real vision-capable model), not a fake keyword scan. Needs its own API key from
// https://console.anthropic.com — a real paid API key, separate from a claude.ai subscription.
// Until ANTHROPIC_API_KEY is set, uploads still work (the file is saved), the analysis step just
// says plainly that it isn't configured yet rather than pretending to have read the document.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

async function analyzeDocumentWithClaude(fileData, fileType) {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: 'not_configured' };

  const isPdf = fileType === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
    : { type: 'image', source: { type: 'base64', media_type: fileType, data: fileData } };

  const prompt = `You're looking at a patient-uploaded prescription or lab report. Extract the key factors clearly and concisely, in plain language a patient can understand:

- Medicines mentioned: name, dosage, and frequency if visible
- Any lab values present: the value, whether it's in/out of the normal range, and what that generally means
- Anything that stands out as worth discussing with a doctor

Keep it factual and based only on what's actually in the document — don't guess at anything illegible. End with a brief reminder that this is a summary to discuss with their doctor, not a diagnosis. Keep the whole thing under 250 words.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [contentBlock, { type: 'text', text: prompt }]
        }]
      }),
      signal: AbortSignal.timeout(70000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ Claude document analysis failed:', JSON.stringify(data).substring(0, 300));
      return { ok: false, reason: 'api_error', detail: data.error?.message || `HTTP ${res.status}` };
    }
    const text = data.content?.find(b => b.type === 'text')?.text || 'No analysis returned.';
    return { ok: true, analysis: text };
  } catch (err) {
    console.log('⚠️ Claude document analysis error:', err.message);
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
}

// ========== PRESCRIPTION / LAB REPORT ANALYSIS (Gemini vision API — free tier) ==========
// Google's Gemini API has a genuine ongoing free tier for its Flash models (no trial-credit
// ceiling, unlike Anthropic's one-time trial credit) — this is what lets the document analysis
// feature be tested and used at zero cost before deciding whether to pay for anything.
// Get a free key at https://aistudio.google.com/apikey — no credit card required.
//
// Model note: using gemini-3.8-flash specifically because the 2.5 generation is being shut down
// by Google in October 2026 and the 2.0 generation already shut down in June 2026 — checked
// Google's own current docs before picking this rather than guessing at a model name that would
// break in a few weeks.
//
// Real privacy tradeoff worth knowing: on Google's free tier, prompts and responses (including
// uploaded prescription images) may be used by Google to improve their products, per their
// current terms — this does not apply on a paid Gemini plan. Worth keeping in mind for a
// healthcare app handling real patient documents.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_MODEL = 'gemini-3.8-flash';

async function analyzeDocumentWithGemini(fileData, fileType, attempt = 0) {
  if (!GEMINI_API_KEY) return { ok: false, reason: 'not_configured' };

  const prompt = `You're looking at a patient-uploaded prescription or lab report. Extract the key factors clearly and concisely, in plain language a patient can understand:

- Medicines mentioned: name, dosage, and frequency if visible
- Any lab values present: the value, whether it's in/out of the normal range, and what that generally means
- Anything that stands out as worth discussing with a doctor

Keep it factual and based only on what's actually in the document — don't guess at anything illegible. End with a brief reminder that this is a summary to discuss with their doctor, not a diagnosis. Keep the whole thing under 250 words.`;

  try {
    // Uses the x-goog-api-key header rather than the older ?key= URL query parameter — Google's
    // newer "AQ." auth keys (the default for all keys issued since mid-2026) are documented to
    // require this specifically; sending them via the query-param method returns
    // ACCESS_TOKEN_TYPE_UNSUPPORTED. The header method works for the older AIza-format keys too,
    // so this is the safer choice regardless of which key type is configured.
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: fileType, data: fileData } }
          ]
        }]
      }),
      signal: AbortSignal.timeout(70000)
    });
    const data = await res.json();
    if (!res.ok) {
      // 503/UNAVAILABLE means Google's model is temporarily overloaded — confirmed via real
      // "high demand" responses on live requests, a well-documented recurring pattern across
      // the whole Gemini lineup (not specific to this model or this key). Worth retrying with
      // backoff rather than making the patient manually re-upload for something that usually
      // clears within a minute. Any other error (bad key, malformed request) fails immediately —
      // retrying those would just waste the patient's wait time on something a retry can't fix.
      if (res.status === 503 && attempt < 2) {
        const waitMs = attempt === 0 ? 3000 : 8000;
        console.log(`⏳ Gemini overloaded (503) — retry ${attempt + 1}/2 in ${waitMs / 1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
        return analyzeDocumentWithGemini(fileData, fileType, attempt + 1);
      }
      console.log('⚠️ Gemini document analysis failed:', JSON.stringify(data).substring(0, 300));
      return { ok: false, reason: 'api_error', detail: data.error?.message || `HTTP ${res.status}` };
    }
    const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || 'No analysis returned.';
    return { ok: true, analysis: text };
  } catch (err) {
    console.log('⚠️ Gemini document analysis error:', err.message);
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
}

// Unified document analyzer — tries Gemini first (free), and now also falls back to Claude if
// Gemini fails for ANY reason after its own retries are exhausted, not just when Gemini isn't
// configured. This only kicks in when both providers are actually configured, so it never
// incurs cost the person hasn't already opted into by setting up both keys — it just means a
// temporary Gemini outage doesn't leave the feature broken when a working backup is right there.
async function analyzeDocument(fileData, fileType) {
  const geminiResult = await analyzeDocumentWithGemini(fileData, fileType);
  if (geminiResult.ok) return geminiResult;
  if (!ANTHROPIC_API_KEY) return geminiResult;
  console.log(`ℹ️ Gemini failed (${geminiResult.reason}), falling back to Claude...`);
  return analyzeDocumentWithClaude(fileData, fileType);
}

// ========== MSG91 WHATSAPP — TWO-WAY DOSE CONFIRMATION & VITALS CAPTURE ==========
// MSG91 is Biomexa's sole WhatsApp provider: one real business number, real webhooks for
// inbound replies, and quick-reply buttons — which is what makes "patient taps Taken/Not Taken,
// then texts their BP" possible.
//
// Setup required on your end before this does anything (see .env.example for full steps):
// 1. Get WhatsApp Business API access in your MSG91 dashboard (control.msg91.com).
// 2. Create + get Meta approval for a template with quick-reply buttons — the real one in use:
//      Name: dose_reminder
//      Body: "Time for your {{medicine_name}} dose ({{dosage}}). Did you take it?"
//      Buttons: "Taken" / "Not Taken" / "Remind Me Later"
// 3. Set MSG91_AUTH_KEY, MSG91_INTEGRATED_NUMBER, MSG91_DOSE_TEMPLATE_NAME,
//    MSG91_TEMPLATE_NAMESPACE below.
// 4. In MSG91 dashboard → Settings → Webhooks, point the inbound WhatsApp webhook at:
//      https://<your-render-url>/api/webhooks/msg91-whatsapp
//
// Until these are set, sendDoseReminderTemplate() logs a clear "not configured" message —
// no WhatsApp messages of any kind go out without this configured.
const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY || null;
const MSG91_INTEGRATED_NUMBER = process.env.MSG91_INTEGRATED_NUMBER || null;
const MSG91_DOSE_TEMPLATE_NAME = process.env.MSG91_DOSE_TEMPLATE_NAME || 'dose_reminder';
const MSG91_TEMPLATE_NAMESPACE = process.env.MSG91_TEMPLATE_NAMESPACE || '';
const MSG91_TEMPLATE_LANG = process.env.MSG91_TEMPLATE_LANG || 'en';
const MSG91_CONFIGURED = !!(MSG91_AUTH_KEY && MSG91_INTEGRATED_NUMBER);

// Sends the dose reminder as a real WhatsApp template message with Taken/Not Taken/Remind Me
// Later quick-reply buttons. Returns { success, provider } same shape as sendWhatsAppFree, so
// callers can fall back the same way. Component keys below (medicine_name, dosage) match the
// named variables used in the real approved template — if you ever recreate the template with
// different variable names, update these keys to match or sends will fail with a mismatch error.
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
                body_1: { type: 'text', value: medicineName, parameter_name: 'medicine_name' },
                body_2: { type: 'text', value: dosage, parameter_name: 'dosage' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 WhatsApp template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// ===== RISK ALERT TEMPLATE — bypasses the 24h free-text window that was silently failing
// (Meta error 131047) for both automatic vitals-triggered alerts and the admin broadcast. =====
// Setup needed: create + get Meta approval for a second template in MSG91 (same process as
// dose_reminder), then set MSG91_RISK_TEMPLATE_NAME/MSG91_RISK_TEMPLATE_NAMESPACE below. Suggested
// template body: "Biomexa Alert: {{patient_name}}, your recent check-in shows {{risk_level}} risk
// ({{reason}}). Please stay on schedule with your medicine or reach out to a doctor on Biomexa
// Connect." — no buttons needed, this is informational only. Until configured, callers fall back
// to sendWhatsAppFree (free text), which still works for anyone within an active session.
const MSG91_RISK_TEMPLATE_NAME = process.env.MSG91_RISK_TEMPLATE_NAME || null;
const MSG91_RISK_TEMPLATE_NAMESPACE = process.env.MSG91_RISK_TEMPLATE_NAMESPACE || '';

async function sendRiskAlertTemplate(phone, patientName, riskLevel, reason) {
  if (!MSG91_CONFIGURED || !MSG91_RISK_TEMPLATE_NAME) {
    return { success: false, provider: 'msg91_risk_template_not_configured' };
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
            name: MSG91_RISK_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_RISK_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: patientName, parameter_name: 'patient_name' },
                body_2: { type: 'text', value: riskLevel, parameter_name: 'risk_level' },
                body_3: { type: 'text', value: reason, parameter_name: 'reason' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 risk alert template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 risk alert template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 risk alert template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Unified risk-alert sender — tries the template first (works regardless of session state),
// falls back to free text only if the template isn't configured yet.
async function sendRiskAlertMessage(phone, patientName, riskLevel, reason) {
  const templateResult = await sendRiskAlertTemplate(phone, patientName, riskLevel, reason);
  if (templateResult.success) return templateResult;

  const fallbackMsg = `🚨 *Biomexa Health Check-In*\n\nHi ${patientName}, our system flagged your treatment adherence as *${riskLevel} risk* (${reason}).\n\nPlease try to stay on schedule with your medicine, and consider reaching out to a doctor on Biomexa Connect if you're having trouble.\n\n- Biomexa Team`;
  return sendWhatsAppFree(phone, fallbackMsg);
}

// ===== DOCTOR ALERT TEMPLATE — closes the last critical 131047 gap. The message telling a
// doctor a patient's vitals are dangerous was still free-text, meaning it could silently fail
// to reach the doctor at exactly the moment it matters most (confirmed pattern via MSG91 Logs:
// repeated "Failed By Meta" / 131047 entries with no template name, same signature as every
// other free-text failure this session). =====
// Setup: create + get Meta approval for a fourth template in MSG91 (identical process to the
// other three). Suggested body: "Biomexa Doctor Alert: Patient {{patient_name}} ({{phone}})
// has a {{severity}} reading — {{reason}}. Please reach out as soon as possible." — no buttons.
const MSG91_DOCTOR_ALERT_TEMPLATE_NAME = process.env.MSG91_DOCTOR_ALERT_TEMPLATE_NAME || null;
const MSG91_DOCTOR_ALERT_TEMPLATE_NAMESPACE = process.env.MSG91_DOCTOR_ALERT_TEMPLATE_NAMESPACE || '';

async function sendDoctorAlertTemplate(doctorPhone, patientName, patientPhone, severity, reason) {
  if (!MSG91_CONFIGURED || !MSG91_DOCTOR_ALERT_TEMPLATE_NAME) {
    return { success: false, provider: 'msg91_doctor_alert_template_not_configured' };
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
            name: MSG91_DOCTOR_ALERT_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_DOCTOR_ALERT_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [doctorPhone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: patientName, parameter_name: 'patient_name' },
                body_2: { type: 'text', value: patientPhone, parameter_name: 'phone' },
                body_3: { type: 'text', value: severity, parameter_name: 'severity' },
                body_4: { type: 'text', value: reason, parameter_name: 'reason' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 doctor alert template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 doctor alert template sent to', doctorPhone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 doctor alert template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Unified doctor-alert sender — template first, free text fallback only if not configured yet.
async function sendDoctorAlertMessage(doctorPhone, patientName, patientPhone, severity, reason) {
  const templateResult = await sendDoctorAlertTemplate(doctorPhone, patientName, patientPhone, severity, reason);
  if (templateResult.success) return templateResult;

  const fallbackMsg = `🚨 *RISK ALERT — ${severity.toUpperCase()}*\n\nPatient: ${patientName}\nPhone: ${patientPhone}\nIssue: ${reason}\n\nLogged via Biomexa WhatsApp vitals capture. Please reach out as soon as possible.\n\n- Biomexa Team`;
  return sendWhatsAppFree(doctorPhone, fallbackMsg);
}

// ===== WELCOME TEMPLATE — same fix as risk_alert, applied to the one message every single new
// signup needs and, until now, could never actually receive: brand-new contacts have no open
// WhatsApp session, so the free-text welcome message was silently blocked (Meta error 131047)
// on every register/quick-reminder signup. =====
// Setup: create + get Meta approval for a third template in MSG91 (identical process to
// dose_reminder and risk_alert). Suggested body: "Welcome to Biomexa, {{patient_name}}! Your
// account is set up and dose reminders are now active." — no buttons needed.
const MSG91_WELCOME_TEMPLATE_NAME = process.env.MSG91_WELCOME_TEMPLATE_NAME || null;
const MSG91_WELCOME_TEMPLATE_NAMESPACE = process.env.MSG91_WELCOME_TEMPLATE_NAMESPACE || '';

async function sendWelcomeTemplate(phone, patientName) {
  if (!MSG91_CONFIGURED || !MSG91_WELCOME_TEMPLATE_NAME) {
    return { success: false, provider: 'msg91_welcome_template_not_configured' };
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
            name: MSG91_WELCOME_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_WELCOME_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: patientName, parameter_name: 'patient_name' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 welcome template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 welcome template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 welcome template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Unified welcome sender — template first (reaches a brand-new contact regardless of session
// state), falls back to free text only if the template isn't configured yet.
async function sendWelcomeMessage(phone, patientName, fallbackMsg) {
  const templateResult = await sendWelcomeTemplate(phone, patientName);
  if (templateResult.success) return templateResult;
  return sendWhatsAppFree(phone, fallbackMsg);
}

// Parses free-text vitals like "BP 120/80, temp 98.6, pulse 72" — deliberately permissive since
// real patients won't format this consistently. Returns only the fields it actually found.
// Two layers: first tries explicit labels (100% reliable, unchanged from before — anyone who
// writes "pulse 72" or "sugar 110" gets exactly that, regardless of order or what else is in
// the message). Anything NOT caught by a label falls through to a smart bare-number pass, so a
// patient can just type "120/80 98.6 72 110" with no labels at all. That fallback deliberately
// does NOT try to guess between a bare pulse number and a bare glucose number by value — their
// normal and dangerous ranges genuinely overlap, and guessing wrong there could tell a doctor
// "high pulse" when it was actually dangerous blood sugar. Instead: BP is found by its unique
// "/" shape (safe, unambiguous), temperature by a decimal point (people essentially never write
// a decimal for pulse or sugar, so this is a real signal, not a guess), and whatever whole
// numbers are left are taken in order — first remaining is pulse, next is sugar.
function parseVitalsFromText(text) {
  const result = {};
  let consumed = text;

  const bpMatch = text.match(/(\d{2,3})\s*\/\s*(\d{2,3})/); // "120/80" anywhere in the message
  if (bpMatch) {
    result.bpSystolic = parseInt(bpMatch[1], 10);
    result.bpDiastolic = parseInt(bpMatch[2], 10);
    consumed = consumed.replace(bpMatch[0], ' ');
  }

  const tempLabelMatch = text.match(/temp(?:erature)?[:\s]*([\d.]+)/i) || text.match(/([\d.]{3,5})\s*(?:f|°f|degrees)/i);
  if (tempLabelMatch) {
    result.temperature = parseFloat(tempLabelMatch[1]);
    consumed = consumed.replace(tempLabelMatch[0], ' ');
  }

  const hrLabelMatch = text.match(/(?:pulse|hr|heart\s*rate)[:\s]*(\d{2,3})/i);
  if (hrLabelMatch) {
    result.heartRate = parseInt(hrLabelMatch[1], 10);
    consumed = consumed.replace(hrLabelMatch[0], ' ');
  }

  const glucoseLabelMatch = text.match(/(?:sugar|glucose|blood\s*sugar|bs)[:\s]*(\d{2,3})/i);
  if (glucoseLabelMatch) {
    result.glucose = parseInt(glucoseLabelMatch[1], 10);
    consumed = consumed.replace(glucoseLabelMatch[0], ' ');
  }

  // Bare-number fallback for whatever wasn't caught by a label above.
  if (result.temperature === undefined) {
    const bareDecimal = consumed.match(/\b(\d{2,3}\.\d)\b/);
    if (bareDecimal) {
      result.temperature = parseFloat(bareDecimal[1]);
      consumed = consumed.replace(bareDecimal[0], ' ');
    }
  }

  if (result.heartRate === undefined || result.glucose === undefined) {
    const bareWholeNumbers = (consumed.match(/\b\d{2,3}\b/g) || []).map(n => parseInt(n, 10));
    if (result.heartRate === undefined && bareWholeNumbers.length) {
      result.heartRate = bareWholeNumbers.shift();
    }
    if (result.glucose === undefined && bareWholeNumbers.length) {
      result.glucose = bareWholeNumbers.shift();
    }
  }

  return result;
}

// ========== EMAIL SETUP (fallback for password reset — doesn't depend on WhatsApp opt-in) ==========
// Uses Gmail SMTP with an App Password (not your normal Gmail password — generate one free at
// https://myaccount.google.com/apppasswords). This exists because WhatsApp reset OTPs only reach
// patients/doctors who've messaged Biomexa's WhatsApp number recently (MSG91's session rule);
// email works for everyone with an email on file, so it's the dependable path.
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

// ========== WHATSAPP SENDING (MSG91 only) ==========
// Sends a plain free-text message via MSG91. The "bulk" endpoint (used elsewhere for the
// approved template) explicitly rejected free text with "only template is supported for bulk" —
// confirmed via live logs on 2026-09-10. This uses the non-bulk singular endpoint instead
// (same API family, minus "/bulk/"), which matches MSG91's documented "Send message (once
// session started)" operation for free text.
async function sendMsg91Text(phone, message) {
  if (!MSG91_CONFIGURED) return { success: false, provider: 'msg91_not_configured' };
  try {
    const res = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
      body: JSON.stringify({
        integrated_number: MSG91_INTEGRATED_NUMBER,
        recipient_number: phone.replace(/\D/g, ''),
        content_type: 'text',
        text: message
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 text send failed:', JSON.stringify(data).substring(0, 300));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 WhatsApp text sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 text send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// MSG91 is Biomexa's sole WhatsApp provider — CallMeBot and Twilio have both been removed.
// userApiKey is accepted for backward compatibility with old call sites but is no longer used.
async function sendWhatsAppFree(phone, message, userApiKey) {
  if (MSG91_CONFIGURED) {
    const msg91Result = await sendMsg91Text(phone, message);
    if (msg91Result.success) return msg91Result;
  } else {
    console.log('⚠️ MSG91 not configured — cannot deliver to', phone);
  }

  console.log('❌ WhatsApp message could not be delivered to', phone);
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
    active: { type: Boolean, default: true },
    durationDays: Number, // optional — how many days this treatment runs for; null/undefined = ongoing indefinitely
    startDate: { type: Date, default: Date.now },
    endDate: Date // computed from startDate + durationDays when durationDays is set; reminders stop after this date
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
  glucose: Number, // blood sugar, mg/dL — especially relevant for diabetes patients (Diabmexa)
  source: { type: String, default: 'whatsapp' }, // whatsapp | manual | doctor
  recordedAt: { type: Date, default: Date.now }
});

// Prescriptions and lab reports a patient uploads for AI analysis. Stores the file itself as
// base64 (no external file storage configured) — kept intentionally small (5MB cap, enforced at
// upload) since Mongo documents have a 16MB hard limit and base64 adds ~33% overhead.
const uploadedDocumentSchema = new mongoose.Schema({
  patientPhone: String,
  fileName: String,
  fileType: String, // mime type, e.g. image/jpeg, application/pdf
  fileData: String, // base64, no data: URL prefix
  analysis: String, // Claude's extracted key factors, filled in after analysis completes
  analysisStatus: { type: String, default: 'pending' }, // pending | done | failed | not_configured
  uploadedAt: { type: Date, default: Date.now }
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
    heartRate: Number,
    glucose: Number
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
const UploadedDocument = mongoose.model('UploadedDocument', uploadedDocumentSchema);
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

  if (vitals.glucose >= 250) {
    reasons.push(`Severe hyperglycemia: sugar ${vitals.glucose} mg/dL`);
    severity = 'critical';
  } else if (vitals.glucose && vitals.glucose <= 70) {
    reasons.push(`Hypoglycemia: sugar ${vitals.glucose} mg/dL`);
    severity = 'critical';
  } else if (vitals.glucose >= 180) {
    reasons.push(`High blood sugar: sugar ${vitals.glucose} mg/dL`);
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
    sendDoctorAlertMessage(availableDoctor.phone, patient.name, patient.phone, danger.severity, danger.reason);
  }

  // Uses the risk alert template when configured (works regardless of session state) — this is
  // what fixes the "Sent" but never-delivered issue confirmed via MSG91's own logs (Meta error
  // 131047: the patient hadn't messaged within 24h, so free text was silently rejected).
  sendRiskAlertMessage(patient.phone, patient.name, danger.severity === 'critical' ? 'Critical' : 'High', danger.reason);

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
app.post('/api/auth/register', signupLimiter, async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    const existing = await Patient.findOne({ phone });
    if (existing) return res.status(400).json({ message: 'Phone number already registered. Please login.' });

    const hashed = await bcrypt.hash(password, 10);
    const patient = new Patient({ name, phone, email, password: hashed });
    await patient.save();

    const token = jwt.sign({ id: patient._id, phone }, JWT_SECRET, { expiresIn: '7d' });

    // Tries the welcome template first (works even for a brand-new contact who's never
    // messaged your business number), falls back to free text if the template isn't
    // configured — same fix already proven for risk_alert.
    const welcomeMsg = `🎉 Welcome to Biomexa, ${name}!\n\nYour WhatsApp dose reminders are now active. We'll notify you when it's time to take your medicine.\n\nReply CONFIRM after each dose to track your adherence.\n\n- Biomexa Team`;
    const waResult = await sendWelcomeMessage(phone, name, welcomeMsg);

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
app.post('/api/quick-reminder', signupLimiter, async (req, res) => {
  try {
    const { name, phone, medicineName, dosage, time, foodNote, durationDays } = req.body;
    if (!name || !phone || !medicineName || !time) {
      return res.status(400).json({ message: 'Name, phone, medicine, and time are required.' });
    }
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(time)) {
      return res.status(400).json({ message: 'Time must be in 24-hour format (HH:MM), e.g. 09:00' });
    }
    const days = durationDays ? parseInt(durationDays, 10) : null;
    if (days !== null && (isNaN(days) || days < 1 || days > 365)) {
      return res.status(400).json({ message: 'Treatment duration must be between 1 and 365 days, or left blank for ongoing.' });
    }

    let patient = await Patient.findOne({ phone });
    let isNewAccount = false;

    if (!patient) {
      isNewAccount = true;
      const randomPassword = crypto.randomBytes(12).toString('hex');
      const hashed = await bcrypt.hash(randomPassword, 10);
      patient = await Patient.create({ name, phone, password: hashed, medicines: [] });
    }

    const startDate = new Date();
    const endDate = days ? new Date(startDate.getTime() + days * 86400000) : null;
    patient.medicines.push({ name: medicineName, dosage: dosage || '', time, frequency: 'daily', foodNote: foodNote || '', active: true, durationDays: days, startDate, endDate });
    await patient.save();

    // Same fix as /api/medicines: don't create a "today" dose for a time that's already passed —
    // the reminder cron only matches an exact current-time tick, it can't catch up retroactively,
    // so that dose would sit stuck as Pending forever. Skip it and let tomorrow's daily
    // generation create the first real one instead.
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const timeAlreadyPassedToday = time <= currentTime;

    if (!timeAlreadyPassedToday) {
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
    }

    const firstReminderNote = timeAlreadyPassedToday
      ? `Today's ${time} slot has already passed, so your first reminder will be tomorrow at ${time}.`
      : '';
    const durationNote = days ? `\n📅 This reminder will run for ${days} day${days > 1 ? 's' : ''} and then stop automatically.` : '';
    const msg = isNewAccount
      ? `🎉 Hi ${name}! Your reminder for *${medicineName}* is set for ${time} daily.${firstReminderNote ? '\n' + firstReminderNote : ''}${durationNote}\n\nWe've also created your Biomexa account with this number — use "Forgot password" on the login page anytime if you want full dashboard access.\n\n- Biomexa Team`
      : `✅ Added a new reminder for *${medicineName}* at ${time} daily to your existing Biomexa account.${firstReminderNote ? '\n' + firstReminderNote : ''}${durationNote}\n\n- Biomexa Team`;

    // A brand-new contact hasn't messaged your business number yet, so MSG91 free-text delivery
    // isn't guaranteed (WhatsApp only allows that within an open 24h session). The approved
    // template works regardless of session state, so try that first for new accounts — existing
    // patients have likely already messaged in before, so plain text is fine for them.
    let waResult;
    if (isNewAccount && MSG91_CONFIGURED) {
      waResult = await sendDoseReminderTemplate(phone, medicineName, dosage || '');
      if (!waResult.success) waResult = await sendWhatsAppFree(phone, msg);
    } else {
      waResult = await sendWhatsAppFree(phone, msg);
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

// Quick vitals logging — same phone-identified pattern as /api/quick-reminder, for pages like
// the Diabmexa AI guide's "Daily Vitals & Glucose Tracker" where a visitor isn't logged in.
// Finds/creates the patient by phone, saves a real VitalsLog entry, updates their baseline, and
// runs the same danger check the WhatsApp flow uses so risk alerts stay consistent everywhere.
app.post('/api/quick-vitals', signupLimiter, async (req, res) => {
  try {
    const { name, phone, glucose, bpSystolic, bpDiastolic, temperature, heartRate } = req.body;
    if (!phone || (!glucose && !bpSystolic && !temperature && !heartRate)) {
      return res.status(400).json({ message: 'Phone number and at least one vital reading are required.' });
    }

    let patient = await Patient.findOne({ phone });
    if (!patient) {
      const randomPassword = crypto.randomBytes(12).toString('hex');
      const hashed = await bcrypt.hash(randomPassword, 10);
      patient = await Patient.create({ name: name || 'Biomexa Patient', phone, password: hashed, medicines: [] });
    }

    const vitals = {};
    if (glucose) vitals.glucose = parseInt(glucose, 10);
    if (bpSystolic) vitals.bpSystolic = parseInt(bpSystolic, 10);
    if (bpDiastolic) vitals.bpDiastolic = parseInt(bpDiastolic, 10);
    if (temperature) vitals.temperature = parseFloat(temperature);
    if (heartRate) vitals.heartRate = parseInt(heartRate, 10);

    await VitalsLog.create({ patientPhone: phone, ...vitals, source: 'manual' });

    const baselineUpdate = {};
    if (vitals.glucose) baselineUpdate['baselineVitals.glucose'] = vitals.glucose;
    if (vitals.bpSystolic) baselineUpdate['baselineVitals.bpSystolic'] = vitals.bpSystolic;
    if (vitals.bpDiastolic) baselineUpdate['baselineVitals.bpDiastolic'] = vitals.bpDiastolic;
    if (vitals.temperature) baselineUpdate['baselineVitals.temperature'] = vitals.temperature;
    if (Object.keys(baselineUpdate).length) await Patient.findOneAndUpdate({ phone }, baselineUpdate);

    const alert = await triggerRiskAlert(patient, vitals);

    res.json({ message: 'Vitals saved to your Biomexa record.', riskFlagged: !!alert });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    const patient = await Patient.findOne({ phone });
    if (!patient) return res.status(400).json({ message: 'User not found' });

    const match = await bcrypt.compare(password, patient.password);
    if (!match) return res.status(400).json({ message: 'Invalid password' });

    const token = jwt.sign({ id: patient._id, phone }, JWT_SECRET, { expiresIn: '7d' });

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

// ========== FORGOT PASSWORD (patients & doctors, WhatsApp + email) ==========
// Tries WhatsApp first (only works if the account has messaged Biomexa's WhatsApp number
// recently — MSG91's session rule), then email (works for anyone with an email on file, once
// EMAIL_USER/EMAIL_APP_PASSWORD are set). Succeeds if EITHER channel delivers.
app.post('/api/auth/forgot-password', otpLimiter, async (req, res) => {
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
    const waResult = isAdmin ? { success: false } : await sendWhatsAppFree(phone, otpMsg);
    const emailResult = await sendResetEmail(account.email, otp, account.name || account.username);

    if (!waResult.success && !emailResult.success) {
      return res.status(500).json({
        message: isAdmin
          ? 'Could not deliver the code by email. Make sure EMAIL_USER/EMAIL_APP_PASSWORD are configured on the server.'
          : account.email
            ? 'Could not deliver the code over WhatsApp or email. Please try again in a moment.'
            : 'This account has no email on file, and WhatsApp delivery only works if you\'ve messaged Biomexa on WhatsApp recently. Please contact support.'
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
      sendWhatsAppFree(phone, confirmMsg);
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

// A patient's own logged vitals history — every real reading they've sent over WhatsApp,
// most recent first. This is what lets a patient actually see the data they've been sending in,
// not just have it silently feed the AI risk model behind the scenes.
app.get('/api/patient/vitals-history', auth, async (req, res) => {
  try {
    const logs = await VitalsLog.find({ patientPhone: req.user.phone }).sort({ recordedAt: -1 }).limit(30);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const ALLOWED_DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_DOCUMENT_BASE64_LENGTH = 5 * 1024 * 1024 * 1.4; // ~5MB file, base64 adds ~33% overhead

// Upload a prescription or lab report for AI analysis. Accepts base64 (sent as plain JSON,
// no multipart handling needed) — the frontend reads the file via FileReader before sending.
// Analysis runs synchronously in the same request when Gemini or Claude is configured; the
// request can take up to ~30s for that reason, which the frontend's loading state accounts for.
app.post('/api/patient/upload-report', auth, async (req, res) => {
  try {
    const { fileName, fileType, fileData } = req.body;
    if (!fileName || !fileType || !fileData) {
      return res.status(400).json({ message: 'File name, type, and data are required.' });
    }
    if (!ALLOWED_DOCUMENT_TYPES.includes(fileType)) {
      return res.status(400).json({ message: 'Only JPG, PNG, WEBP, or PDF files are supported.' });
    }
    if (fileData.length > MAX_DOCUMENT_BASE64_LENGTH) {
      return res.status(400).json({ message: 'File is too large — please upload something under 5MB.' });
    }

    const doc = await UploadedDocument.create({
      patientPhone: req.user.phone,
      fileName, fileType, fileData,
      analysisStatus: 'pending'
    });

    const result = await analyzeDocument(fileData, fileType);
    if (result.ok) {
      doc.analysis = result.analysis;
      doc.analysisStatus = 'done';
    } else if (result.reason === 'not_configured') {
      doc.analysisStatus = 'not_configured';
    } else {
      doc.analysisStatus = 'failed';
      doc.analysis = 'Analysis failed — you can try re-uploading, or ask your doctor to review this directly.';
    }
    await doc.save();

    res.json({
      message: result.ok ? 'Uploaded and analyzed!' : result.reason === 'not_configured' ? 'Uploaded — AI analysis isn\'t configured yet, but your file is saved.' : 'Uploaded, but analysis failed.',
      document: { _id: doc._id, fileName: doc.fileName, analysis: doc.analysis, analysisStatus: doc.analysisStatus, uploadedAt: doc.uploadedAt }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// List of past uploads — deliberately excludes fileData (the base64 blob) from the list view
// to keep the response small; a single document's full data is fetched separately if needed.
app.get('/api/patient/uploaded-reports', auth, async (req, res) => {
  try {
    const docs = await UploadedDocument.find({ patientPhone: req.user.phone })
      .select('-fileData')
      .sort({ uploadedAt: -1 })
      .limit(20);
    res.json(docs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Every missed dose with its exact scheduled date and time — the detail level a patient (or
// their doctor) needs to actually see the pattern, not just an aggregate adherence percentage.
app.get('/api/patient/missed-doses', auth, async (req, res) => {
  try {
    const missed = await Dose.find({ patientPhone: req.user.phone, status: 'missed' })
      .sort({ scheduledDate: -1, scheduledTime: -1 })
      .limit(60);
    res.json(missed);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Builds the same real AI-engine analysis used on the doctor side (effectiveness score, real
// clinical insights, treatment recommendations) but scoped to the logged-in patient's own data
// via their auth token — this is the shared logic both /api/patient/treatment-report and its
// WhatsApp-sending counterpart below call, so the portal view and the WhatsApp summary are
// always built from the exact same real analysis, never two different computations drifting
// apart.
async function buildPatientTreatmentReport(phone) {
  const patient = await Patient.findOne({ phone });
  if (!patient) return { error: 'Patient not found', status: 404 };

  const doses = await Dose.find({ patientPhone: phone }).sort({ scheduledDate: 1 });
  if (!doses.length) return { error: 'No dose history yet — add a medicine and confirm a few doses first, then check back.', status: 400 };

  const vitalsLogs = await VitalsLog.find({ patientPhone: phone }).sort({ recordedAt: 1 });
  const vitalsByDay = {};
  for (const v of vitalsLogs) {
    const day = v.recordedAt.toISOString().split('T')[0];
    vitalsByDay[day] = v;
  }
  const usedRealVitals = vitalsLogs.length > 0;

  const primaryMed = patient.medicines?.[0] || { name: doses[0].medicineName, dosage: doses[0].dosage, time: doses[0].scheduledTime };
  const schedule = [...new Set(patient.medicines?.map(m => m.time) || [doses[0].scheduledTime])];

  const dose_history = doses
    .filter(d => d.status !== 'pending')
    .map(d => {
      const dayLog = vitalsByDay[d.scheduledDate];
      return {
        date: d.scheduledDate,
        status: d.status === 'taken' ? 'taken' : 'not_taken',
        vitals: {
          bp_systolic: dayLog?.bpSystolic || patient.baselineVitals?.bpSystolic || 130,
          bp_diastolic: dayLog?.bpDiastolic || patient.baselineVitals?.bpDiastolic || 85,
          glucose: dayLog?.glucose || patient.baselineVitals?.glucose || 110,
          temperature: dayLog?.temperature || patient.baselineVitals?.temperature || 98.6
        },
        symptoms: []
      };
    });

  if (!dose_history.length) return { error: 'All your doses so far are still pending — check back once you\'ve confirmed a few.', status: 400 };

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
    indication: 'hypertension'
  };

  const result = await callAiEngine('/analyze', payload);
  if (!result.ok) {
    const messages = {
      not_configured: 'The AI engine isn\'t configured yet — please try again later.',
      unreachable: 'Could not reach the AI engine right now — it may be waking up from sleep, please try again in a minute.',
      engine_error: 'The AI engine returned an error: ' + result.detail
    };
    return { error: messages[result.reason] || 'AI engine unavailable', status: 503 };
  }

  return { data: { ...result.data, usedRealVitals, patientName: patient.name } };
}

app.get('/api/patient/treatment-report', auth, async (req, res) => {
  const result = await buildPatientTreatmentReport(req.user.phone);
  if (result.error) return res.status(result.status).json({ message: result.error });
  res.json(result.data);
});

// Sends a condensed, readable version of the same report over WhatsApp — the full report with
// every data point stays on the portal, WhatsApp gets the score, adherence, and the top
// insight/recommendation so it's genuinely readable as a chat message, not a wall of JSON.
app.post('/api/patient/treatment-report/send-whatsapp', auth, async (req, res) => {
  const result = await buildPatientTreatmentReport(req.user.phone);
  if (result.error) return res.status(result.status).json({ message: result.error });

  const r = result.data;
  const topInsight = r.clinical_insights?.[0] || 'No specific concerns flagged.';
  const topRecommendation = r.treatment_recommendations?.[0] || 'Continue as prescribed.';

  const msg = `📊 *Your Treatment Report*\n\n💊 ${r.drug_name}\n📅 ${r.course_duration_days} day(s) tracked\n✅ Adherence: ${r.adherence_summary?.adherence_rate}%\n⭐ Effectiveness: ${r.effectiveness_category} (${r.effectiveness_score}/100)\n\n🔍 *Key insight:*\n${topInsight}\n\n💡 *Advice:*\n${topRecommendation}\n\nFull report with all details is on your Biomexa dashboard.\n\n- Biomexa Team`;

  const waResult = await sendWhatsAppFree(req.user.phone, msg);
  res.json({ message: waResult.success ? 'Report sent to your WhatsApp!' : 'Could not deliver to WhatsApp right now, but your full report is ready on the dashboard.', whatsappSent: waResult.success });
});

// Lets a logged-in patient log vitals directly from their own dashboard — same underlying save
// as the WhatsApp flow (VitalsLog, baseline update, risk-alert check), just entered via a form
// instead of parsed from free text. Identified by the auth token, not a phone in the body.
app.post('/api/patient/vitals', auth, async (req, res) => {
  try {
    const { bpSystolic, bpDiastolic, temperature, heartRate, glucose } = req.body;
    if (!bpSystolic && !temperature && !heartRate && !glucose) {
      return res.status(400).json({ message: 'Enter at least one reading.' });
    }

    const patient = await Patient.findOne({ phone: req.user.phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    const vitals = {};
    if (bpSystolic) vitals.bpSystolic = parseInt(bpSystolic, 10);
    if (bpDiastolic) vitals.bpDiastolic = parseInt(bpDiastolic, 10);
    if (temperature) vitals.temperature = parseFloat(temperature);
    if (heartRate) vitals.heartRate = parseInt(heartRate, 10);
    if (glucose) vitals.glucose = parseInt(glucose, 10);

    await VitalsLog.create({ patientPhone: req.user.phone, ...vitals, source: 'manual' });

    const baselineUpdate = {};
    if (vitals.bpSystolic) baselineUpdate['baselineVitals.bpSystolic'] = vitals.bpSystolic;
    if (vitals.bpDiastolic) baselineUpdate['baselineVitals.bpDiastolic'] = vitals.bpDiastolic;
    if (vitals.temperature) baselineUpdate['baselineVitals.temperature'] = vitals.temperature;
    if (vitals.glucose) baselineUpdate['baselineVitals.glucose'] = vitals.glucose;
    if (Object.keys(baselineUpdate).length) await Patient.findOneAndUpdate({ phone: req.user.phone }, baselineUpdate);

    const alert = await triggerRiskAlert(patient, vitals);

    res.json({ message: 'Vitals saved.', riskFlagged: !!alert });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Sends one real WhatsApp message right now, so a patient can immediately confirm they're
// receiving messages from Biomexa's WhatsApp number.
app.post('/api/patient/test-whatsapp', auth, async (req, res) => {
  try {
    const patient = await Patient.findOne({ phone: req.user.phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    const result = await sendWhatsAppFree(patient.phone, `🧪 *Test message from Biomexa*\n\nIf you're reading this on WhatsApp, your reminders are connected and working.\n\n- Biomexa Team`);
    if (!result.success) return res.status(500).json({ message: 'Could not deliver a test message right now — please try again in a moment.' });
    res.json({ message: 'Test message sent — check your WhatsApp.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ========== MEDICINE ROUTES ==========

// Add Medicine
app.post('/api/medicines', auth, async (req, res) => {
  try {
    const { name, dosage, frequency, foodNote, durationDays } = req.body;

    // Accepts either a single `time` (backward compatible with older clients) or a `times`
    // array — this is what lets a patient add one medicine with two reminder times (e.g. a
    // twice-daily prescription) in a single submission, instead of having to repeat the whole
    // form with the same medicine name twice.
    const rawTimes = Array.isArray(req.body.times) ? req.body.times : [req.body.time];
    const times = rawTimes.filter(Boolean);

    if (!times.length) {
      return res.status(400).json({ message: 'At least one reminder time is required.' });
    }
    if (times.length > 4) {
      return res.status(400).json({ message: 'Up to 4 reminder times are supported per medicine.' });
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    for (const t of times) {
      if (!timeRegex.test(t)) {
        return res.status(400).json({ message: `"${t}" is not a valid time — use 24-hour format (HH:MM), e.g. 14:30` });
      }
    }
    // Reject exact duplicate times in the same submission — everything downstream (dose dedup,
    // the reminder cron's exact-time match) assumes each time for a given medicine is distinct.
    if (new Set(times).size !== times.length) {
      return res.status(400).json({ message: 'Each reminder time must be different.' });
    }

    const days = durationDays ? parseInt(durationDays, 10) : null;
    if (days !== null && (isNaN(days) || days < 1 || days > 365)) {
      return res.status(400).json({ message: 'Treatment duration must be between 1 and 365 days, or left blank for ongoing.' });
    }

    const startDate = new Date();
    const endDate = days ? new Date(startDate.getTime() + days * 86400000) : null;
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().split('T')[0];

    // One medicine sub-document per time — this keeps every existing piece of logic (daily
    // regeneration, the reminder cron's exact-time match, per-dose confirmation and vitals
    // capture) working completely unchanged, since each one is a real, independent medicine
    // entry rather than a new data shape those systems would need to understand.
    const medicineEntries = times.map(t => ({
      name, dosage, time: t, frequency, foodNote, active: true, durationDays: days, startDate, endDate
    }));

    const patient = await Patient.findOneAndUpdate(
      { phone: req.user.phone },
      { $push: { medicines: { $each: medicineEntries } } },
      { new: true }
    );

    // Same "time already passed today" protection as before, applied per time — a medicine
    // added with one time in the future and one already passed today correctly gets today's
    // dose for the future one and starts the passed one tomorrow, rather than losing both.
    const createdToday = [];
    const deferredToTomorrow = [];
    for (const t of times) {
      if (t <= currentTime) {
        deferredToTomorrow.push(t);
      } else {
        await Dose.create({
          patientPhone: req.user.phone,
          medicineName: name,
          dosage,
          scheduledTime: t,
          scheduledDate: today,
          foodNote: foodNote || '',
          status: 'pending'
        });
        createdToday.push(t);
      }
    }

    const timesLabel = times.join(' & ');
    let scheduleNote;
    if (deferredToTomorrow.length === 0) {
      scheduleNote = `You'll receive a WhatsApp reminder when it's time to take it.`;
    } else if (createdToday.length === 0) {
      scheduleNote = `Today's slot${deferredToTomorrow.length > 1 ? 's' : ''} (${deferredToTomorrow.join(', ')}) already passed, so your first reminder${deferredToTomorrow.length > 1 ? 's start' : ' starts'} tomorrow.`;
    } else {
      scheduleNote = `${createdToday.join(', ')} is scheduled for today. ${deferredToTomorrow.join(', ')} already passed today, so that one starts tomorrow.`;
    }

    // Send confirmation WhatsApp
    const durationNote = days ? `\n📅 This reminder will run for ${days} day${days > 1 ? 's' : ''} and then stop automatically.` : '';
    const confirmMsg = `💊 *Medicine Added*\n\n${name} — ${dosage}\n⏰ ${timesLabel}\n${foodNote ? '🍽️ ' + foodNote + '\n' : ''}${durationNote}\n${scheduleNote}\n\n- Biomexa Team`;
    sendWhatsAppFree(req.user.phone, confirmMsg);

    res.json({ message: `Medicine added with ${times.length} reminder time${times.length > 1 ? 's' : ''}.`, medicines: patient.medicines });
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
    sendWhatsAppFree(req.user.phone, confirmMsg);

    res.json({ message: 'Dose confirmed', dose });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== WHATSAPP REMINDER CRON ==========
// Tracks the last calendar date the daily dose-generation ran, so it only actually does the
// work once per day even though it's checked on every minute tick — this replaces a separate
// fixed-clock-time cron ('1 0 * * *') that never actually fired, because Render's free tier
// puts the service to sleep when idle and only wakes it on incoming traffic; the odds of it
// being awake at exactly 00:01 were effectively zero. Piggybacking on the reliable once-a-minute
// job means this runs the moment the service is next awake, whatever time that happens to be.
let lastDoseGenerationDate = null;

async function generateTodaysDoses(todayStr) {
  console.log('🌅 Generating today\'s doses for all active medicines...');
  const today = new Date();
  const currentTime = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
  try {
    const patients = await Patient.find({ 'medicines.active': true });
    let created = 0, expired = 0, skippedPassed = 0;

    for (const patient of patients) {
      for (const med of patient.medicines) {
        if (!med.active) continue;

        if (med.endDate && new Date(med.endDate) < today) {
          med.active = false;
          expired++;
          continue;
        }

        const existing = await Dose.findOne({ patientPhone: patient.phone, medicineName: med.name, scheduledTime: med.time, scheduledDate: todayStr });
        if (existing) continue;

        // Same protection as /api/medicines: if this is the first regeneration run of the day
        // and it happens to occur after this medicine's time has already passed (Render's free
        // tier can wake up late after sleeping), creating a "today" dose here would leave it
        // permanently stuck as Pending — the exact-time-match reminder cron can never catch up
        // on a minute that's already gone by. Skip it; tomorrow's regeneration creates a real one.
        if (med.time <= currentTime) {
          skippedPassed++;
          continue;
        }

        await Dose.create({
          patientPhone: patient.phone,
          medicineName: med.name,
          dosage: med.dosage,
          scheduledTime: med.time,
          scheduledDate: todayStr,
          foodNote: med.foodNote || '',
          status: 'pending'
        });
        created++;
      }
      if (patient.isModified('medicines')) await patient.save();
    }
    console.log(`🌅 Daily dose generation done: ${created} created, ${expired} medicine(s) ended their course, ${skippedPassed} skipped (time already passed today).`);
  } catch (err) {
    console.error('❌ Daily dose generation error:', err.message);
  }
}

cron.schedule('* * * * *', async () => {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toISOString().split('T')[0];

  if (lastDoseGenerationDate !== today) {
    lastDoseGenerationDate = today;
    await generateTodaysDoses(today);
  }

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
      // free text like "CONFIRM". Falls back to a plain-text WhatsApp reminder otherwise.
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
        const result = await sendWhatsAppFree(dose.patientPhone, message);
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
      const explicitlyMissed = /not\s*taken|missed|no\b(?!.*later)/.test(reply);
      const wantsLater = /remind.*later|later|snooze/.test(reply);

      if (wantsLater) {
        // Push the dose's scheduled time forward 20 minutes and clear sentReminder so the
        // existing cron job picks it up again naturally, same as a normal first reminder.
        const snoozeTime = new Date(Date.now() + 20 * 60 * 1000);
        const hh = String(snoozeTime.getHours()).padStart(2, '0');
        const mm = String(snoozeTime.getMinutes()).padStart(2, '0');
        await Dose.findByIdAndUpdate(convo.doseId, { scheduledTime: `${hh}:${mm}`, sentReminder: false });
        await sendWhatsAppFree(phone, `⏰ No problem — we'll remind you again in about 20 minutes.`);
        await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: null, doseId: null, updatedAt: new Date() });
        return;
      }

      if (took || explicitlyMissed) {
        await Dose.findByIdAndUpdate(convo.doseId, { status: took ? 'taken' : 'missed' });

        if (took) {
          await sendWhatsAppFree(phone, '✅ Logged as taken!\n\n📋 *Quick check-in*\n\nGot all 4? Just copy the numbers below (skip the words in brackets):\n\n```\n120/80(BP) 98.6(Temp) 72(Pulse) 110(Sugar)\n```\n\nOnly have some? Use labels instead:\n"sugar 110" or "BP 120/80, pulse 72"\n\nOr reply "skip".');
          await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: 'awaiting_vitals', updatedAt: new Date() });
        } else {
          await sendWhatsAppFree(phone, `Noted — marked as not taken. Please try to take it as soon as possible, or reach out to your doctor via the Biomexa app if you're having trouble with this medicine.`);
          await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: null, doseId: null, updatedAt: new Date() });
        }
      }
      return;
    }

    if (convo && convo.state === 'awaiting_vitals') {
      if (/^skip$/i.test(freeText.trim())) {
        await sendWhatsAppFree(phone, `No problem — see you at the next dose! 💪`);
        await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: null, updatedAt: new Date() });
        return;
      }

      const vitals = parseVitalsFromText(freeText);
      if (Object.keys(vitals).length === 0) {
        await sendWhatsAppFree(phone, 'Sorry, I couldn\'t read any numbers from that.\n\nGot all 4? Copy the numbers below (skip the bracketed words):\n```\n120/80(BP) 98.6(Temp) 72(Pulse) 110(Sugar)\n```\n\nOnly some? Use labels:\n"sugar 110" or "BP 120/80"\n\nOr reply "skip".');
        return;
      }

      await VitalsLog.create({ patientPhone: phone, ...vitals, source: 'whatsapp' });

      // Keep the patient's baseline snapshot current too, so anywhere that reads baselineVitals
      // (dashboards, the AI engine fallback) reflects their latest reading.
      const baselineUpdate = {};
      if (vitals.bpSystolic) baselineUpdate['baselineVitals.bpSystolic'] = vitals.bpSystolic;
      if (vitals.bpDiastolic) baselineUpdate['baselineVitals.bpDiastolic'] = vitals.bpDiastolic;
      if (vitals.temperature) baselineUpdate['baselineVitals.temperature'] = vitals.temperature;
      if (vitals.glucose) baselineUpdate['baselineVitals.glucose'] = vitals.glucose;
      if (Object.keys(baselineUpdate).length) await Patient.findOneAndUpdate({ phone }, baselineUpdate);

      const summary = [
        vitals.bpSystolic && `BP ${vitals.bpSystolic}/${vitals.bpDiastolic}`,
        vitals.temperature && `Temp ${vitals.temperature}°F`,
        vitals.heartRate && `Pulse ${vitals.heartRate}`,
        vitals.glucose && `Sugar ${vitals.glucose} mg/dL`
      ].filter(Boolean).join(', ');

      // Risk check — if this reading is dangerous, triggerRiskAlert handles notifying both the
      // patient and an available doctor. The "logged" confirmation still goes out either way.
      const alert = patient ? await triggerRiskAlert(patient, vitals) : null;
      if (!alert) {
        await sendWhatsAppFree(phone, `📊 Logged: ${summary}. Thanks — this is saved to your Biomexa dashboard now.`);
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
app.post('/api/doctors/register', signupLimiter, async (req, res) => {
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

    const token = jwt.sign({ id: doctor._id, phone, role: 'doctor' }, JWT_SECRET, { expiresIn: '7d' });

    const welcomeMsg = `👨‍⚕️ *Welcome to Biomexa, Dr. ${name}!*\n\nYour doctor profile is now live on the Biomexa Connect network. Patients with a high risk score can reach you instantly via WhatsApp.\n\nYou're marked *Available* by default — toggle this anytime from your dashboard.\n\n- Biomexa Team`;
    sendWelcomeMessage(phone, `Dr. ${name}`, welcomeMsg);

    res.json({ message: 'Doctor registered successfully', token, doctor: { id: doctor._id, name, phone, specialty: doctor.specialty, available: doctor.available } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Doctor login (real accounts)
app.post('/api/doctors/login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    const doctor = await Doctor.findOne({ phone });
    if (!doctor) return res.status(400).json({ message: 'No doctor account found with this number' });

    const match = await bcrypt.compare(password, doctor.password);
    if (!match) return res.status(400).json({ message: 'Invalid password' });

    const token = jwt.sign({ id: doctor._id, phone, role: 'doctor' }, JWT_SECRET, { expiresIn: '7d' });
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

app.post('/api/doctors/test-whatsapp', doctorAuth, async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.doctor.id);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found' });

    const result = await sendWhatsAppFree(doctor.phone, `🧪 *Test message from Biomexa*\n\nIf you're reading this on WhatsApp, patient connect alerts will reach you.\n\n- Biomexa Team`);
    if (!result.success) return res.status(500).json({ message: 'Could not deliver a test message right now — please try again in a moment.' });
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

      const { features, adherence, missed, vitals, hasRealVitals } = await computePatientFeatures(p);
      let riskProb;
      if (model && model.weights.length === features.length) {
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
        bpSystolic: vitals.bpSystolic,
        bpDiastolic: vitals.bpDiastolic,
        bpStatus: vitals.bpSystolic >= 140 || vitals.bpDiastolic >= 90 ? 'high' : vitals.bpSystolic < 100 ? 'low' : 'normal',
        vitalsAreReal: hasRealVitals,
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

    const allVitals = await VitalsLog.find({ patientPhone: phone }).sort({ recordedAt: 1 });

    const today = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      const dayDoses = await Dose.find({ patientPhone: phone, scheduledDate: dateStr });
      const taken = dayDoses.filter(x => x.status === 'taken').length;
      const adherence = dayDoses.length ? Math.round((taken / dayDoses.length) * 100) : null;

      // Real vitals logged that day (last one wins if several) — falls back to the baseline
      // snapshot only when nothing was actually logged that day, and marks which is which.
      const dayVitals = allVitals.filter(v => v.recordedAt.toISOString().split('T')[0] === dateStr);
      const latest = dayVitals[dayVitals.length - 1];

      days.push({
        date: dateStr,
        label: d.toLocaleDateString('en-IN', { weekday: 'short' }),
        adherence,
        bpSystolic: latest?.bpSystolic || patient.baselineVitals?.bpSystolic || null,
        bpDiastolic: latest?.bpDiastolic || patient.baselineVitals?.bpDiastolic || null,
        temperature: latest?.temperature || null,
        heartRate: latest?.heartRate || null,
        glucose: latest?.glucose || patient.baselineVitals?.glucose || null,
        hasRealVitals: !!latest
      });
    }
    res.json({ patient: { name: patient.name, phone: patient.phone, baselineVitals: patient.baselineVitals }, days });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Full effectiveness analysis via the Python AI engine (ai_engine.py) — real vital-trend
// analysis, adherence scoring, clinical insights and treatment recommendations, computed from
// this patient's actual dose history and real WhatsApp-logged vitals (VitalsLog) where available,
// falling back to their baseline snapshot for any day without a logged reading.
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

app.get('/api/admin/login', loginLimiter, adminAuth, (req, res) => {
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
// Turns one patient's real Dose + Vitals history into a feature vector for the risk model.
// Combines adherence/regimen-complexity signals with their most recent real vitals reading —
// this is what makes the model genuinely predict from "vitals AND adherence score" together,
// rather than adherence alone. Falls back sensibly when a patient has no vitals logged yet.
async function computePatientFeatures(patient) {
  const doses = await Dose.find({ patientPhone: patient.phone });
  const total = doses.length;
  const missed = doses.filter(d => d.status === 'missed').length;
  const taken = doses.filter(d => d.status === 'taken').length;
  const adherence = total ? taken / total : 1;
  const daysSince = patient.createdAt ? Math.max(1, Math.floor((Date.now() - new Date(patient.createdAt)) / 86400000)) : 1;
  const numMedicines = (patient.medicines || []).length || 1;
  const doseFreq = total / daysSince;

  // Real vitals — prefer the most recent WhatsApp-logged reading (see VitalsLog), fall back to
  // the baseline snapshot taken at signup, then to population-normal defaults if the patient
  // has never had any vitals recorded at all.
  const latestVitals = await VitalsLog.findOne({ patientPhone: patient.phone }).sort({ recordedAt: -1 });
  const bpSystolic = latestVitals?.bpSystolic || patient.baselineVitals?.bpSystolic || 120;
  const bpDiastolic = latestVitals?.bpDiastolic || patient.baselineVitals?.bpDiastolic || 80;
  const temperature = latestVitals?.temperature || patient.baselineVitals?.temperature || 98.6;
  const heartRate = latestVitals?.heartRate || 72;
  const glucose = latestVitals?.glucose || patient.baselineVitals?.glucose || 100;
  const hasRealVitals = !!latestVitals;

  const features = [numMedicines, missed, daysSince, doseFreq, bpSystolic, bpDiastolic, temperature, heartRate, glucose];
  return {
    features, adherence, missed, total, hasRealVitals,
    vitals: { bpSystolic, bpDiastolic, temperature, heartRate, glucose }
  };
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
      message: 'Model trained successfully on real patient adherence AND vitals data',
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
      const { features, adherence, missed, total, vitals, hasRealVitals } = await computePatientFeatures(p);
      let riskProb;
      if (model && model.weights.length === features.length) {
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
        bpSystolic: vitals.bpSystolic,
        bpDiastolic: vitals.bpDiastolic,
        vitalsAreReal: hasRealVitals,
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

// Deletes one patient and every piece of data tied to their phone number — doses, vitals logs,
// conversation state, and any risk alerts. This is for cleaning up test accounts before going
// live with real patients; there's no undo, so the frontend requires a confirmation before
// calling this.
app.delete('/api/admin/patients/:phone', adminAuth, async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const patient = await Patient.findOne({ phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    const [doses, vitals, alerts] = await Promise.all([
      Dose.deleteMany({ patientPhone: phone }),
      VitalsLog.deleteMany({ patientPhone: phone }),
      RiskAlert.deleteMany({ patientPhone: phone })
    ]);
    await ConversationState.deleteOne({ patientPhone: phone });
    await Patient.deleteOne({ phone });

    res.json({
      message: `Deleted ${patient.name} (${phone}) and all associated data.`,
      deleted: { doses: doses.deletedCount, vitals: vitals.deletedCount, alerts: alerts.deletedCount }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin-triggered bulk risk alert — sends a real WhatsApp message to every patient currently
// flagged High or Critical by the trained AI model (same risk calculation as the table above,
// so "who counts as high-risk" is always consistent between what the admin sees and who gets
// messaged). Distinct from the automatic per-reading RiskAlert system (which fires on a single
// dangerous vitals reading) — this is a deliberate, admin-initiated check-in broadcast.
app.post('/api/admin/send-risk-alerts', adminAuth, async (req, res) => {
  try {
    const model = await TrainedModel.findOne().sort({ trainedAt: -1 });
    const patients = await Patient.find();
    const results = { sent: [], failed: [], skipped_low_risk: 0 };

    for (const p of patients) {
      const { features, adherence } = await computePatientFeatures(p);
      let riskProb;
      if (model && model.weights.length === features.length) {
        const norm = features.map((v, j) => (v - model.featureMeans[j]) / model.featureStds[j]);
        const z = norm.reduce((s, v, j) => s + v * model.weights[j], 0) + model.bias;
        riskProb = sigmoid(z);
      } else {
        riskProb = Math.max(0, Math.min(1, 1 - adherence));
      }

      if (riskProb <= 0.33) { results.skipped_low_risk++; continue; }

      const label = riskProb > 0.66 ? 'Critical' : 'High';
      const reason = `adherence risk ${Math.round(riskProb * 100)}%`;

      // Uses the risk alert template when configured — this is what actually reaches patients
      // regardless of whether they've messaged recently. Free text (the old behavior) was
      // showing "Sent" from MSG91's API but silently failing at Meta for anyone outside their
      // 24h session window (confirmed via MSG91's own Logs — error 131047).
      const result = await sendRiskAlertMessage(p.phone, p.name, label, reason);
      if (result.success) {
        results.sent.push({ name: p.name, phone: p.phone, risk_label: label, risk_score: riskProb });
      } else {
        results.failed.push({ name: p.name, phone: p.phone, risk_label: label });
      }
    }

    res.json({
      message: `Sent ${results.sent.length} risk alert(s), ${results.failed.length} failed to deliver, ${results.skipped_low_risk} patient(s) not high-risk.`,
      ...results
    });
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

// Public status check — lets the frontend know whether MSG91 (Biomexa's sole WhatsApp
// provider) is configured server-side. No auth needed — this is not sensitive, just a
// feature-availability flag.
app.get('/api/whatsapp-status', (req, res) => {
  res.json({
    msg91Configured: MSG91_CONFIGURED,
    riskTemplateConfigured: !!MSG91_RISK_TEMPLATE_NAME,
    welcomeTemplateConfigured: !!MSG91_WELCOME_TEMPLATE_NAME,
    doctorAlertTemplateConfigured: !!MSG91_DOCTOR_ALERT_TEMPLATE_NAME
  });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Biomexa Server running on port ${PORT}`);
  console.log(`📱 WhatsApp reminders active (checking every minute)`);
  console.log(`🔐 Password reset via WhatsApp OTP enabled`);
  if (MSG91_CONFIGURED) {
    console.log(`✅ MSG91 configured — integrated number ${MSG91_INTEGRATED_NUMBER}, template "${MSG91_DOSE_TEMPLATE_NAME}"`);
  } else {
    console.log(`\n⚠️  WARNING: MSG91 not configured (MSG91_AUTH_KEY / MSG91_INTEGRATED_NUMBER missing)!`);
    console.log(`   No WhatsApp messages will be sent — MSG91 is Biomexa's only WhatsApp provider.`);
    console.log(`   See .env.example for setup steps.\n`);
  }
});
