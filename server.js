require('dotenv').config();
// Reminder times are Indian times (HH:MM as the patient typed them), so the server clock must be too.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { cleanVitals, toFahrenheit, normaliseEntry, checkVitalsDanger } = require('./vitals/calibration');
const { buildVitalsProgress } = require('./vitals/progress');
const ivfCare = require('./ivf/routes'); // Biomexa IVF Care — separate module, mounted near the end of this file

const app = express();
app.set('trust proxy', 1); // Render sits behind a reverse proxy — without this, req.ip returns
                            // the proxy's address for every request, not the real client IP,
                            // which would make the rate limiter below treat all users as one.
app.use(cors());
app.use(express.json({ limit: '22mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/razorpay/webhook')) req.rawBody = buf; } })); // default is 100kb — up to 3 files (~5MB each, base64 adds ~33%) per upload needs real headroom

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
const orderLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many orders from this connection. Please try again in an hour, or contact us directly.' });
// Product chat calls a real AI model per message, so it needs its own, more generous-but-bounded
// limit — a real Q&A conversation is several messages, unlike a one-shot signup/order form.
const productChatLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 25, message: 'Too many questions in a short time — please wait a few minutes and try again.' });

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

// Builds the prompt for X-rays and other medical imaging — deliberately different, and more
// carefully worded, than the prescription/lab-report prompt. A general-purpose vision model is
// NOT a validated diagnostic radiology tool, and treating its output as one would be a real
// safety risk. This prompt is built specifically to keep the AI in a "describe and flag for a
// professional" role — it never states a diagnosis, never names a disease as confirmed, and
// always routes the person back to a qualified doctor or radiologist for anything that matters.
function buildImagingPrompt(language, fileCount, audience, referenceContext = '', patientContext = '') {
  const languageInstruction = language && language !== 'English'
    ? `Write your entire response in ${language} — including section headers, translated naturally. Keep the emojis.`
    : 'Write in clear language.';

  const multiFileNote = fileCount > 1
    ? `You're looking at ${fileCount} images that are part of the same scan or study (e.g. different views/angles) — consider them together.`
    : `You're looking at a medical image — an X-ray, scan, or similar.`;

  const selfCheckInstruction = `\n\nBefore finalizing, re-check each specific observation against the image once more — if you're not genuinely confident a described feature is actually visible, soften it to "possible" or drop it rather than stating it plainly. Precision matters more than sounding thorough.`;

  if (audience === 'doctor') {
    return `${multiFileNote} You're assisting a licensed doctor as a second pair of eyes, not replacing their read. ${languageInstruction}

Structure your response exactly like this:

*🩻 Image Type & Quality*
What kind of image this appears to be (e.g. chest X-ray, PA view) and whether image quality/positioning is adequate for assessment.

*🔍 Observations*
Describe what's visible in neutral, descriptive terms (e.g. "increased opacity in the right lower lobe", "no obvious fracture line visible") — describe findings, don't name a diagnosis as confirmed. If something looks genuinely unremarkable, say so plainly rather than manufacturing a finding.

*⚠️ Worth a Closer Look*
Anything that stands out as worth the doctor's specific attention or a formal radiology read — only if something genuinely does.

Rules: you are a general-purpose vision model, not a validated radiology AI — state this limitation explicitly once, near the top. Never state a diagnosis as confirmed or rule one out with certainty. Never suggest this replaces a formal radiologist report for anything ambiguous or significant. Base observations only on what's actually visible — don't guess at poor-quality or ambiguous regions, say the image quality limits assessment there instead. Keep the whole thing under 280 words.${patientContext}${referenceContext}${selfCheckInstruction}`;
  }

  return `${multiFileNote} Write for a patient with no medical training. This will be shown on their dashboard and can be sent to them on WhatsApp, so use WhatsApp's formatting: *asterisks* for bold headers, plain short lines. ${languageInstruction}

Structure your response exactly like this:

*🩻 What This Image Shows*
Plainly say what kind of scan this looks like, in one line.

*🔍 What I Can See*
Describe what's visible in plain, neutral language — no diagnosis, no disease names stated as fact. If something looks different from the surrounding area, describe it factually (e.g. "there's an area that looks different from the tissue around it") without naming what it is.

*💡 Worth Mentioning to Your Doctor*
Only if something genuinely stands out — phrase it as "worth asking your doctor about," never as a finding to be worried about on its own.

CRITICAL rules: you are NOT a diagnostic tool and must never state or imply a diagnosis, a disease name, or a "you have X" conclusion — that requires a qualified doctor or radiologist actually reviewing this. Always end with a clear, unmissable line: "This is not a diagnosis. Please share this image with your doctor for a proper reading — especially if you have any symptoms or concerns right now." If the image suggests anything that could be urgent, add: "If you're experiencing symptoms, please don't wait — contact a doctor promptly." Keep the whole thing under 220 words.${patientContext}${referenceContext}${selfCheckInstruction}`;
}

// Builds the shared analysis prompt — same structure and rules for both providers, just the
// language changes. Kept as one function so improving the extraction quality only needs to
// happen in one place.
function buildAnalysisPrompt(language, fileCount, referenceContext = '', patientContext = '') {
  const languageInstruction = language && language !== 'English'
    ? `Write your ENTIRE response in ${language} — every word, including the section headers themselves (translate "Medicines", "Lab Values", "Worth Discussing" naturally into ${language}, keep the emojis). Do not mix in English except for the actual medicine/drug names, which should stay as printed on the document.`
    : 'Write your response in clear, plain English.';

  const multiFileNote = fileCount > 1
    ? `You're looking at ${fileCount} images/pages that are all part of the SAME prescription or report (e.g. front and back, or multiple pages) — read them together as one document, not separately, and don't repeat information that appears on more than one page.`
    : `You're looking at a patient-uploaded prescription or lab report.`;

  const selfCheckInstruction = `\n\nBefore finalizing, re-check every number, dosage, and name you've written against the document once more — a transposed digit or misread drug name is a real safety risk. If anything is genuinely ambiguous, flag it as unclear rather than guessing a plausible-looking value.`;

  return `${multiFileNote} Write a summary an average patient — not a medical professional — can genuinely understand at a glance. This same text will be shown on their dashboard AND sent to them as a WhatsApp message, so use WhatsApp's formatting: *asterisks* for bold section headers, plain short lines, no markdown tables or nested bullets. ${languageInstruction}

Structure it exactly like this, skipping any section that doesn't apply:

*💊 Medicines*
For each one: name, dosage, how often and when to take it (e.g. "after food", "at night") if that's shown, and what it's generally used for in one short plain-language phrase (e.g. "Metformin 500mg, twice daily after food — helps manage blood sugar").

*🔬 Lab Values*
For each one: the value, and a plain-language flag like "normal", "a bit high", or "low" — never just the raw number alone. Briefly say in everyday words what that value relates to (e.g. "HbA1c 7.2% — a bit high; this reflects average blood sugar over ~3 months").

*📋 Doctor's Notes*
Any diagnosis, instructions, or follow-up advice written on the document (e.g. "follow up in 2 weeks", "avoid salty food") — only if something is actually written there.

*💡 Worth Discussing*
One or two short, concrete points on what stands out — only if something genuinely does.

Rules: base this only on what's actually in the document — never guess at anything illegible or invent a value. If handwriting is genuinely hard to read, say so plainly for that specific item rather than skipping it silently (e.g. "Medicine name unclear — please confirm with your pharmacist") rather than guessing. Avoid medical jargon; if a technical term is unavoidable, explain it in a few plain words right there. End with one line reminding them this is a summary to discuss with their doctor, not a diagnosis. Keep the whole thing under 280 words so it reads well as a WhatsApp message.${patientContext}${referenceContext}${selfCheckInstruction}`;
}

// Builds a short, factual line of the patient's own known context (existing conditions, current
// medicines) to append to the analysis prompt — this is what lets the AI interpret a value
// correctly for THIS patient (e.g. a glucose reading reads differently for someone with known
// diabetes) instead of treating every document in a vacuum. Deliberately short and factual, never
// speculative, and skipped entirely when there's nothing on file rather than inventing filler.
function buildPatientContext(patient) {
  if (!patient) return '';
  const parts = [];
  if (patient.medicalHistory && patient.medicalHistory.length) {
    parts.push(`Known conditions/history: ${patient.medicalHistory.join(', ')}.`);
  }
  const activeMeds = (patient.medicines || []).filter(m => m.active).map(m => m.name).filter(Boolean);
  if (activeMeds.length) {
    parts.push(`Currently prescribed: ${[...new Set(activeMeds)].join(', ')}.`);
  }
  if (!parts.length) return '';
  return `\n\nThis patient's own known context on file (use this to interpret findings more accurately for THIS specific patient, but still base every finding only on what's actually in the uploaded document/image — never invent something not shown just because it fits their history): ${parts.join(' ')}`;
}

// Pulls a handful of relevant clinical-reference entries (added by admins, or auto-generated
// from a doctor's correction of a past AI analysis) and formats them as extra context appended
// to the analysis prompt. This is retrieval-augmented context injection, NOT literal model
// retraining/fine-tuning — there's no way to actually retrain Gemini/Claude from a web app, and
// nobody should be told that's happening. What this DOES do: it lets doctor corrections and
// admin-curated clinical notes steer future AI output for similar documents, without ever
// touching the underlying model. Fails safe — any error or empty result just returns '', so a
// broken reference lookup never blocks a document analysis.
async function getReferenceContext(category) {
  try {
    const entries = await ClinicalReference.find({ category })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();
    if (!entries || entries.length === 0) return '';
    const formatted = entries.map(e => `- ${e.title ? e.title + ': ' : ''}${e.content}`).join('\n');
    return `\n\nAdditional clinical context curated by this platform's medical team for similar cases (use this to sharpen your response where relevant, but still base findings only on what's actually in the uploaded document):\n${formatted}`;
  } catch (err) {
    console.log('⚠️ getReferenceContext failed (non-fatal):', err.message);
    return '';
  }
}

async function analyzeDocumentWithClaude(files, language, documentType = 'prescription', audience = 'patient', referenceContext = '', patientContext = '') {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: 'not_configured' };

  const contentBlocks = files.map(f => {
    const isPdf = f.fileType === 'application/pdf';
    return isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.fileData } }
      : { type: 'image', source: { type: 'base64', media_type: f.fileType, data: f.fileData } };
  });

  const prompt = documentType === 'imaging'
    ? buildImagingPrompt(language, files.length, audience, referenceContext, patientContext)
    : buildAnalysisPrompt(language, files.length, referenceContext, patientContext);

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
        max_tokens: 1300,
        messages: [{
          role: 'user',
          content: [...contentBlocks, { type: 'text', text: prompt }]
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
// Two models tried in sequence: 3.8 Flash first (the newest, most capable), then 3.5 Flash-Lite
// as a same-family backup if the first is overloaded — confirmed via Google's own current docs
// that Flash-Lite is a separate, currently-supported, genuinely free ("billing not required")
// model. Since it's a different, less brand-new model, it's a reasonable bet to have different
// capacity than 3.8 Flash during a demand spike on the newest release specifically.
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

async function callGeminiModel(model, parts, maxRetries, attempt = 0) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts }] }),
    signal: AbortSignal.timeout(70000)
  });
  const data = await res.json();
  if (!res.ok) {
    // 503/UNAVAILABLE means this specific model is temporarily overloaded — confirmed via real
    // "high demand" responses on live requests, a well-documented recurring pattern across the
    // whole Gemini lineup, and specifically common on the newest model right after release
    // (everyone tries it at once). Worth retrying with backoff within the SAME model first, but
    // NOT models earlier in the fallback chain get fewer retries than the last one — the whole
    // point of having a second, less-contended model is to reach it quickly rather than
    // exhausting the busiest model's patience first.
    if (res.status === 503 && attempt < maxRetries) {
      const waitMs = attempt === 0 ? 3000 : 8000;
      console.log(`⏳ ${model} overloaded (503) — retry ${attempt + 1}/${maxRetries} in ${waitMs / 1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
      return callGeminiModel(model, parts, maxRetries, attempt + 1);
    }
    return { ok: false, status: res.status, detail: data.error?.message || `HTTP ${res.status}`, data };
  }
  const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || 'No analysis returned.';
  return { ok: true, analysis: text };
}

async function analyzeDocumentWithGemini(files, language, documentType = 'prescription', audience = 'patient', referenceContext = '', patientContext = '') {
  if (!GEMINI_API_KEY) return { ok: false, reason: 'not_configured' };

  const prompt = documentType === 'imaging'
    ? buildImagingPrompt(language, files.length, audience, referenceContext, patientContext)
    : buildAnalysisPrompt(language, files.length, referenceContext, patientContext);
  const parts = [
    { text: prompt },
    ...files.map(f => ({ inline_data: { mime_type: f.fileType, data: f.fileData } }))
  ];

  let lastFailure = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    const isLastModel = i === GEMINI_MODELS.length - 1;
    // Non-final models get 1 retry (fail fast, move on) — the last model gets the full 2, since
    // there's nothing left to fall through to on the Gemini side after it except Claude.
    const maxRetries = isLastModel ? 2 : 1;
    try {
      const result = await callGeminiModel(model, parts, maxRetries);
      if (result.ok) {
        if (i > 0) console.log(`✅ Succeeded on fallback model ${model}`);
        return { ok: true, analysis: result.analysis };
      }
      lastFailure = result;
      console.log(`⚠️ ${model} failed:`, JSON.stringify(result.data || {}).substring(0, 300));
    } catch (err) {
      lastFailure = { detail: err.message };
      console.log(`⚠️ ${model} error:`, err.message);
    }
  }
  return { ok: false, reason: 'api_error', detail: lastFailure?.detail || 'All Gemini models unavailable' };
}

// Unified document analyzer — tries Gemini first (free), and now also falls back to Claude if
// Gemini fails for ANY reason after its own retries are exhausted, not just when Gemini isn't
// configured. This only kicks in when both providers are actually configured, so it never
// incurs cost the person hasn't already opted into by setting up both keys — it just means a
// temporary Gemini outage doesn't leave the feature broken when a working backup is right there.
// `files` is an array of {fileType, fileData} — 1 to 3 pages/images analyzed together as one
// document. `language` is the preferred language for the written-out analysis. `documentType` is
// 'prescription' (default) or 'imaging' — picks which prompt is used. `audience` is 'patient'
// (default) or 'doctor' — only affects the imaging prompt's tone/depth.
async function analyzeDocument(files, language, documentType = 'prescription', audience = 'patient', patient = null) {
  // Fetched once and reused for both providers so a Gemini→Claude fallback doesn't double up
  // on database reads for the same analysis.
  const referenceContext = await getReferenceContext(documentType === 'imaging' ? 'imaging' : 'prescription');
  const patientContext = buildPatientContext(patient);
  const geminiResult = await analyzeDocumentWithGemini(files, language, documentType, audience, referenceContext, patientContext);
  if (geminiResult.ok) return geminiResult;
  if (!ANTHROPIC_API_KEY) return geminiResult;
  console.log(`ℹ️ Gemini failed (${geminiResult.reason}), falling back to Claude...`);
  return analyzeDocumentWithClaude(files, language, documentType, audience, referenceContext, patientContext);
}

// ========== STRUCTURED RESULT EXTRACTION (any lab / scan report) ==========
// Reads every result row printed on a report so a reviewing doctor gets fields for exactly the
// tests in that report (glucose + HbA1c on a diabetes panel, follicle sizes on a scan, etc.).
// Values are copied as printed, never interpreted; the doctor checks them against the original.
const EXTRACT_PROMPT = `You are reading a medical report (lab test, scan, semen analysis, embryology or similar).
List EVERY result row printed on it. Copy names, values, units and reference ranges exactly as printed. Do not interpret, diagnose, convert units or guess missing values.
Return ONLY a JSON object, no markdown, in this exact shape:
{"reportType":"short name of the report, e.g. Diabetes panel, Thyroid profile, Follicle scan","tests":[{"name":"test name as printed","value":"result as printed","unit":"unit or empty","refRange":"reference range as printed or empty","flag":"high|low|abnormal|normal or empty"}]}
Rules: one entry per result (not per heading); skip patient details, method lines and comments; for scans include each measurement (e.g. "Left ovary follicles", "Lead follicle", "Endometrial thickness"); "flag" only if the report marks it or the value is clearly outside the printed range; at most 40 tests. If nothing readable, return {"reportType":"","tests":[]}.`;

function parseExtractJson(text) {
  const t = String(text || '');
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(t.slice(start, end + 1));
    const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const tests = (Array.isArray(j.tests) ? j.tests : []).slice(0, 40).map(x => ({
      name: clip(x.name, 100), value: clip(x.value, 60), unit: clip(x.unit, 30), refRange: clip(x.refRange, 120),
      flag: ['high', 'low', 'abnormal', 'normal'].includes(String(x.flag || '').toLowerCase()) ? String(x.flag).toLowerCase() : ''
    })).filter(x => x.name && x.value);
    return { reportType: clip(j.reportType, 80), tests };
  } catch { return null; }
}

async function extractReportResults(files) {
  if (GEMINI_API_KEY) {
    const parts = [{ text: EXTRACT_PROMPT }, ...files.map(f => ({ inline_data: { mime_type: f.fileType, data: f.fileData } }))];
    for (let i = 0; i < GEMINI_MODELS.length; i++) {
      try {
        const r = await callGeminiModel(GEMINI_MODELS[i], parts, i === GEMINI_MODELS.length - 1 ? 2 : 1);
        const parsed = r.ok && parseExtractJson(r.analysis);
        if (parsed) return { ok: true, ...parsed };
      } catch (err) { console.log(`⚠️ ${GEMINI_MODELS[i]} extraction error:`, err.message); }
    }
  }
  if (ANTHROPIC_API_KEY) {
    try {
      const content = files.map(f => f.fileType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.fileData } }
        : { type: 'image', source: { type: 'base64', media_type: f.fileType, data: f.fileData } });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, messages: [{ role: 'user', content: [...content, { type: 'text', text: EXTRACT_PROMPT }] }] }),
        signal: AbortSignal.timeout(70000)
      });
      const data = await res.json();
      const parsed = res.ok && parseExtractJson(data.content?.find(b => b.type === 'text')?.text);
      if (parsed) return { ok: true, ...parsed };
    } catch (err) { console.log('⚠️ Claude extraction error:', err.message); }
  }
  return { ok: false, reason: GEMINI_API_KEY || ANTHROPIC_API_KEY ? 'failed' : 'not_configured' };
}

// ========== CLINICAL REFERENCE IMAGE ANALYSIS (admin-curated teaching examples) ==========
// Lets an admin upload a REFERENCE image (e.g. a labeled example X-ray) with their own note on
// what it demonstrates. The AI describes the visual findings in plain language; that description,
// combined with the admin's note, becomes a ClinicalReference entry for the chosen category
// (usually 'imaging'). getReferenceContext() then injects up to 5 recent entries per category into
// every FUTURE real patient document analysis of that category — so this is how an admin actually
// "teaches" the engine to recognize things better over time.
//
// Important: this is retrieval-augmented context, NOT literal model retraining — there is no way
// to fine-tune Gemini or Claude from a web app, and nobody should be told that's happening. What
// this genuinely does: it gives the AI concrete, admin-verified examples of what to look for,
// which measurably sharpens its output on similar future images without ever touching the
// underlying model weights.
function buildReferenceImagePrompt(adminNote) {
  return `You are helping build a clinical reference library for a medication-adherence platform. An admin has uploaded a REFERENCE medical image (e.g. an example X-ray or scan) specifically to teach the AI what to look for in similar images in the future — this is NOT a real patient case, so describe it as a teaching example, not a diagnosis.

${adminNote ? `The admin's note on this image: "${adminNote}"` : 'The admin did not provide an additional note.'}

Describe, in plain factual language:
1. What type of image this is, and the view/angle if identifiable.
2. The key visual findings present — be specific and descriptive. Since this is reference/teaching material curated by the platform's medical team (not output shown to a patient), describing findings plainly is the whole point.
3. Any subtle or easy-to-miss visual details worth flagging as a teaching point for recognizing similar images in the future.

Keep it factual and descriptive rather than hedged. Plain text, no markdown headers. Keep it under 200 words.`;
}

async function analyzeReferenceImageWithGemini(fileType, fileData, adminNote) {
  if (!GEMINI_API_KEY) return { ok: false, reason: 'not_configured' };
  const prompt = buildReferenceImagePrompt(adminNote);
  const parts = [{ text: prompt }, { inline_data: { mime_type: fileType, data: fileData } }];

  let lastFailure = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    const isLastModel = i === GEMINI_MODELS.length - 1;
    const maxRetries = isLastModel ? 2 : 1;
    try {
      const result = await callGeminiModel(model, parts, maxRetries);
      if (result.ok) return result;
      lastFailure = result;
    } catch (err) {
      lastFailure = { detail: err.message };
    }
  }
  return { ok: false, reason: 'api_error', detail: lastFailure?.detail || 'All Gemini models unavailable' };
}

async function analyzeReferenceImageWithClaude(fileType, fileData, adminNote) {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: 'not_configured' };
  const prompt = buildReferenceImagePrompt(adminNote);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: fileType, data: fileData } },
            { type: 'text', text: prompt }
          ]
        }]
      }),
      signal: AbortSignal.timeout(70000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ Claude reference image analysis failed:', JSON.stringify(data).substring(0, 300));
      return { ok: false, reason: 'api_error', detail: data.error?.message || `HTTP ${res.status}` };
    }
    const text = data.content?.find(b => b.type === 'text')?.text || 'No description returned.';
    return { ok: true, analysis: text };
  } catch (err) {
    console.log('⚠️ Claude reference image analysis error:', err.message);
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
}

// Tries Gemini first (free), falls back to Claude — same pattern as analyzeDocument above.
async function analyzeReferenceImage(fileType, fileData, adminNote) {
  const geminiResult = await analyzeReferenceImageWithGemini(fileType, fileData, adminNote);
  if (geminiResult.ok) return geminiResult;
  if (!ANTHROPIC_API_KEY) return geminiResult;
  console.log(`ℹ️ Gemini failed (${geminiResult.reason}) on reference image, falling back to Claude...`);
  return analyzeReferenceImageWithClaude(fileType, fileData, adminNote);
}

// ========== TREATMENT REPORT SIMPLIFICATION ==========
// The AI engine's clinical_insights/treatment_recommendations were written for the doctor
// dashboard ("LOW ADHERENCE (65%): May be masking true drug effectiveness. Address before
// changing therapy.") and were being shown to patients completely unchanged — dense clinical
// language nobody without medical training would find clear. This reuses the same Gemini/Claude
// infrastructure already built for document analysis (same providers, same fallback chain,
// text-only instead of vision) to rewrite them in plain language, in the patient's preferred
// language, without losing any of the actual substance.

// The engine writes for clinicians ("Consider dose increase or add ARB/ACE-i"). A patient must
// never be told to change their dose or add a medicine by an app — that line is replaced with a
// prompt to review the report with their doctor. Urgent readings are kept, reworded as "see a
// doctor soon". Doctors still get the full clinical text in the doctor dashboard.
const CLINICAL_ACTION_RE = /\b(dose|dosing|escalat|titrat|increase|add[- ]on|add (an?|another)|ARB|ACE|inhibitor|metformin|combination therapy|alternative therapy|discontinu|switch|regimen)\b/i;
function patientSafeAdvice(lines, isRecommendation = false) {
  const out = [];
  let doctorLine = false;
  for (const raw of lines || []) {
    const line = String(raw || '');
    if (/^URGENT/i.test(line)) { out.push(line.replace(/Needs prompt medical review\.?/i, 'Please contact your doctor soon.')); continue; }
    if (CLINICAL_ACTION_RE.test(line)) {
      // Keep the observation part (before the first ". ") if it's safe, drop the treatment advice.
      const observation = line.split(/\.\s+/)[0];
      if (!isRecommendation && observation && !CLINICAL_ACTION_RE.test(observation)) out.push(observation + '.');
      doctorLine = true;
      continue;
    }
    out.push(line);
  }
  if (doctorLine) out.push('Share this report with your doctor — only your doctor should decide whether to change your dose or medicines.');
  return out;
}

function buildSimplifyPrompt(insights, recommendations, language) {
  const languageInstruction = language && language !== 'English'
    ? `Write your entire response in ${language}.`
    : 'Write in clear, plain English.';

  return `Rewrite these clinical treatment notes for a patient with no medical background — keep every real fact and number, just explain it in everyday words instead of clinical shorthand. ${languageInstruction}

Rules: don't drop any point, don't add anything that isn't implied by the original, explain any medical term you have to keep, keep each point to one short sentence. Never tell the patient to change, increase, reduce, stop, add or switch any medicine or dose, and never name a medicine they should take — if a point implies that, say "talk to your doctor about this" instead. Keep any "URGENT" point clearly urgent. Respond with ONLY valid JSON in exactly this shape, nothing else — no markdown, no code fences:
{"insights": ["...", "..."], "recommendations": ["...", "..."]}

Clinical insights to rewrite:
${insights.map((s, i) => `${i + 1}. ${s}`).join('\n') || '(none)'}

Clinical recommendations to rewrite:
${recommendations.map((s, i) => `${i + 1}. ${s}`).join('\n') || '(none)'}`;
}

function parseSimplifiedJson(text) {
  try {
    // Models occasionally wrap JSON in a code fence despite instructions not to — strip it
    // before parsing rather than failing on something trivially recoverable.
    const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed.insights) && Array.isArray(parsed.recommendations)) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function simplifyTreatmentReport(insights, recommendations, language) {
  if (!insights.length && !recommendations.length) return null;
  const prompt = buildSimplifyPrompt(insights, recommendations, language);

  if (GEMINI_API_KEY) {
    for (const model of GEMINI_MODELS) {
      try {
        const result = await callGeminiModel(model, [{ text: prompt }], 1);
        if (result.ok) {
          const parsed = parseSimplifiedJson(result.analysis);
          if (parsed) return parsed;
          console.log(`⚠️ ${model} simplify response wasn't valid JSON, trying next option`);
        }
      } catch (err) {
        console.log(`⚠️ ${model} simplify error:`, err.message);
      }
    }
  }

  if (ANTHROPIC_API_KEY) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: AbortSignal.timeout(45000)
      });
      const data = await res.json();
      if (res.ok) {
        const text = data.content?.find(b => b.type === 'text')?.text || '';
        const parsed = parseSimplifiedJson(text);
        if (parsed) return parsed;
      }
    } catch (err) {
      console.log('⚠️ Claude simplify error:', err.message);
    }
  }

  // Neither provider produced usable output — caller falls back to the original clinical text
  // rather than showing nothing.
  return null;
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

// ===== TREATMENT REPORT TEMPLATE — closes the same 131047 gap for the one message a patient
// actively taps a button to request. Confirmed via real logs: "✅ MSG91 WhatsApp text sent to
// +91XXXXXXXXXX" for a treatment-report request that the patient never actually received on
// WhatsApp — success at the MSG91 API level, but this was always a free-text send via
// sendWhatsAppFree(), which silently fails at Meta's level (error 131047, "re-engagement
// message") for anyone outside the 24-hour session window. Same root cause and same fix pattern
// as risk_alert/welcome/doctor_alert above. =====
// Setup: create + get Meta approval for a fifth template in MSG91 (identical process to the
// other four). A WhatsApp template variable can't contain line breaks, so this uses short,
// single-line values only — the full report with every data point still lives on the dashboard.
// Suggested template body: "📊 Biomexa Treatment Report — {{1}}\n\nMedicine: {{2}}\nAdherence:
// {{3}}\nEffectiveness: {{4}}\n\nKey insight: {{5}}\n\nFull report with all details is on your
// Biomexa dashboard." — no buttons needed. Until configured, this falls back to the existing
// free-text send, which still works for anyone who has messaged Biomexa's WhatsApp number
// within the last 24 hours.
const MSG91_TREATMENT_REPORT_TEMPLATE_NAME = process.env.MSG91_TREATMENT_REPORT_TEMPLATE_NAME || null;
const MSG91_TREATMENT_REPORT_TEMPLATE_NAMESPACE = process.env.MSG91_TREATMENT_REPORT_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;

// Template params can't contain newlines and read best kept short — collapses whitespace and
// caps length rather than silently truncating mid-word.
function sanitizeTemplateParam(text, maxLen = 300) {
  const collapsed = (text || '').replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen - 1).trim() + '…' : collapsed;
}

async function sendTreatmentReportTemplate(phone, patientName, drugName, adherenceRate, effectivenessLabel, topInsight) {
  if (!MSG91_CONFIGURED || !MSG91_TREATMENT_REPORT_TEMPLATE_NAME) {
    return { success: false, provider: 'msg91_treatment_report_template_not_configured' };
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
            name: MSG91_TREATMENT_REPORT_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_TREATMENT_REPORT_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: sanitizeTemplateParam(patientName, 60), parameter_name: 'patient_name' },
                body_2: { type: 'text', value: sanitizeTemplateParam(drugName, 60), parameter_name: 'drug_name' },
                body_3: { type: 'text', value: sanitizeTemplateParam(adherenceRate, 20), parameter_name: 'adherence_rate' },
                body_4: { type: 'text', value: sanitizeTemplateParam(effectivenessLabel, 40), parameter_name: 'effectiveness' },
                body_5: { type: 'text', value: sanitizeTemplateParam(topInsight, 300), parameter_name: 'key_insight' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 treatment report template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 treatment report template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 treatment report template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Unified treatment-report sender — template first (reaches the patient regardless of session
// state), falls back to the existing free-text message only if the template isn't configured yet.
async function sendTreatmentReportMessage(phone, patientName, drugName, adherenceRate, effectivenessLabel, topInsight, fallbackMsg) {
  const templateResult = await sendTreatmentReportTemplate(phone, patientName, drugName, adherenceRate, effectivenessLabel, topInsight);
  if (templateResult.success) return templateResult;
  return sendWhatsAppFree(phone, fallbackMsg);
}

// ===== UPLOADED REPORT/PRESCRIPTION ANALYSIS TEMPLATE — same 131047 gap, this time on the
// "Send to WhatsApp" button for an uploaded document's AI analysis (prescription, lab report, or
// imaging). Reported directly: a patient uploaded a blood report, the platform generated the
// analysis fine, but tapping "Send to WhatsApp" never delivered it — identical root cause to
// treatment_report and every other template above: sendWhatsAppFree() succeeds at the MSG91 API
// level but is silently rejected by Meta (131047) for anyone outside the 24-hour session window.
// =====
// Setup: create + get Meta approval for a sixth template in MSG91 (identical process to the
// other five). Suggested template body: "📄 Biomexa Report Analysis — {{1}}\n\nDocument: {{2}}
// \n\nSummary: {{3}}\n\nFull detailed analysis is on your Biomexa dashboard." — no buttons
// needed. The full analysis (with all formatting) always stays on the dashboard; the WhatsApp
// template gets a short, single-line-safe summary since template variables can't contain line
// breaks. Until configured, falls back to the existing free-text send.
const MSG91_REPORT_ANALYSIS_TEMPLATE_NAME = process.env.MSG91_REPORT_ANALYSIS_TEMPLATE_NAME || null;
const MSG91_REPORT_ANALYSIS_TEMPLATE_NAMESPACE = process.env.MSG91_REPORT_ANALYSIS_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;

async function sendReportAnalysisTemplate(phone, patientName, fileName, summary) {
  if (!MSG91_CONFIGURED || !MSG91_REPORT_ANALYSIS_TEMPLATE_NAME) {
    return { success: false, provider: 'msg91_report_analysis_template_not_configured' };
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
            name: MSG91_REPORT_ANALYSIS_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_REPORT_ANALYSIS_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: sanitizeTemplateParam(patientName, 60), parameter_name: 'patient_name' },
                body_2: { type: 'text', value: sanitizeTemplateParam(fileName, 80), parameter_name: 'file_name' },
                body_3: { type: 'text', value: sanitizeTemplateParam(summary, 500), parameter_name: 'summary' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 report analysis template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 report analysis template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 report analysis template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Unified report-analysis sender — template first (reaches the patient regardless of session
// state), falls back to the existing free-text message only if the template isn't configured yet.
async function sendReportAnalysisMessage(phone, patientName, fileName, analysisText, fallbackMsg) {
  // Strips WhatsApp's *bold* markers and collapses the analysis into a single-line summary
  // that's safe as a template parameter — the fully-formatted version stays on the dashboard.
  const plainSummary = (analysisText || '').replace(/\*/g, '');
  const templateResult = await sendReportAnalysisTemplate(phone, patientName, fileName, plainSummary);
  if (templateResult.success) return templateResult;
  return sendWhatsAppFree(phone, fallbackMsg);
}

// ===== PASSWORD RESET OTP TEMPLATE — same 131047 gap, this time on the forgot-password flow.
// Reported directly: a patient (Kunal) requested a password reset and never received the OTP on
// WhatsApp. Root cause is identical to every fix above: /api/auth/forgot-password sent the OTP
// with sendWhatsAppFree() only, which is silently rejected by Meta (131047, "re-engagement
// message") for anyone outside the 24-hour session window — which is most people resetting a
// password, since they're locked out precisely because they haven't been actively using the
// account/WhatsApp. Email was already wired up as a fallback in an earlier fix, so this wasn't a
// total outage for accounts with an email on file — but WhatsApp itself, which most patients
// expect to actually work, silently failed. =====
// Setup: create + get Meta approval for a seventh template in MSG91 (identical process to the
// others). Suggested template body: "🔐 Biomexa Password Reset — {{1}}\n\nYour OTP code is:
// {{2}}\n\nThis code expires in {{3}} minutes. If you didn't request this, please ignore this
// message." — no buttons needed. Until configured, this falls back to the existing free-text
// send, which still works for anyone who has messaged Biomexa's WhatsApp number within the last
// 24 hours.
const MSG91_OTP_TEMPLATE_NAME = process.env.MSG91_OTP_TEMPLATE_NAME || null;
const MSG91_OTP_TEMPLATE_NAMESPACE = process.env.MSG91_OTP_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;

async function sendPasswordResetOTPTemplate(phone, accountName, otp, expiryMinutes) {
  if (!MSG91_CONFIGURED || !MSG91_OTP_TEMPLATE_NAME) {
    return { success: false, provider: 'msg91_otp_template_not_configured' };
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
            name: MSG91_OTP_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_OTP_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              // Meta only approves OTP templates in the AUTHENTICATION category (a Utility OTP
              // template was rejected as "incorrect category"). Authentication templates have a
              // fixed body with exactly one variable — the code — plus a "Copy code" button that
              // must be sent the same code.
              components: {
                body_1: { type: 'text', value: String(otp) },
                button_1: { subtype: 'url', type: 'text', value: String(otp) }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 OTP template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 OTP template sent to', phone);
    return { success: true, provider: 'msg91', viaTemplate: true };
  } catch (err) {
    console.log('⚠️ MSG91 OTP template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Unified OTP sender — template first (reaches the patient/doctor regardless of session state),
// falls back to the existing free-text message only if the template isn't configured yet.
async function sendPasswordResetOTPMessage(phone, accountName, otp, expiryMinutes, fallbackMsg) {
  const templateResult = await sendPasswordResetOTPTemplate(phone, accountName, otp, expiryMinutes);
  if (templateResult.success) return templateResult;
  return sendWhatsAppFree(phone, fallbackMsg);
}

// Phone numbers aren't stored in one consistent format — patient signup always adds "+91", but
// doctor signup stores whatever was typed (often a bare 10-digit number). The reset page always
// sends "+91XXXXXXXXXX", so an exact-match lookup said "No doctor account found" for any doctor
// who registered without the country code. These are every reasonable spelling of one number.
function phoneVariants(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  // '+91 ' + last10 covers accounts saved with a space after the country code — without it the
  // WhatsApp webhook (which sees "+91XXXXXXXXXX") never found their conversation, so Taken /
  // Not Taken / Remind Me Later taps were silently ignored.
  // '+910' + last10 matches accounts saved with the trunk 0 kept ("+91 09958…" typed at sign-up):
  // WhatsApp replies arrive as "91XXXXXXXXXX", so without it their Taken taps found no dose.
  return [...new Set([s, '+' + digits, digits, last10, '+91' + last10, '+91 ' + last10, '91' + last10, '+910' + last10, '910' + last10].filter(Boolean))];
}

// One canonical format for numbers typed into public forms ("+91 98765 43210", "09876543210",
// "9876543210" all -> "+919876543210") — the same shape signup and login use, so a patient who
// sets a reminder from a product page can later log in with the same number.
// Calendar date (YYYY-MM-DD) in the server's own time zone — the same zone getHours() uses for
// reminder times. toISOString() gives the UTC date, which in India is still "yesterday" until
// 5:30 AM, so doses for 12:00–5:29 AM were only created at 5:30 AM and fired late, and the
// portal showed yesterday's doses before 5:30 AM.
function localDateStr(d = new Date()) {
  d = new Date(d);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A reminder time that passed only a few minutes ago (e.g. set for "now", or the form took a
// minute to fill in) still goes out right away instead of silently waiting until tomorrow.
const JUST_MISSED_MINUTES = 15;
function hhmmToMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
function startsTomorrow(time, currentTime) {
  const late = hhmmToMin(currentTime) - hhmmToMin(time);
  return late > JUST_MISSED_MINUTES;
}

const logDuration = days => (days ? ` for ${days} day(s)` : ', ongoing');

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '+91' + digits.slice(1);
  if (digits.length === 13 && digits.startsWith('910')) return '+91' + digits.slice(3); // "+91 0XXXXXXXXXX"
  return digits ? '+' + digits : '';
}

// Finds a patient/doctor account whatever format its phone was saved in.
async function findAccountByPhone(role, phone) {
  const Model = role === 'doctor' ? Doctor : Patient;
  return Model.findOne({ phone: { $in: phoneVariants(phone) } });
}

// ===== "RESET" over WhatsApp — the reliable OTP path until the OTP template is approved =====
// Free-text WhatsApp messages only reach people who messaged Biomexa's number in the last 24 hours
// (Meta error 131047). Without MSG91_OTP_TEMPLATE_NAME set, and with email not configured, OTPs
// were being "sent" (MSG91 accepts them) but silently dropped by Meta — so forgot-password looked
// like it worked but the code never arrived. When the user themselves messages "RESET", that
// inbound message opens the 24-hour window, so a free-text reply IS delivered. Reuses their
// pending code from the website if there is one, otherwise issues a fresh one.
const RESET_KEYWORD_RE = /^\s*(reset|otp|reset\s*password|forgot\s*password|password\s*reset)\s*[.!]?\s*$/i;

async function handleWhatsAppResetRequest(phone) {
  const variants = phoneVariants(phone);
  let otpRecord = await Otp.findOne({
    phone: { $in: variants },
    role: { $in: ['patient', 'doctor'] },
    used: false,
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });

  let account;
  if (otpRecord) {
    account = await findAccountByPhone(otpRecord.role, phone);
  } else {
    // No pending request from the website — issue one directly, patient account first.
    let role = 'patient';
    account = await findAccountByPhone('patient', phone);
    if (!account) { role = 'doctor'; account = await findAccountByPhone('doctor', phone); }
    if (!account) {
      await sendWhatsAppFree(phone, `We couldn't find a Biomexa account linked to this WhatsApp number.\n\nIf you signed up with a different number, request the reset from that number instead.\n\n- Biomexa Team`);
      return;
    }
    // Stored under the "+91XXXXXXXXXX" form — exactly what the reset page sends at the verify step.
    const identifier = '+91' + phone.replace(/\D/g, '').slice(-10);
    await Otp.updateMany({ phone: { $in: variants }, role, used: false }, { used: true });
    otpRecord = await Otp.create({
      phone: identifier, role, otp: generateOTP(), resetToken: generateResetToken(),
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000)
    });
  }

  const minutesLeft = Math.max(1, Math.round((otpRecord.expiresAt - Date.now()) / 60000));
  const name = account && (account.name || account.username);
  await sendWhatsAppFree(phone, `🔐 *Biomexa Password Reset*\n\n${name ? `Hi ${name}, y` : 'Y'}our OTP code is: *${otpRecord.otp}*\n\nEnter it on the Forgot Password page. It expires in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.\n\nIf you didn't request this, you can ignore this message.\n\n- Biomexa Team`);
  console.log(`🔐 OTP delivered on WhatsApp RESET request to ${phone} (${otpRecord.role})`);
}

// ===== POST-LOGIN "WELCOME BACK" TEMPLATE — same 131047 gap, this time on the message sent
// right after a patient logs in. Reported directly: patients log in fine, but the "Welcome back"
// WhatsApp notification with their next dose never arrives. Root cause is identical to every fix
// above: /api/auth/login sent this with sendWhatsAppFree() only, which the MSG91 API accepts and
// logs as "sent" but which Meta silently drops (131047) for anyone outside the 24-hour session
// window — which is most patients logging into the website rather than actively chatting on
// WhatsApp. That's also why earlier log checks found no failure lines for this: MSG91 reports the
// send as accepted even when Meta discards it downstream, so "sent" in the logs never meant
// "delivered". =====
// Setup: create + get Meta approval for an eighth template in MSG91 (identical process to the
// others). Suggested template body: "👋 Biomexa — Welcome back, {{1}}!\n\n{{2}}" — no buttons
// needed. {{2}} carries a single-line, dynamically-built status line (e.g. "Your next dose:
// Metformin 500mg at 9:00 AM" or "No pending doses today. Great job!") since template variables
// can't contain line breaks — the fully-formatted version with food notes etc. stays in the
// free-text fallback. Until configured, this falls back to the existing free-text send.
const MSG91_LOGIN_TEMPLATE_NAME = process.env.MSG91_LOGIN_TEMPLATE_NAME || null;
const MSG91_LOGIN_TEMPLATE_NAMESPACE = process.env.MSG91_LOGIN_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;

async function sendLoginTemplate(phone, patientName, statusLine) {
  if (!MSG91_CONFIGURED || !MSG91_LOGIN_TEMPLATE_NAME) {
    return { success: false, provider: 'msg91_login_template_not_configured' };
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
            name: MSG91_LOGIN_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_LOGIN_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: sanitizeTemplateParam(patientName, 60), parameter_name: 'patient_name' },
                body_2: { type: 'text', value: sanitizeTemplateParam(statusLine, 300), parameter_name: 'status_line' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 login template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 login template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 login template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Unified login-notification sender — template first (reaches the patient regardless of session
// state), falls back to the existing free-text message only if the template isn't configured yet.
async function sendLoginMessage(phone, patientName, statusLine, fallbackMsg) {
  const templateResult = await sendLoginTemplate(phone, patientName, statusLine);
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
// toFahrenheit lives in vitals/calibration.js (shared with the vitals form and the charts).
function parseVitalsFromText(text) {
  const result = {};
  let consumed = text;

  const bpMatch = text.match(/(\d{2,3})\s*\/\s*(\d{2,3})/); // "120/80" anywhere in the message
  if (bpMatch) {
    result.bpSystolic = parseInt(bpMatch[1], 10);
    result.bpDiastolic = parseInt(bpMatch[2], 10);
    consumed = consumed.replace(bpMatch[0], ' ');
  }

  // Temperature: "temp 99", "temperature: 98.6", "fever 101", "99F", "99 °F", "37.2C", "99°".
  // Whole numbers count too — most thermometers people read out show "99" or "101", not "99.0".
  const labelledTemp = text.match(/(?:temp(?:erature)?|tmp|fever|bukhar)\s*[:=\-]?\s*(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:°\s*)?([fc](?![a-z]))?/i);
  const tempLabelMatch = labelledTemp ||
    text.match(/\b(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:°\s*([fc])?|([fc])(?![a-z])|\s*degrees?\s*([fc])?)/i);
  if (tempLabelMatch) {
    const unit = (tempLabelMatch[2] || tempLabelMatch[3] || tempLabelMatch[4] || '').toLowerCase();
    const t = toFahrenheit(parseFloat(tempLabelMatch[1].replace(',', '.')), unit);
    if (t !== null) result.temperature = t;
    // A labelled but impossible temperature ("temp 150") is a typo — drop it rather than let the
    // number fall through and be saved as a pulse or sugar reading.
    if (t !== null || labelledTemp) consumed = consumed.replace(tempLabelMatch[0], ' ');
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
    const bareDecimal = consumed.match(/\b(\d{2,3}[.,]\d{1,2})\b/);
    const t = bareDecimal && toFahrenheit(parseFloat(bareDecimal[1].replace(',', '.')), '');
    if (t !== null && t !== undefined && bareDecimal) {
      result.temperature = t;
      consumed = consumed.replace(bareDecimal[0], ' ');
    }
  }

  // Whole-number temperature in the check-in's own order — "BP Temp Pulse Sugar", e.g.
  // "120/80 99 72 110". This used to save 99 as the pulse and 72 as the sugar, and no
  // temperature at all. With two or more bare numbers, the first is the temperature when it's a
  // believable one (93–108 °F or 34–42 °C); "120/80 72 110" (no temp) still reads as pulse +
  // sugar because 72 can't be a body temperature. A single bare number stays ambiguous
  // (99 could be pulse, sugar or temp), so it is not guessed as a temperature.
  if (result.temperature === undefined) {
    const wholes = consumed.match(/\b\d{2,3}\b/g) || [];
    const asTemp = wholes.length >= 2 ? toFahrenheit(parseInt(wholes[0], 10), '') : null;
    if (asTemp !== null) {
      result.temperature = asTemp;
      consumed = consumed.replace(new RegExp(`\\b${wholes[0]}\\b`), ' ');
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

// Notifies the pharmacy (not the customer) that a new order came in via the public product
// pages — this is order-intake, not a receipt, so it always goes to ADMIN_EMAIL, never the
// customer's own address (an order form doesn't collect one).
async function sendOrderNotificationEmail(order) {
  const adminEmail = process.env.ADMIN_EMAIL || 'biomexapharmaceuticals@gmail.com';
  if (!emailTransport) return { success: false };
  try {
    await emailTransport.sendMail({
      from: `"Biomexa Pharmaceuticals" <${process.env.EMAIL_USER}>`,
      to: adminEmail,
      subject: `🛒 New order — ${order.productName} (${order.quantity}x)`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#0d7377;">New Order Received</h2>
        <p><strong>Product:</strong> ${order.productName} × ${order.quantity}</p>
        <p><strong>Customer:</strong> ${order.customerName}</p>
        <p><strong>Phone:</strong> ${order.phone}</p>
        <p><strong>Address:</strong> ${order.address}</p>
        ${order.notes ? `<p><strong>Notes:</strong> ${order.notes}</p>` : ''}
        <p><strong>Prescription:</strong> ${order.prescriptionFiles && order.prescriptionFiles.length ? `${order.prescriptionFiles.length} file(s) attached — open Admin → Orders to view` : 'customer will share it on the call'}</p>
        <p style="color:#888;font-size:13px;">View and manage this order in the admin portal.</p>
      </div>`
    });
    console.log('✅ Order notification email sent to', adminEmail);
    return { success: true };
  } catch (err) {
    console.log('⚠️ Order notification email failed:', err.message);
    return { success: false };
  }
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

// ===== WHATSAPP 24-HOUR WINDOW + IVF CARE UPDATE TEMPLATE =====
// Meta only delivers free-text messages within 24 hours of the person's last message to the
// Biomexa number; outside that window MSG91 still answers "sent" but Meta drops it (131047).
// Every inbound message is recorded here so senders know which kind of message will arrive.
const WaInbound = mongoose.model('WaInbound', new mongoose.Schema({
  digits: { type: String, unique: true }, lastInboundAt: Date
}), 'wa_inbound');
const waDigits = p => String(p || '').replace(/\D/g, '').slice(-10);
function noteWhatsAppInbound(phone) {
  return WaInbound.updateOne({ digits: waDigits(phone) }, { lastInboundAt: new Date() }, { upsert: true }).catch(() => {});
}
async function whatsappWindowOpen(phone) {
  const r = await WaInbound.findOne({ digits: waDigits(phone) }).lean().catch(() => null);
  return !!(r && r.lastInboundAt && Date.now() - new Date(r.lastInboundAt).getTime() < 23.5 * 3600e3);
}

// Setup: create + get Meta approval for a UTILITY template in MSG91 named e.g. ivf_care_update:
//   Body: "Biomexa IVF Care update: {{1}}\n\n{{2}}\n\nOpen your IVF Care app for the full details: biomexapharmaceuticals.com/ivf.html"
//   Variables: {{1}} = title, {{2}} = details. No buttons.
// then set MSG91_IVF_UPDATE_TEMPLATE_NAME (and MSG91_IVF_UPDATE_TEMPLATE_NAMESPACE if different).
const MSG91_IVF_UPDATE_TEMPLATE_NAME = process.env.MSG91_IVF_UPDATE_TEMPLATE_NAME || null;
const MSG91_IVF_UPDATE_TEMPLATE_NAMESPACE = process.env.MSG91_IVF_UPDATE_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;
async function sendIvfUpdateTemplate(phone, title, details) {
  if (!MSG91_CONFIGURED || !MSG91_IVF_UPDATE_TEMPLATE_NAME) return { success: false, provider: 'msg91_ivf_update_template_not_configured' };
  try {
    const res = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
      body: JSON.stringify({
        integrated_number: MSG91_INTEGRATED_NUMBER,
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp', type: 'template',
          template: {
            name: MSG91_IVF_UPDATE_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_IVF_UPDATE_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                // ivf_care_update uses numbered variables: {{1}} = title, {{2}} = details
                body_1: { type: 'text', value: sanitizeTemplateParam(title, 80) || 'Update' },
                body_2: { type: 'text', value: sanitizeTemplateParam(details, 700) || '-' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) { console.log('⚠️ MSG91 IVF update template send failed:', JSON.stringify(data).substring(0, 500)); return { success: false, provider: 'msg91', detail: data }; }
    console.log('✅ MSG91 IVF update template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 IVF update template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// Setup: create + get Meta approval for a UTILITY template in MSG91 named e.g. biomexa_care_renewal:
//   Body: "Hi {{1}}, {{2}}\n\nYour treatment: {{3}}\n\nRenew Biomexa Care to keep Talk to a Doctor, treatment reports,
//          AI report analysis and reminders for all your medicines. Plans from ₹99/month: biomexapharmaceuticals.com/subscribe.html"
//   Variables: {{1}} = first name, {{2}} = status line, {{3}} = treatment summary. No buttons.
// then set MSG91_RENEWAL_TEMPLATE_NAME (and MSG91_RENEWAL_TEMPLATE_NAMESPACE if different).
// Trial/plan notices go to every patient, most of whom haven't messaged Biomexa in the last 24 h,
// so without this template Meta drops them.
const MSG91_RENEWAL_TEMPLATE_NAME = process.env.MSG91_RENEWAL_TEMPLATE_NAME || null;
const MSG91_RENEWAL_TEMPLATE_NAMESPACE = process.env.MSG91_RENEWAL_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;
async function sendRenewalTemplate(phone, firstName, statusLine, treatmentLine) {
  if (!MSG91_CONFIGURED || !MSG91_RENEWAL_TEMPLATE_NAME) return { success: false, provider: 'msg91_renewal_template_not_configured' };
  try {
    const res = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authkey': MSG91_AUTH_KEY },
      body: JSON.stringify({
        integrated_number: MSG91_INTEGRATED_NUMBER,
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp', type: 'template',
          template: {
            name: MSG91_RENEWAL_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_RENEWAL_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: sanitizeTemplateParam(firstName, 40) || 'there' },
                body_2: { type: 'text', value: sanitizeTemplateParam(statusLine, 200) || 'your Biomexa Care access has changed.' },
                body_3: { type: 'text', value: sanitizeTemplateParam(treatmentLine, 300) || '-' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) { console.log('⚠️ MSG91 renewal template send failed:', JSON.stringify(data).substring(0, 500)); return { success: false, provider: 'msg91', detail: data }; }
    console.log('✅ MSG91 renewal template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 renewal template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

// ========== MONGODB SETUP ==========
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/biomexa')
  .then(async () => {
    console.log('✅ MongoDB connected');
    await bootstrapAdmin();
    await resetFailedOffers_2026_11_09();
  })
  .catch(err => console.log('❌ MongoDB connection error:', err.message));

// ONE-OFF (safe to delete after 11 Nov 2026): the 9 Nov 11 AM biomexa_care_offer run was rejected
// by Meta (3 params sent, template has 2) but those patients were still marked as sent, which would
// hold them back for AD_INTERVAL_DAYS. Clear that mark so the next run sends them the offer.
// Idempotent: once cleared they no longer match, and new sends fall outside the window.
async function resetFailedOffers_2026_11_09() {
  if (Date.now() > new Date('2026-11-11T00:00:00+05:30').getTime()) return;
  try {
    const r = await Patient.updateMany(
      { lastAdSentAt: { $gte: new Date('2026-11-09T10:55:00+05:30'), $lte: new Date('2026-11-09T11:05:00+05:30') } },
      { $unset: { lastAdSentAt: '' } }
    );
    if (r.modifiedCount) console.log(`🔁 Reset ${r.modifiedCount} patient(s) from the failed 9 Nov offer run`);
  } catch (err) {
    console.log('⚠️ Failed-offer reset error:', err.message);
  }
}

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
  age: Number,     // optional, entered at sign-up
  gender: String,  // optional: male | female | other
  city: String,    // optional, entered at sign-up
  preferredLanguage: { type: String, default: 'English' }, // drives AI-generated report language (document analysis, treatment reports)
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
    endDate: Date, // computed from startDate + durationDays when durationDays is set; reminders stop after this date
    // End-of-course follow-up (see processCompletedCourses): 0 = nothing sent yet, 1 = "course
    // complete + report" sent, 2 = doctor/refill follow-up sent, 3 = final refill nudge sent.
    completedAt: Date,
    stoppedByPatient: { type: Boolean, default: false }, // removed from the portal before its course ended
    followUpStage: { type: Number, default: 0 },
    lastFollowUpAt: Date,
    courseSummary: { taken: Number, missed: Number, adherence: Number }
  }],
  // Product message every AD_INTERVAL_DAYS (see processProductAds). Patients can reply STOP.
  lastAdSentAt: Date,
  lastReminderInviteAt: Date, // admin Reminder Center "invite to add a reminder" (max once a day)
  lastPortalInviteAt: Date,   // admin Reminder Center "what you get on the portal" message to campaign sign-ups (max once a day)
  // Biomexa Care subscription (see SUBSCRIPTION section). One-time payments; each payment adds
  // its period on top of any time still left.
  subscription: {
    plan: String,        // monthly | halfyearly | yearly
    startedAt: Date,
    expiresAt: Date
  },
  lastSubNoticeKey: String, // which trial/expiry WhatsApp notice was sent last (sent once each)
  broadcastKeys: [String], // one-off broadcasts already sent to this patient (see broadcastTrialExpired)
  adOptOut: { type: Boolean, default: false },
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
  autoMissed: Boolean, // marked missed because nobody replied (see markUnansweredDosesMissed)
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
  // Admin approval: pending (just signed up) | verified (approved — can see patients and be
  // contacted) | rejected | suspended. Nothing but "verified" gets any access.
  status: { type: String, default: 'pending' },
  reviewedAt: Date,
  reviewedBy: String,
  reviewNote: String,
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
  // New multi-file shape — up to 3 files analyzed together as one document (e.g. front/back of
  // a prescription, or a multi-page report). Old single-file fields below are kept so documents
  // uploaded before this change still read back correctly.
  files: [{ fileName: String, fileType: String, fileData: String }],
  fileName: String, // legacy single-file field, or a display summary name for a multi-file upload
  fileType: String,
  fileData: String,
  language: { type: String, default: 'English' }, // language this analysis was generated in
  documentType: { type: String, default: 'prescription' }, // 'prescription' | 'imaging' — which prompt/framing was used
  uploadedByRole: { type: String, default: 'patient' }, // 'patient' | 'doctor' — doctors can upload imaging for a patient too
  analysis: String, // AI-extracted key factors, filled in after analysis completes
  analysisStatus: { type: String, default: 'pending' }, // pending | done | failed | not_configured
  // Doctor review/correction safety net — the AI's output isn't treated as final until a real
  // doctor either confirms it or corrects it. A correction also feeds the clinical reference
  // library below, so similar future documents benefit from the fix.
  reviewStatus: { type: String, default: 'unreviewed' }, // unreviewed | confirmed | corrected
  doctorCorrection: String,
  reviewedBy: String,
  reviewedByPhone: String,
  reviewedAt: Date,
  uploadedAt: { type: Date, default: Date.now }
});

// Clinical reference entries — admin-curated notes, or auto-generated from a doctor correcting
// a past AI analysis. Injected as extra context into future analysis prompts for the same
// category (see getReferenceContext above). This is retrieval-augmented context, not literal
// model retraining.
const clinicalReferenceSchema = new mongoose.Schema({
  title: String,
  category: { type: String, default: 'general' }, // 'prescription' | 'imaging' | 'lab_reference' | 'general'
  content: String,
  source: { type: String, default: 'admin' }, // 'admin' | 'doctor_correction' | 'admin_image'
  addedBy: String,
  // Set when this entry came from an admin-uploaded reference image (e.g. a labeled example
  // X-ray) rather than typed text — see the image-analysis endpoint below. The image itself is
  // kept for admin review/audit but excluded from every list response (imageFileData is large).
  hasImage: { type: Boolean, default: false },
  imageFileName: String,
  imageFileType: String,
  imageFileData: String,
  createdAt: { type: Date, default: Date.now }
});

// Orders placed from the public product pages — a plain order-intake record, not a payment
// transaction (no payment gateway is wired up). An admin follows up manually (call, WhatsApp,
// generate an invoice, arrange delivery) using the Orders panel in the admin portal, which is
// notified by email/WhatsApp the moment a new one comes in.
const orderSchema = new mongoose.Schema({
  productName: String,
  productSlug: String,
  customerName: String,
  phone: String,
  address: String,
  quantity: { type: Number, default: 1 },
  notes: String,
  // Prescription uploaded with the order (up to 3 JPG/PNG/WEBP/PDF files, base64), or the customer
  // chose to share it when the team calls.
  prescriptionFiles: [{ fileName: String, fileType: String, fileData: String }],
  prescriptionLater: { type: Boolean, default: false },
  promoCode: String,      // accepted discount code, e.g. BIOMEXA15
  discountPct: Number,    // discount the team applies when confirming the order on the call
  status: { type: String, default: 'new' }, // new | confirmed | shipped | cancelled
  createdAt: { type: Date, default: Date.now }
});

// Tracks what we're waiting for next from a patient on WhatsApp — dose confirmation, then vitals,
// then nothing. This is what lets the inbound webhook interpret a short reply like "Taken" or
// "120/80" correctly, based on where the conversation currently is.
const conversationStateSchema = new mongoose.Schema({
  patientPhone: { type: String, unique: true },
  state: { type: String, default: null }, // 'awaiting_dose_confirm' | 'awaiting_vitals' | 'lead_signup_*' | null
  doseId: String,
  draft: { type: mongoose.Schema.Types.Mixed, default: null }, // answers so far in the WhatsApp sign-up chat
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
const ClinicalReference = mongoose.model('ClinicalReference', clinicalReferenceSchema);
const Order = mongoose.model('Order', orderSchema);
// Razorpay payments for the Biomexa Care subscription — one row per checkout attempt.
const paymentSchema = new mongoose.Schema({
  patientPhone: String,
  patientName: String,
  plan: String,
  amount: Number,          // in paise
  currency: { type: String, default: 'INR' },
  orderId: { type: String, unique: true },
  paymentId: String,
  status: { type: String, default: 'created' }, // created | paid | failed
  periodStart: Date,
  periodEnd: Date,
  paidAt: Date,
  createdAt: { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', paymentSchema);
const ConversationState = mongoose.model('ConversationState', conversationStateSchema);
const RiskAlert = mongoose.model('RiskAlert', riskAlertSchema);
const Admin = mongoose.model('Admin', adminSchema);

// checkVitalsDanger lives in vitals/calibration.js — the same rules flag points on the charts.

// Fires a real risk alert: saves it, notifies an available doctor on WhatsApp, and warns the
// patient too. Called from the MSG91 webhook right after vitals are logged.
async function triggerRiskAlert(patient, vitals) {
  const danger = checkVitalsDanger(vitals);
  if (!danger) return null;

  const availableDoctor = await Doctor.findOne({ available: true, status: 'verified' }).sort({ createdAt: -1 });

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

// ========== BIOMEXA CARE SUBSCRIPTION (Razorpay, one-time payment per period) ==========
// Every patient gets everything free for TRIAL_DAYS. After that, these need an active plan:
//   • Talk to a Doctor (connect + the doctor's WhatsApp number)
//   • Treatment reports (and "Send to WhatsApp")
//   • AI document analysis (prescriptions, lab reports, imaging)
//   • More than FREE_MEDICINE_LIMIT medicines on reminders (basic reminders for up to 2 stay free)
// Accounts that existed before subscriptions launched get their 25 days from launch day, not from
// sign-up — otherwise every existing patient would be locked out on day one.
const SUBSCRIPTION_PLANS = {
  monthly:    { id: 'monthly',    name: 'Monthly',  price: 99,  days: 30,  label: '₹99 / month' },
  halfyearly: { id: 'halfyearly', name: '6 Months', price: 499, days: 182, label: '₹499 / 6 months', note: 'Save 16%' },
  yearly:     { id: 'yearly',     name: 'Yearly',   price: 899, days: 365, label: '₹899 / year', note: 'Best value — save 24%' }
};
const TRIAL_DAYS = 25;
const FREE_MEDICINE_LIMIT = 2;
const SUBSCRIPTION_LAUNCH = new Date('2026-10-08T00:00:00+05:30');
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const PAYMENTS_CONFIGURED = !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
// Test-run switch. While false (the default), nothing is locked — every patient keeps every
// feature even after their trial — but trial tracking and the day-26 "subscribe" WhatsApp
// reminders still run. Set SUBSCRIPTION_ENFORCED=true on Render to start locking features.
const SUBSCRIPTION_ENFORCED = process.env.SUBSCRIPTION_ENFORCED === 'true';
// After the trial (or a plan) ends: a reminder on day 26, then every N days, at most M times.
const SUB_REMINDER_EVERY_DAYS = Math.max(1, parseInt(process.env.SUB_REMINDER_EVERY_DAYS, 10) || 3);
const SUB_REMINDER_MAX = Math.max(1, parseInt(process.env.SUB_REMINDER_MAX, 10) || 10);

function trialEndsAt(patient) {
  const created = patient?.createdAt ? new Date(patient.createdAt) : new Date();
  const start = created > SUBSCRIPTION_LAUNCH ? created : SUBSCRIPTION_LAUNCH;
  return new Date(start.getTime() + TRIAL_DAYS * 86400000);
}

// Access across every saved record of the number (duplicate "+91 X" accounts share one plan).
function accessFor(records) {
  const now = new Date();
  const list = (Array.isArray(records) ? records : [records]).filter(Boolean);
  let expiresAt = null, plan = null, trialEnd = null;
  for (const p of list) {
    const e = p.subscription?.expiresAt ? new Date(p.subscription.expiresAt) : null;
    if (e && (!expiresAt || e > expiresAt)) { expiresAt = e; plan = p.subscription.plan; }
    const t = trialEndsAt(p);
    if (!trialEnd || t > trialEnd) trialEnd = t;
  }
  const subscribed = !!(expiresAt && expiresAt > now);
  const inTrial = !subscribed && trialEnd > now;
  const tier = subscribed ? 'subscribed' : inTrial ? 'trial' : 'free';
  const until = subscribed ? expiresAt : inTrial ? trialEnd : null;
  return {
    tier, premium: tier !== 'free' || !SUBSCRIPTION_ENFORCED, enforced: SUBSCRIPTION_ENFORCED, plan: subscribed ? plan : null,
    planName: subscribed && SUBSCRIPTION_PLANS[plan] ? SUBSCRIPTION_PLANS[plan].name : null,
    expiresAt: subscribed ? expiresAt : null, trialEndsAt: trialEnd,
    daysLeft: until ? Math.max(0, Math.ceil((until - now) / 86400000)) : 0,
    lastExpiredAt: !subscribed && expiresAt ? expiresAt : null,
    freeMedicineLimit: FREE_MEDICINE_LIMIT
  };
}
async function accessForPhone(phone) {
  return accessFor(await Patient.find({ phone: { $in: phoneVariants(phone) } }));
}

const PREMIUM_FEATURE_NAMES = {
  doctor: 'Talk to a Doctor',
  report: 'Treatment reports',
  analysis: 'AI document analysis',
  medicines: 'Reminders for more than 2 medicines'
};
function subscriptionRequired(res, feature, access) {
  return res.status(402).json({
    code: 'subscription_required', feature,
    message: `${PREMIUM_FEATURE_NAMES[feature] || 'This feature'} is part of Biomexa Care. Your ${TRIAL_DAYS}-day free trial has ended — subscribe from ₹99/month to continue.`,
    subscribeUrl: `${SITE_URL}/subscribe.html`,
    access
  });
}
// Use after `auth` on patient routes.
function requirePremium(feature) {
  return async (req, res, next) => {
    try {
      const access = await accessForPhone(req.user.phone);
      if (access.premium) { req.access = access; return next(); }
      return subscriptionRequired(res, feature, access);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  };
}
// Free plan: reminders for up to FREE_MEDICINE_LIMIT different medicines. Returns null if OK.
async function medicineLimitBlock(phone, newName) {
  const records = await Patient.find({ phone: { $in: phoneVariants(phone) } });
  const access = accessFor(records);
  if (access.premium) return null;
  const names = new Set(records.flatMap(r => (r.medicines || []).filter(m => m.active).map(m => String(m.name).trim().toLowerCase())));
  if (names.has(String(newName || '').trim().toLowerCase()) || names.size < FREE_MEDICINE_LIMIT) return null;
  return access;
}

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
    const name = String(req.body.name || '').trim();
    const phone = normalizePhone(req.body.phone);
    const email = String(req.body.email || '').trim() || undefined;
    const password = String(req.body.password || '');
    if (!name) return res.status(400).json({ message: 'Please enter your name.' });
    if (!/^\+91\d{10}$/.test(phone) && !/^\+\d{11,15}$/.test(phone)) return res.status(400).json({ message: 'Please enter a valid 10-digit mobile number.' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });

    // Matches accounts saved in any number format — including ones created automatically when a
    // reminder was set from a product page, whose owner never chose a password.
    const existing = await findAccountByPhone('patient', phone);
    if (existing) return res.status(409).json({ code: 'exists', message: 'This number already has a Biomexa account. Please log in — or use "Forgot password" if you never set one.' });

    const hashed = await bcrypt.hash(password, 10);
    // Optional profile — helps the admin see who signed up (Campaign Insights).
    const ageNum = parseInt(req.body.age, 10);
    const age = ageNum >= 1 && ageNum <= 120 ? ageNum : undefined;
    const gender = ['male', 'female', 'other'].includes(String(req.body.gender || '').toLowerCase()) ? String(req.body.gender).toLowerCase() : undefined;
    const city = String(req.body.city || '').trim().slice(0, 60) || undefined;
    const patient = new Patient({ name, phone, email, password: hashed, age, gender, city });
    await patient.save();

    const token = jwt.sign({ id: patient._id, phone }, JWT_SECRET, { expiresIn: '7d' });

    // Tries the welcome template first (works even for a brand-new contact who's never
    // messaged your business number), falls back to free text if the template isn't
    // configured — same fix already proven for risk_alert.
    // IVF Care sign-ups (from ivf-auth.html) get an IVF welcome pointing back to IVF Care, not the
    // general medicine-reminder portal.
    const isIvf = req.body.program === 'ivf';
    const welcomeMsg = isIvf
      ? `🎉 Welcome to Biomexa IVF Care, ${name}!\n\nNext step: choose your IVF centre so your doctor can follow your treatment. You'll then get injection and trigger-shot reminders here on WhatsApp.\n\n${SITE_URL}/ivf.html\n\n- Biomexa IVF Care`
      : `🎉 Welcome to Biomexa, ${name}!\n\nYour WhatsApp dose reminders are now active. We'll notify you when it's time to take your medicine.\n\nReply CONFIRM after each dose to track your adherence.\n\n- Biomexa Team`;
    // The approved welcome template is tried first for everyone (it reaches brand-new contacts);
    // the IVF-specific text is the free-text fallback when the template isn't configured.
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
    const { name, phone: rawPhone, medicineName, dosage, time, foodNote, durationDays } = req.body;
    let phone = normalizePhone(rawPhone);
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

    let patient = await findAccountByPhone('patient', phone);
    let isNewAccount = false;
    if (patient) {
      const limited = await medicineLimitBlock(patient.phone, medicineName);
      if (limited) return subscriptionRequired(res, 'medicines', limited);
    }

    if (!patient) {
      isNewAccount = true;
      const randomPassword = crypto.randomBytes(12).toString('hex');
      const hashed = await bcrypt.hash(randomPassword, 10);
      patient = await Patient.create({ name, phone, password: hashed, medicines: [] });
    }
    phone = patient.phone; // doses/reminders must use the number exactly as the account stores it

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
    const timeAlreadyPassedToday = startsTomorrow(time, currentTime);

    if (!timeAlreadyPassedToday) {
      const today = localDateStr(new Date());
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

    console.log(`🗓️ Reminder set (sign-up): ${phone} — ${medicineName} at ${time}${logDuration(days)}${isNewAccount ? ', new account' : ''} (${timeAlreadyPassedToday ? 'starts tomorrow' : 'first one today'})`);

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
    const { name, phone: rawPhone, glucose, bpSystolic, bpDiastolic, temperature, heartRate } = req.body;
    let phone = normalizePhone(rawPhone);
    if (!phone || (!glucose && !bpSystolic && !temperature && !heartRate)) {
      return res.status(400).json({ message: 'Phone number and at least one vital reading are required.' });
    }
    // Calibrated once, then the CLEANED numbers are what get saved (°C converted to °F, BP only
    // as a full pair, rounded) — the raw form strings used to be parsed again and saved as typed.
    const check = cleanVitals(normaliseEntry({ bpSystolic, bpDiastolic, temperature, heartRate, glucose }));
    if (check.rejected.length) {
      return res.status(400).json({ message: `This reading looks incorrect: ${check.rejected.join(', ')}. Please check the numbers and try again.` });
    }
    if (!Object.keys(check.clean).length) return res.status(400).json({ message: 'Enter at least one reading.' });

    let patient = await findAccountByPhone('patient', phone);
    if (!patient) {
      const randomPassword = crypto.randomBytes(12).toString('hex');
      const hashed = await bcrypt.hash(randomPassword, 10);
      patient = await Patient.create({ name: name || 'Biomexa Patient', phone, password: hashed, medicines: [] });
    }
    phone = patient.phone;

    const vitals = check.clean;
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

// ========== PRODUCT ORDERS (public product pages) ==========
// Plain order-intake, not a payment transaction — no payment gateway is wired up. Saves the
// order, then notifies the pharmacy by email and (if configured) WhatsApp so someone can follow
// up manually. Both notifications are fire-and-forget: a notification failing never blocks the
// order itself from being saved and confirmed to the customer.
// Medicine discount codes. Orders are confirmed by phone (no online payment), so the code is saved
// on the order and shown to the team, who apply the discount on the call.
const PROMO_CODES = {
  // 10-day offer: 25 Oct – 3 Nov 2026 (inclusive, Indian time).
  BIOMEXA15: { pct: 15, products: /telmexa|diabmexa/i, label: '15% off Telmexa AM and Diabmexa M 500', adLabel: '15% off Biomexa medicines', validUntil: new Date('2026-11-03T23:59:59+05:30') }
};
const promoActive = p => p && (!p.validUntil || new Date() <= p.validUntil);
const promoEndLabel = p => p.validUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
// {{offer_line}} in the product message: the running offer, or a plain order line once it has ended.
function adOfferLine() {
  const live = Object.entries(PROMO_CODES).find(([, p]) => promoActive(p));
  // WhatsApp copy never names a medicine (keeps the marketing template approvable); the website does.
  if (!live) return 'Order Biomexa medicines for home delivery: biomexapharmaceuticals.com/products/';
  const [code, p] = live;
  return `🎁 Offer till ${p.validUntil ? promoEndLabel(p) : 'stock lasts'}: ${p.adLabel || p.label} with code ${code}. Order: biomexapharmaceuticals.com/products/`;
}
app.post('/api/orders', orderLimiter, async (req, res) => {
  try {
    const { productName, productSlug, customerName, phone, address, quantity, notes } = req.body;
    if (!productName || !customerName || !phone || !address) {
      return res.status(400).json({ message: 'Name, phone, and address are required.' });
    }
    const code = String(req.body.promoCode || '').trim().toUpperCase();
    const promo = code ? PROMO_CODES[code] : null;
    if (code && !promo) return res.status(400).json({ message: `The discount code "${code}" isn't valid. Please check it or leave it empty.` });
    if (promo && !promoActive(promo)) return res.status(400).json({ message: `The ${code} offer ended on ${promoEndLabel(promo)}. Please leave the code empty to place your order.` });
    if (promo && !promo.products.test(`${productName} ${productSlug || ''}`)) {
      return res.status(400).json({ message: `${code} works on ${promo.label.replace(/^\d+% off /, '')} only.` });
    }
    // Prescription: required for these medicines — either uploaded now or shared on the call.
    const rx = (Array.isArray(req.body.prescriptionFiles) ? req.body.prescriptionFiles : [])
      .filter(f => f && f.fileName && f.fileType && f.fileData)
      .map(f => ({ fileName: String(f.fileName).slice(0, 120), fileType: String(f.fileType), fileData: String(f.fileData).replace(/^data:[^,]*,/, '') }));
    const rxLater = req.body.prescriptionLater === true;
    if (rx.length > 3) return res.status(400).json({ message: 'Please upload up to 3 prescription files.' });
    for (const f of rx) {
      if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(f.fileType)) return res.status(400).json({ message: `"${f.fileName}" — please upload a JPG, PNG, WEBP or PDF.` });
      if (f.fileData.length * 0.75 > 5 * 1024 * 1024) return res.status(400).json({ message: `"${f.fileName}" is too large — please upload a file under 5 MB.` });
    }
    if (!rx.length && !rxLater) return res.status(400).json({ message: 'Please upload your prescription, or tick "I\'ll share it when the team calls".' });

    const order = await Order.create({
      productName,
      productSlug: productSlug || '',
      customerName,
      phone: normalizePhone(phone) || phone,
      address,
      quantity: quantity ? Math.max(1, parseInt(quantity, 10) || 1) : 1,
      // Discount is also written into the notes so it shows in the existing admin orders list.
      notes: `${promo ? `[Discount ${code}: ${promo.pct}% off] ` : ''}${notes || ''}`.trim(),
      promoCode: promo ? code : undefined,
      discountPct: promo ? promo.pct : undefined,
      prescriptionFiles: rx,
      prescriptionLater: !rx.length && rxLater
    });
    const rxText = rx.length ? `Prescription: ${rx.length} file${rx.length > 1 ? 's' : ''} attached (see Admin → Orders)` : 'Prescription: customer will share it on the call';

    sendOrderNotificationEmail(order).catch(() => {});
    if (process.env.ADMIN_NOTIFY_PHONE) {
      sendWhatsAppFree(
        process.env.ADMIN_NOTIFY_PHONE,
        `🛒 *New Order*\n\n${order.productName} × ${order.quantity}\n${order.customerName} — ${order.phone}\n${order.address}${order.notes ? '\n\nNotes: ' + order.notes : ''}\n${rxText}\n\n- Biomexa Team`
      ).catch(() => {});
    }

    res.json({ message: `Order received!${promo ? ` ${code} applied: ${promo.pct}% off.` : ''} Our team will contact you shortly to confirm and arrange delivery.`, orderId: order._id, discountPct: order.discountPct || 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    // File contents are left out of the list (they can be MBs each); fetch one via the route below.
    const orders = await Order.find().select('-prescriptionFiles.fileData').sort({ createdAt: -1 }).limit(200);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/orders/:id/prescription/:idx', adminAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found.' });
    const order = await Order.findById(req.params.id).select('prescriptionFiles');
    const f = order && order.prescriptionFiles[parseInt(req.params.idx, 10)];
    if (!f) return res.status(404).json({ message: 'Prescription file not found.' });
    res.set('Content-Type', f.fileType);
    res.set('Content-Disposition', `inline; filename="${String(f.fileName).replace(/[^\w.\- ]/g, '_')}"`);
    res.send(Buffer.from(f.fileData, 'base64'));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['new', 'confirmed', 'shipped', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${validStatuses.join(', ')}` });
    }
    const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    res.json({ message: 'Order updated.', order });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== PRODUCT AI CHAT (public product pages) ==========
// Replaces the old hardcoded canned-response "AI Guide" chat with a real answer from the same
// Gemini/Claude infrastructure already powering document analysis elsewhere on the platform.
// Public and unauthenticated (it's on a public marketing page), so it's rate-limited and scoped
// to a fixed, small set of known products — never a free-form system prompt the caller controls.
const PRODUCT_INFO = {
  'Telmexa AM': `Telmexa AM (Telmisartan 40mg + Amlodipine Besylate 5mg) is a once-daily combination antihypertensive (ARB + calcium channel blocker) for blood pressure management. Take one tablet each morning, 6-8 AM, with a light breakfast. Avoid grapefruit/grapefruit juice entirely (raises amlodipine levels). Limit high-sodium foods and alcohol. High-potassium foods (bananas, spinach, supplements) should be limited and potassium monitored periodically. DASH-diet foods, beetroot, and pomegranate are beneficial. Never take a second dose in the evening. Common side effects: mild dizziness, ankle swelling, headache — usually resolve in ~2 weeks. Seek urgent care for severe dizziness/fainting, facial swelling, or difficulty breathing.`,
  'Diabmexa M 500': `Diabmexa M 500 (Metformin Hydrochloride IP 500mg) is a first-line oral medicine for Type 2 Diabetes, typically taken twice daily with meals to reduce GI side effects and support the dawn-phenomenon (elevated morning blood sugar). Avoid excessive alcohol (raises lactic acidosis risk). Take consistently at the same times daily. Common side effects: GI upset, metallic taste — usually improve over the first few weeks. Regular blood sugar monitoring is recommended.`
};

function buildProductChatPrompt(productName, question, history) {
  const productInfo = PRODUCT_INFO[productName];
  const historyText = (Array.isArray(history) ? history : []).slice(-6)
    .map(h => `${h.role === 'user' ? 'Patient' : 'Assistant'}: ${String(h.content ?? h.text ?? '').slice(0, 800)}`).join('\n');
  return `You are Biomexa Pharmaceuticals' AI medicine guide for ${productName}. Reference information about this product:\n${productInfo}\n\nAnswer the patient's question in clear, plain, reassuring language — short paragraphs, WhatsApp-safe formatting (*asterisks* for bold, no markdown tables or headers with #). Base your answer only on the reference information above plus general, widely-known medication-safety knowledge — never invent specifics not given here. Never state a diagnosis or tell them to change their dose. Always close by reminding them to confirm anything before changing their treatment with their doctor. If the question describes symptoms that could be a medical emergency, tell them to seek care immediately instead of continuing the chat. Reply in the same language the patient writes in (English, Hindi or Hinglish). Use short bullet points starting with "- " when listing several things. Keep the answer under 150 words.\n${historyText ? '\nRecent conversation:\n' + historyText + '\n' : ''}\nPatient's question: "${question}"`;
}

async function answerProductQuestionWithGemini(productName, question, history) {
  if (!GEMINI_API_KEY) return { ok: false, reason: 'not_configured' };
  const parts = [{ text: buildProductChatPrompt(productName, question, history) }];
  let lastFailure = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    const isLastModel = i === GEMINI_MODELS.length - 1;
    try {
      const result = await callGeminiModel(model, parts, isLastModel ? 1 : 0);
      if (result.ok) return { ok: true, answer: result.analysis };
      lastFailure = result;
    } catch (err) {
      lastFailure = { detail: err.message };
    }
  }
  return { ok: false, reason: 'api_error', detail: lastFailure?.detail || 'All Gemini models unavailable' };
}

async function answerProductQuestionWithClaude(productName, question, history) {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: buildProductChatPrompt(productName, question, history) }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: 'api_error', detail: data.error?.message || `HTTP ${res.status}` };
    const text = data.content?.find(b => b.type === 'text')?.text || 'No answer returned.';
    return { ok: true, answer: text };
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
}

// ========== NATURAL AI VOICE (Gemini text-to-speech) ==========
// The AI Pharmacist / AI Assistant read replies aloud. Phone voices sound robotic, so this turns
// text into natural speech with Gemini's TTS model in a warm, calm pharmacist tone. The page falls
// back to the device voice whenever this fails, so nothing breaks without it.
// The TTS model is found from the key's own model list (any model with "tts" in its name), since
// Google renames these often; set GEMINI_TTS_MODEL to force one. GEMINI_TTS_VOICE picks the
// voice (default Sulafat — warm); GEMINI_TTS_STYLE sets the tone.
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Sulafat';
const GEMINI_TTS_STYLE = process.env.GEMINI_TTS_STYLE || 'Read this aloud in a warm, calm, caring and reassuring tone, like a friendly Indian pharmacist talking to a patient. Speak smoothly at a relaxed pace with natural pauses:';
let ttsModelCache = { name: process.env.GEMINI_TTS_MODEL || null, checkedAt: 0 };
async function geminiTtsModel() {
  if (process.env.GEMINI_TTS_MODEL) return process.env.GEMINI_TTS_MODEL;
  if (ttsModelCache.name && Date.now() - ttsModelCache.checkedAt < 6 * 3600e3) return ttsModelCache.name;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': GEMINI_API_KEY }, signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    const names = (d.models || []).filter(m => /tts/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
    // Newest version first; Flash (fast) before Pro; stable before preview.
    const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    names.sort((a, b) => ver(b) - ver(a) || (/flash/.test(b) - /flash/.test(a)) || (/preview/.test(a) - /preview/.test(b)));
    ttsModelCache = { name: names[0] || null, checkedAt: Date.now() };
    if (names[0]) console.log('🔊 Gemini TTS model:', names[0]); else console.log('⚠️ No Gemini TTS model available for this key — pages use the device voice');
  } catch (err) { console.log('⚠️ Could not list Gemini models for TTS:', err.message); }
  return ttsModelCache.name;
}
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const ttsCache = new Map(); // text → wav, small in-memory cache for repeated guide/greeting lines
async function geminiSpeak(text) {
  const model = await geminiTtsModel(); if (!model) return null;
  const body = voiceName => ({
    contents: [{ parts: [{ text: `${GEMINI_TTS_STYLE}\n\n${text}` }] }],
    generationConfig: { responseModalities: ['AUDIO'], ...(voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } } : {}) }
  });
  for (const voice of [GEMINI_TTS_VOICE, null]) {   // retry with the model's default voice if ours is unknown
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body(voice)), signal: AbortSignal.timeout(30000)
    });
    const d = await r.json().catch(() => ({}));
    const part = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData && /audio/.test(p.inlineData.mimeType || ''));
    if (r.ok && part) {
      const mime = part.inlineData.mimeType, raw = Buffer.from(part.inlineData.data, 'base64');
      if (/wav|mpeg|mp3|ogg/.test(mime)) return { audio: raw, type: mime };
      const rate = parseInt((mime.match(/rate=(\d+)/) || [])[1], 10) || 24000;
      return { audio: pcmToWav(raw, rate), type: 'audio/wav' };
    }
    console.log(`⚠️ Gemini TTS failed (${model}${voice ? ', ' + voice : ''}):`, (d.error?.message || `HTTP ${r.status}`).slice(0, 200));
    if (r.status === 404) ttsModelCache = { name: null, checkedAt: 0 };   // model gone — rediscover next time
    if (r.status !== 400) break;
  }
  return null;
}
const ttsLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 120, message: 'Too many voice requests — please wait a few minutes.' });
app.post('/api/tts', ttsLimiter, async (req, res) => {
  try {
    const text = String(req.body.text || '').replace(/[*#_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!text) return res.status(400).json({ message: 'Nothing to read.' });
    if (!GEMINI_API_KEY) return res.status(503).json({ message: 'Natural voice is not configured.' });
    const key = crypto.createHash('sha1').update(text).digest('hex');
    let out = ttsCache.get(key);
    if (!out) {
      out = await geminiSpeak(text);
      if (!out) return res.status(503).json({ message: 'Natural voice is unavailable right now.' });
      ttsCache.set(key, out); if (ttsCache.size > 200) ttsCache.delete(ttsCache.keys().next().value);
    }
    res.set('Content-Type', out.type); res.set('Cache-Control', 'public, max-age=86400');
    res.send(out.audio);
  } catch (err) {
    console.log('⚠️ TTS error:', err.message);
    res.status(503).json({ message: 'Natural voice is unavailable right now.' });
  }
});

app.post('/api/product-chat', productChatLimiter, async (req, res) => {
  try {
    const { productName, question, history } = req.body;
    if (!productName || !PRODUCT_INFO[productName]) {
      return res.status(400).json({ message: 'Unknown product.' });
    }
    if (!question || !question.trim()) {
      return res.status(400).json({ message: 'Question is required.' });
    }

    const geminiResult = await answerProductQuestionWithGemini(productName, question.trim(), history);
    const result = geminiResult.ok ? geminiResult : (ANTHROPIC_API_KEY ? await answerProductQuestionWithClaude(productName, question.trim(), history) : geminiResult);

    if (!result.ok) {
      return res.status(result.reason === 'not_configured' ? 503 : 502).json({
        message: result.reason === 'not_configured'
          ? 'The AI guide isn\'t configured yet — please check the product page for dosing and food-interaction details, or contact us directly.'
          : 'Could not get an answer right now — please try again in a moment.'
      });
    }
    res.json({ answer: result.answer });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    // Exact match first; then the same number in another saved format (e.g. "+91 0…").
    const patient = await Patient.findOne({ phone }) || await Patient.findOne({ phone: { $in: phoneVariants(phone) } });
    if (!patient) return res.status(400).json({ message: 'User not found' });

    const match = await bcrypt.compare(password, patient.password);
    if (!match) return res.status(400).json({ message: 'Invalid password' });

    const token = jwt.sign({ id: patient._id, phone: patient.phone }, JWT_SECRET, { expiresIn: '7d' });

    // Get today's doses for the welcome message
    const today = localDateStr(new Date());
    const todayDoses = await Dose.find({
      patientPhone: patient.phone,
      scheduledDate: today,
      status: 'pending'
    }).sort({ scheduledTime: 1 });

    let loginMsg = `👋 Welcome back, ${patient.name}!\n\nYou've successfully logged in to Biomexa.`;
    let statusLine;
    if (todayDoses.length > 0) {
      const nextDose = todayDoses[0];
      loginMsg += `\n\n💊 Your next dose:\n*${nextDose.medicineName}* — ${nextDose.dosage}\n⏰ ${nextDose.scheduledTime}`;
      if (nextDose.foodNote) loginMsg += `\n🍽️ ${nextDose.foodNote}`;
      statusLine = `Your next dose: ${nextDose.medicineName} (${nextDose.dosage}) at ${nextDose.scheduledTime}.`;
    } else {
      loginMsg += `\n\n✅ No pending doses for today. Great job!`;
      statusLine = 'No pending doses for today. Great job!';
    }
    loginMsg += `\n\n- Biomexa Team`;

    // Template first (reaches the patient regardless of WhatsApp session window), free-text
    // fallback only if MSG91_LOGIN_TEMPLATE_NAME isn't configured yet — same fix as the OTP,
    // treatment report, and report analysis sends above.
    sendLoginMessage(patient.phone, patient.name, statusLine, loginMsg);

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
      : await findAccountByPhone(isDoctor ? 'doctor' : 'patient', phone);
    if (!account) return res.status(400).json({ message: `No ${isAdmin ? 'admin' : isDoctor ? 'doctor' : 'patient'} account found${isAdmin ? ' with this username' : ' with this phone number'}` });

    const roleKey = isAdmin ? 'admin' : isDoctor ? 'doctor' : 'patient';
    const identifier = isAdmin ? account.username : phone;

    const otp = generateOTP();
    const resetToken = generateResetToken();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await Otp.updateMany({ phone: isAdmin ? identifier : { $in: phoneVariants(identifier) }, role: roleKey, used: false }, { used: true });
    await Otp.create({ phone: identifier, role: roleKey, otp, resetToken, expiresAt });

    const otpMsg = `🔐 *Biomexa Password Reset*\n\nYour OTP code is: *${otp}*\n\nThis code will expire in ${OTP_EXPIRY_MINUTES} minutes.\n\nIf you didn't request this, please ignore this message.\n\n- Biomexa Team`;

    // Admin has no WhatsApp number tied to the account — email only.
    const waResult = isAdmin
      ? { success: false }
      : await sendPasswordResetOTPMessage(phone, account.name || account.username, otp, OTP_EXPIRY_MINUTES, otpMsg);
    const emailResult = await sendResetEmail(account.email, otp, account.name || account.username);

    if (isAdmin && !emailResult.success) {
      return res.status(500).json({
        message: 'Could not deliver the code by email. Make sure EMAIL_USER/EMAIL_APP_PASSWORD are configured on the server.'
      });
    }

    // Only an approved template or email is guaranteed to arrive. A free-text WhatsApp "success"
    // just means MSG91 accepted it — Meta drops it for anyone outside the 24-hour session window.
    // In that case the page shows a one-tap "send RESET on WhatsApp" button, which opens the
    // session so the code is actually delivered (see handleWhatsAppResetRequest).
    const guaranteed = !!(waResult.viaTemplate || emailResult.success);
    const whatsappNumber = String(MSG91_INTEGRATED_NUMBER || '').replace(/\D/g, '');
    res.json({
      message: guaranteed
        ? `OTP sent via ${[waResult.viaTemplate && 'WhatsApp', emailResult.success && 'email'].filter(Boolean).join(' and ')}`
        : 'Code ready. If it doesn\'t arrive on WhatsApp within a minute, tap "Get code on WhatsApp" and send the message.',
      sentVia: { whatsapp: !!waResult.success, email: !!emailResult.success },
      needsWhatsAppReply: !isAdmin && !guaranteed,
      whatsappNumber
    });
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
      phone: roleKey === 'admin' ? phone : { $in: phoneVariants(phone) },
      otp: String(otp || '').trim(),
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

    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const otpRecord = await Otp.findOne({
      phone: isAdmin ? phone : { $in: phoneVariants(phone) },
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
    } else {
      // Update the account whatever format its phone was saved in (see phoneVariants).
      const Model = isDoctor ? Doctor : Patient;
      const updated = await Model.findOneAndUpdate({ phone: { $in: phoneVariants(phone) } }, { password: hashed });
      if (!updated) return res.status(400).json({ message: 'Account not found. Please start over.' });
    }

    otpRecord.used = true;
    await otpRecord.save();

    if (!isAdmin) {
      const confirmMsg = `✅ *Password Reset Successful*\n\nYour Biomexa password has been reset successfully.\n\nIf you didn't do this, please contact support immediately.\n\n- Biomexa Team`;
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
    // Excludes the password hash — it was being sent to the frontend on every profile load for
    // no reason; the frontend never needed it and nothing should send a password hash to the
    // client even when hashed.
    const patient = await Patient.findOne({ phone: req.user.phone }).select('-password');
    if (!patient) return res.status(404).json({ message: 'Patient not found' });
    const r = await computeRiskScore(patient);
    res.json({
      ...patient.toObject(),
      access: await accessForPhone(req.user.phone),
      // Same calibrated score the doctor and admin dashboards show.
      risk: { label: r.label, score: r.score, adherence: r.adherenceKnown ? Math.round(r.adherence * 100) : null, dosesLogged: r.due, reasons: r.reasons }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Lets a patient update their own editable profile fields — currently name and email.
// Phone is intentionally not editable here since it's the account identifier used for login,
// WhatsApp delivery, and every record tied to this patient; changing it needs its own
// verification flow, not a plain profile edit.
const SUPPORTED_LANGUAGES = ['English', 'Hindi', 'Tamil', 'Telugu', 'Bengali', 'Marathi', 'Gujarati', 'Kannada'];

app.patch('/api/patient/profile', auth, async (req, res) => {
  try {
    const { name, email, preferredLanguage } = req.body;
    const update = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: 'Name cannot be empty.' });
      update.name = name.trim();
    }
    if (email !== undefined) update.email = email.trim();
    if (preferredLanguage !== undefined) {
      if (!SUPPORTED_LANGUAGES.includes(preferredLanguage)) {
        return res.status(400).json({ message: `Language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}` });
      }
      update.preferredLanguage = preferredLanguage;
    }
    if (!Object.keys(update).length) return res.status(400).json({ message: 'Nothing to update.' });

    const patient = await Patient.findOneAndUpdate({ phone: req.user.phone }, update, { new: true }).select('-password');
    res.json({ message: 'Profile updated!', patient });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Lets a logged-in patient change their own password directly, given their current one —
// the existing forgot-password flow is OTP-based and meant for when they can't log in at all;
// this is the normal in-session path, same pattern as the admin's own change-password endpoint.
app.post('/api/patient/change-password', loginLimiter, auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are both required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    }

    const patient = await Patient.findOne({ phone: req.user.phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    const match = await bcrypt.compare(currentPassword, patient.password);
    if (!match) return res.status(400).json({ message: 'Current password is incorrect.' });

    patient.password = await bcrypt.hash(newPassword, 10);
    await patient.save();

    res.json({ message: 'Password changed successfully!' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// A patient's own logged vitals history — every real reading they've sent over WhatsApp,
// most recent first. This is what lets a patient actually see the data they've been sending in,
// not just have it silently feed the AI risk model behind the scenes.
app.get('/api/patient/vitals-history', auth, async (req, res) => {
  try {
    // All saved formats of the number — WhatsApp readings arrive as 91XXXXXXXXXX even when the
    // account is saved as "+91 XXXXX…", and the dashboard charts already count both.
    const logs = await VitalsLog.find({ patientPhone: { $in: phoneVariants(req.user.phone) } }).sort({ recordedAt: -1 }).limit(30);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Charts + end-of-treatment analysis for one patient — one chart per vital that has been
// recorded, day-by-day medicine adherence, and a final analysis report (vitals/progress.js).
// The patient portal and the doctor dashboard both call this, so they always show the same
// numbers. Phone variants are matched so readings saved under "+91 98…" and "+9198…" both count.
async function loadVitalsProgress(patient) {
  const phones = phoneVariants(patient.phone);
  const [doses, vitalsLogs] = await Promise.all([
    Dose.find({ patientPhone: { $in: phones } }).sort({ scheduledDate: 1 }).lean(),
    VitalsLog.find({ patientPhone: { $in: phones } }).sort({ recordedAt: 1 }).lean()
  ]);
  const pr = buildVitalsProgress({ patient, doses, vitalsLogs, now: new Date() });
  return { patient: { name: patient.name, phone: patient.phone }, ...pr };
}

app.get('/api/patient/vitals-progress', auth, async (req, res) => {
  try {
    const patient = await Patient.findOne({ phone: req.user.phone }).lean();
    if (!patient) return res.status(404).json({ message: 'Patient not found' });
    res.json(await loadVitalsProgress(patient));
  } catch (err) {
    console.log(`❌ Vitals progress failed for ${req.user.phone}:`, err.message);
    res.status(500).json({ message: 'Could not load your vitals charts right now — please try again.' });
  }
});

const ALLOWED_DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_DOCUMENT_BASE64_LENGTH = 5 * 1024 * 1024 * 1.4; // ~5MB per file, base64 adds ~33% overhead
const MAX_FILES_PER_UPLOAD = 3;

// Upload a prescription or lab report for AI analysis. Accepts either a single file (fileName/
// fileType/fileData — the original shape, kept for backward compatibility) or multiple files
// together (a `files` array — e.g. front and back of a prescription, or several pages of a
// report), analyzed together as one document. Sent as plain base64 JSON, no multipart handling
// needed — the frontend reads each file via FileReader before sending.
// Analysis runs synchronously in the same request when Gemini or Claude is configured; the
// request can take up to ~30s for that reason, which the frontend's loading state accounts for.
app.post('/api/patient/upload-report', auth, requirePremium('analysis'), async (req, res) => {
  try {
    const rawFiles = Array.isArray(req.body.files) ? req.body.files
      : (req.body.fileName ? [{ fileName: req.body.fileName, fileType: req.body.fileType, fileData: req.body.fileData }] : []);
    const files = rawFiles.filter(f => f && f.fileName && f.fileType && f.fileData);
    const documentType = req.body.documentType === 'imaging' ? 'imaging' : 'prescription';

    if (!files.length) {
      return res.status(400).json({ message: 'At least one file (name, type, and data) is required.' });
    }
    if (files.length > MAX_FILES_PER_UPLOAD) {
      return res.status(400).json({ message: `Up to ${MAX_FILES_PER_UPLOAD} files are supported per upload.` });
    }
    if (documentType === 'imaging' && files.some(f => f.fileType === 'application/pdf')) {
      return res.status(400).json({ message: 'X-rays and imaging should be uploaded as photos (JPG/PNG/WEBP), not PDF.' });
    }
    for (const f of files) {
      if (!ALLOWED_DOCUMENT_TYPES.includes(f.fileType)) {
        return res.status(400).json({ message: `"${f.fileName}" — only JPG, PNG, WEBP, or PDF files are supported.` });
      }
      if (f.fileData.length > MAX_DOCUMENT_BASE64_LENGTH) {
        return res.status(400).json({ message: `"${f.fileName}" is too large — please upload something under 5MB.` });
      }
    }

    const patient = await Patient.findOne({ phone: req.user.phone });
    const language = patient?.preferredLanguage || 'English';
    const displayName = files.length > 1 ? `${files[0].fileName} (+${files.length - 1} more)` : files[0].fileName;

    const doc = await UploadedDocument.create({
      patientPhone: req.user.phone,
      files: files.map(f => ({ fileName: f.fileName, fileType: f.fileType, fileData: f.fileData })),
      fileName: displayName,
      fileType: files[0].fileType,
      language,
      documentType,
      uploadedByRole: 'patient',
      analysisStatus: 'pending'
    });

    const result = await analyzeDocument(files, language, documentType, 'patient', patient);
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

// Lets a patient delete an uploaded report/prescription — removes the file data and analysis
// entirely, not just from the visible list.
app.delete('/api/patient/uploaded-reports/:id', auth, async (req, res) => {
  try {
    const doc = await UploadedDocument.findOneAndDelete({ _id: req.params.id, patientPhone: req.user.phone });
    if (!doc) return res.status(404).json({ message: 'Report not found.' });
    res.json({ message: 'Report deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Sends a previously-completed document analysis over WhatsApp — the prompt already formats
// the analysis with WhatsApp-style *bold* headers, so this sends the exact same text shown on
// the dashboard rather than reformatting or condensing it again.
app.post('/api/patient/uploaded-reports/:id/send-whatsapp', auth, requirePremium('analysis'), async (req, res) => {
  try {
    const doc = await UploadedDocument.findOne({ _id: req.params.id, patientPhone: req.user.phone });
    if (!doc) return res.status(404).json({ message: 'Report not found.' });
    if (doc.analysisStatus !== 'done' || !doc.analysis) {
      return res.status(400).json({ message: 'This report doesn\'t have a completed analysis to send yet.' });
    }

    const msg = `📄 *Report Analysis: ${doc.fileName}*\n\n${doc.analysis}\n\n- Biomexa Team`;

    // Uses the report-analysis template when configured (works regardless of session state) —
    // fixes the same "generated fine, never arrived on WhatsApp" issue as the treatment report,
    // for the same reason (Meta error 131047 on free-text sends outside the 24h session window).
    const patient = await Patient.findOne({ phone: req.user.phone });
    const waResult = await sendReportAnalysisMessage(req.user.phone, patient?.name || 'there', doc.fileName, doc.analysis, msg);

    res.json({
      message: waResult.success ? 'Sent to your WhatsApp!' : 'Could not deliver to WhatsApp right now — you can still view it on your dashboard.',
      whatsappSent: waResult.success
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Every missed dose with its exact scheduled date and time — the detail level a patient (or
// their doctor) needs to actually see the pattern, not just an aggregate adherence percentage.
app.get('/api/patient/missed-doses', auth, async (req, res) => {
  try {
    const missed = await Dose.find({ patientPhone: { $in: phoneVariants(req.user.phone) }, status: 'missed' })
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

// ========== VITALS: PLAUSIBILITY + TREATMENT-ANALYSIS INPUT ==========
// VITAL_LIMITS / cleanVitals live in vitals/calibration.js — one set of plausibility rules for
// every entry path and every report.

// One builder for both the doctor view and the patient's report, so they can never disagree.
//  • one entry per scheduled dose (adherence = taken ÷ doses scheduled)
//  • every REAL reading is its own data point ("vitals_only") — days without a reading add
//    nothing (they used to be filled with the patient's latest reading, which faked "time in
//    range" and trends), and impossible readings are ignored
//  • baseline = the FIRST real reading of each vital (it used to be the latest one, so every
//    "change from baseline" was 0%)
//  • BP and blood sugar both assessed ('general'); symptoms aren't collected yet
function buildAnalysisInput(patient, doses, vitalsLogs) {
  const FIELDS = { bpSystolic: 'bp_systolic', bpDiastolic: 'bp_diastolic', glucose: 'glucose', temperature: 'temperature' };
  const byDay = {}, first = {}, readings = [];
  let ignored = 0;
  for (const v of [...vitalsLogs].sort((a, b) => a.recordedAt - b.recordedAt)) {
    const { clean, rejected } = cleanVitals(v);
    ignored += rejected.length;
    const iso = v.recordedAt.toISOString();
    const day = localDateStr(v.recordedAt);
    const bucket = byDay[day] || (byDay[day] = {});
    for (const [f, val] of Object.entries(clean)) {
      bucket[f] = val;                             // for the day-by-day table: latest of the day
      if (FIELDS[f] && first[f] == null) first[f] = val;
    }
    // Every real reading is its own data point — two readings in a day are both kept (a 580
    // sugar in the morning must not disappear behind a 450 in the evening).
    const eng = Object.fromEntries(Object.entries(FIELDS).map(([k, e]) => [e, clean[k] ?? null]));
    if (Object.values(eng).some(x => x != null)) readings.push({ key: iso, date: day, status: 'vitals_only', vitals: eng, symptoms: [] });
  }
  const none = Object.fromEntries(Object.values(FIELDS).map(e => [e, null]));

  const relevant = doses.filter(d => d.status !== 'pending');
  const entries = [
    // One entry per scheduled dose — adherence = taken ÷ doses due. Doses carry no vitals.
    ...relevant.map(d => ({ key: `${d.scheduledDate}T${d.scheduledTime || '00:00'}`, date: d.scheduledDate, status: d.status === 'taken' ? 'taken' : 'not_taken', vitals: none, symptoms: [] })),
    ...readings
  ].sort((a, b) => a.key.localeCompare(b.key)).map(({ key, ...e }) => e);

  const active = (patient.medicines || []).filter(m => m.active);
  const primaryMed = active[0] || patient.medicines?.[0] || { name: relevant[0]?.medicineName, dosage: relevant[0]?.dosage };
  const payload = {
    patient: {
      id: patient.phone,
      drug_name: primaryMed.name || 'Unknown',
      drug_dose: primaryMed.dosage || '',
      schedule: [...new Set(relevant.map(d => d.scheduledTime))],
      baseline_bp: [first.bpSystolic ?? null, first.bpDiastolic ?? null],
      baseline_glucose: first.glucose ?? null,
      baseline_temp: first.temperature ?? null,
      history: patient.medicalHistory || [],
      baseline_blood_test: {}
    },
    dose_history: entries,
    indication: 'general',
    symptoms_tracked: false
  };
  return { payload, byDay, relevant, doseCount: relevant.length, usedRealVitals: readings.length > 0, ignoredReadings: ignored };
}

async function buildPatientTreatmentReport(phone) {
  const patient = await Patient.findOne({ phone });
  if (!patient) return { error: 'Patient not found', status: 404 };

  // Every saved format of the number, same as the charts (loadVitalsProgress) — otherwise
  // WhatsApp readings saved as 91XXXXXXXXXX were missing from the report but on the charts.
  const phones = phoneVariants(patient.phone);
  const doses = await Dose.find({ patientPhone: { $in: phones } }).sort({ scheduledDate: 1 });
  if (!doses.length) return { error: 'No dose history yet — add a medicine and confirm a few doses first, then check back.', status: 400 };

  const vitalsLogs = await VitalsLog.find({ patientPhone: { $in: phones } }).sort({ recordedAt: 1 });
  const { payload, byDay, relevant, usedRealVitals } = buildAnalysisInput(patient, doses, vitalsLogs);
  if (!relevant.length) return { error: 'All your doses so far are still pending — check back once you\'ve confirmed a few.', status: 400 };
  const dose_history = payload.dose_history;

  // Day-by-day table the patient sees: each dose, and that day's real readings if any were logged.
  const dailyBreakdown = relevant.map(d => {
    const day = byDay[d.scheduledDate];
    return {
      date: d.scheduledDate, time: d.scheduledTime, medicineName: d.medicineName, dosage: d.dosage, status: d.status,
      vitalsSource: day ? 'logged' : 'none',
      vitals: day ? { bpSystolic: day.bpSystolic, bpDiastolic: day.bpDiastolic, temperature: day.temperature, heartRate: day.heartRate, glucose: day.glucose } : null
    };
  }).reverse();

  console.log(`📊 Treatment report requested for ${phone} — ${relevant.length} dose(s), ${Object.keys(byDay).length} day(s) with readings`);
  const result = await callAiEngine('/analyze', payload);
  if (!result.ok) {
    console.log(`⚠️ Treatment report AI call failed for ${phone}: ${result.reason} — ${result.detail || ''}`);
    const messages = {
      not_configured: 'The AI engine isn\'t configured yet — please try again later.',
      unreachable: 'Could not reach the AI engine right now — it may be waking up from sleep, please try again in a minute.',
      engine_error: 'The AI engine returned an error: ' + result.detail
    };
    return { error: messages[result.reason] || 'AI engine unavailable', status: 503 };
  }

  // The AI engine wraps its actual analysis fields (drug_name, effectiveness_score,
  // adherence_summary, clinical_insights, treatment_recommendations, etc.) one level deeper
  // than the top of the HTTP response — under full_report — with a separate, differently-shaped
  // "dashboard" summary alongside it. Confirmed by reading ai_engine.py directly: the earlier
  // code was reading these fields off the top level, where they never existed, which is exactly
  // why every one of them came through as undefined on both the portal and WhatsApp.
  const report = result.data.full_report || {};

  // The engine's insights/recommendations were written for the doctor dashboard ("LOW ADHERENCE
  // (65%): May be masking true drug effectiveness.") — rewritten here in plain language, in the
  // patient's preferred language, before ever reaching the portal or WhatsApp. Falls back to the
  // original clinical text if simplification fails for any reason, rather than showing nothing.
  const language = patient.preferredLanguage || 'English';
  // Dose / drug-change advice is for doctors — patients see "discuss with your doctor" instead.
  report.clinical_insights = patientSafeAdvice(report.clinical_insights || []);
  report.treatment_recommendations = patientSafeAdvice(report.treatment_recommendations || [], true);
  const simplified = await simplifyTreatmentReport(report.clinical_insights, report.treatment_recommendations, language);
  if (simplified) {
    report.clinical_insights = simplified.insights;
    report.treatment_recommendations = simplified.recommendations;
  } else {
    console.log(`ℹ️ Treatment report simplification unavailable for ${phone}, using original clinical text`);
  }

  return { data: { ...report, usedRealVitals, patientName: patient.name, dailyBreakdown } };
}

app.get('/api/patient/treatment-report', auth, requirePremium('report'), async (req, res) => {
  try {
    const result = await buildPatientTreatmentReport(req.user.phone);
    if (result.error) {
      console.log(`❌ Treatment report failed for ${req.user.phone}: ${result.error}`);
      return res.status(result.status).json({ message: result.error });
    }
    res.json(result.data);
  } catch (err) {
    // Was previously unguarded — a transient DB hiccup here would crash the whole Node process,
    // taking the API down for every patient, not just this request. Caught explicitly now.
    console.log(`❌ Treatment report crashed for ${req.user.phone}:`, err.message);
    res.status(500).json({ message: 'Could not generate your treatment report right now — please try again.' });
  }
});

// Sends a condensed, readable version of the same report over WhatsApp — the full report with
// every data point stays on the portal, WhatsApp gets the score, adherence, and the top
// insight/recommendation so it's genuinely readable as a chat message, not a wall of JSON.
app.post('/api/patient/treatment-report/send-whatsapp', auth, requirePremium('report'), async (req, res) => {
  try {
    const result = await buildPatientTreatmentReport(req.user.phone);
    if (result.error) return res.status(result.status).json({ message: result.error });

    const r = result.data;
    const topInsight = r.clinical_insights?.[0] || 'No specific concerns flagged.';
    const topRecommendation = r.treatment_recommendations?.[0] || 'Continue as prescribed.';

    const msg = `📊 *Your Treatment Report*\n\n💊 ${r.drug_name}\n📅 ${r.course_duration_days} day(s) tracked\n✅ Adherence: ${r.adherence_summary?.adherence_rate}%\n⭐ Effectiveness: ${r.effectiveness_category} (${r.effectiveness_score}/100)\n\n🔍 *Key insight:*\n${topInsight}\n\n💡 *Advice:*\n${topRecommendation}\n\nFull report with all details is on your Biomexa dashboard.\n\n- Biomexa Team`;

    // Uses the treatment-report template when configured (works regardless of session state) —
    // this is what fixes "sent" but never-delivered reports (Meta error 131047: the patient
    // hadn't messaged Biomexa's WhatsApp number within the last 24 hours, so the old free-text
    // send was silently rejected at Meta's level even though MSG91's own API returned success).
    // patientName comes from the report itself (buildPatientTreatmentReport already looked the
    // patient up) rather than a second DB call.
    const waResult = await sendTreatmentReportMessage(
      req.user.phone,
      r.patientName || 'there',
      r.drug_name,
      `${r.adherence_summary?.adherence_rate}%`,
      `${r.effectiveness_category} (${r.effectiveness_score}/100)`,
      topInsight,
      msg
    );
    res.json({ message: waResult.success ? 'Report sent to your WhatsApp!' : 'Could not deliver to WhatsApp right now, but your full report is ready on the dashboard.', whatsappSent: waResult.success });
  } catch (err) {
    console.log(`❌ Send-to-WhatsApp crashed for ${req.user.phone}:`, err.message);
    res.status(500).json({ message: 'Could not send your report to WhatsApp right now — please try again.' });
  }
});

// Lets a logged-in patient log vitals directly from their own dashboard — same underlying save
// as the WhatsApp flow (VitalsLog, baseline update, risk-alert check), just entered via a form
// instead of parsed from free text. Identified by the auth token, not a phone in the body.
app.post('/api/patient/vitals', auth, async (req, res) => {
  try {
    const { bpSystolic, bpDiastolic, temperature, heartRate, glucose } = req.body;
    if (!bpSystolic && !bpDiastolic && !temperature && !heartRate && !glucose) {
      return res.status(400).json({ message: 'Enter at least one reading.' });
    }
    const check = cleanVitals(normaliseEntry({ bpSystolic, bpDiastolic, temperature, heartRate, glucose }));
    if (check.rejected.length) {
      return res.status(400).json({ message: `This reading looks incorrect: ${check.rejected.join(', ')}. Please check the numbers and try again.` });
    }
    if (!Object.keys(check.clean).length) return res.status(400).json({ message: 'Enter at least one reading.' });

    const patient = await Patient.findOne({ phone: req.user.phone });
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    // The calibrated values are what get saved — never the raw form strings.
    const vitals = check.clean;

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
    const today = localDateStr(now);

    // One medicine sub-document per time — this keeps every existing piece of logic (daily
    // regeneration, the reminder cron's exact-time match, per-dose confirmation and vitals
    // capture) working completely unchanged, since each one is a real, independent medicine
    // entry rather than a new data shape those systems would need to understand.
    const medicineEntries = times.map(t => ({
      name, dosage, time: t, frequency, foodNote, active: true, durationDays: days, startDate, endDate
    }));

    // Same medicine already running -> don't double every reminder.
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'Please enter the medicine name.' });
    const limited = await medicineLimitBlock(req.user.phone, name);
    if (limited) return subscriptionRequired(res, 'medicines', limited);
    const current = await Patient.findOne({ phone: req.user.phone }).select('medicines');
    const dup = current && current.medicines.find(m => m.active && String(m.name).trim().toLowerCase() === String(name).trim().toLowerCase());
    if (dup) return res.status(409).json({ code: 'duplicate', message: `${dup.name} reminders are already active on your account. Stop the old one in "My medicines" first if you want to change the times.` });

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
      if (startsTomorrow(t, currentTime)) {
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

    console.log(`🗓️ Reminder set: ${req.user.phone} — ${name} at ${times.join(', ')}${logDuration(days)} (today: ${createdToday.join(', ') || 'none'}, from tomorrow: ${deferredToTomorrow.join(', ') || 'none'})`);

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
    // Older accounts can exist twice ("+91XXXXXXXXXX" and "+91 XXXXXXXXXX"). Show medicines
    // from both so a patient can see — and stop — every reminder that goes to their number.
    const accounts = await Patient.find({ phone: { $in: phoneVariants(req.user.phone) } });
    res.json(accounts.flatMap(a => a.medicines || []));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== DOSE ROUTES ==========

// Get Today's Doses
app.get('/api/doses/today', auth, async (req, res) => {
  try {
    const today = localDateStr(new Date());
    const doses = await Dose.find({
      patientPhone: { $in: phoneVariants(req.user.phone) },
      scheduledDate: today
    }).sort({ scheduledTime: 1 });
    res.json(doses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Lets a patient delete a single dose entry — e.g. a test entry or one added by mistake.
// Scoped to the patient's own phone so this can never touch another patient's records, even
// with a guessed/valid-looking dose ID.
// Stop a medicine from the portal (the 🗑️ on a dose, or "Stop" in My medicines). Deleting just
// today's dose used to leave the medicine active, so the next morning's run recreated it and
// reminders carried on. This ends the medicine now: no more doses or reminders, and the single
// refill / Biomexa message goes out via processCompletedCourses (9 AM–9 PM).
app.delete('/api/patient/medicines/:name', auth, async (req, res) => {
  try {
    const name = String(req.params.name || '').trim().toLowerCase();
    // Every saved format of this number — a duplicate "+91 XXXXXXXXXX" account kept sending
    // reminders after the patient stopped the medicine on their main account.
    const variants = phoneVariants(req.user.phone);
    const accounts = await Patient.find({ phone: { $in: variants } });
    if (!accounts.length) return res.status(404).json({ message: 'Patient not found.' });
    const now = new Date();
    const todayStr = localDateStr(now);
    let stoppedCount = 0, medName = null, removedCount = 0;
    for (const patient of accounts) {
      const matches = patient.medicines.filter(m => m.active && String(m.name).trim().toLowerCase() === name);
      if (!matches.length) continue;
      // One refill message only: from the account they're logged into (or the first one stopped).
      const sendsRefill = patient.phone === req.user.phone || stoppedCount === 0;
      for (const m of matches) {
        m.active = false; m.endDate = now; m.completedAt = now; m.stoppedByPatient = true;
        m.followUpStage = sendsRefill ? 0 : 3;
      }
      await patient.save();
      stoppedCount += matches.length; medName = medName || matches[0].name;
      const removed = await Dose.deleteMany({
        patientPhone: patient.phone, medicineName: matches[0].name, status: 'pending', sentReminder: false, scheduledDate: { $gte: todayStr }
      });
      removedCount += removed.deletedCount;
    }
    if (!stoppedCount) return res.status(404).json({ message: 'That medicine is not active any more.' });
    // Clear a pending "Taken / Not taken" only if it was for this medicine.
    const convos = await ConversationState.find({ patientPhone: { $in: variants }, state: 'awaiting_dose_confirm' });
    for (const convo of convos) {
      const d = convo.doseId ? await Dose.findById(convo.doseId).catch(() => null) : null;
      if (!d || String(d.medicineName).trim().toLowerCase() === name) {
        await ConversationState.updateOne({ _id: convo._id }, { state: null, doseId: null });
      }
    }
    console.log(`🛑 ${req.user.phone} stopped ${medName} (${stoppedCount} reminder time${stoppedCount > 1 ? 's' : ''} across ${accounts.length} account record(s), ${removedCount} upcoming dose(s) removed)`);
    processCompletedCourses(); // refill message now if it's 9 AM–9 PM, otherwise in the morning
    res.json({ message: `Reminders for ${medName} have stopped.`, stopped: stoppedCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/doses/:id', auth, async (req, res) => {
  try {
    const variants = phoneVariants(req.user.phone);
    const dose = await Dose.findOneAndDelete({ _id: req.params.id, patientPhone: { $in: variants } });
    if (!dose) return res.status(404).json({ message: 'Dose not found.' });
    // Deleting a dose also ends that medicine's reminder at that time — otherwise the medicine
    // stayed active and the next morning's run quietly recreated it. Other times of a
    // twice-daily medicine are left alone; the portal's "Stop" ends the whole medicine.
    const now = new Date();
    let stopped = 0;
    for (const patient of await Patient.find({ phone: { $in: variants } })) {
      let here = 0;
      for (const m of patient.medicines) {
        if (m.active && m.name === dose.medicineName && m.time === dose.scheduledTime) {
          m.active = false; m.endDate = now; m.completedAt = now; m.stoppedByPatient = true;
          m.followUpStage = stopped ? 3 : 0; // one refill message, not one per duplicate account
          here++; stopped++;
        }
      }
      if (here) await patient.save();
    }
    await Dose.deleteMany({ patientPhone: { $in: variants }, medicineName: dose.medicineName, scheduledTime: dose.scheduledTime, status: 'pending' });
    if (stopped) console.log(`🛑 ${req.user.phone} deleted ${dose.medicineName} at ${dose.scheduledTime} — that reminder is stopped`);
    res.json({ message: stopped ? `Deleted. No more ${dose.scheduledTime} reminders for ${dose.medicineName}.` : 'Dose deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Confirm Dose
app.post('/api/doses/:id/confirm', auth, async (req, res) => {
  try {
    const dose = await Dose.findOneAndUpdate(
      { _id: req.params.id, patientPhone: { $in: phoneVariants(req.user.phone) } },
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
    let created = 0, expired = 0, createdLate = 0;

    for (const patient of patients) {
      for (const med of patient.medicines) {
        if (!med.active) continue;

        if (med.endDate && new Date(med.endDate) <= today) {
          // Deactivated here too so no dose is created; processCompletedCourses sends the
          // "course complete" message and follow-ups (it keys off endDate, not active).
          med.active = false;
          med.completedAt = med.completedAt || today;
          expired++;
          continue;
        }

        const existing = await Dose.findOne({ patientPhone: patient.phone, medicineName: med.name, scheduledTime: med.time, scheduledDate: todayStr });
        if (existing) continue;

        // Previously this SKIPPED creating today's dose entirely when the medicine's time had
        // already passed by the time the server (re)started — e.g. after a Render free-tier
        // sleep/wake, or after any deploy restarts the process. That left patients silently
        // never reminded for the rest of the day, with no way to catch up, because the reminder
        // cron below used to match scheduledTime to the exact current minute. Confirmed as a
        // real regression: three deploys in one evening caused three restarts, and the logs
        // showed doses being skipped each time ("skipped: time already passed today") with no
        // reminder ever going out for those. Still created now — the cron below has been changed
        // to catch up on anything with scheduledTime <= now, not just an exact-minute match, so
        // a late-created dose gets its reminder sent on the very next minute tick instead of
        // being silently lost for the whole day.
        if (med.time <= currentTime) {
          createdLate++;
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
    console.log(`🌅 Daily dose generation done: ${created} created (${createdLate} of those already past their time — will be reminded on the next check instead of skipped), ${expired} medicine(s) ended their course.`);
  } catch (err) {
    console.error('❌ Daily dose generation error:', err.message);
  }
}

// ========== END OF TREATMENT COURSE ==========
// When a medicine with a set duration reaches its endDate: reminders stop immediately (the course
// is deactivated and any not-yet-sent doses for it are removed), and the patient gets a short
// follow-up sequence on WhatsApp:
//   Stage 1 (right away)  — "course complete", their adherence for the course, link to the full
//                           treatment report, and a nudge to review it with their doctor.
//   Stage 2 (+2 days)     — reminder to consult the doctor + refill link if the doctor continues it.
//   Stage 3 (+7 days)     — last gentle refill / check-in reminder.
// Follow-ups stop by themselves if the patient restarts the same medicine. Messages are only sent
// 09:00–21:00 so nobody gets a WhatsApp at midnight; anything due overnight goes out in the morning.
// Refill links point to the Biomexa product page when the medicine is a Biomexa product;
// otherwise the message introduces the Biomexa range, always framed as "ask your doctor" —
// patients shouldn't switch medicines on the strength of a WhatsApp message alone.
const SITE_URL = (process.env.SITE_URL || 'https://biomexa-website.onrender.com').replace(/\/+$/, '');
const COURSE_MSG_START_HOUR = 9, COURSE_MSG_END_HOUR = 21;

// Optional approved template so these reach patients outside WhatsApp's 24-hour session window
// (most will be — the course has ended, so they're no longer replying to dose reminders).
// Suggested body: "✅ Biomexa — Hi {{1}}, here is an update on your {{2}} treatment course:\n\n{{3}}\n\nThank you for trusting Biomexa with your care. — Biomexa Team" (see .env.example)
const MSG91_COURSE_TEMPLATE_NAME = process.env.MSG91_COURSE_TEMPLATE_NAME || null;
const MSG91_COURSE_TEMPLATE_NAMESPACE = process.env.MSG91_COURSE_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;

async function sendCourseTemplate(phone, patientName, medicineName, summaryLine) {
  if (!MSG91_CONFIGURED || !MSG91_COURSE_TEMPLATE_NAME) {
    return { success: false, provider: 'msg91_course_template_not_configured' };
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
            name: MSG91_COURSE_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_COURSE_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: {
                body_1: { type: 'text', value: sanitizeTemplateParam(patientName || 'there', 60), parameter_name: 'patient_name' },
                body_2: { type: 'text', value: sanitizeTemplateParam(medicineName, 60), parameter_name: 'medicine_name' },
                body_3: { type: 'text', value: sanitizeTemplateParam(summaryLine, 600), parameter_name: 'summary' }
              }
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 course template send failed:', JSON.stringify(data).substring(0, 500));
      return { success: false, provider: 'msg91', detail: data };
    }
    console.log('✅ MSG91 course template sent to', phone);
    return { success: true, provider: 'msg91' };
  } catch (err) {
    console.log('⚠️ MSG91 course template send error:', err.message);
    return { success: false, provider: 'msg91', detail: err.message };
  }
}

async function sendCourseMessage(phone, patientName, medicineName, summaryLine, fallbackMsg) {
  const templateResult = await sendCourseTemplate(phone, patientName, medicineName, summaryLine);
  if (templateResult.success) return templateResult;
  return sendWhatsAppFree(phone, fallbackMsg);
}

// Matches a patient's medicine to a Biomexa product ("Telmexa AM 40mg" -> Telmexa AM).
function findBiomexaProduct(medicineName) {
  const n = String(medicineName || '').toLowerCase();
  const key = Object.keys(MEDICINE_CATALOG).find(k => n.includes(k.toLowerCase()) || n.includes(MEDICINE_CATALOG[k].slug.replace(/-/g, ' ')));
  return key ? { name: key, ...MEDICINE_CATALOG[key] } : null;
}

function refillLine(medicineName) {
  const product = findBiomexaProduct(medicineName);
  if (product) {
    return {
      text: `🛒 *Refill ${product.name}* — if your doctor continues it, order in one tap:\n${SITE_URL}${product.url}#orderForm`,
      short: `If your doctor continues it, refill ${product.name} at ${SITE_URL}${product.url}`
    };
  }
  return {
    text: `💊 *Biomexa medicines* — quality BP & diabetes care (Telmexa AM, Diabmexa M 500) with free WhatsApp reminders. Ask your doctor if one is right for you:\n${SITE_URL}/products/index.html`,
    short: `Ask your doctor about Biomexa medicines: ${SITE_URL}/products/index.html`
  };
}

async function summarizeCourse(phone, med) {
  const query = { patientPhone: phone, medicineName: med.name };
  if (med.startDate) query.scheduledDate = { $gte: localDateStr(new Date(med.startDate)) };
  const doses = await Dose.find(query);
  const taken = doses.filter(d => d.status === 'taken').length;
  const missed = doses.filter(d => d.status !== 'taken' && d.status !== 'pending').length;
  const unconfirmed = doses.filter(d => d.status === 'pending').length;
  const total = taken + missed + unconfirmed;
  const adherence = total ? Math.round((taken / total) * 100) : null;
  return { taken, missed, unconfirmed, total, adherence };
}

// The one WhatsApp message sent when reminders for a medicine end — either its course days ran
// out or the patient removed it from the portal. Nothing else is sent afterwards: it's a refill
// prompt for Biomexa products, or an introduction to Biomexa medicines for anything else (always
// "ask your doctor" — nobody should switch medicines on the strength of a WhatsApp message).
function courseMessages(patient, med) {
  const first = (patient.name || 'there').split(' ')[0];
  const days = med.durationDays ? `${med.durationDays}-day ` : '';
  const why = med.stoppedByPatient
    ? `you've removed *${med.name}* from Biomexa, so its reminders have stopped`
    : `your ${days}course of *${med.name}* is complete, so its reminders have stopped`;
  const whyShort = med.stoppedByPatient ? 'Reminders for this medicine have stopped.' : `Your ${days}course is complete and reminders have stopped.`;
  const product = findBiomexaProduct(med.name);
  if (product) {
    const url = `${SITE_URL}${product.url}#orderForm`;
    return {
      summaryLine: `${whyShort} Need a refill of ${product.name}? Order it for home delivery: ${url} . If your doctor asked you to continue, please don't stop suddenly.`,
      full: `💊 *Time to refill ${product.name}?*\n\nHi ${first}, ${why}.\n\n🛒 *Order ${product.name}* — delivered to your home:\n${url}\n\nIf your doctor has asked you to continue, please don't stop suddenly — keep your supply going. Add it again on Biomexa any time and your reminders restart.\n\n- Biomexa Team`
    };
  }
  const url = `${SITE_URL}/products/index.html`;
  return {
    summaryLine: `${whyShort} For your next prescription, ask your doctor about Biomexa medicines (Telmexa AM for BP, Diabmexa M 500 for diabetes) with free WhatsApp reminders: ${url}`,
    full: `💊 *Your next refill — try Biomexa*\n\nHi ${first}, ${why}.\n\nBiomexa medicines come with free WhatsApp dose reminders, an AI pharmacist and treatment reports:\n• *Telmexa AM* — for blood pressure\n• *Diabmexa M 500* — for diabetes\n\nAsk your doctor if one is right for you, and order here:\n${url}\n\n- Biomexa Team`
  };
}

let courseCheckRunning = false;
async function processCompletedCourses() {
  if (courseCheckRunning) return;
  courseCheckRunning = true;
  try {
    const now = new Date();
    const hour = now.getHours();
    const withinSendingHours = hour >= COURSE_MSG_START_HOUR && hour < COURSE_MSG_END_HOUR;
    const todayStr = localDateStr(now);

    const patients = await Patient.find({
      medicines: { $elemMatch: { endDate: { $ne: null, $lte: now }, followUpStage: { $not: { $gte: 3 } } } }
    });

    for (const patient of patients) {
      let changed = false;
      for (const med of patient.medicines) {
        if (!med.endDate || new Date(med.endDate) > now || (med.followUpStage || 0) >= 3) continue;

        // Stop reminders the moment the course ends — not just at the next daily run.
        if (med.active || !med.completedAt) {
          med.active = false;
          med.completedAt = med.completedAt || now;
          changed = true;
          const removed = await Dose.deleteMany({
            patientPhone: patient.phone, medicineName: med.name, status: 'pending', sentReminder: false,
            scheduledDate: { $gte: todayStr }
          });
          console.log(`🏁 Course ended: ${med.name} for ${patient.phone} — reminders stopped${removed.deletedCount ? `, ${removed.deletedCount} upcoming dose(s) removed` : ''}`);
        }

        // Patient restarted the same medicine (new active entry) — no refill message needed.
        const restarted = patient.medicines.some(m => m !== med && m.active && m.name.toLowerCase() === med.name.toLowerCase());
        if (restarted) {
          await Patient.updateOne({ _id: patient._id, 'medicines._id': med._id }, { $set: { 'medicines.$.followUpStage': 3, 'medicines.$.active': false } });
          med.followUpStage = 3; continue;
        }

        // Courses that ended before this feature shipped (or while the service was down for days)
        // shouldn't suddenly get a "your course just finished" message — close them out silently.
        if (!med.followUpStage && now - new Date(med.endDate) > 3 * 86400000) {
          await Patient.updateOne({ _id: patient._id, 'medicines._id': med._id }, { $set: { 'medicines.$.followUpStage': 3, 'medicines.$.active': false } });
          med.followUpStage = 3;
          continue;
        }

        // Exactly one message per ended medicine, sent 9 AM–9 PM.
        if ((med.followUpStage || 0) >= 1 || !withinSendingHours) continue;

        // Claim it atomically (0 -> 3 = done) so two instances during a deploy never double-send.
        const claimed = await Patient.updateOne(
          { _id: patient._id, medicines: { $elemMatch: { _id: med._id, followUpStage: { $in: [0, null] } } } },
          { $set: { 'medicines.$.followUpStage': 3, 'medicines.$.lastFollowUpAt': now, 'medicines.$.active': false, 'medicines.$.completedAt': med.completedAt } }
        );
        if (!claimed.modifiedCount) continue;
        med.followUpStage = 3;

        const summary = await summarizeCourse(patient.phone, med);
        await Patient.updateOne({ _id: patient._id, 'medicines._id': med._id },
          { $set: { 'medicines.$.courseSummary': { taken: summary.taken, missed: summary.missed, adherence: summary.adherence } } });

        const { summaryLine, full } = courseMessages(patient, med);
        const result = await sendCourseMessage(patient.phone, patient.name, med.name, summaryLine, full);
        if (!result.success) {
          // Delivery failed outright (MSG91 down) — release the claim so the next check retries.
          await Patient.updateOne({ _id: patient._id, 'medicines._id': med._id }, { $set: { 'medicines.$.followUpStage': 0 } });
          med.followUpStage = 0;
        }
        console.log(`📨 Refill message for ${med.name}${med.stoppedByPatient ? ' (removed by patient)' : ''} → ${patient.phone}: ${result.success ? 'sent' : 'failed, will retry'}`);
      }
      if (changed) {
        // Only the active/completedAt flags were changed in memory; stages were written atomically above.
        await Patient.updateOne({ _id: patient._id }, {
          $set: Object.fromEntries(patient.medicines.flatMap((m, i) => m.completedAt
            ? [[`medicines.${i}.active`, m.active], [`medicines.${i}.completedAt`, m.completedAt]] : []))
        });
      }
    }
  } catch (err) {
    console.error('❌ Course completion check error:', err.message);
  } finally {
    courseCheckRunning = false;
  }
}

// ========== PRODUCT MESSAGE EVERY 10 DAYS (marketing) ==========
// Separate from dose reminders. Once a day (11 AM) every patient who hasn't had one in
// AD_INTERVAL_DAYS gets a short Telmexa AM / Diabmexa M 500 message. New patients wait out their
// first AD_INTERVAL_DAYS so it never lands next to their welcome message; replying STOP opts out.
// WhatsApp only delivers unsolicited promotional content through an approved MARKETING template —
// there is deliberately no free-text fallback. Until MSG91_AD_TEMPLATE_NAME is set this just logs
// that it skipped. See .env.example for the template to create.
const MSG91_AD_TEMPLATE_NAME = process.env.MSG91_AD_TEMPLATE_NAME || null;
const MSG91_AD_TEMPLATE_NAMESPACE = process.env.MSG91_AD_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;
const AD_INTERVAL_DAYS = Math.max(1, parseInt(process.env.AD_INTERVAL_DAYS, 10) || 10);
// New sign-ups wait this long before their first product message (keeps it away from the welcome message).
const AD_NEW_PATIENT_WAIT_DAYS = Math.max(0, parseInt(process.env.AD_NEW_PATIENT_WAIT_DAYS, 10) || 1);
// Set to 'false' only if the approved template has just {{patient_name}} (the older version).
const AD_TEMPLATE_HAS_ACCESS_LINE = process.env.AD_TEMPLATE_HAS_ACCESS_LINE !== 'false';
// The exact variables in the APPROVED template, in body order. Meta rejects the whole message if the
// count differs ("number of localizable_params (3) does not match the expected number of params (2)").
// e.g. AD_TEMPLATE_PARAMS=patient_name,access_line  — any of: patient_name, access_line, offer_line.
const AD_TEMPLATE_PARAMS = (process.env.AD_TEMPLATE_PARAMS
  ? process.env.AD_TEMPLATE_PARAMS.split(',').map(x => x.trim().replace(/[{}]/g, '')).filter(Boolean)
  : (AD_TEMPLATE_HAS_ACCESS_LINE ? ['patient_name', 'access_line', 'offer_line'] : ['patient_name']));

function adTemplateComponents(patientName, accessLine) {
  const values = {
    patient_name: () => sanitizeTemplateParam(String(patientName || 'there').split(' ')[0], 40),
    access_line: () => sanitizeTemplateParam(accessLine || 'welcome to Biomexa Care.', 250),
    offer_line: () => sanitizeTemplateParam(adOfferLine(), 250)
  };
  const out = {};
  AD_TEMPLATE_PARAMS.forEach((name, i) => {
    if (!values[name]) { console.log(`⚠️ AD_TEMPLATE_PARAMS: unknown variable "${name}" — skipped`); return; }
    out[`body_${i + 1}`] = { type: 'text', value: values[name](), parameter_name: name };
  });
  return out;
}
const AD_SEND_HOUR = 11;
const AD_MAX_PER_RUN = 300;
const AD_STOP_RE = /^\s*(stop|unsubscribe|stop ads|no ads)\s*[.!]?\s*$/i;
const AD_START_RE = /^\s*(start|subscribe)\s*[.!]?\s*$/i;

// Per-patient line for {{access_line}}: trial end date / plan status, plus a nudge when every
// medicine on reminders is stopped.
function adAccessLine(records) {
  const a = accessFor(records);
  const fmt = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  let line = a.tier === 'subscribed' ? `your Biomexa Care plan is active till ${fmt(a.expiresAt)}.`
    : a.tier === 'trial' ? `your free trial of Biomexa Care ends on ${fmt(a.trialEndsAt)}. Subscribe to keep every feature.`
    : 'your free trial of Biomexa Care has ended. Subscribe to keep every feature.';
  const meds = records.flatMap(r => r.medicines || []);
  if (!meds.length) line += ' Add your medicines in the app to get free WhatsApp reminders.';
  else if (!meds.some(m => m.active !== false)) line += ' Your medicine reminders are stopped right now. Restart them any time in the app.';
  return line;
}

async function sendAdTemplate(phone, patientName, accessLine) {
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
            name: MSG91_AD_TEMPLATE_NAME,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_AD_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone.replace(/\D/g, '')],
              components: adTemplateComponents(patientName, accessLine)
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log('⚠️ MSG91 product message failed:', JSON.stringify(data).substring(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.log('⚠️ MSG91 product message error:', err.message);
    return false;
  }
}

let lastAdRunDate = null;
async function processProductAds(now = new Date()) {
  const today = localDateStr(now);
  if (lastAdRunDate === today || now.getHours() < AD_SEND_HOUR || now.getHours() >= 20) return;
  lastAdRunDate = today;
  if (!MSG91_CONFIGURED || !MSG91_AD_TEMPLATE_NAME) {
    console.log('ℹ️ 10-day product message skipped — set MSG91_AD_TEMPLATE_NAME once the marketing template is approved');
    return;
  }
  try {
    const cutoff = new Date(now.getTime() - AD_INTERVAL_DAYS * 86400000);
    // Every patient — including those whose medicines are all stopped — except anyone who replied STOP.
    const due = await Patient.find({
      adOptOut: { $ne: true },
      createdAt: { $lte: new Date(now.getTime() - AD_NEW_PATIENT_WAIT_DAYS * 86400000) },
      $or: [{ lastAdSentAt: null }, { lastAdSentAt: { $exists: false } }, { lastAdSentAt: { $lte: cutoff } }]
    }).select('name phone').limit(AD_MAX_PER_RUN);
    let sent = 0;
    for (const p of due) {
      // Claim first so a restart or a second instance can't send the same patient twice.
      const claimed = await Patient.findOneAndUpdate(
        { _id: p._id, $or: [{ lastAdSentAt: null }, { lastAdSentAt: { $exists: false } }, { lastAdSentAt: { $lte: cutoff } }] },
        { lastAdSentAt: now }
      );
      if (!claimed) continue;
      const twins = await Patient.find({ phone: { $in: phoneVariants(p.phone) } }).select('createdAt subscription medicines');
      if (await sendAdTemplate(p.phone, p.name, adAccessLine(twins.length ? twins : [p]))) sent++;
      await new Promise(r => setTimeout(r, 300)); // stay well under MSG91 rate limits
    }
    console.log(`📣 10-day product message: ${sent} sent of ${due.length} due`);
  } catch (err) {
    console.error('❌ Product message run error:', err.message);
  }
}

// A reminded dose nobody confirmed within DOSE_MISSED_AFTER_HOURS counts as missed, so adherence
// reflects reality (unanswered reminders used to stay "pending" forever and were left out of the
// rate — a patient who answered 2 of 15 reminders showed 100%). A late "Taken" on WhatsApp or the
// dashboard Confirm button still turns it into taken.
const DOSE_MISSED_AFTER_HOURS = Math.max(1, parseFloat(process.env.DOSE_MISSED_AFTER_HOURS) || 3);
let lastMissedSweep = 0;
async function markUnansweredDosesMissed(now = new Date()) {
  if (now - lastMissedSweep < 10 * 60 * 1000) return; // every 10 minutes is plenty
  lastMissedSweep = now.getTime();
  try {
    const cutoff = new Date(now.getTime() - DOSE_MISSED_AFTER_HOURS * 3600e3);
    const cutDate = localDateStr(cutoff);
    const cutTime = `${String(cutoff.getHours()).padStart(2, '0')}:${String(cutoff.getMinutes()).padStart(2, '0')}`;
    const r = await Dose.updateMany(
      { status: 'pending', sentReminder: true, $or: [{ scheduledDate: { $lt: cutDate } }, { scheduledDate: cutDate, scheduledTime: { $lte: cutTime } }] },
      { status: 'missed', autoMissed: true }
    );
    if (r.modifiedCount) console.log(`🕒 Marked ${r.modifiedCount} unanswered dose(s) as missed (no reply within ${DOSE_MISSED_AFTER_HOURS}h)`);
    if (!markUnansweredDosesMissed.reported) {
      // One-time health check (counts only): how past doses are recorded across all patients.
      markUnansweredDosesMissed.reported = true;
      const rows = await Dose.aggregate([
        { $match: { scheduledDate: { $lt: localDateStr(now) } } },
        { $group: { _id: { status: '$status', reminded: '$sentReminder' }, n: { $sum: 1 } } }
      ]);
      console.log('🩺 Past-dose status counts:', JSON.stringify(rows.map(x => [x._id.status, x._id.reminded, x.n])), '| total doses:', await Dose.estimatedDocumentCount());
      // What each patient's dashboard shows (last 4 digits only): adherence% taken/missed/pending.
      const seen = new Set(), out = [];
      for (const p of await Patient.find().select('phone')) {
        const k = String(p.phone).replace(/\D/g, '').slice(-10); if (seen.has(k)) continue; seen.add(k);
        const r = await computeRiskScore(p);
        if (r.total) { out.push(k); console.log(`🩺 Patient …${k.slice(-4)} dashboard adherence ${r.adherenceKnown ? Math.round(r.adherence * 100) + '%' : 'none yet'} — taken ${r.due - r.missed}, missed ${r.missed}, pending ${r.total - r.due}`); }
      }
      console.log(`🩺 Checked ${out.length} patients with doses`);
    }
  } catch (err) { console.error('❌ Missed-dose sweep error:', err.message); }
}

cron.schedule('* * * * *', async () => {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = localDateStr(now);

  if (lastDoseGenerationDate !== today) {
    lastDoseGenerationDate = today;
    await generateTodaysDoses(today);
  }

  // Course-end checks every 5 minutes (and on the first tick after a wake-up/restart).
  if (now.getMinutes() % 5 === 0 || !processCompletedCourses.ranOnce) {
    processCompletedCourses.ranOnce = true;
    processCompletedCourses(); // not awaited — must never delay dose reminders
  }
  processProductAds(now); // once a day after 11 AM; not awaited
  processSubscriptionNotices(now); // once a day after 10 AM; not awaited
  broadcastTrialExpired(now); // one-off, only when TRIAL_EXPIRED_BROADCAST is set; not awaited

  markUnansweredDosesMissed(now); // not awaited

  console.log(`⏰ [${currentTime}] Checking for pending doses...`);

  try {
    // Was an exact match on scheduledTime === currentTime — meant any dose whose minute got
    // missed (server asleep/restarting right at that exact minute, which a deploy causes) was
    // silently never reminded for the rest of the day, since the clock only moves forward and
    // that exact minute never comes again. Now catches up on anything still pending at or before
    // now, so a missed minute gets its reminder on the very next tick instead of being lost.
    const pendingDoses = await Dose.find({
      scheduledDate: today,
      scheduledTime: { $lte: currentTime },
      status: 'pending',
      sentReminder: false
    });

    console.log(`📋 Found ${pendingDoses.length} dose(s) due at or before ${currentTime}`);

    for (const dose of pendingDoses) {
      // Atomically claim this dose before doing anything else — Render's zero-downtime deploys
      // briefly run the old and new instance side by side, and both would otherwise run this
      // same cron tick a few seconds apart, find the same pending dose, and send it twice. This
      // findOneAndUpdate is atomic at the database level: only one instance's update can match
      // sentReminder: false and flip it, so only one instance proceeds to actually send.
      const claimed = await Dose.findOneAndUpdate(
        { _id: dose._id, sentReminder: false },
        { sentReminder: true },
        { new: true }
      );
      if (!claimed) continue; // another instance already claimed and is sending this one

      const patient = await Patient.findOne({ phone: dose.patientPhone });
      if (!patient) {
        console.log(`⚠️ Patient not found for ${dose.patientPhone}`);
        continue;
      }

      // Course already over (ended between course checks) — never remind past the end date.
      const sameMeds = patient.medicines.filter(m => m.name === dose.medicineName);
      if (sameMeds.length && sameMeds.every(m => m.endDate && new Date(m.endDate) <= now)) {
        await Dose.deleteOne({ _id: dose._id });
        console.log(`🏁 Skipped reminder for ended course: ${dose.medicineName} → ${dose.patientPhone}`);
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
        console.log(`✅ Reminder sent to ${dose.patientPhone} for ${dose.medicineName} at ${currentTime} via ${sentVia}`);
      } else {
        // Both the template and free-text fallback failed (e.g. MSG91 itself down) — release
        // the claim so the next minute's tick retries it, instead of silently giving up on a
        // dose forever just because this one attempt hit a transient failure.
        await Dose.findByIdAndUpdate(dose._id, { sentReminder: false });
        console.log(`❌ Failed to send reminder to ${dose.patientPhone} — will retry next check`);
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
    let phone = '+' + rawPhone.replace(/\D/g, '');
    noteWhatsAppInbound(phone); // opens the 24h free-text window for this number

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

    // "RESET" keyword — checked first so it works mid-conversation too (see handleWhatsAppResetRequest).
    if (!buttonText && RESET_KEYWORD_RE.test(freeText)) {
      await handleWhatsAppResetRequest(phone);
      return;
    }

    // MSG91 always sends "+91XXXXXXXXXX", but older accounts were saved as "+91 XXXXXXXXXX" (and
    // reminders/conversation state use the stored format), so match any variant and then carry on
    // with the number exactly as it's stored — every update below keys off `phone`.
    const variants = phoneVariants(phone);
    const convo = await ConversationState.findOne({ patientPhone: { $in: variants } }).sort({ updatedAt: -1 });
    const patient = await Patient.findOne({ phone: { $in: variants } });
    phone = (convo && convo.patientPhone) || (patient && patient.phone) || phone;

    // Replies from a lead-campaign contact who hasn't signed up yet (START → sign-up link, STOP → opt out).
    if (!patient && await handleLeadReply(phone, buttonText, freeText)) return;

    // STOP / START for the 10-day product message. Dose reminders are unaffected.
    if (!buttonText && patient && (AD_STOP_RE.test(freeText) || AD_START_RE.test(freeText))) {
      const optOut = AD_STOP_RE.test(freeText);
      await Patient.updateOne({ _id: patient._id }, { adOptOut: optOut });
      await sendWhatsAppFree(phone, optOut
        ? '✅ Done — you won\'t get Biomexa product messages any more. Your medicine reminders carry on as normal.\n\nReply START to receive them again.'
        : '✅ You\'ll get Biomexa product updates again (about once every 10 days). Reply STOP any time to opt out.');
      return;
    }

    // IVF Care replies (IVF medicine / trigger-shot buttons, WhatsApp check-ins, and the CHECKIN /
    // PROGRESS keywords) are handled by the IVF module.
    const ivfKeyword = /^\s*(check\s*-?\s*in|checkin|progress|my progress|summary)\s*$/i.test(freeText || buttonText || '') || /^\s*hi\s+biomexa\s+ivf/i.test(freeText || '');
    if ((convo && typeof convo.state === 'string' && convo.state.startsWith('ivf_')) || ivfKeyword) {
      if (await ivfCare.handleWhatsAppReply({ phone, convo, buttonText, freeText })) return;
    }

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
        // The date moves with the time: a snooze at 11:50 PM is 12:10 AM *tomorrow*. Keeping
        // today's date made "00:10" look already-due, so it re-sent at once (the doubled
        // late-night reminders).
        await Dose.findByIdAndUpdate(convo.doseId, { scheduledTime: `${hh}:${mm}`, scheduledDate: localDateStr(snoozeTime), sentReminder: false });
        await sendWhatsAppFree(phone, `⏰ No problem — we'll remind you again in about 20 minutes.`);
        await ConversationState.findOneAndUpdate({ patientPhone: phone }, { state: null, doseId: null, updatedAt: new Date() });
        return;
      }

      if (took || explicitlyMissed) {
        await Dose.findByIdAndUpdate(convo.doseId, { status: took ? 'taken' : 'missed' });

        if (took) {
          await sendWhatsAppFree(phone, '✅ Logged as taken!\n\n📋 *Quick check-in*\n\nGot all 4? Just copy the numbers below (skip the words in brackets):\n\n```\n120/80(BP) 98.6(Temp) 72(Pulse) 110(Sugar)\n```\n\nOnly have some? Use labels instead:\n"temp 99", "sugar 110" or "BP 120/80, pulse 72"\n\nOr reply "skip".');
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

      const parsed = parseVitalsFromText(freeText);
      const { clean: vitals, rejected } = cleanVitals(parsed);
      if (rejected.length && Object.keys(vitals).length === 0) {
        await sendWhatsAppFree(phone, `Hmm, that reading looks like a typo: ${rejected.join(', ')}.\n\nPlease check and send it again, e.g. "BP 120/80, sugar 110" — or reply "skip".`);
        return;
      }
      if (Object.keys(vitals).length === 0) {
        await sendWhatsAppFree(phone, 'Sorry, I couldn\'t read any numbers from that.\n\nGot all 4? Copy the numbers below (skip the bracketed words):\n```\n120/80(BP) 98.6(Temp) 72(Pulse) 110(Sugar)\n```\n\nOnly some? Use labels:\n"temp 99", "sugar 110" or "BP 120/80"\n\nOr reply "skip".');
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
      ].filter(Boolean).join(', ') + (rejected.length ? ` (not saved — looks like a typo: ${rejected.join(', ')})` : '');

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


// ========== STAFF ACCESS (doctor or admin) ==========
// Patient health data (patient list, vitals, treatment analysis, risk alerts) used to be served
// with no login check at all — anyone with a patient's phone number could read their report.
// Access now needs one of:
//   • a real doctor account's login token (Bearer JWT, role "doctor"), or
//   • the admin username/password (Basic auth, checked against the Admin collection), or
//   • the shared demo staff login — ONLY if DEMO_DOCTOR_USER and DEMO_DOCTOR_PASSWORD are set.
//     The old hard-coded drsharma/biomexa2026 was printed on the public login page, so it gave
//     every visitor access to real patient data; it no longer works unless you choose to enable
//     a private demo login of your own.
function isDemoDoctorLogin(user, pass) {
  const u = process.env.DEMO_DOCTOR_USER, p = process.env.DEMO_DOCTOR_PASSWORD;
  return !!(u && p && user === u && pass === p);
}
async function staffAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const r = await approvedDoctorFromToken(auth.slice(7));
      if (r.error) return res.status(r.error).json({ message: r.message, code: r.code });
      req.doctor = r.decoded; return next();
    }
    if (auth.startsWith('Basic ')) {
      const [u, ...rest] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      const pw = rest.join(':');
      if (isDemoDoctorLogin(u, pw)) return next();
      const admin = await Admin.findOne({ username: u });
      if (admin && await bcrypt.compare(pw, admin.password)) { req.admin = admin; return next(); }
    }
    return res.status(401).json({ message: 'Doctor or admin login required' });
  } catch {
    return res.status(401).json({ message: 'Your session has expired — please log in again.' });
  }
}

// ========== DOCTOR ROUTES (Mock login kept for the legacy staff dashboard) ==========
app.get('/api/doctor/login', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ message: 'Basic auth required' });
  }
  const creds = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  const user = creds[0], pw = creds.slice(1).join(':');
  if (isDemoDoctorLogin(user, pw)) {
    return res.json({ message: 'Doctor authenticated' });
  }
  // The Biomexa admin can open the doctor portal with the admin username/password
  // (the same credentials staffAuth already accepts for every patient-data route).
  try {
    const admin = await Admin.findOne({ username: user });
    if (admin && await bcrypt.compare(pw, admin.password)) return res.json({ message: 'Admin authenticated' });
  } catch { /* fall through */ }
  res.status(401).json({ message: 'Invalid credentials' });
});

// ========== DOCTOR SIGNUP / LOGIN / AVAILABILITY (real accounts) ==========
// Doctor JWT + the account must be approved ("verified") by an admin. Checked on every request,
// so suspending a doctor in the admin panel cuts access immediately, not when their token expires.
const DOCTOR_STATUS_MESSAGES = {
  pending: 'Your doctor account is being reviewed by the Biomexa team. We\'ll message you on WhatsApp as soon as it\'s approved.',
  rejected: 'Your doctor account was not approved. Please contact Biomexa if you think this is a mistake.',
  suspended: 'Your doctor account has been suspended. Please contact Biomexa.'
};
async function approvedDoctorFromToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.role !== 'doctor') return { error: 403, message: 'Doctor account required' };
  const doctor = await Doctor.findById(decoded.id).select('status');
  if (!doctor) return { error: 401, message: 'Doctor account not found' };
  if (doctor.status !== 'verified') return { error: 403, code: 'not_approved', message: DOCTOR_STATUS_MESSAGES[doctor.status] || DOCTOR_STATUS_MESSAGES.pending };
  return { decoded };
}
const doctorAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    const r = await approvedDoctorFromToken(token);
    if (r.error) return res.status(r.error).json({ message: r.message, code: r.code });
    req.doctor = r.decoded;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Doctor signup — creates a real doctor account for the "Connect with a Doctor" portal
app.post('/api/doctors/register', signupLimiter, async (req, res) => {
  try {
    const { email, phone, password, specialty, licenseNumber, experienceYears, bio } = req.body;
    // Stored without a leading "Dr." — every message and page adds it, so a doctor who typed
    // "Dr. Aditi Sharma" (as the signup form's own example shows) would otherwise read "Dr. Dr. …".
    const name = String(req.body.name || '').trim().replace(/^dr\.?\s+/i, '');
    if (!name || !phone || !password || !licenseNumber) {
      return res.status(400).json({ message: 'Name, WhatsApp number, password and license number are required' });
    }
    const cleanPhone = normalizePhone(phone);
    if (!/^\+\d{11,15}$/.test(cleanPhone)) return res.status(400).json({ message: 'Please enter a valid WhatsApp number.' });
    if (String(password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    const existing = await findAccountByPhone('doctor', cleanPhone);
    if (existing) return res.status(400).json({ message: 'A doctor account already exists with this phone number' });

    // New doctors start as "pending": no access to patient data, not listed for patients, no
    // patient alerts — until an admin checks their licence and approves them (admin panel).
    const hashed = await bcrypt.hash(password, 10);
    const doctor = new Doctor({ name, email: email || undefined, phone: cleanPhone, password: hashed, specialty, licenseNumber: String(licenseNumber).trim(), experienceYears, bio, available: false, status: 'pending' });
    await doctor.save();
    console.log(`🩺 New doctor sign-up awaiting approval: Dr. ${name} (${cleanPhone}), licence ${doctor.licenseNumber}`);

    const welcomeMsg = `👨‍⚕️ *Thanks for joining Biomexa, Dr. ${name}!*\n\nWe've received your details and our team is verifying your medical licence (${doctor.licenseNumber}). This usually takes up to 24 hours.\n\nWe'll message you here as soon as your account is approved — you can then log in, see patients and receive connect requests.\n\n- Biomexa Team`;
    sendWelcomeMessage(cleanPhone, `Dr. ${name}`, welcomeMsg);

    res.json({ message: 'Your account has been created and is awaiting verification.', pending: true, doctor: { name, phone: cleanPhone, specialty: doctor.specialty } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Doctor login (real accounts)
app.post('/api/doctors/login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    const doctor = await findAccountByPhone('doctor', phone);
    if (!doctor) return res.status(400).json({ message: 'No doctor account found with this number' });

    const match = await bcrypt.compare(password, doctor.password);
    if (!match) return res.status(400).json({ message: 'Invalid password' });
    if (doctor.status !== 'verified') {
      return res.status(403).json({ code: 'not_approved', status: doctor.status, message: DOCTOR_STATUS_MESSAGES[doctor.status] || DOCTOR_STATUS_MESSAGES.pending });
    }

    const token = jwt.sign({ id: doctor._id, phone: doctor.phone, role: 'doctor' }, JWT_SECRET, { expiresIn: '7d' });
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

// Same imaging analysis feature as the patient portal, for a doctor to use directly — e.g. a
// quick AI-assisted second look at an X-ray while reviewing a patient. Optionally tagged with a
// patientPhone if the doctor wants to associate it with a specific patient's record; otherwise
// it's just saved under the doctor's own history. Uses the doctor-audience prompt (more
// clinical tone) rather than the patient one, but with the exact same safety framing — never a
// confirmed diagnosis, always recommends formal radiology review for anything significant.
app.post('/api/doctors/upload-imaging', doctorAuth, async (req, res) => {
  try {
    const rawFiles = Array.isArray(req.body.files) ? req.body.files : [];
    const files = rawFiles.filter(f => f && f.fileName && f.fileType && f.fileData);
    const patientPhone = req.body.patientPhone || null;

    if (!files.length) {
      return res.status(400).json({ message: 'At least one file (name, type, and data) is required.' });
    }
    if (files.length > MAX_FILES_PER_UPLOAD) {
      return res.status(400).json({ message: `Up to ${MAX_FILES_PER_UPLOAD} files are supported per upload.` });
    }
    if (files.some(f => f.fileType === 'application/pdf')) {
      return res.status(400).json({ message: 'X-rays and imaging should be uploaded as photos (JPG/PNG/WEBP), not PDF.' });
    }
    for (const f of files) {
      if (!ALLOWED_DOCUMENT_TYPES.includes(f.fileType)) {
        return res.status(400).json({ message: `"${f.fileName}" — only JPG, PNG, or WEBP files are supported.` });
      }
      if (f.fileData.length > MAX_DOCUMENT_BASE64_LENGTH) {
        return res.status(400).json({ message: `"${f.fileName}" is too large — please upload something under 5MB.` });
      }
    }

    const displayName = files.length > 1 ? `${files[0].fileName} (+${files.length - 1} more)` : files[0].fileName;
    // Looked up (when a patient is actually specified) so the AI can weigh known conditions/
    // current medicines for this specific patient — see buildPatientContext.
    const contextPatient = patientPhone ? await Patient.findOne({ phone: patientPhone }) : null;

    const doc = await UploadedDocument.create({
      patientPhone: patientPhone || req.doctor.phone, // falls back to the doctor's own phone so this still shows in their own history when no patient is specified
      files: files.map(f => ({ fileName: f.fileName, fileType: f.fileType, fileData: f.fileData })),
      fileName: displayName,
      fileType: files[0].fileType,
      language: 'English',
      documentType: 'imaging',
      uploadedByRole: 'doctor',
      analysisStatus: 'pending'
    });

    const result = await analyzeDocument(files, 'English', 'imaging', 'doctor', contextPatient);
    if (result.ok) {
      doc.analysis = result.analysis;
      doc.analysisStatus = 'done';
    } else if (result.reason === 'not_configured') {
      doc.analysisStatus = 'not_configured';
    } else {
      doc.analysisStatus = 'failed';
      doc.analysis = 'Analysis failed — please try re-uploading.';
    }
    await doc.save();

    res.json({
      message: result.ok ? 'Uploaded and analyzed!' : result.reason === 'not_configured' ? 'Uploaded — AI analysis isn\'t configured yet.' : 'Uploaded, but analysis failed.',
      document: { _id: doc._id, fileName: doc.fileName, analysis: doc.analysis, analysisStatus: doc.analysisStatus, uploadedAt: doc.uploadedAt }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/doctors/imaging-history', doctorAuth, async (req, res) => {
  try {
    const docs = await UploadedDocument.find({ patientPhone: req.doctor.phone, uploadedByRole: 'doctor', documentType: 'imaging' })
      .select('-files')
      .sort({ uploadedAt: -1 })
      .limit(20);
    res.json(docs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/doctors/imaging-history/:id', doctorAuth, async (req, res) => {
  try {
    const doc = await UploadedDocument.findOneAndDelete({ _id: req.params.id, patientPhone: req.doctor.phone, uploadedByRole: 'doctor' });
    if (!doc) return res.status(404).json({ message: 'Not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== DOCTOR REVIEW / CORRECTION WORKFLOW ==========
// The AI's document analysis is a helpful first pass, not a final answer — this is the safety
// net that keeps a human doctor in the loop. Any completed analysis (prescription or imaging,
// from any patient) shows up here until a doctor either confirms it's accurate or corrects it.
// A correction also gets folded into the clinical reference library so similar future documents
// benefit from the fix — see getReferenceContext.
// Adds each document's patient name (one DB lookup for the whole list) so the doctor sees
// "Rahul Sharma · +91…" instead of just a number. Matches any stored phone format.
async function attachPatientNames(docs) {
  const phones = [...new Set(docs.map(d => d.patientPhone).filter(Boolean))];
  if (!phones.length) return docs.map(d => d.toObject());
  const patients = await Patient.find({ phone: { $in: phones.flatMap(phoneVariants) } }).select('name phone');
  const nameByDigits = {};
  for (const p of patients) nameByDigits[String(p.phone).replace(/\D/g, '').slice(-10)] = p.name;
  return docs.map(d => ({ ...d.toObject(), patientName: nameByDigits[String(d.patientPhone || '').replace(/\D/g, '').slice(-10)] || null }));
}

app.get('/api/doctors/review-queue', doctorAuth, async (req, res) => {
  try {
    const docs = await UploadedDocument.find({ analysisStatus: 'done', reviewStatus: 'unreviewed' })
      .select('-files -fileData')
      .sort({ uploadedAt: -1 })
      .limit(50);
    res.json(await attachPatientNames(docs));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/doctors/reviewed-history', doctorAuth, async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.doctor.id);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found' });
    const docs = await UploadedDocument.find({ reviewedByPhone: doctor.phone })
      .select('-files -fileData')
      .sort({ reviewedAt: -1 })
      .limit(50);
    res.json(await attachPatientNames(docs));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/doctors/uploaded-reports/:id/review', doctorAuth, async (req, res) => {
  try {
    const { action, correction } = req.body;
    if (!['confirm', 'correct'].includes(action)) {
      return res.status(400).json({ message: 'action must be "confirm" or "correct".' });
    }
    if (action === 'correct' && (!correction || !correction.trim())) {
      return res.status(400).json({ message: 'A correction is required when correcting an analysis.' });
    }

    const doc = await UploadedDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Report not found.' });

    const doctor = await Doctor.findById(req.doctor.id);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found' });

    doc.reviewStatus = action === 'confirm' ? 'confirmed' : 'corrected';
    if (action === 'correct') doc.doctorCorrection = correction.trim();
    doc.reviewedBy = doctor.name;
    doc.reviewedByPhone = doctor.phone;
    doc.reviewedAt = new Date();
    await doc.save();

    // A correction is a real, doctor-verified signal — feed it into the clinical reference
    // library so future AI analyses of similar documents are steered by it.
    if (action === 'correct') {
      try {
        await ClinicalReference.create({
          title: `Doctor correction — ${doc.documentType}`,
          category: doc.documentType === 'imaging' ? 'imaging' : 'prescription',
          content: `Original AI analysis was corrected by a doctor. Corrected version: ${correction.trim()}`,
          source: 'doctor_correction',
          addedBy: doctor.name
        });
      } catch (refErr) {
        console.log('⚠️ Failed to save clinical reference from correction (non-fatal):', refErr.message);
      }
    }

    res.json({ message: action === 'confirm' ? 'Analysis confirmed.' : 'Correction saved — this will help improve future AI analyses.', document: doc });
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
    const doctors = await Doctor.find({ status: 'verified' }).select('-password -email -phone -licenseNumber -reviewNote -reviewedBy -reviewedAt').sort({ available: -1, createdAt: -1 }).limit(50);
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// "Connect me now" — fired from the home page or patient portal when a patient wants a doctor urgently.
// Notifies the doctor over WhatsApp with the patient's details and urgency level.
app.post('/api/doctors/:id/connect', auth, requirePremium('doctor'), async (req, res) => {
  try {
    // Talk to a Doctor is part of Biomexa Care: the patient must be logged in, and the name and
    // number sent to the doctor come from their account (not from whatever the page sends).
    const me = await Patient.findOne({ phone: req.user.phone });
    const patientName = me?.name || req.body.patientName;
    const patientPhone = me?.phone || req.user.phone;
    const { urgency, message } = req.body;
    const doctor = await Doctor.findOne({ _id: req.params.id, status: 'verified' });
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

app.get('/api/patients', staffAuth, async (req, res) => {
  // Risk = computeRiskScore (adherence + recent misses + latest real vitals). BP is the latest
  // real reading, else the sign-up baseline, else blank — never a made-up default.
  try {
    const patients = await Patient.find().limit(50);
    const data = [];
    for (let i = 0; i < patients.length; i++) {
      const p = patients[i];
      // Active medicine first; never a made-up product name for a patient with no medicines.
      const med = (p.medicines || []).find(m => m.active) || (p.medicines || [])[0];
      const medName = med?.name || 'None';
      const catalogEntry = MEDICINE_CATALOG[medName] || null;

      const r = await computeRiskScore(p);
      const latest = await VitalsLog.findOne({ patientPhone: { $in: phoneVariants(p.phone) } }).sort({ recordedAt: -1 });
      const lv = latest ? cleanVitals(latest).clean : {};
      const bpSys = lv.bpSystolic || p.baselineVitals?.bpSystolic || null;
      const bpDia = lv.bpDiastolic || p.baselineVitals?.bpDiastolic || null;
      const adherence = r.adherence;

      data.push({
        id: i + 1,
        name: p.name,
        phone: p.phone,
        medicine: medName,
        medicineInfo: catalogEntry,
        adherence_score: r.adherenceKnown ? Math.round(adherence * 100) : null,
        bpSystolic: bpSys,
        bpDiastolic: bpDia,
        bpStatus: !bpSys ? 'unknown' : bpSys >= 140 || bpDia >= 90 ? 'high' : bpSys < 100 ? 'low' : 'normal',
        vitalsAreReal: !!latest,
        risk_score: r.score,
        ai_risk_label: r.label,
        risk_reasons: r.reasons,
        ai_prediction: r.missChance,
        missed_doses: r.missed,
        next_dose: await nextPendingDose(p),
        sentiment: !r.adherenceKnown ? 'neutral' : adherence > 0.8 ? 'positive' : adherence < 0.5 ? 'negative' : 'neutral'
      });
    }
    data.sort((a, b) => b.risk_score - a.risk_score).forEach((d, i) => { d.id = i + 1; });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 7-day adherence + BP trend for one patient — powers the "View Trends" panel in the doctor dashboard
app.get('/api/doctor/patient/:phone/vitals', staffAuth, async (req, res) => {
  try {
    const patient = await findAccountByPhone('patient', req.params.phone);
    const phone = patient?.phone;
    if (!patient) return res.status(404).json({ message: 'Patient not found' });

    const allVitals = await VitalsLog.find({ patientPhone: { $in: phoneVariants(phone) } }).sort({ recordedAt: 1 });

    const today = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = localDateStr(d);

      const dayDoses = await Dose.find({ patientPhone: { $in: phoneVariants(phone) }, scheduledDate: dateStr });
      const taken = dayDoses.filter(x => x.status === 'taken').length;
      // Only doses whose outcome is known count — a dose later today (still pending) isn't a miss.
      const decided = dayDoses.filter(x => x.status !== 'pending').length;
      const adherence = decided ? Math.round((taken / decided) * 100) : null;

      // Real vitals logged that day (last one wins if several) — falls back to the baseline
      // snapshot only when nothing was actually logged that day, and marks which is which.
      // Only real, plausible readings — a day with nothing logged shows as a gap, not a copy
      // of the patient's latest reading.
      const dayVitals = allVitals.filter(v => localDateStr(v.recordedAt) === dateStr);
      const merged = dayVitals.reduce((acc, v) => Object.assign(acc, cleanVitals(v).clean), {});
      const latest = Object.keys(merged).length ? merged : null;

      days.push({
        date: dateStr,
        label: d.toLocaleDateString('en-IN', { weekday: 'short' }),
        adherence,
        bpSystolic: latest?.bpSystolic ?? null,
        bpDiastolic: latest?.bpDiastolic ?? null,
        temperature: latest?.temperature ?? null,
        heartRate: latest?.heartRate ?? null,
        glucose: latest?.glucose ?? null,
        hasRealVitals: !!(latest && Object.keys(latest).length)
      });
    }
    res.json({ patient: { name: patient.name, phone: patient.phone, baselineVitals: patient.baselineVitals }, days });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Full-course charts + end-of-treatment analysis for one patient (same builder as the portal).
app.get('/api/doctor/patient/:phone/vitals-progress', staffAuth, async (req, res) => {
  try {
    const patient = await findAccountByPhone('patient', req.params.phone);
    if (!patient) return res.status(404).json({ message: 'Patient not found' });
    res.json(await loadVitalsProgress(patient.toObject ? patient.toObject() : patient));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Full effectiveness analysis via the Python AI engine (ai_engine.py) — real vital-trend
// analysis, adherence scoring, clinical insights and treatment recommendations, computed from
// this patient's actual dose history and real WhatsApp-logged vitals (VitalsLog) where available,
// falling back to their baseline snapshot for any day without a logged reading.
app.get('/api/doctor/patient/:phone/effectiveness', staffAuth, async (req, res) => {
  try {
    const patient = await findAccountByPhone('patient', req.params.phone);
    if (!patient) return res.status(404).json({ message: 'Patient not found' });
    const phones = phoneVariants(patient.phone);

    const doses = await Dose.find({ patientPhone: { $in: phones } }).sort({ scheduledDate: 1 });
    if (!doses.length) {
      return res.status(400).json({ message: 'No dose history yet for this patient — nothing to analyze.' });
    }
    const vitalsLogs = await VitalsLog.find({ patientPhone: { $in: phones } }).sort({ recordedAt: 1 });
    // Same builder as the patient's own report, so doctor and patient always see the same numbers.
    const { payload, relevant, usedRealVitals } = buildAnalysisInput(patient, doses, vitalsLogs);
    if (!relevant.length) {
      return res.status(400).json({ message: 'All doses for this patient are still pending — nothing to analyze yet.' });
    }

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

// Recent risk alerts — powers the alert banner on the doctor dashboard and admin panel. Any
// logged-in doctor or admin sees all active alerts (staffAuth), regardless of which patients are
// "theirs" — but never the public.
app.get('/api/doctor/alerts', staffAuth, async (req, res) => {
  try {
    const alerts = await RiskAlert.find({ acknowledged: false }).sort({ createdAt: -1 }).limit(50);
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/doctor/alerts/:id/acknowledge', staffAuth, async (req, res) => {
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
    const alert = await RiskAlert.findOne({ patientPhone: { $in: phoneVariants(req.user.phone) }, acknowledged: false }).sort({ createdAt: -1 });
    res.json(alert || null);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/export/patients', staffAuth, async (req, res) => {
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
  const doses = await Dose.find({ patientPhone: { $in: phoneVariants(patient.phone) } });
  const total = doses.length;
  const missed = doses.filter(d => d.status === 'missed').length;
  const taken = doses.filter(d => d.status === 'taken').length;
  // Only doses that are due count — pending ones (later today, not yet reminded) aren't "missed".
  const due = doses.filter(d => d.status !== 'pending').length;
  const adherence = due ? taken / due : 1;
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

// ========== CALIBRATED RISK SCORE (admin table, doctor dashboard, stats, risk broadcast) ==========
// Replaces the trained logistic model for scoring. That model never saw adherence or vitals —
// only regimen size, missed count, days since sign-up and dose frequency — and it was fitted on
// ~10 patients. "Days since sign-up" only grows, so every patient drifted outside the training
// range and scored ~100% "Critical", including patients with 100% adherence and no misses.
//
// The score (0–1) is built from what actually drives risk, and every point is explainable:
//   • Adherence: 60% overall non-adherence + 40% last-7-days miss rate, scaled by confidence
//     (a patient with 2 logged doses can't be "Critical" on adherence alone; full weight at 7+).
//   • Latest real vitals in the last 14 days: elevated → 0.45, dangerous → 0.9.
//   • Combined: the higher of the two, plus a small bump when both are raised.
// Labels: Critical ≥ 0.6, High ≥ 0.2 (≈ below 80% adherence, the usual cut-off), Low below;
// "No data" when nothing is logged yet.
const RISK_VITAL_RULES = [
  // [test, severity, reason]
  [v => v.bpSystolic >= 180 || v.bpDiastolic >= 120, 0.9, v => `BP ${v.bpSystolic}/${v.bpDiastolic} (crisis range)`],
  [v => v.glucose >= 300 || (v.glucose && v.glucose < 54), 0.9, v => `Sugar ${v.glucose} mg/dL (dangerous)`],
  [v => v.temperature >= 103, 0.9, v => `Fever ${v.temperature}°F`],
  [v => v.heartRate > 130 || (v.heartRate && v.heartRate < 40), 0.9, v => `Pulse ${v.heartRate}`],
  [v => v.bpSystolic >= 140 || v.bpDiastolic >= 90, 0.45, v => `BP ${v.bpSystolic}/${v.bpDiastolic} (high)`],
  [v => v.glucose >= 180 || (v.glucose && v.glucose < 70), 0.45, v => `Sugar ${v.glucose} mg/dL`],
  [v => v.temperature >= 100.4, 0.45, v => `Temp ${v.temperature}°F`],
  [v => v.heartRate > 110 || (v.heartRate && v.heartRate < 50), 0.45, v => `Pulse ${v.heartRate}`]
];

async function computeRiskScore(patient) {
  const phones = phoneVariants(patient.phone);
  const doses = await Dose.find({ patientPhone: { $in: phones } });
  const due = doses.filter(d => d.status !== 'pending');
  const taken = due.filter(d => d.status === 'taken').length;
  const missed = due.filter(d => d.status === 'missed').length;
  const adherence = due.length ? taken / due.length : null;

  // Last 7 calendar days including today (6 days back) — 7 days back made it an 8-day window.
  const weekAgo = localDateStr(new Date(Date.now() - 6 * 86400000));
  const recent = due.filter(d => d.scheduledDate >= weekAgo);
  const recentMissed = recent.filter(d => d.status !== 'taken').length;
  const recentMissRate = recent.length ? recentMissed / recent.length : (adherence !== null ? 1 - adherence : 0);

  const reasons = [];
  let adhScore = 0;
  if (adherence !== null) {
    const confidence = Math.min(1, due.length / 7);
    adhScore = confidence * (0.6 * (1 - adherence) + 0.4 * recentMissRate);
    if (adherence < 0.8) reasons.push(`Adherence ${Math.round(adherence * 100)}% (${missed} missed)`);
    if (recent.length && recentMissed) reasons.push(`${recentMissed} of ${recent.length} doses missed this week`);
    if (due.length < 7) reasons.push(`Only ${due.length} dose${due.length === 1 ? '' : 's'} logged so far`);
  }

  // Latest real (plausible) reading in the last 14 days — typos are ignored, same as reports.
  const latestLog = await VitalsLog.findOne({ patientPhone: { $in: phones }, recordedAt: { $gte: new Date(Date.now() - 14 * 86400000) } }).sort({ recordedAt: -1 });
  const vitals = latestLog ? cleanVitals(latestLog).clean : {};
  let vitalScore = 0;
  for (const [test, sev, why] of RISK_VITAL_RULES) {
    if (test(vitals) && sev > vitalScore) { vitalScore = sev; reasons.unshift(why(vitals)); }
  }

  const hasData = adherence !== null || !!latestLog;
  const score = Math.min(1, Math.max(adhScore, vitalScore) + 0.15 * Math.min(adhScore, vitalScore));
  const label = !hasData ? 'No data' : score >= 0.6 ? 'Critical' : score >= 0.2 ? 'High' : 'Low';
  // Chance the next dose is missed: last-7-days miss rate with a light prior (Laplace), so
  // 0 misses out of 3 reads as ~20%, not a confident 0%.
  const missChance = recent.length ? (recentMissed + 1) / (recent.length + 2) : (due.length ? (missed + 1) / (due.length + 2) : null);

  return {
    score: Math.round(score * 100) / 100, label, reasons, hasData,
    adherence: adherence ?? 1, adherenceKnown: adherence !== null, missed, total: doses.length, due: due.length,
    missChance, vitals, hasRealVitals: !!latestLog
  };
}

async function nextPendingDose(patient) {
  const now = new Date();
  const today = localDateStr(now);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const d = await Dose.findOne({
    patientPhone: { $in: phoneVariants(patient.phone) }, status: 'pending',
    $or: [{ scheduledDate: { $gt: today } }, { scheduledDate: today, scheduledTime: { $gte: hhmm } }]
  }).sort({ scheduledDate: 1, scheduledTime: 1 });
  if (d) return new Date(`${d.scheduledDate}T${d.scheduledTime}:00+05:30`);
  // Today's doses are created each midnight — fall back to the earliest active reminder time tomorrow.
  const times = (patient.medicines || []).filter(m => m.active && m.time).map(m => m.time).sort();
  if (!times.length) return null;
  const later = times.find(t => t >= hhmm);
  const date = later ? today : localDateStr(new Date(now.getTime() + 86400000));
  return new Date(`${date}T${later || times[0]}:00+05:30`);
}

function activeMedicineNames(patient) {
  const names = [...new Set((patient.medicines || []).filter(m => m.active).map(m => m.name))];
  return names.length ? names.join(', ') : 'None active';
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

// ========== CLINICAL REFERENCE LIBRARY ==========
// Lets an admin (or a doctor's correction, automatically) add curated clinical notes that get
// injected as extra context into future AI document analyses — see getReferenceContext above.
// This is NOT literal model retraining (there's no way to retrain Gemini/Claude from a web app);
// it's retrieval-augmented context that steers future prompts toward what's actually been
// verified correct for this platform's patient population.
app.post('/api/admin/clinical-data', adminAuth, async (req, res) => {
  try {
    const { title, category, content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ message: 'content is required.' });
    const validCategories = ['prescription', 'imaging', 'lab_reference', 'general'];
    const cat = validCategories.includes(category) ? category : 'general';

    const entry = await ClinicalReference.create({
      title: title?.trim() || '',
      category: cat,
      content: content.trim(),
      source: 'admin',
      addedBy: req.admin?.email || req.admin?.username || 'admin'
    });
    res.json({ message: 'Clinical reference added — future AI analyses will take this into account.', entry });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/clinical-data', adminAuth, async (req, res) => {
  try {
    const entries = await ClinicalReference.find().sort({ createdAt: -1 }).limit(200).select('-imageFileData');
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Upload a REFERENCE image (e.g. a labeled example X-ray) so the AI can extract a plain-language
// description of it and add that to the clinical reference library — see analyzeReferenceImage
// above for what this does and doesn't do (retrieval context, not model retraining). Sent as
// base64 JSON, same pattern as patient document uploads (no multipart handling needed).
app.post('/api/admin/clinical-data/image', adminAuth, async (req, res) => {
  try {
    const { title, category, note, fileName, fileType, fileData } = req.body;
    if (!fileData || !fileType) {
      return res.status(400).json({ message: 'An image file is required.' });
    }
    if (fileData.length > MAX_DOCUMENT_BASE64_LENGTH) {
      return res.status(400).json({ message: 'Image is too large — please upload a file under ~5MB.' });
    }
    const validCategories = ['prescription', 'imaging', 'lab_reference', 'general'];
    const cat = validCategories.includes(category) ? category : 'imaging';

    const result = await analyzeReferenceImage(fileType, fileData, note);
    if (!result.ok) {
      return res.status(result.reason === 'not_configured' ? 503 : 502).json({
        message: result.reason === 'not_configured'
          ? 'Image analysis isn\'t configured yet — set GEMINI_API_KEY or ANTHROPIC_API_KEY on the server.'
          : 'Could not analyze this image right now — please try again in a moment.'
      });
    }

    const content = `${note ? note.trim() + '\n\n' : ''}AI-extracted teaching points: ${result.analysis.trim()}`;
    const entry = await ClinicalReference.create({
      title: title?.trim() || fileName || 'Reference image',
      category: cat,
      content,
      source: 'admin_image',
      addedBy: req.admin?.email || req.admin?.username || 'admin',
      hasImage: true,
      imageFileName: fileName || '',
      imageFileType: fileType,
      imageFileData: fileData
    });

    const entryObj = entry.toObject();
    delete entryObj.imageFileData;
    res.json({ message: 'Reference image analyzed and added to the clinical library — future imaging analyses will take this into account.', entry: entryObj });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Fetches a reference entry's original uploaded image, for admin review — deliberately separate
// from the list endpoint above so the (potentially large) base64 blob is only ever sent when
// actually needed.
app.get('/api/admin/clinical-data/:id/image', adminAuth, async (req, res) => {
  try {
    const entry = await ClinicalReference.findById(req.params.id).select('imageFileType imageFileData hasImage');
    if (!entry || !entry.hasImage) return res.status(404).json({ message: 'No image on this entry.' });
    res.json({ fileType: entry.imageFileType, fileData: entry.imageFileData });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/admin/clinical-data/:id', adminAuth, async (req, res) => {
  try {
    const entry = await ClinicalReference.findByIdAndDelete(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Not found.' });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Read-only views so patients and doctors can see what clinical context is guiding the AI —
// transparency into what's shaping their analyses, per the request to let all three portals
// fetch this data.
app.get('/api/patient/clinical-data', auth, async (req, res) => {
  try {
    const entries = await ClinicalReference.find().sort({ createdAt: -1 }).limit(100).select('-addedBy -imageFileData');
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/doctors/clinical-data', doctorAuth, async (req, res) => {
  try {
    const entries = await ClinicalReference.find().sort({ createdAt: -1 }).limit(100).select('-imageFileData');
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin's patient view — risk scores come from the trained model when one exists,
// and fall back to a deterministic adherence-based heuristic (never random) otherwise.
// ========== ADMIN: DOCTOR APPROVALS ==========
// New doctors can't see patients, appear in "Talk to a doctor" or receive patient alerts until
// approved here. Suspending cuts access immediately (checked on every request).
app.get('/api/admin/doctors', adminAuth, async (req, res) => {
  try {
    const doctors = await Doctor.find().select('-password').sort({ createdAt: -1 }).limit(200);
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/admin/doctors/:id/:action', adminAuth, async (req, res) => {
  try {
    const { id, action } = req.params;
    const next = { approve: 'verified', reject: 'rejected', suspend: 'suspended' }[action];
    if (!next) return res.status(400).json({ message: 'Unknown action.' });
    const note = String(req.body?.note || '').trim().slice(0, 300);
    if ((action === 'reject' || action === 'suspend') && !note) return res.status(400).json({ message: 'Please add a short reason — it is sent to the doctor.' });

    const update = { status: next, reviewedAt: new Date(), reviewedBy: req.admin?.username || 'admin', reviewNote: note || undefined };
    if (next !== 'verified') update.available = false;
    const doctor = await Doctor.findByIdAndUpdate(id, update, { new: true }).select('-password');
    if (!doctor) return res.status(404).json({ message: 'Doctor not found.' });

    const loginUrl = `${SITE_URL}/doctor.html`;
    const dn = String(doctor.name || '').replace(/^dr\.?\s+/i, ''); // older accounts may include "Dr."
    const msg = next === 'verified'
      ? `✅ *Your Biomexa doctor account is approved, Dr. ${dn}!*\n\nYou can now log in, see patient adherence and reports, and receive patient connect requests:\n${loginUrl}\n\nTurn on *Available* in your dashboard when you're ready to take patient requests.\n\n- Biomexa Team`
      : next === 'rejected'
        ? `Dr. ${dn}, we couldn't approve your Biomexa doctor account.\n\nReason: ${note}\n\nIf you think this is a mistake, please reply to this message with your details.\n\n- Biomexa Team`
        : `Dr. ${dn}, your Biomexa doctor account has been suspended.\n\nReason: ${note}\n\nPlease reply to this message if you have questions.\n\n- Biomexa Team`;
    const wa = await sendWhatsAppFree(doctor.phone, msg);
    console.log(`🩺 Doctor ${doctor.phone} -> ${next} by ${update.reviewedBy}${note ? ` (${note})` : ''}`);
    res.json({ message: `Dr. ${dn} is now ${next === 'verified' ? 'approved' : next}.`, doctor, whatsappSent: !!wa?.success });
  } catch (err) {
    res.status(500).json({ message: err.name === 'CastError' ? 'Doctor not found.' : err.message });
  }
});

app.get('/api/admin/patients', adminAuth, async (req, res) => {
  try {
    const patients = await Patient.find().limit(200);
    const data = [];
    for (let i = 0; i < patients.length; i++) {
      const p = patients[i];
      const r = await computeRiskScore(p);
      data.push({
        id: i + 1,
        name: p.name,
        phone: p.phone,
        medicine: activeMedicineNames(p),
        adherence_score: r.adherenceKnown ? Math.round(r.adherence * 100) : null,
        bpSystolic: r.vitals.bpSystolic ?? null,
        bpDiastolic: r.vitals.bpDiastolic ?? null,
        vitalsAreReal: r.hasRealVitals,
        risk_score: r.score,
        ai_risk_label: r.label,
        risk_reasons: r.reasons,
        ai_prediction: r.missChance,
        missed_doses: r.missed,
        doses_logged: r.due,
        sentiment: !r.adherenceKnown ? 'neutral' : (r.adherence > 0.8 ? 'positive' : r.adherence < 0.5 ? 'negative' : 'neutral')
      });
    }
    // Highest risk first, so the patients who need attention are at the top.
    data.sort((a, b) => b.risk_score - a.risk_score).forEach((d, i) => { d.id = i + 1; });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== SUBSCRIPTION ROUTES (subscribe.html) ==========
app.get('/api/subscription/plans', (req, res) => {
  res.json({
    plans: Object.values(SUBSCRIPTION_PLANS), trialDays: TRIAL_DAYS, freeMedicineLimit: FREE_MEDICINE_LIMIT, enforced: SUBSCRIPTION_ENFORCED,
    paymentsEnabled: PAYMENTS_CONFIGURED
  });
});

app.get('/api/patient/subscription', auth, async (req, res) => {
  try {
    const records = await Patient.find({ phone: { $in: phoneVariants(req.user.phone) } });
    if (!records.length) return res.status(404).json({ message: 'Patient not found.' });
    const payments = await Payment.find({ patientPhone: { $in: phoneVariants(req.user.phone) }, status: 'paid' })
      .sort({ paidAt: -1 }).limit(10).select('plan amount paidAt periodStart periodEnd paymentId');
    res.json({ ...accessFor(records), paymentsEnabled: PAYMENTS_CONFIGURED, payments });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

function razorpayAuthHeader() {
  return 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
}
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Step 1 — create a Razorpay order for the chosen plan; the page opens Razorpay Checkout with it.
app.post('/api/patient/subscription/order', auth, async (req, res) => {
  try {
    if (!PAYMENTS_CONFIGURED) return res.status(503).json({ message: 'Online payment is not switched on yet — please try again soon.' });
    const plan = SUBSCRIPTION_PLANS[req.body?.plan];
    if (!plan) return res.status(400).json({ message: 'Please choose a plan.' });
    const patient = (await Patient.findOne({ phone: req.user.phone })) || (await findAccountByPhone('patient', req.user.phone));
    if (!patient) return res.status(404).json({ message: 'Patient not found.' });

    const receipt = `bx_${Date.now()}_${last10(patient.phone)}`.slice(0, 40);
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: razorpayAuthHeader() },
      body: JSON.stringify({ amount: plan.price * 100, currency: 'INR', receipt, notes: { plan: plan.id, phone: patient.phone, product: 'Biomexa Care' } }),
      signal: AbortSignal.timeout(15000)
    });
    const order = await r.json();
    if (!r.ok || !order.id) {
      console.log('⚠️ Razorpay order failed:', JSON.stringify(order).slice(0, 300));
      return res.status(502).json({ message: 'Could not start the payment. Please try again in a minute.' });
    }
    await Payment.create({ patientPhone: patient.phone, patientName: patient.name, plan: plan.id, amount: order.amount, currency: order.currency, orderId: order.id });
    res.json({
      keyId: RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency,
      plan, prefill: { name: patient.name || '', contact: patient.phone.replace(/\D/g, '').slice(-10), email: patient.email || '' }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Marks a payment paid and extends the plan. Idempotent — the browser callback and the Razorpay
// webhook can both arrive for the same payment; only the first one extends the subscription.
async function activateSubscription(orderId, paymentId) {
  const pay = await Payment.findOneAndUpdate(
    { orderId, status: { $ne: 'paid' } },
    { status: 'paid', paymentId, paidAt: new Date() },
    { new: true }
  );
  if (!pay) return { already: true, payment: await Payment.findOne({ orderId }) };
  const plan = SUBSCRIPTION_PLANS[pay.plan];
  const records = await Patient.find({ phone: { $in: phoneVariants(pay.patientPhone) } });
  const access = accessFor(records);
  const now = new Date();
  // Time still left on a current plan is kept; the new period is added after it.
  const start = access.expiresAt && access.expiresAt > now ? access.expiresAt : now;
  const end = new Date(start.getTime() + plan.days * 86400000);
  await Patient.updateMany({ _id: { $in: records.map(r => r._id) } }, {
    $set: { 'subscription.plan': plan.id, 'subscription.expiresAt': end, 'subscription.startedAt': access.tier === 'subscribed' ? (records[0].subscription?.startedAt || now) : now }
  });
  pay.periodStart = start; pay.periodEnd = end; await pay.save();
  const first = String(pay.patientName || '').trim().split(/\s+/)[0] || 'there';
  const endTxt = end.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  sendWhatsAppFree(pay.patientPhone,
    `✅ *Payment received — welcome to Biomexa Care!*\n\nHi ${first}, your ${plan.name} plan (₹${plan.price}) is active until *${endTxt}*.\n\nUnlocked for you:\n• Talk to a Doctor\n• Treatment reports on WhatsApp\n• AI prescription & lab report analysis\n• Reminders for all your medicines\n\nPayment ID: ${paymentId}\n\n- Biomexa Team`).catch(() => {});
  console.log(`💳 Subscription paid: ${pay.patientPhone} — ${plan.id} ₹${plan.price}, until ${end.toISOString().slice(0, 10)} (${paymentId})`);
  return { payment: pay, expiresAt: end, plan };
}

// Step 2 — the page sends Razorpay's response; the signature proves it really came from Razorpay.
app.post('/api/patient/subscription/verify', auth, async (req, res) => {
  try {
    if (!PAYMENTS_CONFIGURED) return res.status(503).json({ message: 'Payments are not configured.' });
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (!orderId || !paymentId || !signature) return res.status(400).json({ message: 'Payment details missing.' });
    const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    if (!safeEqualHex(expected, signature)) {
      await Payment.updateOne({ orderId, status: 'created' }, { status: 'failed', paymentId });
      console.log(`⚠️ Razorpay signature mismatch for ${orderId}`);
      return res.status(400).json({ message: 'Payment could not be verified. If money was deducted, it will be refunded by Razorpay — or contact Biomexa.' });
    }
    const own = await Payment.findOne({ orderId, patientPhone: { $in: phoneVariants(req.user.phone) } });
    if (!own) return res.status(404).json({ message: 'Order not found for this account.' });
    const result = await activateSubscription(orderId, paymentId);
    const access = await accessForPhone(req.user.phone);
    res.json({ message: `Payment successful — Biomexa Care is active until ${new Date(access.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.`, access, already: !!result.already });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Backup path: Razorpay → server webhook (payment.captured / order.paid), so a patient whose
// browser closed mid-payment still gets their plan. Set the webhook in Razorpay Dashboard →
// Settings → Webhooks to <API>/api/razorpay/webhook with RAZORPAY_WEBHOOK_SECRET.
app.post('/api/razorpay/webhook', async (req, res) => {
  try {
    if (!RAZORPAY_WEBHOOK_SECRET || !req.rawBody) return res.status(400).json({ message: 'Webhook not configured' });
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
    if (!safeEqualHex(expected, req.headers['x-razorpay-signature'])) return res.status(400).json({ message: 'Bad signature' });
    const ev = req.body?.event;
    const payEnt = req.body?.payload?.payment?.entity;
    if ((ev === 'payment.captured' || ev === 'order.paid') && payEnt?.order_id) {
      const known = await Payment.findOne({ orderId: payEnt.order_id });
      if (known) await activateSubscription(payEnt.order_id, payEnt.id);
    } else if (ev === 'payment.failed' && payEnt?.order_id) {
      await Payment.updateOne({ orderId: payEnt.order_id, status: 'created' }, { status: 'failed', paymentId: payEnt.id });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Razorpay webhook error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/subscriptions', adminAuth, async (req, res) => {
  try {
    const patients = await Patient.find().select('name phone createdAt subscription').lean();
    const people = new Map();
    for (const p of patients) {
      const k = last10(p.phone) || String(p._id);
      (people.get(k) || people.set(k, []).get(k)).push(p);
    }
    const rows = [...people.values()].map(list => {
      const a = accessFor(list);
      const main = list.find(x => !/\s/.test(x.phone)) || list[0];
      return { name: main.name, phone: main.phone, tier: a.tier, planName: a.planName, expiresAt: a.expiresAt, trialEndsAt: a.trialEndsAt, daysLeft: a.daysLeft };
    });
    const payments = await Payment.find({ status: 'paid' }).sort({ paidAt: -1 }).limit(100).lean();
    // Total of ALL paid payments (the list above is only the latest 100). Amounts are in paise.
    const [sum] = await Payment.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    const revenue = (sum?.total || 0) / 100;
    const counts = { subscribed: 0, trial: 0, free: 0 };
    rows.forEach(r => counts[r.tier]++);
    res.json({ counts, revenue, paymentsEnabled: PAYMENTS_CONFIGURED, enforced: SUBSCRIPTION_ENFORCED, reminderEveryDays: SUB_REMINDER_EVERY_DAYS, patients: rows, payments });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Daily WhatsApp notices (10 AM–8 PM, once a day):
//   • Trial: nothing during the 25 free days. From day 26 (the day after day 25, counted from
//     the patient's own sign-up), if they haven't subscribed: "your free trial has ended —
//     subscribe or these services will stop", then again every SUB_REMINDER_EVERY_DAYS days,
//     at most SUB_REMINDER_MAX times. Stops as soon as they subscribe.
//   • Paid plan: 3 days before it ends and on the last day; after it lapses, the same day-after
//     reminders as the trial.
// Each notice is sent once (lastSubNoticeKey). If the server was asleep on a reminder day, the
// latest due reminder goes out on the next day it runs instead of waiting for the next slot.
// Every notice also tells the patient where their treatment stands (medicines + adherence).
let lastSubNoticeRun = null;
async function treatmentSummaryFor(twins) {
  const meds = twins.flatMap(x => (x.medicines || []).filter(m => m.active !== false).map(m => m.name)).filter(Boolean);
  const uniq = [...new Set(meds)];
  const since = localDateStr(new Date(Date.now() - 30 * 86400000));
  const phones = twins.map(x => x.phone);
  const [taken, missed] = await Promise.all([
    Dose.countDocuments({ patientPhone: { $in: phones }, scheduledDate: { $gte: since }, status: 'taken' }),
    Dose.countDocuments({ patientPhone: { $in: phones }, scheduledDate: { $gte: since }, status: 'missed' })
  ]);
  const medPart = uniq.length ? `${uniq.length} active medicine${uniq.length > 1 ? 's' : ''} (${uniq.slice(0, 3).join(', ')}${uniq.length > 3 ? '…' : ''})` : 'no active medicines on reminders';
  const adhPart = taken + missed ? `, ${Math.round(100 * taken / (taken + missed))}% of doses taken in the last 30 days` : '';
  return medPart + adhPart;
}
// Template outside the 24-hour window (Meta drops free text there); free text inside it.
async function sendSubscriptionNotice(phone, first, statusLine, treatment, fullText) {
  if (await whatsappWindowOpen(phone)) return sendWhatsAppFree(phone, fullText);
  const t = await sendRenewalTemplate(phone, first, statusLine, treatment);
  if (t.success) return t;
  if (!MSG91_RENEWAL_TEMPLATE_NAME) console.log(`⚠️ Subscription notice to ${phone} is outside the 24h window and MSG91_RENEWAL_TEMPLATE_NAME is not set — Meta will probably drop this free-text message`);
  return sendWhatsAppFree(phone, fullText);
}
function dayDiff(fromDateStr, toDateStr) {
  return Math.round((new Date(toDateStr + 'T00:00:00Z') - new Date(fromDateStr + 'T00:00:00Z')) / 86400000);
}
// One-off "your free trial has ended" message to every patient whose trial is over and who has
// no active plan. Runs only while TRIAL_EXPIRED_BROADCAST is set on Render (its value is the
// broadcast's name, e.g. "trial-ended-2026-11-04"), 10 AM–8 PM, once per patient per name
// (broadcastKeys), so restarts never send it twice. Uses the approved renewal template outside
// the 24-hour window. Also counts as that day's trial-ended reminder, so it isn't doubled.
let broadcastRunning = false, broadcastDone = null;
async function broadcastTrialExpired(now = new Date()) {
  const tag = (process.env.TRIAL_EXPIRED_BROADCAST || '').trim();
  if (!tag || broadcastRunning || broadcastDone === tag || now.getHours() < 10 || now.getHours() >= 20) return;
  broadcastRunning = true;
  try {
    const patients = await Patient.find().select('name phone createdAt subscription lastSubNoticeKey medicines broadcastKeys');
    const seen = new Set(); let sent = 0, skipped = 0, failed = 0;
    for (const p of patients) {
      const k = last10(p.phone);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const twins = patients.filter(x => last10(x.phone) === k);
      if (twins.some(x => (x.broadcastKeys || []).includes(tag))) continue;
      const a = accessFor(twins);
      if (a.tier !== 'free' || a.lastExpiredAt) { skipped++; continue; }   // still in trial, subscribed, or a lapsed paid plan
      const first = String(p.name || '').trim().split(/\s+/)[0] || 'there';
      const endedOn = new Date(a.trialEndsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      const status = `your ${TRIAL_DAYS}-day free trial ended on ${endedOn}. Please subscribe to keep these services.`;
      const treatment = await treatmentSummaryFor(twins);
      const msg = `Hi ${first}, your *${TRIAL_DAYS}-day free trial* of Biomexa Care ended on ${endedOn}.\n\n💊 Your treatment: ${treatment}.\n\nTo keep using Talk to a Doctor, treatment reports, AI prescription & lab report analysis and reminders for all your medicines, please subscribe — otherwise these services will stop.\n\nPlans from ₹99/month (₹899/year):\n${SITE_URL}/subscribe.html\n\n- Biomexa Team`;
      const target = twins.find(x => !/\s/.test(x.phone)) || p;
      const r = await sendSubscriptionNotice(target.phone, first, status, treatment, msg);
      if (r?.success) {
        sent++;
        // Mark it, and count it as today's scheduled trial-ended reminder so that isn't sent too.
        const endedKey = localDateStr(a.trialEndsAt);
        const n = Math.floor(dayDiff(endedKey, localDateStr(now)) / SUB_REMINDER_EVERY_DAYS);
        await Patient.updateMany({ _id: { $in: twins.map(x => x._id) } }, { $addToSet: { broadcastKeys: tag }, lastSubNoticeKey: `trial-ended-${endedKey}-${Math.max(0, n)}` });
        console.log(`📣 Trial-ended broadcast (${tag}) → …${k.slice(-4)}`);
      } else failed++;
      await new Promise(r2 => setTimeout(r2, 300));
    }
    broadcastDone = tag;
    console.log(`📣 Trial-ended broadcast "${tag}" done: ${sent} sent, ${failed} failed, ${skipped} skipped (still in trial or subscribed)`);
  } catch (err) {
    console.error('❌ Trial-ended broadcast error:', err.message);
  } finally { broadcastRunning = false; }
}

async function processSubscriptionNotices(now = new Date()) {
  const today = localDateStr(now);
  if (lastSubNoticeRun === today || now.getHours() < 10 || now.getHours() >= 20) return;
  lastSubNoticeRun = today;
  try {
    const patients = await Patient.find().select('name phone createdAt subscription lastSubNoticeKey medicines');
    const seen = new Set();
    let sent = 0;
    for (const p of patients) {
      const k = last10(p.phone);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const twins = patients.filter(x => last10(x.phone) === k);
      const a = accessFor(twins);
      let key = null, status = null, kind = null;
      const first = String(p.name || '').trim().split(/\s+/)[0] || 'there';
      const link = `${SITE_URL}/subscribe.html`;

      if (a.tier === 'subscribed') {
        const left = dayDiff(today, localDateStr(a.expiresAt));
        // 3-day heads-up (sent on day 3, 2 or 1 if a day was missed) and a last-day notice.
        const slot = left === 0 ? 0 : (left >= 1 && left <= 3 ? 3 : null);
        if (slot !== null) {
          key = `plan-${slot}d-${localDateStr(a.expiresAt)}`;
          kind = 'plan-ending';
          status = `your Biomexa Care plan ends ${left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`}.`;
        }
      } else {
        // Trial (or a lapsed plan) is over: day 26 onwards. n = the latest reminder that is due.
        const endedOn = localDateStr(a.lastExpiredAt || a.trialEndsAt);   // = day 26 for a trial
        const after = dayDiff(endedOn, today);                             // 0 on day 26
        const n = Math.floor(after / SUB_REMINDER_EVERY_DAYS);
        if (after >= 0 && n < SUB_REMINDER_MAX) {
          kind = a.lastExpiredAt ? 'plan' : 'trial';
          key = `${kind}-ended-${endedOn}-${n}`;
          status = kind === 'trial'
            ? `your ${TRIAL_DAYS}-day free trial of Biomexa Care has ended. Please subscribe to keep these services.`
            : 'your Biomexa Care plan has ended. Please renew to keep these services.';
        }
      }
      if (!key || twins.some(x => x.lastSubNoticeKey === key)) continue;
      const target = twins.find(x => !/\s/.test(x.phone)) || p;
      const treatment = await treatmentSummaryFor(twins);
      const msg = kind === 'plan-ending'
        ? `⏳ Hi ${first}, ${status}\n\n💊 Your treatment: ${treatment}.\n\nRenew to keep Talk to a Doctor, treatment reports, AI report analysis and reminders for all your medicines — from ₹99/month (₹899/year):\n${link}\n\n- Biomexa Team`
        : `Hi ${first}, ${kind === 'trial' ? `your *${TRIAL_DAYS}-day free trial* of Biomexa Care has ended` : 'your *Biomexa Care plan* has ended'}.\n\n💊 Your treatment: ${treatment}.\n\nTo keep using Talk to a Doctor, treatment reports, AI prescription & lab report analysis and reminders for all your medicines, please ${kind === 'trial' ? 'subscribe' : 'renew'} — otherwise these services will stop.\n\nPlans from ₹99/month (₹899/year):\n${link}\n\n- Biomexa Team`;
      const r = await sendSubscriptionNotice(target.phone, first, status, treatment, msg);
      if (r?.success) {
        sent++;
        await Patient.updateMany({ _id: { $in: twins.map(x => x._id) } }, { lastSubNoticeKey: key });
        console.log(`💳 Subscription reminder (${key}) → ${target.phone}`);
      }
      await new Promise(r2 => setTimeout(r2, 250));
    }
    if (sent) console.log(`💳 Subscription reminders sent: ${sent}${SUBSCRIPTION_ENFORCED ? '' : ' (test run — features are not locked)'}`);
  } catch (err) {
    console.error('❌ Subscription notice error:', err.message);
  }
}

// ========== SUPPORT TICKETS ("Report a problem" on every portal) ==========
// Patients, doctors, IVF centres (and anyone on the site) can raise a ticket. They get a ticket
// number on screen and on WhatsApp, can check its status with ticket number + phone, and every
// admin reply / status change is sent to them on WhatsApp. Optional SUPPORT_ALERT_PHONE gets a
// WhatsApp for each new ticket.
const TICKET_ROLES = { patient: 'Patient', doctor: 'Doctor', ivf_patient: 'IVF patient', ivf_centre: 'IVF centre', visitor: 'Visitor' };
const TICKET_CATEGORIES = {
  reminders: 'WhatsApp reminders', login: 'Login / account', reports: 'Reports / AI analysis', doctor: 'Doctor connect',
  payment: 'Payment / subscription', ivf: 'IVF Care', website: 'Website not working', other: 'Something else'
};
const TICKET_STATUS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
const ticketSchema = new mongoose.Schema({
  ticketNo: { type: String, unique: true },
  role: String, name: String, phone: String, email: String,
  category: String, subject: String, message: String, page: String, userAgent: String,
  status: { type: String, default: 'open' },
  replies: [{ by: String, text: String, at: { type: Date, default: Date.now } }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const Ticket = mongoose.model('Ticket', ticketSchema);
const ticketLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 6, message: 'Too many tickets from this connection — please wait a while, or reply to your earlier ticket on WhatsApp.' });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function newTicketNo() {
  for (let i = 0; i < 6; i++) {
    const no = 'BX-' + Math.floor(100000 + Math.random() * 900000);
    if (!(await Ticket.exists({ ticketNo: no }))) return no;
  }
  return 'BX-' + Date.now().toString().slice(-8);
}

app.post('/api/tickets', ticketLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const role = TICKET_ROLES[b.role] ? b.role : 'visitor';
    const category = TICKET_CATEGORIES[b.category] ? b.category : 'other';
    const name = clip(b.name, 80);
    const phone = normalizePhone(b.phone);
    const email = clip(b.email, 120);
    const subject = clip(b.subject, 140);
    const message = String(b.message || '').trim().slice(0, 3000);
    if (!name) return res.status(400).json({ message: 'Please enter your name.' });
    if (!/^\+\d{11,13}$/.test(phone)) return res.status(400).json({ message: 'Please enter a valid WhatsApp number so we can reply to you.' });
    if (message.length < 10) return res.status(400).json({ message: 'Please describe the problem in a little more detail.' });

    const t = await Ticket.create({
      ticketNo: await newTicketNo(), role, name, phone, email, category,
      subject: subject || TICKET_CATEGORIES[category], message,
      page: clip(b.page, 200), userAgent: clip(req.headers['user-agent'], 200)
    });
    console.log(`🎫 Ticket ${t.ticketNo} (${TICKET_ROLES[role]}, ${TICKET_CATEGORIES[category]}) from ${phone}`);
    const first = name.split(' ')[0];
    sendWhatsAppFree(phone, `🎫 *Biomexa support — ticket ${t.ticketNo}*\n\nHi ${first}, we've received your report: "${t.subject}".\n\nOur team will look into it and reply here on WhatsApp. You can check the status any time at ${SITE_URL}/support.html with your ticket number.\n\n- Biomexa Team`).catch(() => {});
    if (process.env.SUPPORT_ALERT_PHONE) {
      sendWhatsAppFree(process.env.SUPPORT_ALERT_PHONE, `🎫 New ticket ${t.ticketNo}\n${TICKET_ROLES[role]}: ${name} (${phone})\n${TICKET_CATEGORIES[category]} — ${t.subject}\n\n${message.slice(0, 500)}`).catch(() => {});
    }
    res.json({ ticketNo: t.ticketNo, message: `Ticket ${t.ticketNo} raised. We'll reply on WhatsApp.` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Status check: ticket number + the phone it was raised from.
app.get('/api/tickets/:ticketNo', loginLimiter, async (req, res) => {
  try {
    const t = await Ticket.findOne({ ticketNo: String(req.params.ticketNo || '').toUpperCase().trim() });
    if (!t || last10(t.phone) !== last10(req.query.phone)) return res.status(404).json({ message: 'No ticket found with that number and WhatsApp number.' });
    res.json({
      ticketNo: t.ticketNo, status: t.status, statusLabel: TICKET_STATUS[t.status] || t.status,
      category: TICKET_CATEGORIES[t.category] || t.category, subject: t.subject, message: t.message,
      createdAt: t.createdAt, updatedAt: t.updatedAt,
      replies: t.replies.filter(r => r.by !== 'internal').map(r => ({ text: r.text, at: r.at }))
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/tickets', adminAuth, async (req, res) => {
  try {
    const tickets = await Ticket.find().sort({ createdAt: -1 }).limit(300).lean();
    const counts = { open: 0, in_progress: 0, resolved: 0 };
    tickets.forEach(t => { counts[t.status] = (counts[t.status] || 0) + 1; });
    res.json({ counts, tickets, roles: TICKET_ROLES, categories: TICKET_CATEGORIES });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin reply and/or status change — the reporter is told on WhatsApp.
app.post('/api/admin/tickets/:id', adminAuth, async (req, res) => {
  try {
    const t = await Ticket.findById(req.params.id);
    if (!t) return res.status(404).json({ message: 'Ticket not found.' });
    const text = String(req.body?.reply || '').trim().slice(0, 2000);
    const status = TICKET_STATUS[req.body?.status] ? req.body.status : t.status;
    if (!text && status === t.status) return res.status(400).json({ message: 'Write a reply or change the status.' });
    if (text) t.replies.push({ by: req.admin?.username || 'admin', text });
    const statusChanged = status !== t.status;
    t.status = status; t.updatedAt = new Date();
    await t.save();
    const first = String(t.name || '').split(' ')[0] || 'there';
    const lines = [`🎫 *Biomexa support — ticket ${t.ticketNo}*`, '', `Hi ${first},`];
    if (text) lines.push('', text);
    if (statusChanged) lines.push('', status === 'resolved' ? '✅ We have marked this ticket as *resolved*. If the problem is still there, just reply here.' : `Status: *${TICKET_STATUS[status]}*`);
    lines.push('', '- Biomexa Team');
    const wa = await sendWhatsAppFree(t.phone, lines.join('\n'));
    console.log(`🎫 Ticket ${t.ticketNo} → ${status}${text ? ' (replied)' : ''} by ${req.admin?.username || 'admin'}`);
    res.json({ message: `Ticket ${t.ticketNo} updated.`, whatsappSent: !!wa?.success, ticket: t });
  } catch (err) {
    res.status(500).json({ message: err.name === 'CastError' ? 'Ticket not found.' : err.message });
  }
});

// ========== ADMIN REMINDER CENTER (admin-reminders.html) ==========
// Who is getting reminders right now, whose course has finished or was stopped, and who never set
// one — plus a one-click WhatsApp invite to add a reminder for another medicine/dose, and a way
// for the admin to add a reminder for a patient directly.
function last10(phone) { return String(phone || '').replace(/\D/g, '').slice(-10); }

app.get('/api/admin/reminder-center', adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const patients = await Patient.find().select('name phone medicines createdAt lastReminderInviteAt').lean();
    // Duplicate records of one number ("+91X" / "+91 X") are shown as one person.
    const people = new Map();
    for (const p of patients) {
      const key = last10(p.phone) || String(p._id);
      const cur = people.get(key);
      if (!cur) people.set(key, { ...p, phones: [p.phone], medicines: [...(p.medicines || [])] });
      else {
        cur.phones.push(p.phone);
        cur.medicines.push(...(p.medicines || []));
        if (!cur.name || /test/i.test(cur.name)) cur.name = p.name || cur.name;
        if (p.lastReminderInviteAt && (!cur.lastReminderInviteAt || p.lastReminderInviteAt > cur.lastReminderInviteAt)) cur.lastReminderInviteAt = p.lastReminderInviteAt;
        if (!/\s/.test(p.phone)) cur.phone = p.phone; // prefer the "+91XXXXXXXXXX" record
      }
    }
    const allPhones = patients.map(p => p.phone);
    const doseStats = await Dose.aggregate([
      { $match: { patientPhone: { $in: allPhones } } },
      { $group: {
        _id: '$patientPhone',
        taken: { $sum: { $cond: [{ $eq: ['$status', 'taken'] }, 1, 0] } },
        due: { $sum: { $cond: [{ $ne: ['$status', 'pending'] }, 1, 0] } },
        lastSent: { $max: { $cond: ['$sentReminder', { $concat: ['$scheduledDate', 'T', '$scheduledTime'] }, null] } }
      } }
    ]);
    const statsByPhone = Object.fromEntries(doseStats.map(d => [d._id, d]));

    const groupMeds = (meds) => {
      const by = {};
      for (const m of meds) {
        const k = `${String(m.name).trim().toLowerCase()}|${m.active ? 1 : 0}`;
        const g = by[k] || (by[k] = { name: m.name, dosage: m.dosage || '', times: [], active: !!m.active, startDate: m.startDate, endDate: m.endDate, completedAt: m.completedAt, stoppedByPatient: !!m.stoppedByPatient, durationDays: m.durationDays || null, adherence: m.courseSummary?.adherence ?? null });
        if (m.time && !g.times.includes(m.time)) g.times.push(m.time);
        if (m.completedAt && (!g.completedAt || m.completedAt > g.completedAt)) g.completedAt = m.completedAt;
      }
      return Object.values(by).map(g => ({
        ...g, times: g.times.sort(),
        daysLeft: g.active && g.endDate ? Math.max(0, Math.ceil((new Date(g.endDate) - now) / 86400000)) : null
      }));
    };

    const rows = [...people.values()].map(p => {
      const meds = groupMeds(p.medicines);
      const active = meds.filter(m => m.active);
      // A medicine both active and finished (re-added later) only shows as active.
      const activeNames = new Set(active.map(m => m.name.trim().toLowerCase()));
      const finished = meds.filter(m => !m.active && !activeNames.has(m.name.trim().toLowerCase()))
        .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
      let taken = 0, due = 0, lastSent = null;
      for (const ph of p.phones) {
        const st = statsByPhone[ph];
        if (!st) continue;
        taken += st.taken; due += st.due;
        if (st.lastSent && (!lastSent || st.lastSent > lastSent)) lastSent = st.lastSent;
      }
      return {
        name: p.name, phone: p.phone, otherPhones: p.phones.filter(x => x !== p.phone),
        status: active.length ? 'active' : finished.length ? 'completed' : 'none',
        active, finished,
        adherence: due ? Math.round((taken / due) * 100) : null, dosesLogged: due,
        lastReminder: lastSent, joinedAt: p.createdAt, lastInviteAt: p.lastReminderInviteAt || null
      };
    });
    // WhatsApp campaign leads who tapped START. Those who then signed up are tagged on their
    // patient row ("From campaign"); those who haven't signed up yet get a row of their own.
    await syncJoinedLeads();
    const campaignLeads = await Lead.find({ $or: [{ repliedAt: { $ne: null } }, { status: 'joined' }] })
      .select('name phone source status segment medicine language repliedAt joinedAt lastSignupInviteAt').lean();
    const rowByKey = new Map(rows.map(r => [last10(r.phone), r]));
    const startedRows = [];
    for (const l of campaignLeads) {
      const key = last10(l.phone);
      const row = rowByKey.get(key);
      if (row) {
        row.campaign = { listName: l.name || '', source: l.source || '', startedAt: l.repliedAt || null, joinedAt: l.joinedAt || null, language: l.language || 'en' };
      } else if (l.status === 'replied') {
        startedRows.push({
          name: l.name || 'Unnamed contact', phone: '+91' + key, otherPhones: [], status: 'started', lead: true,
          active: [], finished: [], adherence: null, dosesLogged: 0, lastReminder: null, joinedAt: null,
          lastInviteAt: l.lastSignupInviteAt || null,
          campaign: { listName: l.name || '', source: l.source || '', startedAt: l.repliedAt, segment: l.segment || 'general', medicine: l.medicine || '', language: l.language || 'en' }
        });
      }
    }
    // Free-text WhatsApp is only delivered within 24h of the person's last message to Biomexa,
    // so show the admin whose window is still open (and for how long).
    const campaignRows = [...rows.filter(r => r.campaign), ...startedRows];
    if (campaignRows.length) {
      const inbound = await WaInbound.find({ digits: { $in: campaignRows.map(r => last10(r.phone)) } }).lean().catch(() => []);
      const lastIn = new Map(inbound.map(w => [w.digits, w.lastInboundAt]));
      for (const r of campaignRows) {
        const at = lastIn.get(last10(r.phone));
        const closesAt = at ? new Date(new Date(at).getTime() + 23.5 * 3600e3) : null;
        r.campaign.windowClosesAt = closesAt && closesAt > now ? closesAt : null;
      }
    }
    startedRows.sort((a, b) => new Date(b.campaign.startedAt) - new Date(a.campaign.startedAt));

    rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const counts = { active: 0, completed: 0, none: 0 };
    rows.forEach(r => counts[r.status]++);
    counts.started = startedRows.length;
    counts.campaign = rows.filter(r => r.campaign).length;
    res.json({ counts, total: rows.length, patients: [...rows, ...startedRows] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// One button: WhatsApp every patient in the chosen group an invite to add a reminder for another
// medicine or dose. Each person gets it at most once a day, however many times it's pressed.
app.post('/api/admin/reminder-center/invite', adminAuth, async (req, res) => {
  try {
    const audience = ['all', 'active', 'completed', 'none'].includes(req.body?.audience) ? req.body.audience : 'all';
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 20 * 3600000);
    const patients = await Patient.find().select('name phone medicines lastReminderInviteAt');
    const seen = new Set();
    const results = { sent: 0, failed: [], skippedRecent: 0, skippedAudience: 0 };
    for (const p of patients) {
      const key = last10(p.phone);
      if (!key || seen.has(key)) continue;
      // Status across every record of this number.
      const twins = patients.filter(x => last10(x.phone) === key);
      const meds = twins.flatMap(x => x.medicines || []);
      const status = meds.some(m => m.active) ? 'active' : meds.length ? 'completed' : 'none';
      if (audience !== 'all' && status !== audience) { results.skippedAudience++; seen.add(key); continue; }
      if (twins.some(x => x.lastReminderInviteAt && x.lastReminderInviteAt > dayAgo)) { results.skippedRecent++; seen.add(key); continue; }
      seen.add(key);
      const target = twins.find(x => !/\s/.test(x.phone)) || p;
      const first = String(target.name || 'there').trim().split(/\s+/)[0];
      const link = `${SITE_URL}/reminders.html`;
      const msg = status === 'active'
        ? `💊 Hi ${first}! Taking any other medicine — or a second dose of one you already take?\n\nAdd it here and Biomexa will remind you on WhatsApp at the right time, free:\n${link}\n\nUse this same WhatsApp number.\n\n- Biomexa Team`
        : status === 'completed'
          ? `💊 Hi ${first}! Your Biomexa reminders have finished.\n\nStarted a new medicine, or still taking one? Set up a free WhatsApp reminder in 30 seconds:\n${link}\n\nUse this same WhatsApp number.\n\n- Biomexa Team`
          : `💊 Hi ${first}! You haven't set up any medicine reminders yet.\n\nAdd your medicine and time, and Biomexa will remind you on WhatsApp every day, free:\n${link}\n\nUse this same WhatsApp number.\n\n- Biomexa Team`;
      const r = await sendWhatsAppFree(target.phone, msg);
      if (r && r.success) {
        results.sent++;
        await Patient.updateMany({ _id: { $in: twins.map(x => x._id) } }, { lastReminderInviteAt: now });
      } else {
        results.failed.push({ name: target.name, phone: target.phone });
      }
      await new Promise(r2 => setTimeout(r2, 250)); // stay under MSG91 rate limits
    }
    console.log(`📨 Reminder invite (${audience}) by ${req.admin?.username || 'admin'}: ${results.sent} sent, ${results.failed.length} failed, ${results.skippedRecent} already invited today`);
    res.json({
      message: `Invite sent to ${results.sent} patient${results.sent === 1 ? '' : 's'}.` +
        (results.skippedRecent ? ` ${results.skippedRecent} already got one in the last day.` : '') +
        (results.failed.length ? ` ${results.failed.length} could not be sent.` : ''),
      ...results
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ----- Campaign follow-ups from the Reminder Center -----
// "started":  leads who tapped START but haven't signed up → why signing up is worth it + their sign-up link.
// "campaign": leads who signed up → everything their Biomexa portal does + how to log in.
// Both are free text, so they only go to people who messaged Biomexa in the last 24h (WhatsApp
// rule — outside it Meta silently drops the message). Each person gets one at most once a day.
function portalBenefitLines(lang, segment) {
  const hi = lang === 'hi';
  const vitals = segment === 'diabetes' || segment === 'bp' || segment === 'general';
  const L = hi ? [
    '⏰ दवा का रिमाइंडर यहीं WhatsApp पर — जवाब देकर डोज़ "ली" मार्क करें',
    '📊 आपका अपना हेल्थ डैशबोर्ड — कितनी डोज़ लीं, आपका % रिकॉर्ड',
    vitals && '🩸 शुगर / बीपी रीडिंग भेजें और अपने चार्ट देखें',
    '📄 रिपोर्ट या पर्चा अपलोड करें — आसान भाषा में समझें',
    '📋 डॉक्टर को दिखाने के लिए ट्रीटमेंट रिपोर्ट',
    '🩺 डॉक्टर से बात करें, और दवा के सवालों के लिए AI असिस्टेंट',
    '🛒 दवा खत्म होने से पहले रिफ़िल रिमाइंडर, घर पर डिलीवरी'
  ] : [
    '⏰ Medicine reminders right here on WhatsApp — reply to mark each dose taken',
    '📊 Your own health dashboard — doses taken and your adherence %',
    vitals && '🩸 Send your sugar / BP readings and see your charts',
    '📄 Upload a report or prescription and get it explained in simple words',
    '📋 A treatment report you can show your doctor',
    '🩺 Talk to a doctor, plus an AI assistant for medicine questions',
    '🛒 Refill reminders before you run out, with home delivery'
  ];
  return L.filter(Boolean).join('\n');
}

function signupNudgeMessage(lead, phone) {
  const hi = lead.language === 'hi';
  const link = leadSignupLink(lead, phone);
  if (lead.segment === 'ivf') {
    return hi
      ? `🙏 नमस्ते! आपने START दबाया था — Biomexa IVF Care बस एक कदम दूर है।\n\nसाइन अप करने पर आपके इंजेक्शन, स्कैन और क्लिनिक विज़िट का पूरा ध्यान रखा जाएगा, WhatsApp पर रिमाइंडर के साथ।\n\n👉 यहाँ साइन अप करें:\n${link}\n\nकोई सवाल? यहीं जवाब दें। — टीम Biomexa 💙`
      : `🙏 Hi! You tapped START — Biomexa IVF Care is one step away.\n\nOnce you sign up, we keep track of your injections, scans and clinic visits, with reminders right here on WhatsApp.\n\n👉 Sign up here:\n${link}\n\nHave a question? Just reply here. — Team Biomexa 💙`;
  }
  const benefits = portalBenefitLines(lead.language, lead.segment);
  return hi
    ? `🙏 नमस्ते! आपने START दबाया था — आपके मुफ़्त दवा रिमाइंडर बस एक कदम दूर हैं।\n\nसाइन अप (1 मिनट) करने पर आपको मिलेगा:\n${benefits}\n\n👉 यहाँ साइन अप करें:\n${link}\n\nया *START* लिखें — हम यहीं चैट में सेट कर देंगे। आपका WhatsApp नंबर पहले से भरा हुआ है। कोई सवाल? यहीं जवाब दें। — टीम Biomexa 💙`
    : `🙏 Hi! You tapped START — your free medicine reminders are one step away.\n\nSign up (takes 1 minute) and you get:\n${benefits}\n\n👉 Sign up here:\n${link}\n\nOr just reply *START* and we'll set it up right here in the chat. Your WhatsApp number is already filled in. Have a question? Just reply here. — Team Biomexa 💙`;
}

function portalLoginMessage(name, lang, segment) {
  const hi = lang === 'hi';
  const first = String(name || '').trim().split(/\s+/)[0] || (hi ? 'जी' : 'there');
  const login = `${SIGNUP_SITE_URL}/login.html`;
  const benefits = portalBenefitLines(lang, segment);
  return hi
    ? `🎉 नमस्ते ${first}! आपके Biomexa रिमाइंडर चालू हैं। आपका अपना Biomexa हेल्थ पोर्टल भी तैयार है — लॉग इन करके यह सब इस्तेमाल करें:\n\n${benefits}\n\n🔐 लॉग इन करें: ${login}\nइसी WhatsApp नंबर से।\n\nपासवर्ड नहीं है? यहाँ *RESET* लिखकर भेजें, हम पासवर्ड सेट करने का लिंक भेज देंगे।\n\n— टीम Biomexa 💙`
    : `🎉 Hi ${first}! Your Biomexa reminders are running. You also have your own Biomexa health portal — log in to use all of it:\n\n${benefits}\n\n🔐 Log in: ${login}\nUse this same WhatsApp number.\n\nNo password yet? Just reply *RESET* here and we'll send you a link to set one.\n\n— Team Biomexa 💙`;
}

// body: { audience: 'started' | 'campaign', phone?: one person only }
app.post('/api/admin/reminder-center/campaign-invite', adminAuth, async (req, res) => {
  try {
    const audience = req.body?.audience === 'campaign' ? 'campaign' : 'started';
    const only = req.body?.phone ? last10(req.body.phone) : null;
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 20 * 3600000);
    const results = { sent: 0, failed: [], skippedRecent: 0, skippedWindow: 0 };
    await syncJoinedLeads();

    if (audience === 'started') {
      const leads = await Lead.find({ status: 'replied' });
      for (const lead of leads) {
        const key = last10(lead.phone);
        if (only && key !== only) continue;
        if (lead.lastSignupInviteAt && lead.lastSignupInviteAt > dayAgo) { results.skippedRecent++; continue; }
        const phone = '+91' + key;
        if (!(await whatsappWindowOpen(phone))) { results.skippedWindow++; continue; }
        const r = await sendWhatsAppFree(phone, signupNudgeMessage(lead, phone));
        if (r && r.success) { results.sent++; await Lead.updateOne({ _id: lead._id }, { lastSignupInviteAt: now }); }
        else results.failed.push({ name: lead.name, phone });
        await new Promise(r2 => setTimeout(r2, 250));
      }
    } else {
      const leads = await Lead.find({ status: 'joined' }).select('phone language segment').lean();
      const patients = await Patient.find({}).select('name phone lastPortalInviteAt');
      const seen = new Set();
      for (const lead of leads) {
        const key = last10(lead.phone);
        if (seen.has(key) || (only && key !== only)) continue;
        seen.add(key);
        const twins = patients.filter(p => last10(p.phone) === key);
        if (!twins.length) continue;
        if (twins.some(p => p.lastPortalInviteAt && p.lastPortalInviteAt > dayAgo)) { results.skippedRecent++; continue; }
        const target = twins.find(p => !/\s/.test(p.phone)) || twins[0];
        if (!(await whatsappWindowOpen(target.phone))) { results.skippedWindow++; continue; }
        const r = await sendWhatsAppFree(target.phone, portalLoginMessage(target.name, lead.language, lead.segment));
        if (r && r.success) { results.sent++; await Patient.updateMany({ _id: { $in: twins.map(p => p._id) } }, { lastPortalInviteAt: now }); }
        else results.failed.push({ name: target.name, phone: target.phone });
        await new Promise(r2 => setTimeout(r2, 250));
      }
    }

    const who = audience === 'started' ? 'sign-up message' : 'portal message';
    console.log(`📨 Campaign ${who} by ${req.admin?.username || 'admin'}${only ? ' (one person)' : ''}: ${results.sent} sent, ${results.failed.length} failed, ${results.skippedRecent} already sent today, ${results.skippedWindow} outside 24h window`);
    res.json({
      message: `${who[0].toUpperCase() + who.slice(1)} sent to ${results.sent} ${results.sent === 1 ? 'person' : 'people'}.` +
        (results.skippedWindow ? ` ${results.skippedWindow} not sent — they haven't messaged Biomexa in the last 24 hours, so WhatsApp would block it.` : '') +
        (results.skippedRecent ? ` ${results.skippedRecent} already got it in the last day.` : '') +
        (results.failed.length ? ` ${results.failed.length} could not be sent.` : ''),
      ...results
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== LEAD CAMPAIGNS — WhatsApp onboarding for new (not-yet-registered) contacts ==========
// Admin uploads a CSV of leads (name, number) on admin-leads.html, then sends the approved
// MARKETING template "lead_onboarding" in safe daily batches. Leads who tap "Start Reminders" /
// reply START get a free-text reply with the sign-up link (their reply opens the 24h window, so
// it costs nothing); STOP marks them opted out and they are never messaged again.
// WhatsApp only allows business-initiated messages through an approved template, so there is no
// free-text fallback here. See .env.example for the template to create.
const MSG91_LEAD_TEMPLATE_NAME = process.env.MSG91_LEAD_TEMPLATE_NAME || null;
const MSG91_LEAD_TEMPLATE_NAMESPACE = process.env.MSG91_LEAD_TEMPLATE_NAMESPACE || MSG91_TEMPLATE_NAMESPACE;
// New contacts are never greeted by name (the name in an uploaded list may be wrong or belong to
// someone else). With the approved lead_onboarding template ("Hello {{1}} 🙏") the variable is
// always filled with "there". If you create a template with no variable at all, set
// MSG91_LEAD_TEMPLATE_HAS_VARIABLE=false and nothing is sent for it.
const LEAD_TEMPLATE_HAS_VARIABLE = process.env.MSG91_LEAD_TEMPLATE_HAS_VARIABLE !== 'false';
// Optional condition-specific invites (must have NO variables), e.g. MSG91_LEAD_TEMPLATE_DIABETES=lead_invite_diabetes.
// Anyone whose segment has no template of its own gets MSG91_LEAD_TEMPLATE_NAME.
function leadTemplateFor(segment) {
  const own = segment && segment !== 'general' ? process.env['MSG91_LEAD_TEMPLATE_' + segment.toUpperCase()] : null;
  return own ? { name: own, hasVariable: false } : { name: MSG91_LEAD_TEMPLATE_NAME, hasVariable: LEAD_TEMPLATE_HAS_VARIABLE };
}
const LEAD_GREETING_WORD = 'there';
// Sign-up link sent to leads — the public custom domain, so patients see a link they trust.
const SIGNUP_SITE_URL = (process.env.SIGNUP_SITE_URL || 'https://biomexapharmaceuticals.com').replace(/\/+$/, '');
// New WhatsApp numbers can only start ~250 new conversations a day until Meta raises the tier —
// going over it (or getting many blocks) hurts the number's quality rating.
const LEAD_DAILY_LIMIT = Math.max(1, parseInt(process.env.LEAD_DAILY_LIMIT, 10) || 250);
const LEAD_SEND_START_HOUR = 9;  // IST — don't message strangers early morning…
const LEAD_SEND_END_HOUR = 21;   // …or late at night.

const Lead = mongoose.model('Lead', new mongoose.Schema({
  name: { type: String, default: '' },
  phone: { type: String, required: true, unique: true }, // canonical 91XXXXXXXXXX
  source: { type: String, default: '' },                  // e.g. "Dr Sharma clinic", "Pharmacy camp"
  status: { type: String, enum: ['new', 'sending', 'sent', 'failed', 'replied', 'joined', 'optout'], default: 'new', index: true },
  sentAt: Date,
  repliedAt: Date,
  joinedAt: Date,
  optedOutAt: Date,
  lastError: String,
  uploadedBy: String,
  // Profile read from the uploaded list — used to pick the right message for each person.
  segment: { type: String, default: 'general', index: true }, // diabetes | bp | thyroid | heart | ivf | general
  condition: String,
  medicine: String,
  city: String,
  doctor: String,
  age: String,
  gender: String,
  language: { type: String, default: 'en' },                // 'hi' when the list shows Hindi
  templateUsed: String,
  signupVia: String,                                        // 'whatsapp' when they signed up in the chat, else the web form
  lastSignupInviteAt: Date                                  // admin Reminder Center "finish signing up" nudge (max once a day)
}, { timestamps: true }));

// ---------- Lead profiling: what condition / medicine / city / language a contact has ----------
const LEAD_SEGMENTS = [
  { key: 'diabetes', label: 'Diabetes', hi: 'शुगर (डायबिटीज़)',
    re: /\b(diabet\w*|sugar|madhumeh|t2dm|dm|dm2|type ?2|hba1c|metformin|glimepiride|gliclazide|sitagliptin|vildagliptin|teneligliptin|dapagliflozin|empagliflozin|voglibose|insulin|diabmexa)\b/i, dev: /मधुमेह|शुगर|डायबिटीज/ },
  { key: 'bp', label: 'Blood pressure', hi: 'बीपी',
    re: /\b(bp|b\.p|hypertension|htn|blood pressure|telmisartan|amlodipine|losartan|olmesartan|cilnidipine|ramipril|enalapril|metoprolol|atenolol|telmexa)\b/i, dev: /रक्तचाप|बीपी|ब्लड प्रेशर/ },
  { key: 'thyroid', label: 'Thyroid', hi: 'थायराइड',
    re: /\b(thyroid|hypothyroid\w*|hyperthyroid\w*|thyroxine|levothyroxine|eltroxin|thyronorm|carbimazole)\b/i, dev: /थायराइड/ },
  { key: 'heart', label: 'Heart / cholesterol', hi: 'दिल / कोलेस्ट्रॉल',
    re: /\b(cardiac|heart|cholesterol|lipid\w*|cad|angina|atorvastatin|rosuvastatin|statin|clopidogrel|ecosprin)\b/i, dev: /हृदय|दिल|कोलेस्ट्रॉल/ },
  { key: 'ivf', label: 'IVF / fertility', hi: 'IVF',
    re: /\b(ivf|iui|icsi|fertility|infertility|embryo|pcos|pcod)\b/i, dev: /आईवीएफ|बांझपन/ }
];
const SEGMENT_LABEL = Object.fromEntries([...LEAD_SEGMENTS.map(s => [s.key, s.label]), ['general', 'General']]);
const KNOWN_MEDICINES = /\b(diabmexa[\w -]*?\d*|telmexa[\w -]*?(am)?|metformin|glimepiride|gliclazide|sitagliptin|vildagliptin|teneligliptin|dapagliflozin|empagliflozin|voglibose|insulin|telmisartan|amlodipine|losartan|olmesartan|cilnidipine|ramipril|metoprolol|atenolol|thyroxine|levothyroxine|eltroxin|thyronorm|atorvastatin|rosuvastatin|clopidogrel|ecosprin)\b/i;

function leadProfile(c) {
  const all = [c.condition, c.medicine, c.notes].filter(Boolean).join(' ');
  const seg = LEAD_SEGMENTS.find(s => s.re.test(all) || s.dev.test(all));
  let medicine = String(c.medicine || '').trim();
  if (!medicine) { const m = all.match(KNOWN_MEDICINES); if (m) medicine = m[0].trim(); }
  medicine = medicine.replace(/\s+/g, ' ').slice(0, 60);
  if (medicine && medicine === medicine.toLowerCase()) medicine = medicine.replace(/\b\w/g, x => x.toUpperCase());
  const langHint = String(c.language || '').toLowerCase();
  const hindi = /hindi|हिं/.test(langHint) || (!/english/.test(langHint) && /[\u0900-\u097F]/.test([c.name, c.notes, c.condition].join(' ')));
  const clip = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    segment: seg ? seg.key : 'general',
    condition: clip(c.condition, 80),
    medicine,
    city: clip(c.city, 60),
    doctor: clip(c.doctor, 60),
    age: clip(c.age, 10),
    gender: clip(c.gender, 12),
    language: hindi ? 'hi' : 'en'
  };
}

// Indian mobile → "91XXXXXXXXXX", or null if it isn't a valid mobile number.
function leadPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) d = '91' + d;
  return /^91[6-9]\d{9}$/.test(d) ? d : null;
}

function parseCsvText(text) {
  const rows = []; let row = [], field = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

function istHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(d)) % 24;
}

async function sendLeadTemplate(phone, segment) {
  const tpl = leadTemplateFor(segment);
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
            name: tpl.name,
            language: { code: MSG91_TEMPLATE_LANG, policy: 'deterministic' },
            namespace: MSG91_LEAD_TEMPLATE_NAMESPACE,
            to_and_components: [{
              to: [phone],
              components: tpl.hasVariable
                ? { body_1: { type: 'text', value: LEAD_GREETING_WORD, parameter_name: 'patient_name' } }
                : {}
            }]
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.hasError || data.status === 'fail') {
      return { ok: false, error: JSON.stringify(data).substring(0, 300) || `HTTP ${res.status}` };
    }
    return { ok: true, template: tpl.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// One campaign at a time, run in the background so the admin page doesn't time out.
let leadJob = { running: false, total: 0, sent: 0, failed: 0, invites: 0, offers: 0, errors: [], startedAt: null, finishedAt: null, by: null };

// items: { kind: 'invite', leadId } → lead_onboarding template (new contact)
//        { kind: 'offer', patientId, gapDays } → biomexa_care_offer template (existing patient)
async function runLeadCampaign(items) {
  for (const item of items) {
    let r = { ok: false, error: 'skipped' };
    if (item.kind === 'invite') {
      // Re-check: they may have replied STOP or signed up since the list was analysed.
      // Claim it first so two sends (or two servers) can never message the same person twice.
      const fresh = await Lead.findOneAndUpdate({ _id: item.leadId, status: { $in: ['new', 'failed'] } }, { status: 'sending' }, { new: true }).lean();
      if (!fresh) continue;
      r = await sendLeadTemplate(fresh.phone, fresh.segment);
      if (r.ok) await Lead.updateOne({ _id: fresh._id }, { status: 'sent', sentAt: new Date(), lastError: '', templateUsed: r.template });
      else await Lead.updateOne({ _id: fresh._id }, { status: 'failed', lastError: r.error });
      if (r.ok) leadJob.invites++;
    } else {
      const cutoff = new Date(Date.now() - item.gapDays * 86400000);
      // Claim first (same rule as the 11 AM job) so nobody gets two offers.
      const before = await Patient.findOneAndUpdate(
        { _id: item.patientId, adOptOut: { $ne: true }, $or: [{ lastAdSentAt: null }, { lastAdSentAt: { $exists: false } }, { lastAdSentAt: { $lte: cutoff } }] },
        { lastAdSentAt: new Date() }
      );
      if (!before) continue;
      const twins = await Patient.find({ phone: { $in: phoneVariants(before.phone) } }).select('createdAt subscription medicines');
      const ok = await sendAdTemplate(before.phone, before.name, adAccessLine(twins.length ? twins : [before]));
      r = ok ? { ok: true } : { ok: false, error: 'MSG91 rejected the offer message — see server logs' };
      if (ok) leadJob.offers++;
      else await Patient.updateOne({ _id: before._id }, { lastAdSentAt: before.lastAdSentAt || null });
    }
    if (r.ok) leadJob.sent++;
    else {
      leadJob.failed++;
      if (leadJob.errors.length < 5) leadJob.errors.push(String(r.error).slice(0, 200));
      if (/401|auth/i.test(r.error || '')) { console.log('⚠️ Campaign stopped — MSG91 auth error'); break; }
    }
    await new Promise(r2 => setTimeout(r2, 400)); // gentle pace for MSG91 / Meta
  }
}

// Mark leads who have since created a Biomexa account as "joined".
async function syncJoinedLeads() {
  const open = await Lead.find({ status: { $in: ['new', 'sent', 'failed', 'replied'] } }).select('phone').lean();
  if (!open.length) return;
  const patients = await Patient.find().select('phone').lean();
  const patientKeys = new Set(patients.map(p => last10(p.phone)));
  const joinedIds = open.filter(l => patientKeys.has(last10(l.phone))).map(l => l._id);
  if (joinedIds.length) await Lead.updateMany({ _id: { $in: joinedIds } }, { status: 'joined', joinedAt: new Date() });
}

// Inbound WhatsApp from a lead (not a registered patient). Returns true if handled.
// START → sign-up right here in the chat (medicine → time → name → account + reminder created),
// with the web sign-up link as a fallback. IVF leads still go to the IVF Care sign-up page.
async function handleLeadReply(phone, buttonText, freeText) {
  const lead = await Lead.findOne({ phone: '91' + last10(phone) });
  if (!lead) return false;
  const said = (buttonText || freeText || '').trim().toLowerCase();
  const isStop = /^stop\b/.test(said) || AD_STOP_RE.test(said);
  const convo = await ConversationState.findOne({ patientPhone: { $in: phoneVariants(phone) } }).sort({ updatedAt: -1 });
  const inSignup = convo && typeof convo.state === 'string' && convo.state.startsWith('lead_signup_');
  if (isStop) {
    if (inSignup) await ConversationState.updateOne({ _id: convo._id }, { state: null, draft: null, updatedAt: new Date() });
    await Lead.updateOne({ _id: lead._id }, { status: 'optout', optedOutAt: new Date() });
    await sendWhatsAppFree(phone, '✅ Done — Biomexa won\'t message you again. If you ever want free medicine reminders, just reply START.');
    return true;
  }
  // Mid sign-up: every reply is an answer (checked before START so "yes" means "yes, that medicine").
  if (inSignup && !buttonText) return handleLeadSignupStep(lead, convo, phone, (freeText || '').trim());

  const isStart = /start/.test(said) || AD_START_RE.test(said) || /^(yes|haan|ha)\b/.test(said);
  if (isStart) {
    if (lead.status !== 'joined') await Lead.updateOne({ _id: lead._id }, { status: 'replied', repliedAt: new Date(), optedOutAt: null });
    if (lead.segment === 'ivf') { await sendWhatsAppFree(phone, leadWelcomeMessage(lead, phone)); return true; }
    await ConversationState.findOneAndUpdate(
      { patientPhone: (convo && convo.patientPhone) || phone },
      { state: 'lead_signup_med', draft: {}, doseId: null, updatedAt: new Date() },
      { upsert: true }
    );
    await sendWhatsAppFree(phone, leadChatStartMessage(lead, phone));
    return true;
  }
  return false;
}

const leadHi = lead => lead.language === 'hi';
function leadChatStartMessage(lead, phone) {
  const hi = leadHi(lead);
  const L = hi ? 'hi' : 'en';
  const what = {
    en: { diabetes: 'your diabetes medicine', bp: 'your BP medicine', thyroid: 'your thyroid medicine', heart: 'your heart / cholesterol medicine' },
    hi: { diabetes: 'शुगर की दवा', bp: 'बीपी की दवा', thyroid: 'थायराइड की दवा', heart: 'दिल / कोलेस्ट्रॉल की दवा' }
  }[L][lead.segment] || (hi ? 'आपकी दवा' : 'your medicine');
  const ask = lead.medicine
    ? (hi ? `1️⃣ क्या आप *${lead.medicine}* लेते हैं? *YES* लिखें, या अपनी दवा का नाम लिखें।` : `1️⃣ Is it *${lead.medicine}*? Reply *YES*, or type your medicine's name.`)
    : (hi ? `1️⃣ किस दवा का रिमाइंडर चाहिए? दवा का नाम लिखें (जैसे Diabmexa M 500)।` : `1️⃣ Which medicine should we remind you about? Type its name (e.g. Diabmexa M 500).`);
  return hi
    ? `🙏 धन्यवाद! चलिए ${what} के मुफ़्त रिमाइंडर यहीं WhatsApp पर सेट करते हैं — बस 3 छोटे सवाल।\n\n${ask}\n\n(फ़ॉर्म से करना है? यहाँ टैप करें: ${leadSignupLink(lead, phone)} )`
    : `🙏 Thank you! Let's set up free reminders for ${what} right here on WhatsApp — just 3 quick questions.\n\n${ask}\n\n(Prefer a form? Tap here instead: ${leadSignupLink(lead, phone)} )`;
}

// "9", "9 am", "9:30 pm", "21:00", "8.30 PM", "subah 8", "raat 9" — up to 4, separated by , / and / &.
// Returns { times: ['HH:MM', ...] } or { ambiguous: '9' } (no AM/PM given for 1–12) or null.
function parseReminderTimes(text) {
  const t = String(text || '').toLowerCase()
    .replace(/a\.\s?m\.?/g, 'am').replace(/p\.\s?m\.?/g, 'pm')
    .replace(/सुबह|subah|subha|morning/g, ' am ').replace(/शाम|रात|दोपहर|shaam|sham|raat|rat\b|night|evening|dopahar|afternoon/g, ' pm ')
    .replace(/बजे|baje|o'?clock/g, ' ');
  const parts = t.split(/,|\/|&|\band\b|\baur\b|और/).map(x => x.trim()).filter(Boolean);
  const times = [];
  for (const part of parts) {
    const m = part.match(/(?:(am|pm)\s*)?(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*(am|pm)?/);
    if (!m) continue;
    let h = parseInt(m[2], 10); const min = m[3] ? parseInt(m[3], 10) : 0;
    const mer = m[4] || m[1];
    if (h > 23 || min > 59) return null;
    if (mer) { if (h < 1 || h > 12) return null; if (mer === 'pm' && h !== 12) h += 12; if (mer === 'am' && h === 12) h = 0; }
    else if (h >= 1 && h <= 12) return { ambiguous: m[2] + (m[3] ? ':' + m[3] : '') };
    const hhmm = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    if (!times.includes(hhmm)) times.push(hhmm);
  }
  return times.length ? { times: times.slice(0, 4).sort() } : null;
}
const fmt12 = hhmm => { const [h, m] = hhmm.split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

async function handleLeadSignupStep(lead, convo, phone, text) {
  const hi = leadHi(lead);
  const draft = Object.assign({}, convo.draft || {});
  const save = (state) => ConversationState.updateOne({ _id: convo._id }, { state, draft, updatedAt: new Date() });

  if (/^(cancel|exit|quit|band karo|रद्द)\b/i.test(text)) {
    await ConversationState.updateOne({ _id: convo._id }, { state: null, draft: null, updatedAt: new Date() });
    await sendWhatsAppFree(phone, hi ? `ठीक है, रोक दिया। जब चाहें *START* लिखें, या यहाँ साइन अप करें: ${leadSignupLink(lead, phone)}` : `Okay, stopped. Reply *START* any time, or sign up here: ${leadSignupLink(lead, phone)}`);
    return true;
  }

  if (convo.state === 'lead_signup_med') {
    let med = /^(yes|y|haan|ha|han|ji|हाँ|हां)\b/i.test(text) && lead.medicine ? lead.medicine : text;
    med = med.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (med.length < 2 || /^(yes|y|no|haan|ha)$/i.test(med)) {
      await sendWhatsAppFree(phone, hi ? 'कृपया अपनी दवा का नाम लिखें (जैसे Diabmexa M 500)।' : 'Please type your medicine\'s name (e.g. Diabmexa M 500).');
      return true;
    }
    draft.medicine = med;
    await save('lead_signup_time');
    await sendWhatsAppFree(phone, hi
      ? `👍 *${med}*\n\n2️⃣ आप यह दवा किस समय लेते हैं? जैसे *9 AM* या *8:30 PM*।\nदिन में दो बार? दोनों लिखें: *9 AM, 9 PM*`
      : `👍 *${med}*\n\n2️⃣ What time do you take it? e.g. *9 AM* or *8:30 PM*.\nTwice a day? Send both: *9 AM, 9 PM*`);
    return true;
  }

  if (convo.state === 'lead_signup_time') {
    const r = parseReminderTimes(text);
    if (!r || r.ambiguous) {
      const n = r && r.ambiguous;
      await sendWhatsAppFree(phone, n
        ? (hi ? `${n} बजे सुबह या रात? *${n} AM* या *${n} PM* लिखें।` : `Is that ${n} in the morning or at night? Reply *${n} AM* or *${n} PM*.`)
        : (hi ? 'समय समझ नहीं आया। ऐसे लिखें: *9 AM* या *8:30 PM*' : 'Sorry, I didn\'t get the time. Please send it like *9 AM* or *8:30 PM*.'));
      return true;
    }
    draft.times = r.times;
    await save('lead_signup_name');
    await sendWhatsAppFree(phone, hi
      ? `⏰ ${r.times.map(fmt12).join(', ')} — ठीक है।\n\n3️⃣ आख़िरी सवाल: आपका नाम क्या है?`
      : `⏰ ${r.times.map(fmt12).join(', ')} — got it.\n\n3️⃣ Last one: what's your name?`);
    return true;
  }

  if (convo.state === 'lead_signup_name') {
    const name = text.replace(/[^\p{L}\p{M} .'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (name.length < 2) {
      await sendWhatsAppFree(phone, hi ? 'कृपया अपना नाम लिखें।' : 'Please type your name.');
      return true;
    }
    let result;
    try {
      result = await createWhatsAppSignup({ name, phone, medicineName: draft.medicine, times: draft.times || [] });
    } catch (err) {
      console.log('⚠️ WhatsApp sign-up failed for', phone, err.message);
      await sendWhatsAppFree(phone, hi ? `माफ़ कीजिए, कुछ गड़बड़ हो गई। कृपया यहाँ साइन अप करें: ${leadSignupLink(lead, phone)}` : `Sorry, something went wrong on our side. Please sign up here instead: ${leadSignupLink(lead, phone)}`);
      return true;
    }
    await ConversationState.updateOne({ _id: convo._id }, { state: null, draft: null, updatedAt: new Date() });
    await Lead.updateOne({ _id: lead._id }, { status: 'joined', joinedAt: new Date(), signupVia: 'whatsapp' });
    const first = name.split(' ')[0];
    const when = draft.times.map(fmt12).join(hi ? ' और ' : ' and ');
    const firstNote = result.deferred.length === draft.times.length
      ? (hi ? 'पहला रिमाइंडर कल से आएगा।' : 'Your first reminder comes tomorrow.')
      : (hi ? 'पहला रिमाइंडर आज ही आएगा।' : 'Your first reminder is today.');
    console.log(`🗓️ Reminder set (WhatsApp sign-up): ${result.phone} — ${draft.medicine} at ${draft.times.join(', ')}${result.isNewAccount ? ', new account' : ''}`);
    await sendWhatsAppFree(phone, hi
      ? `🎉 हो गया, ${first}! *${draft.medicine}* का रिमाइंडर रोज़ ${when} पर यहीं WhatsApp पर आएगा। ${firstNote}\n\nरिमाइंडर आने पर जवाब देकर डोज़ "ली" मार्क करें।\n\nआपका Biomexa हेल्थ पोर्टल भी तैयार है — रिपोर्ट, चार्ट, डॉक्टर से बात और ज़्यादा दवाएँ जोड़ने के लिए: ${SIGNUP_SITE_URL}/login.html\nपासवर्ड सेट करने के लिए यहाँ *RESET* लिखें।\n\n— टीम Biomexa 💙`
      : `🎉 All set, ${first}! You'll get a reminder for *${draft.medicine}* every day at ${when}, right here on WhatsApp. ${firstNote}\n\nWhen it arrives, just reply to mark the dose taken.\n\nYour Biomexa health portal is ready too — reports, charts, talking to a doctor and adding more medicines: ${SIGNUP_SITE_URL}/login.html\nReply *RESET* here to set your password.\n\n— Team Biomexa 💙`);
    return true;
  }
  return false;
}

// Creates the account (or adds to an existing one) and the reminder(s) — same rules as
// /api/quick-reminder: a time that has already passed today starts tomorrow.
async function createWhatsAppSignup({ name, phone: rawPhone, medicineName, times }) {
  let phone = normalizePhone(rawPhone);
  let patient = await findAccountByPhone('patient', phone);
  let isNewAccount = false;
  if (!patient) {
    isNewAccount = true;
    const hashed = await bcrypt.hash(crypto.randomBytes(12).toString('hex'), 10);
    patient = await Patient.create({ name, phone, password: hashed, medicines: [] });
  }
  phone = patient.phone;
  const startDate = new Date();
  for (const time of times) {
    patient.medicines.push({ name: medicineName, dosage: '', time, frequency: 'daily', foodNote: '', active: true, durationDays: null, startDate, endDate: null });
  }
  await patient.save();
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const deferred = [];
  for (const time of times) {
    if (startsTomorrow(time, currentTime)) { deferred.push(time); continue; }
    await Dose.create({ patientPhone: phone, medicineName, dosage: '', scheduledTime: time, scheduledDate: localDateStr(new Date()), foodNote: '', status: 'pending' });
  }
  return { phone, isNewAccount, deferred };
}

// Sign-up link that opens the right form: their own Biomexa product pre-selected, or their
// medicine name typed in for them, and their WhatsApp number filled in. IVF leads go to IVF Care.
function leadSignupLink(lead, phone) {
  if (lead.segment === 'ivf') return `${SIGNUP_SITE_URL}/ivf-auth.html`;
  const med = String(lead.medicine || '');
  const product = /diabmexa/i.test(med) ? 'diabmexa-m-500' : /telmexa/i.test(med) ? 'telmexa-am' : 'other';
  const medParam = product === 'other' && med ? `&med=${encodeURIComponent(med)}` : '';
  return `${SIGNUP_SITE_URL}/reminders.html?product=${product}${medParam}&phone=${last10(phone)}`;
}

// The reply after "Start Reminders" is free text (the lead opened the chat), so it is written
// for each person from what their list said: condition, medicine and language. No name is used.
function leadWelcomeMessage(lead, phone) {
  const hi = lead.language === 'hi';
  const med = lead.medicine ? (hi ? ` (${lead.medicine})` : ` (${lead.medicine})`) : '';
  const lines = {
    en: {
      diabetes: `We'll remind you to take your diabetes medicine${med} on time, and you can send your sugar readings right here on WhatsApp.`,
      bp: `We'll remind you to take your BP medicine${med} on time, and you can send your BP readings right here on WhatsApp.`,
      thyroid: `We'll remind you to take your thyroid medicine${med} at the same time every day.`,
      heart: `We'll remind you to take your heart / cholesterol medicine${med} on time, every day.`,
      ivf: `Biomexa IVF Care keeps track of your injections, scans and clinic visits, with reminders on WhatsApp.`,
      general: `We'll remind you to take your medicine${med} on time, every day.`
    },
    hi: {
      diabetes: `हम आपको शुगर की दवा${med} समय पर लेने की याद दिलाएंगे, और आप अपनी शुगर रीडिंग यहीं WhatsApp पर भेज सकते हैं।`,
      bp: `हम आपको बीपी की दवा${med} समय पर लेने की याद दिलाएंगे, और आप अपनी बीपी रीडिंग यहीं WhatsApp पर भेज सकते हैं।`,
      thyroid: `हम आपको थायराइड की दवा${med} रोज़ एक ही समय पर लेने की याद दिलाएंगे।`,
      heart: `हम आपको दिल / कोलेस्ट्रॉल की दवा${med} रोज़ समय पर लेने की याद दिलाएंगे।`,
      ivf: `Biomexa IVF Care आपके इंजेक्शन, स्कैन और क्लिनिक विज़िट का ध्यान रखता है, WhatsApp पर रिमाइंडर के साथ।`,
      general: `हम आपको आपकी दवा${med} रोज़ समय पर लेने की याद दिलाएंगे।`
    }
  };
  const L = lines[hi ? 'hi' : 'en'];
  const what = L[lead.segment] || L.general;
  const link = leadSignupLink(lead, phone);
  if (hi) {
    return `🙏 धन्यवाद! चलिए आपके मुफ़्त दवा रिमाइंडर शुरू करते हैं।\n\n${what}\n\n` +
      `👉 साइन अप करने के लिए टैप करें (1 मिनट):\n${link}\n\n` +
      (lead.segment === 'ivf' ? '' : `आपका WhatsApp नंबर पहले से भरा हुआ है।\n\n`) +
      `कोई सवाल? यहीं जवाब दें। — टीम Biomexa 💙`;
  }
  return `🙏 Thank you! Let's set up your free medicine reminders.\n\n${what}\n\n` +
    `👉 Tap to sign up (takes 1 minute):\n${link}\n\n` +
    (lead.segment === 'ivf' ? '' : `Your WhatsApp number is already filled in, so your reminders come right here.\n\n`) +
    `Have a question? Just reply here. — Team Biomexa 💙`;
}

// Business-initiated WhatsApp messages in the last 24h (lead invites + patient offers) —
// this is what Meta's daily messaging limit counts.
async function sentLast24hTotal() {
  const since = new Date(Date.now() - 24 * 3600000);
  const [a, b] = await Promise.all([
    Lead.countDocuments({ sentAt: { $gte: since } }),
    Patient.countDocuments({ lastAdSentAt: { $gte: since } })
  ]);
  return a + b;
}

// Reads any contact table (CSV text from the browser — Excel, Word, PDF, VCF, photos etc. are
// turned into CSV on the admin page first). Finds the number column from the values, and the
// name / condition / medicine / city / doctor / age / gender / language columns from the header.
const LEAD_MAX_CONTACTS = 50000;
const COLUMN_ROLES = [
  ['doctor', /doctor|\bdr\b|physician|consultant|referred|reference|prescriber/],
  ['number', /number|phone|mobile|contact|whatsapp|cell|\bmob\b|\bph\b|\btel\b/],
  ['notes', /notes?|remarks?|comments?|details|description|line/],
  ['medicine', /medicine|medication|drug|\brx\b|prescri|tablet|product|brand|molecule|treatment/],
  ['condition', /condition|disease|diagnos|illness|problem|complaint|ailment|indication|therapy|speciality|specialty|department/],
  ['name', /name|patient|customer|client|person/],
  ['city', /city|town|location|area|district|address|place|village|state|pin|locality/],
  ['age', /\bage\b|dob|birth|years/],
  ['gender', /gender|\bsex\b/],
  ['language', /language|\blang\b/]
];

function parseContactsCsv(csv) {
  const rows = parseCsvText(csv);
  if (!rows.length) throw new Error('The file is empty.');
  const first = rows[0].map(h => String(h).trim().toLowerCase());
  const hasHeader = !first.some(v => leadPhone(v)) && first.some(v => /[a-zऀ-ॿ]/.test(v));
  const body = hasHeader ? rows.slice(1) : rows;
  if (!body.length) throw new Error('The file has a header row but no contacts.');
  if (body.length > LEAD_MAX_CONTACTS) throw new Error(`This file has ${body.length.toLocaleString('en-IN')} rows — please split it into files of up to ${LEAD_MAX_CONTACTS.toLocaleString('en-IN')}.`);
  const width = Math.max(...rows.map(r => r.length));
  const sample = body.length > 2000 ? body.filter((_, i) => i % Math.ceil(body.length / 2000) === 0) : body;
  const score = (col, test) => sample.reduce((n, r) => n + (test(String(r[col] || '').trim()) ? 1 : 0), 0);
  const pick = (test, exclude) => {
    let best = -1, bestScore = 0;
    for (let c = 0; c < width; c++) { if (exclude.has(c)) continue; const s = score(c, test); if (s > bestScore) { best = c; bestScore = s; } }
    return best;
  };
  // Each role: header candidates are checked against what the column actually contains, so
  // "statname" (state) isn't taken as Name and "EmailAddress" isn't taken as City.
  const isName = v => /^[A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F .'-]{1,59}$/.test(v) && !/\d|@/.test(v);
  const VALID = {
    number: v => !!leadPhone(v),
    name: isName,
    city: v => /^[A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F .,'()\/-]{1,80}$/.test(v),
    age: v => { const n = parseInt(v, 10); return (n >= 1 && n <= 120) || /\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/.test(v); },
    gender: v => /^(m|f|o|male|female|other|1|2|3|पुरुष|महिला)$/i.test(v)
  };
  const NOT_ROLE = {
    name: /stat|state|father|mother|husband|wife|guardian|parent|e-?mail|user|login|doctor|\bdr\b|company|org|file|hospital|clinic|city|district|village|block|tehsil|school|college|relation|nominee|\bid\b/,
    number: /e-?mail|aadha|pin ?code|zip|account|amount|serial|\bs\.? ?no\b|\bsr\b|\bid\b|landline|fax/,
    city: /e-?mail|mail|web|url|ip/,
    condition: /e-?mail/, medicine: /e-?mail/
  };
  const EXACT = { name: /^(full ?name|name|patient ?name|candidate ?name|customer ?name|client ?name|person ?name|first ?name)$/ };
  const cols = {};
  const taken = () => new Set(Object.values(cols).filter(i => i >= 0));
  if (hasHeader) {
    for (const [role, re] of COLUMN_ROLES) {
      const t = taken();
      const cands = first.map((h, i) => i).filter(i => !t.has(i) && re.test(first[i]) && !(NOT_ROLE[role] && NOT_ROLE[role].test(first[i])));
      if (!cands.length) continue;
      const ranked = cands.map(i => ({ i, exact: EXACT[role] && EXACT[role].test(first[i]) ? 1 : 0, fit: VALID[role] ? score(i, VALID[role]) / Math.max(1, score(i, v => v !== '')) : 1 }))
        .filter(c => !VALID[role] || c.fit >= 0.5)
        .sort((a, b) => b.exact - a.exact || b.fit - a.fit);
      if (ranked.length) cols[role] = ranked[0].i;
    }
  }
  if (cols.number === undefined || score(cols.number, VALID.number) < sample.length * 0.3) {
    const t = taken(); if (cols.number !== undefined) t.delete(cols.number);
    cols.number = pick(VALID.number, t);
  }
  if (cols.number === -1) throw new Error('Could not find any Indian mobile numbers in this file.');
  if (cols.name === undefined) {
    const t = taken();
    first.forEach((h, i) => { if (hasHeader && NOT_ROLE.name.test(h)) t.add(i); });
    const n = pick(isName, t);
    if (n >= 0 && score(n, isName) >= sample.length * 0.3) cols.name = n;
  }
  const get = (r, role) => cols[role] !== undefined && cols[role] >= 0 ? String(r[cols[role]] || '').trim() : '';
  return {
    columns: Object.fromEntries(Object.entries(cols).filter(([, i]) => i >= 0).map(([role, i]) => [role, hasHeader ? String(rows[0][i]).trim() : `column ${i + 1}`])),
    contacts: body.map(r => ({
      rawNumber: get(r, 'number'),
      name: get(r, 'name').slice(0, 60),
      condition: get(r, 'condition'), medicine: get(r, 'medicine'), city: get(r, 'city'), doctor: get(r, 'doctor'),
      age: get(r, 'age'), gender: get(r, 'gender'), language: get(r, 'language'),
      // Everything else on the row is still searched for conditions / medicines.
      notes: r.join(' ').slice(0, 600)
    }))
  };
}

// Sorts every contact into: invite (new to Biomexa), offer (registered patient), or skipped (why),
// and works out each new contact's profile and the message they will get.
async function analyzeContacts(contacts, gapDays) {
  const cutoff = new Date(Date.now() - gapDays * 86400000);
  const fmt = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const patients = await Patient.find().select('name phone adOptOut lastAdSentAt').lean();
  const byKey = new Map();
  for (const p of patients) { const k = last10(p.phone); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }
  const phones = contacts.map(c => leadPhone(c.rawNumber)).filter(Boolean);
  const leads = new Map();
  for (let i = 0; i < phones.length; i += 5000) {
    (await Lead.find({ phone: { $in: phones.slice(i, i + 5000) } }).lean()).forEach(l => leads.set(l.phone, l));
  }
  const out = [];
  const seen = new Set();
  for (const c of contacts) {
    const phone = leadPhone(c.rawNumber);
    const profile = leadProfile(c);
    const base = { name: c.name, ...profile };
    if (!phone) { if (c.rawNumber || c.name) out.push({ ...base, group: 'skipped', phone: c.rawNumber, reason: 'Not a valid mobile number' }); continue; }
    if (seen.has(phone)) { out.push({ ...base, group: 'skipped', phone, reason: 'Duplicate in this file' }); continue; }
    seen.add(phone);
    const twins = byKey.get(last10(phone));
    if (twins) {
      const main = twins.find(p => !/\s/.test(p.phone)) || twins[0];
      const pname = main.name || c.name;
      const last = twins.map(p => p.lastAdSentAt).filter(Boolean).sort((a, b) => b - a)[0];
      if (twins.some(p => p.adOptOut)) out.push({ ...base, group: 'skipped', name: pname, phone: main.phone, reason: 'Patient replied STOP to offers' });
      else if (last && last > cutoff) out.push({ ...base, group: 'skipped', name: pname, phone: main.phone, reason: `Patient — already got an offer on ${fmt(last)}` });
      else out.push({ ...base, group: 'offer', name: pname, phone: main.phone, patientId: main._id, reason: 'Registered patient → Biomexa Care offer (based on their plan)', template: MSG91_AD_TEMPLATE_NAME });
      continue;
    }
    const lead = leads.get(phone);
    if (lead && lead.status === 'optout') out.push({ ...base, group: 'skipped', phone, reason: 'Replied STOP to our invite' });
    else if (lead && lead.status === 'joined') out.push({ ...base, group: 'skipped', phone, reason: 'Already signed up' });
    else if (lead && lead.sentAt && lead.sentAt > cutoff) out.push({ ...base, group: 'skipped', phone, reason: `Already invited on ${fmt(lead.sentAt)}` });
    else {
      const tpl = leadTemplateFor(profile.segment);
      out.push({ ...base, group: 'invite', phone, leadId: lead ? lead._id : null, template: tpl.name,
        reason: `New contact → ${SEGMENT_LABEL[profile.segment]} invite` + (profile.medicine ? ` · reply mentions ${profile.medicine}` : '') + (profile.language === 'hi' ? ' · Hindi reply' : '') });
    }
  }
  const order = { offer: 0, invite: 1, skipped: 2 };
  out.sort((a, b) => order[a.group] - order[b.group] || String(a.segment).localeCompare(String(b.segment)) || String(a.name).localeCompare(String(b.name)));
  return out;
}

// What the list contains — shown above the send button.
function summarizeAnalysis(rows) {
  const summary = { total: rows.length, invite: 0, offer: 0, skipped: 0 };
  const segments = {}, cities = {}, skipReasons = {};
  let withName = 0, withMedicine = 0, withCity = 0, hindi = 0;
  for (const r of rows) {
    summary[r.group]++;
    if (r.group === 'skipped') { const k = r.reason.replace(/ on \d.*$/, '').replace(/—.*$/, '').trim(); skipReasons[k] = (skipReasons[k] || 0) + 1; continue; }
    segments[r.segment] = (segments[r.segment] || 0) + 1;
    if (r.city) { const k = r.city.split(/[,-]/)[0].trim().replace(/\b\w/g, x => x.toUpperCase()); cities[k] = (cities[k] || 0) + 1; }
    if (r.name) withName++;
    if (r.medicine) withMedicine++;
    if (r.city) withCity++;
    if (r.language === 'hi') hindi++;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
  const reach = summary.invite + summary.offer;
  return {
    summary,
    insights: {
      segments: top(segments, 10).map(s => ({ ...s, label: SEGMENT_LABEL[s.key] || s.key })),
      cities: top(cities, 6),
      skipReasons: top(skipReasons, 6),
      withName, withMedicine, withCity, hindi, reach
    }
  };
}

async function campaignContext() {
  const sent = await sentLast24hTotal();
  const hour = istHour();
  return {
    dailyLimit: LEAD_DAILY_LIMIT,
    sentLast24h: sent,
    remainingToday: Math.max(0, LEAD_DAILY_LIMIT - sent),
    withinSendHours: hour >= LEAD_SEND_START_HOUR && hour < LEAD_SEND_END_HOUR,
    inviteTemplateReady: !!(MSG91_CONFIGURED && MSG91_LEAD_TEMPLATE_NAME),
    offerTemplateReady: !!(MSG91_CONFIGURED && MSG91_AD_TEMPLATE_NAME),
    inviteTemplate: MSG91_LEAD_TEMPLATE_NAME,
    offerTemplate: MSG91_AD_TEMPLATE_NAME
  };
}

const clampGap = v => Math.min(30, Math.max(1, parseInt(v, 10) || 7));

app.get('/api/admin/leads', adminAuth, async (req, res) => {
  try {
    await syncJoinedLeads();
    const [grouped, leads, ctx] = await Promise.all([
      Lead.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      Lead.find().sort({ createdAt: -1 }).limit(2000).lean(),
      campaignContext()
    ]);
    const counts = { new: 0, sent: 0, failed: 0, replied: 0, joined: 0, optout: 0 };
    grouped.forEach(g => { counts[g._id] = g.n; });
    res.json({
      counts, ...ctx, job: leadJob, queue: await queueStatus(),
      leads: leads.map(l => ({ id: l._id, name: l.name, phone: l.phone, source: l.source, status: l.status, segment: l.segment || 'general', medicine: l.medicine || '', city: l.city || '', language: l.language || 'en', sentAt: l.sentAt, repliedAt: l.repliedAt, createdAt: l.createdAt, lastError: l.lastError || '' }))
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== Automatic invite queue ==========
// Every upload adds its new contacts to one first-in-first-out queue. While auto-send is ON
// (the default), the server checks every 10 minutes during sending hours and invites the oldest
// waiting contacts, up to the daily limit — so list after list goes out on its own, day by day.
const AppSetting = mongoose.model('AppSetting', new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed }, { timestamps: true }));
let autoQueueCache = null;
async function getAutoQueue() {
  if (autoQueueCache === null) {
    const row = await AppSetting.findOne({ key: 'leadAutoQueue' }).lean();
    autoQueueCache = row ? !!row.value : true;
  }
  return autoQueueCache;
}
async function setAutoQueue(on) {
  autoQueueCache = !!on;
  await AppSetting.updateOne({ key: 'leadAutoQueue' }, { value: !!on }, { upsert: true });
}

function startLeadJob(items, by) {
  leadJob = { running: true, total: items.length, sent: 0, failed: 0, invites: 0, offers: 0, errors: [], startedAt: new Date(), finishedAt: null, by };
  runLeadCampaign(items)
    .catch(err => console.log('⚠️ Campaign error:', err.message))
    .finally(() => {
      leadJob.running = false; leadJob.finishedAt = new Date();
      console.log(`📨 WhatsApp campaign (${leadJob.by}): ${leadJob.offers} offers + ${leadJob.invites} invites sent, ${leadJob.failed} failed of ${leadJob.total}`);
    });
}

// Oldest waiting contacts first, up to `room` of them.
async function nextQueueBatch(room, retryFailed = false) {
  if (room <= 0) return [];
  await syncJoinedLeads();
  const statuses = retryFailed ? ['new', 'failed'] : ['new'];
  const batch = await Lead.find({ status: { $in: statuses } }).sort({ createdAt: 1, _id: 1 }).limit(room).select('_id').lean();
  return batch.map(l => ({ kind: 'invite', leadId: l._id }));
}

async function processLeadQueue(by) {
  if (leadJob.running) return { started: false, reason: 'A campaign is already sending.' };
  if (!(MSG91_CONFIGURED && MSG91_LEAD_TEMPLATE_NAME)) return { started: false, reason: 'Invite template not set up.' };
  const hour = istHour();
  if (hour < LEAD_SEND_START_HOUR || hour >= LEAD_SEND_END_HOUR) return { started: false, reason: 'Outside sending hours.' };
  // A send interrupted by a restart: don't risk a duplicate — mark it failed (retry from the page).
  await Lead.updateMany({ status: 'sending', updatedAt: { $lt: new Date(Date.now() - 30 * 60000) } }, { status: 'failed', lastError: 'Interrupted by a server restart — use "Retry failed" to send again' });
  const room = LEAD_DAILY_LIMIT - await sentLast24hTotal();
  if (room <= 0) return { started: false, reason: 'Daily limit reached.' };
  const items = await nextQueueBatch(room);
  if (!items.length) return { started: false, reason: 'Queue is empty.' };
  startLeadJob(items, by);
  return { started: true, count: items.length };
}

setInterval(async () => {
  try {
    if (mongoose.connection.readyState !== 1 || !(await getAutoQueue())) return;
    const r = await processLeadQueue('auto queue');
    if (r.started) console.log(`🤖 Auto queue: inviting the next ${r.count} waiting contact(s)`);
  } catch (err) { console.log('⚠️ Auto queue error:', err.message); }
}, 10 * 60 * 1000);

async function queueStatus() {
  const [waiting, failed] = await Promise.all([Lead.countDocuments({ status: 'new' }), Lead.countDocuments({ status: 'failed' })]);
  return { autoQueue: await getAutoQueue(), waiting, failed, daysToFinish: waiting ? Math.ceil(waiting / LEAD_DAILY_LIMIT) : 0 };
}

app.post('/api/admin/leads/auto', adminAuth, async (req, res) => {
  try {
    await setAutoQueue(req.body?.enabled === true);
    let kicked = null;
    if (req.body?.enabled === true) kicked = await processLeadQueue('auto queue');
    console.log(`🤖 Auto queue turned ${req.body?.enabled === true ? 'ON' : 'OFF'} by ${req.admin?.username || 'admin'}`);
    res.json({ ...(await queueStatus()), kicked, job: leadJob });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Step 1 — Body: { csv, gapDays }. Reads and sorts the list; nothing is saved or sent.
app.post('/api/admin/leads/analyze', adminAuth, async (req, res) => {
  try {
    let parsed;
    try { parsed = parseContactsCsv(req.body?.csv); } catch (e) { return res.status(400).json({ message: e.message }); }
    const gapDays = clampGap(req.body?.gapDays);
    const rows = await analyzeContacts(parsed.contacts, gapDays);
    const { summary, insights } = summarizeAnalysis(rows);
    const MAX_ROWS = 5000; // the page shows a sample; counts above cover everyone
    res.json({
      summary, insights, columns: parsed.columns, gapDays, ...(await campaignContext()),
      rowsTruncated: rows.length > MAX_ROWS,
      rows: rows.slice(0, MAX_ROWS).map(({ patientId, leadId, ...r }) => r)
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Turns a photo or scanned PDF of a contact list into CSV with AI vision (Gemini, then Claude).
// Body: { fileData: base64, fileType: 'image/jpeg' | 'application/pdf' | ... }
const CONTACT_EXTRACT_PROMPT = `This file is a list of people (patients / customers / contacts), possibly a photo of a handwritten or printed register. Extract EVERY person with an Indian mobile number.
Return ONLY JSON, no prose: {"contacts":[{"name":"","phone":"","condition":"","medicine":"","city":"","doctor":"","age":"","gender":"","notes":""}]}
Rules: copy phone numbers digit-for-digit exactly as written (never guess or complete missing digits; skip a person if the number is unreadable). Leave a field "" if it is not in the file. "condition" = disease / problem written for that person; "medicine" = medicine names written for them; "notes" = anything else on their row. Keep names as written (Hindi stays Hindi).`;

app.post('/api/admin/leads/extract', adminAuth, async (req, res) => {
  try {
    const fileType = String(req.body?.fileType || '');
    const fileData = String(req.body?.fileData || '');
    if (!/^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/.test(fileType) || !fileData) {
      return res.status(400).json({ message: 'Send a photo (JPG / PNG / WEBP / HEIC) or a PDF.' });
    }
    if (fileData.length > 20 * 1024 * 1024) return res.status(400).json({ message: 'File is too big for AI reading — please keep photos / scans under 15 MB.' });
    if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) return res.status(400).json({ message: 'AI reading of photos and scans isn\'t switched on — add GEMINI_API_KEY (free) on Render, or upload the list as Excel / CSV.' });
    let text = null;
    if (GEMINI_API_KEY) {
      const parts = [{ text: CONTACT_EXTRACT_PROMPT }, { inline_data: { mime_type: fileType, data: fileData } }];
      for (let i = 0; i < GEMINI_MODELS.length && !text; i++) {
        try { const r = await callGeminiModel(GEMINI_MODELS[i], parts, i === GEMINI_MODELS.length - 1 ? 2 : 1); if (r.ok && r.analysis.includes('{')) text = r.analysis; }
        catch (err) { console.log(`⚠️ ${GEMINI_MODELS[i]} contact extraction error:`, err.message); }
      }
    }
    if (!text && ANTHROPIC_API_KEY && fileType !== 'image/heic' && fileType !== 'image/heif') {
      try {
        const block = fileType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
          : { type: 'image', source: { type: 'base64', media_type: fileType, data: fileData } };
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16000, messages: [{ role: 'user', content: [block, { type: 'text', text: CONTACT_EXTRACT_PROMPT }] }] }),
          signal: AbortSignal.timeout(120000)
        });
        const d = await r.json();
        if (r.ok) text = d.content?.find(b => b.type === 'text')?.text || null;
      } catch (err) { console.log('⚠️ Claude contact extraction error:', err.message); }
    }
    if (!text) return res.status(502).json({ message: 'The AI couldn\'t read this file right now. Try a clearer photo, or upload the list as Excel / CSV.' });
    let list = [];
    try { const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); list = Array.isArray(j.contacts) ? j.contacts : []; } catch { list = []; }
    const fields = ['name', 'phone', 'condition', 'medicine', 'city', 'doctor', 'age', 'gender', 'notes'];
    const q = v => '"' + String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
    const rowsOut = list.filter(c => c && c.phone).map(c => fields.map(f => q(c[f])).join(','));
    if (!rowsOut.length) return res.status(400).json({ message: 'No mobile numbers could be read from this file.' });
    res.json({ count: rowsOut.length, csv: fields.join(',') + '\n' + rowsOut.join('\n') });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Step 2 — one click. Body: { csv, gapDays, source, consent: true } to send to a new list, or
// { waitingOnly: true, consent: true, retryFailed } to continue with contacts still waiting from
// earlier uploads (the daily limit leaves the rest for the next day).
app.post('/api/admin/leads/campaign', adminAuth, async (req, res) => {
  try {
    if (req.body?.consent !== true) return res.status(400).json({ message: 'Please tick the box confirming these people agreed to be contacted by Biomexa on WhatsApp.' });
    if (leadJob.running) return res.status(409).json({ message: 'A campaign is already sending. Please wait for it to finish.' });
    const hour = istHour();
    const inHours = hour >= LEAD_SEND_START_HOUR && hour < LEAD_SEND_END_HOUR;
    if (!inHours && req.body?.waitingOnly) {
      return res.status(400).json({ message: `WhatsApp promotions only go out between ${LEAD_SEND_START_HOUR} AM and ${LEAD_SEND_END_HOUR - 12} PM (India time). Please try again then.` });
    }
    const ctx = await campaignContext();
    if (!inHours) ctx.remainingToday = 0; // outside hours a new list is only saved to the queue
    const notes = [];
    let queue;

    if (req.body?.waitingOnly) {
      if (!ctx.inviteTemplateReady) return res.status(400).json({ message: 'The invite template isn\'t set up yet.' });
      const retry = !!req.body?.retryFailed;
      if (!(await Lead.countDocuments({ status: { $in: retry ? ['new', 'failed'] : ['new'] } }))) return res.status(400).json({ message: retry ? 'Nothing waiting or failed.' : 'No contacts are waiting.' });
      queue = await nextQueueBatch(ctx.remainingToday, retry);
      const left = await Lead.countDocuments({ status: 'new' }) - queue.length;
      if (left > 0 && queue.length) notes.push(`${left} more stay in the queue${(await getAutoQueue()) ? ' and go out automatically on the next days' : ''}.`);
    } else {
      let parsed;
      try { parsed = parseContactsCsv(req.body?.csv); } catch (e) { return res.status(400).json({ message: e.message }); }
      const gapDays = clampGap(req.body?.gapDays);
      const source = String(req.body?.source || '').trim().slice(0, 80);
      const rows = await analyzeContacts(parsed.contacts, gapDays);
      const profileOf = r => ({ segment: r.segment, condition: r.condition, medicine: r.medicine, city: r.city, doctor: r.doctor, age: r.age, gender: r.gender, language: r.language });

      // New contacts are always saved (with their profile), even if today's limit is used up.
      let invites = rows.filter(r => r.group === 'invite');
      const newDocs = invites.filter(r => !r.leadId).map(r => ({ name: r.name, phone: r.phone, source, uploadedBy: req.admin?.username || 'admin', ...profileOf(r) }));
      for (let i = 0; i < newDocs.length; i += 2000) {
        try { await Lead.insertMany(newDocs.slice(i, i + 2000), { ordered: false }); } catch (e) { /* a duplicate raced in — fine */ }
      }
      // Existing leads in the list: keep their profile up to date with what this file says.
      const updates = invites.filter(r => r.leadId).map(r => ({ updateOne: { filter: { _id: r.leadId }, update: { $set: Object.fromEntries(Object.entries({ ...profileOf(r), ...(source ? { source } : {}) }).filter(([, v]) => v)) } } }));
      for (let i = 0; i < updates.length; i += 2000) await Lead.bulkWrite(updates.slice(i, i + 2000), { ordered: false });
      if (newDocs.length) {
        const ids = new Map();
        for (let i = 0; i < newDocs.length; i += 5000) {
          (await Lead.find({ phone: { $in: newDocs.slice(i, i + 5000).map(d => d.phone) } }).select('phone').lean()).forEach(l => ids.set(l.phone, l._id));
        }
        invites = invites.map(r => ({ ...r, leadId: r.leadId || ids.get(r.phone) }));
      }

      let offers = rows.filter(r => r.group === 'offer');
      if (!ctx.offerTemplateReady && offers.length) { notes.push(`${offers.length} patient offer${offers.length === 1 ? '' : 's'} not sent — offer template not set up.`); offers = []; }
      if (!ctx.inviteTemplateReady && invites.length) { notes.push(`${invites.length} new contact${invites.length === 1 ? '' : 's'} saved but not invited — invite template not set up.`); invites = []; }
      // Patient offers go now; new contacts join the back of the queue (oldest uploads go first).
      const offerItems = offers.map(r => ({ kind: 'offer', patientId: r.patientId, gapDays })).slice(0, ctx.remainingToday);
      const inviteItems = invites.length || (await Lead.countDocuments({ status: 'new' })) ? await nextQueueBatch(ctx.inviteTemplateReady ? ctx.remainingToday - offerItems.length : 0) : [];
      queue = [...offerItems, ...inviteItems];
      const all = offers.length + invites.length;
      const waitingAfter = (await Lead.countDocuments({ status: 'new' })) - inviteItems.length;
      if (waitingAfter > 0) notes.push(`${waitingAfter.toLocaleString('en-IN')} contact${waitingAfter === 1 ? '' : 's'} in the queue` + ((await getAutoQueue()) ? ` — they go out automatically, about ${LEAD_DAILY_LIMIT} a day (≈ ${Math.ceil(waitingAfter / LEAD_DAILY_LIMIT)} day${Math.ceil(waitingAfter / LEAD_DAILY_LIMIT) === 1 ? '' : 's'}).` : '. Auto-send is OFF — turn it on or press "Send now" each day.'));
      if (!all && !queue.length) return res.status(400).json({ message: 'Nobody in this list needs a message right now — see the reasons in the table.' + (notes.length ? ' ' + notes.join(' ') : '') });
    }

    if (!queue.length) {
      // Nothing can go out right now (limit used up) — but new contacts are saved in the queue.
      if (!req.body?.waitingOnly) return res.json({ message: `Added to the queue. Today's limit of ${ctx.dailyLimit} is used up, so nothing goes out right now.` + (notes.length ? ' ' + notes.join(' ') : ''), job: leadJob, queued: true });
      return res.status(400).json({ message: `Today's limit of ${ctx.dailyLimit} messages is used up.` + (notes.length ? ' ' + notes.join(' ') : '') });
    }

    startLeadJob(queue, req.admin?.username || 'admin');
    const nOffer = queue.filter(b => b.kind === 'offer').length, nInvite = queue.length - nOffer;
    res.status(202).json({
      message: `Sending now: ${nOffer} patient offer${nOffer === 1 ? '' : 's'} and ${nInvite} new-contact invite${nInvite === 1 ? '' : 's'}.` + (notes.length ? ' ' + notes.join(' ') : ''),
      job: leadJob
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Campaign Insights (admin-analytics.html): lead funnel, START / STOP responses, results per
// list source, day-by-day activity and the latest replies. Body-free GET; ?days=7|30|90|365.
app.get('/api/admin/leads/analytics', adminAuth, async (req, res) => {
  try {
    await syncJoinedLeads();
    const days = [7, 30, 90, 365].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
    const now = new Date();
    const since = new Date(now.getTime() - days * 86400000);
    const leads = await Lead.find().select('name phone source status segment medicine city createdAt sentAt repliedAt joinedAt optedOutAt lastError signupVia').lean();
    const inRange = d => d && d >= since;
    // A lead is "in range" when it was invited in the period (or uploaded, if never invited).
    const scoped = leads.filter(l => inRange(l.sentAt) || (!l.sentAt && inRange(l.createdAt)));

    const metrics = list => {
      const m = { uploaded: list.length, invited: 0, started: 0, stopped: 0, joined: 0, failed: 0, noReply: 0, startedJoined: 0, startedWaiting: 0, joinedViaWhatsApp: 0 };
      for (const l of list) {
        if (l.sentAt) m.invited++;
        if (l.repliedAt) m.started++;
        if (l.status === 'optout' || l.optedOutAt) m.stopped++;
        if (l.status === 'joined') m.joined++;
        if (l.repliedAt && l.status === 'joined') m.startedJoined++;
        if (l.repliedAt && l.status === 'replied') m.startedWaiting++;
        if (l.status === 'joined' && l.signupVia === 'whatsapp') m.joinedViaWhatsApp++;
        if (l.status === 'failed') m.failed++;
        if (l.status === 'sent') m.noReply++;
      }
      const pct = (a, b) => b ? Math.round((a / b) * 1000) / 10 : 0;
      m.responseRate = pct(m.started + m.stopped, m.invited);   // anyone who tapped a button
      m.startRate = pct(m.started, m.invited);
      m.stopRate = pct(m.stopped, m.invited);
      m.conversionRate = pct(m.joined, m.invited);              // invited → signed up
      m.startToJoin = pct(m.startedJoined, m.started);           // of those who tapped START, how many signed up
      return m;
    };
    const totals = metrics(scoped);

    // Median time from invite to START.
    const replyHours = scoped.filter(l => l.sentAt && l.repliedAt && l.repliedAt >= l.sentAt)
      .map(l => (l.repliedAt - l.sentAt) / 3600000).sort((a, b) => a - b);
    totals.medianReplyHours = replyHours.length ? Math.round(replyHours[Math.floor(replyHours.length / 2)] * 10) / 10 : null;
    // Invited 2+ days ago and never answered.
    totals.silent48h = scoped.filter(l => l.status === 'sent' && l.sentAt && (now - l.sentAt) > 48 * 3600000).length;

    const bySourceMap = new Map();
    for (const l of scoped) {
      const k = l.source || '(no source)';
      if (!bySourceMap.has(k)) bySourceMap.set(k, []);
      bySourceMap.get(k).push(l);
    }
    const bySource = [...bySourceMap.entries()].map(([source, list]) => ({ source, ...metrics(list) }))
      .sort((a, b) => b.invited - a.invited || b.uploaded - a.uploaded);
    const bySegMap = new Map();
    for (const l of scoped) { const k = l.segment || 'general'; if (!bySegMap.has(k)) bySegMap.set(k, []); bySegMap.get(k).push(l); }
    const bySegment = [...bySegMap.entries()].map(([segment, list]) => ({ segment, label: SEGMENT_LABEL[segment] || segment, ...metrics(list) }))
      .sort((a, b) => b.invited - a.invited || b.uploaded - a.uploaded);

    // Day-by-day (India time).
    const dayKey = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const daily = [];
    const idx = new Map();
    const span = Math.min(days, 90); // keep the chart readable; longer ranges show the last 90 days
    for (let i = span - 1; i >= 0; i--) {
      const k = dayKey(new Date(now.getTime() - i * 86400000));
      idx.set(k, daily.length);
      daily.push({ date: k, invited: 0, started: 0, stopped: 0, joined: 0 });
    }
    const bump = (d, field) => { if (!d) return; const i = idx.get(dayKey(d)); if (i !== undefined) daily[i][field]++; };
    for (const l of leads) { bump(l.sentAt, 'invited'); bump(l.repliedAt, 'started'); bump(l.optedOutAt, 'stopped'); bump(l.joinedAt, 'joined'); }

    // Latest button taps / sign-ups.
    const events = [];
    for (const l of leads) {
      if (l.repliedAt) events.push({ type: 'start', at: l.repliedAt, name: l.name, phone: l.phone, source: l.source, status: l.status, segment: l.segment || 'general' });
      if (l.optedOutAt) events.push({ type: 'stop', at: l.optedOutAt, name: l.name, phone: l.phone, source: l.source, status: l.status, segment: l.segment || 'general' });
      if (l.joinedAt) events.push({ type: 'joined', at: l.joinedAt, name: l.name, phone: l.phone, source: l.source, status: l.status, segment: l.segment || 'general' });
    }
    events.sort((a, b) => b.at - a.at);
    const shown = events.slice(0, 100);
    // For sign-ups, show what the person entered in their own account — not the name on the list.
    const joinedKeys = new Set(shown.filter(e => e.type === 'joined').map(e => last10(e.phone)));
    if (joinedKeys.size) {
      const accounts = await Patient.find().select('name phone age gender city medicines createdAt').lean();
      const byKey = new Map();
      accounts.forEach(p => { const k = last10(p.phone); if (joinedKeys.has(k) && (!byKey.has(k) || p.createdAt < byKey.get(k).createdAt)) byKey.set(k, p); });
      shown.forEach(e => {
        const p = e.type === 'joined' && byKey.get(last10(e.phone));
        if (!p) return;
        e.listName = e.name;
        e.name = p.name || e.name;
        e.signup = {
          age: p.age || null, gender: p.gender || '', city: p.city || '',
          medicines: [...new Set((p.medicines || []).filter(m => m.active !== false).map(m => m.name).filter(Boolean))].slice(0, 4),
          at: p.createdAt
        };
        if (p.createdAt) e.at = p.createdAt;
      });
      shown.sort((a, b) => new Date(b.at) - new Date(a.at));
    }

    // Registered-patient offers (biomexa_care_offer) — sends in the period + total opted out.
    const [offersSent, patientsOptedOut] = await Promise.all([
      Patient.countDocuments({ lastAdSentAt: { $gte: since } }),
      Patient.countDocuments({ adOptOut: true })
    ]);

    res.json({ days, totals, bySource, bySegment, daily, recent: shown, patientOffers: { sent: offersSent, optedOut: patientsOptedOut } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/admin/leads/:id', adminAuth, async (req, res) => {
  try {
    const r = await Lead.deleteOne({ _id: req.params.id });
    res.json({ message: r.deletedCount ? 'Lead deleted.' : 'Lead not found.' });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Admin adds a reminder for a patient (e.g. a new medicine or an extra dose time they asked for).
app.post('/api/admin/patients/:phone/reminders', adminAuth, async (req, res) => {
  try {
    const wanted = decodeURIComponent(req.params.phone);
    const patient = (await Patient.findOne({ phone: wanted })) || (await findAccountByPhone('patient', wanted));
    if (!patient) return res.status(404).json({ message: 'Patient not found.' });
    const name = String(req.body?.name || '').trim();
    const dosage = String(req.body?.dosage || '').trim();
    const foodNote = String(req.body?.foodNote || '').trim();
    const times = [...new Set((Array.isArray(req.body?.times) ? req.body.times : [req.body?.time]).filter(Boolean).map(String))];
    if (!name) return res.status(400).json({ message: 'Please enter the medicine name.' });
    if (!times.length || times.length > 4) return res.status(400).json({ message: 'Add 1 to 4 reminder times.' });
    if (times.some(t => !/^([01]\d|2[0-3]):([0-5]\d)$/.test(t))) return res.status(400).json({ message: 'Times must be HH:MM (24-hour), e.g. 08:00 or 21:30.' });
    const days = req.body?.durationDays ? parseInt(req.body.durationDays, 10) : null;
    if (days !== null && (isNaN(days) || days < 1 || days > 365)) return res.status(400).json({ message: 'Duration must be 1–365 days, or blank for ongoing.' });

    // An extra time for a medicine they already take is fine; the exact same time twice is not.
    const clash = (patient.medicines || []).filter(m => m.active && m.name.trim().toLowerCase() === name.toLowerCase() && times.includes(m.time)).map(m => m.time);
    if (clash.length) return res.status(409).json({ message: `${name} already has a reminder at ${clash.join(', ')}.` });

    const startDate = new Date();
    const endDate = days ? new Date(startDate.getTime() + days * 86400000) : null;
    patient.medicines.push(...times.map(t => ({ name, dosage, time: t, frequency: 'daily', foodNote, active: true, durationDays: days, startDate, endDate })));
    await patient.save();

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = localDateStr(now);
    const todayTimes = [], tomorrowTimes = [];
    for (const t of times) {
      if (startsTomorrow(t, currentTime)) { tomorrowTimes.push(t); continue; }
      const exists = await Dose.findOne({ patientPhone: patient.phone, medicineName: name, scheduledTime: t, scheduledDate: today });
      if (!exists) await Dose.create({ patientPhone: patient.phone, medicineName: name, dosage, scheduledTime: t, scheduledDate: today, foodNote, status: 'pending' });
      todayTimes.push(t);
    }
    const when = tomorrowTimes.length && !todayTimes.length ? ' starting tomorrow' : '';
    const wa = await sendWhatsAppFree(patient.phone,
      `💊 *New reminder added*\n\nHi ${String(patient.name || '').split(' ')[0] || 'there'}, Biomexa has set a reminder for *${name}*${dosage ? ` (${dosage})` : ''} at ${times.join(' & ')} daily${when}.${days ? `\n📅 For ${days} day${days > 1 ? 's' : ''}.` : ''}\n\nYou'll get a WhatsApp message at each time — tap *Taken* once you've had it.\n\n- Biomexa Team`);
    console.log(`🗓️ Reminder set by admin: ${patient.phone} — ${name} at ${times.join(', ')}${logDuration(days)}`);
    res.json({ message: `Reminder added for ${patient.name}: ${name} at ${times.join(', ')}${when}.`, whatsappSent: !!wa?.success });
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
    const patients = await Patient.find();
    const results = { sent: [], failed: [], skipped_low_risk: 0 };

    for (const p of patients) {
      const r = await computeRiskScore(p);
      const riskProb = r.score;
      if (r.label !== 'High' && r.label !== 'Critical') { results.skipped_low_risk++; continue; }

      const label = r.label;
      const reason = r.reasons.slice(0, 2).join('; ') || `risk ${Math.round(riskProb * 100)}%`;

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
      const r = await computeRiskScore(p);
      if (r.adherenceKnown) { sumAdh += r.adherence; counted++; }
      if (r.label === 'High' || r.label === 'Critical') highRisk++;
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

// Public status check — lets the frontend know whether MSG91 (Biomexa's sole WhatsApp
// provider) is configured server-side. No auth needed — this is not sensitive, just a
// feature-availability flag.
app.get('/api/whatsapp-status', (req, res) => {
  res.json({
    msg91Configured: MSG91_CONFIGURED,
    riskTemplateConfigured: !!MSG91_RISK_TEMPLATE_NAME,
    welcomeTemplateConfigured: !!MSG91_WELCOME_TEMPLATE_NAME,
    doctorAlertTemplateConfigured: !!MSG91_DOCTOR_ALERT_TEMPLATE_NAME,
    treatmentReportTemplateConfigured: !!MSG91_TREATMENT_REPORT_TEMPLATE_NAME,
    reportAnalysisTemplateConfigured: !!MSG91_REPORT_ANALYSIS_TEMPLATE_NAME,
    otpTemplateConfigured: !!MSG91_OTP_TEMPLATE_NAME,
    loginTemplateConfigured: !!MSG91_LOGIN_TEMPLATE_NAME,
    courseTemplateConfigured: !!MSG91_COURSE_TEMPLATE_NAME,
    adTemplateConfigured: !!MSG91_AD_TEMPLATE_NAME,
    paymentsConfigured: PAYMENTS_CONFIGURED
  });
});

// Lightweight, dependency-free liveness check — deliberately does NOT touch the database, so it
// stays accurate (and fast) even during a Mongo hiccup. This exists specifically to be pinged by
// an external uptime monitor every few minutes: Render's free tier puts the service to sleep
// after ~15 minutes of no incoming traffic, and every sleep/wake cycle is exactly what caused
// dose reminders to be missed or delayed. A regular external ping is the real, permanent fix —
// it keeps the process (and its once-a-minute reminder cron) running continuously instead of
// depending on patient/doctor traffic to wake it back up.
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', time: new Date().toISOString() }));

// ========== BIOMEXA IVF CARE ==========
// Completely separate feature area (own collections, own /api/ivf routes, own pages ivf.html and
// ivf-doctor.html). It only borrows the existing logins and WhatsApp senders, passed in here.
ivfCare.mount(app, {
  auth, doctorAuth, Patient, Doctor, ConversationState,
  phoneVariants, localDateStr, SITE_URL,
  sendWhatsAppFree, sendDoseReminderTemplate, sendRiskAlertTemplate, sendDoctorAlertMessage,
  sendIvfUpdateTemplate, sendReportAnalysisTemplate, whatsappWindowOpen,
  analyzeDocument, extractReportResults, ALLOWED_DOCUMENT_TYPES, MAX_FILES_PER_UPLOAD, MAX_DOCUMENT_BASE64_LENGTH,
  disableScheduler: process.env.IVF_SCHEDULER_DISABLED === 'true'
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
