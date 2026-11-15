// ========== BIOMEXA — MSG91 WHATSAPP TEMPLATE SYNC ==========
// Reads the templates on the MSG91 account (Get Templates API) and lines every message type the
// server sends up with an APPROVED template:
//   • a template named in Render (MSG91_*_TEMPLATE_NAME) is used if it is approved — with ITS
//     language code and namespace, so "en" vs "en_US" or a stale namespace can't break sends
//   • a type with no name set (or a name that isn't approved) is matched to an approved template
//     whose name clearly fits that type AND whose variable count matches — never on count alone,
//     so a patient can never get the wrong kind of message
//   • variables are fitted to the template at send time: named templates get their own variable
//     names, positional ones get plain {{1}}, {{2}} … values, extra values are dropped
// MSG91's send API answers "success / in process" even when the template doesn't match (the
// failure only shows in delivery reports), so this check is the only early warning.

const TYPES = {
  dose:            { label: 'Dose reminder',               env: 'MSG91_DOSE_TEMPLATE_NAME',            vars: 2, re: /dose|medicine_rem|med_rem|reminder/i, not: /renew|course|lead|invite|signup/i },
  risk:            { label: 'Risk / adherence alert',      env: 'MSG91_RISK_TEMPLATE_NAME',            vars: 3, re: /risk|adherence_alert|health_check/i },
  doctor_alert:    { label: 'Doctor alert',                env: 'MSG91_DOCTOR_ALERT_TEMPLATE_NAME',    vars: 4, re: /doctor.*(alert|urgent)|(alert|urgent).*doctor/i },
  welcome:         { label: 'Welcome (new patient)',       env: 'MSG91_WELCOME_TEMPLATE_NAME',         vars: 1, re: /welcome|onboard/i },
  treatment_report:{ label: 'Treatment report',            env: 'MSG91_TREATMENT_REPORT_TEMPLATE_NAME', vars: 5, re: /treatment.*report|report.*treatment|effectiveness/i },
  report_analysis: { label: 'Report / prescription analysis', env: 'MSG91_REPORT_ANALYSIS_TEMPLATE_NAME', vars: 3, re: /analys|lab_report|prescription|document/i },
  otp:             { label: 'OTP (authentication)',        env: 'MSG91_OTP_TEMPLATE_NAME',             vars: 1, re: /otp|verif|auth_code|one_time/i, category: 'AUTHENTICATION' },
  login:           { label: 'Portal login details',        env: 'MSG91_LOGIN_TEMPLATE_NAME',           vars: 2, re: /login|portal|account_access/i },
  signup:          { label: 'Sign-up follow-up',           env: 'MSG91_SIGNUP_TEMPLATE_NAME',          vars: 2, re: /signup|sign_up|follow_?up/i },
  ivf_update:      { label: 'IVF update',                  env: 'MSG91_IVF_UPDATE_TEMPLATE_NAME',      vars: 2, re: /ivf/i },
  renewal:         { label: 'Renewal / trial ended',       env: 'MSG91_RENEWAL_TEMPLATE_NAME',         vars: 3, re: /renew|subscri|trial|care_plan|plan_end/i },
  order:           { label: 'Medicine order update',       env: 'MSG91_ORDER_TEMPLATE_NAME',           vars: 3, re: /order/i },
  course:          { label: 'Course complete / refill',    env: 'MSG91_COURSE_TEMPLATE_NAME',          vars: 3, re: /course|refill/i },
  ad:              { label: '10-day product message',      env: 'MSG91_AD_TEMPLATE_NAME',              vars: null, re: /product|promo|offer|ad_|marketing/i },
  lead:            { label: 'Lead invite',                 env: 'MSG91_LEAD_TEMPLATE_NAME',            vars: null, re: /lead|invite/i },
  receipt:         { label: 'Payment receipt + invoice',   env: 'MSG91_RECEIPT_TEMPLATE_NAME',         vars: 3, re: /receipt|invoice|payment_(success|confirm|received)/i }
};

let state = { syncedAt: null, error: null, templates: [], byName: new Map(), resolved: {} };

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
function varsIn(text) { const out = []; let m; VAR_RE.lastIndex = 0; while ((m = VAR_RE.exec(String(text || '')))) if (!out.includes(m[1])) out.push(m[1]); return out; }

// Normalise one template/language entry from MSG91's response (shape varies a little by account).
function parseOne(name, lang, extra) {
  const comps = lang.code || lang.components || extra.components || [];
  const list = Array.isArray(comps) ? comps : [];
  const comp = t => list.find(c => String(c.type || '').toUpperCase() === t) || {};
  const body = comp('BODY'), header = comp('HEADER'), buttons = comp('BUTTONS');
  const bodyVars = varsIn(body.text);
  return {
    name,
    language: lang.language || lang.lang || extra.language || 'en',
    status: String(lang.status || extra.status || '').toUpperCase(),
    category: String(lang.category || extra.category || '').toUpperCase(),
    namespace: lang.namespace || extra.namespace || null,
    bodyText: body.text || '',
    bodyVars,
    named: bodyVars.some(v => !/^\d+$/.test(v)),
    headerFormat: header.format || null,
    headerVars: varsIn(header.text),
    buttons: (buttons.buttons || []).map(b => ({ type: b.type, text: b.text, url: b.url }))
  };
}

function parseTemplates(json) {
  const data = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.data?.data) ? json.data.data : [];
  const out = [];
  for (const t of data) {
    const name = t.name || t.template_name;
    if (!name) continue;
    if (Array.isArray(t.languages) && t.languages.length) for (const l of t.languages) out.push(parseOne(name, l, t));
    else out.push(parseOne(name, t, t));
  }
  return out;
}

const approved = t => t && t.status === 'APPROVED';

// Pick the template for one type. Returns { name, language, namespace, source, template, issues }.
function resolveType(key, def, templates, configured, taken) {
  const issues = [];
  const byName = templates.filter(t => t.name === configured);
  const okConfigured = byName.find(approved);
  if (configured && okConfigured) {
    if (def.vars != null && okConfigured.bodyVars.length !== def.vars && !(key === 'otp')) {
      issues.push(`Template "${configured}" has ${okConfigured.bodyVars.length} variable(s); this message sends ${def.vars}.${okConfigured.bodyVars.length < def.vars ? ' The extra values are left out.' : ' It will likely be rejected — the template needs fewer variables.'}`);
    }
    return { name: configured, language: okConfigured.language, namespace: okConfigured.namespace, source: 'render', template: okConfigured, issues };
  }
  if (configured) issues.push(byName.length ? `"${configured}" is set on Render but is ${byName[0].status.toLowerCase() || 'not approved'} in MSG91.` : `"${configured}" is set on Render but no template with that name exists in MSG91.`);
  // Auto-match: name fits the type, variable count fits, category fits, not already used.
  const candidates = templates.filter(t => approved(t) && !taken.has(t.name) && def.re.test(t.name) && !(def.not && def.not.test(t.name))
    && (def.vars == null || t.bodyVars.length === def.vars || (key === 'otp' && t.bodyVars.length === 1))
    && (!def.category || t.category === def.category));
  const names = [...new Set(candidates.map(c => c.name))];
  if (names.length === 1) {
    const t = candidates.find(c => /^en/i.test(c.language)) || candidates[0];
    issues.push(`Using approved template "${t.name}" (matched automatically${configured ? ` instead of "${configured}"` : ''}). Set ${def.env}=${t.name} on Render to make it permanent.`);
    return { name: t.name, language: t.language, namespace: t.namespace, source: 'auto', template: t, issues };
  }
  if (names.length > 1) issues.push(`Several approved templates could fit (${names.join(', ')}) — set ${def.env} on Render to choose one.`);
  if (configured) return { name: configured, language: null, namespace: null, source: 'render-unapproved', template: null, issues };
  if (!names.length) issues.push('No approved template for this message yet — it is sent as plain text only inside the 24-hour window.');
  return { name: null, language: null, namespace: null, source: 'none', template: null, issues };
}

// configured = { type: nameFromEnv | null }
function resolveAll(templates, configured) {
  const resolved = {}, taken = new Set();
  // Types with a valid Render name claim their template first, then automatic matches.
  const keys = Object.keys(TYPES).sort((a, b) => (configured[b] ? 1 : 0) - (configured[a] ? 1 : 0));
  for (const k of keys) {
    const r = resolveType(k, TYPES[k], templates, configured[k] || null, taken);
    if (r.name && r.template) taken.add(r.name);
    resolved[k] = r;
  }
  return resolved;
}

async function syncTemplates({ authKey, integratedNumber, configured, fetchImpl = fetch }) {
  if (!authKey || !integratedNumber) { state.error = 'MSG91 is not configured'; return state; }
  try {
    const url = `https://control.msg91.com/api/v5/whatsapp/get-template-client/${encodeURIComponent(String(integratedNumber).replace(/\D/g, ''))}`;
    const res = await fetchImpl(url, { headers: { authkey: authKey, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.status === 'fail' || json.hasError) throw new Error((json && (json.errors || json.message || json.data)) ? JSON.stringify(json.errors || json.message || json.data).slice(0, 200) : `HTTP ${res.status}`);
    const templates = parseTemplates(json);
    const byName = new Map();
    for (const t of templates) {
      const prev = byName.get(t.name);
      if (!prev || (approved(t) && (!approved(prev) || /^en/i.test(t.language)))) byName.set(t.name, t);
    }
    state = { syncedAt: new Date(), error: null, templates, byName, resolved: resolveAll(templates, configured) };
  } catch (err) {
    state.error = err.message;
    state.syncedAt = state.syncedAt || null;
  }
  return state;
}

// ---- send-time helpers ----
const info = name => (name && state.byName.get(name)) || null;
function langFor(name, fallback) { const t = info(name); return (t && approved(t) && t.language) || fallback; }
function namespaceFor(name, fallback) { const t = info(name); return (t && approved(t) && t.namespace) || fallback; }

// Fit the body variables we send to what the approved template actually has.
function fitComponents(name, components) {
  const t = info(name);
  if (!t || !approved(t) || !components || typeof components !== 'object') return components;
  if (!t.bodyText) return components;               // body not readable (e.g. some OTP templates) — don't guess
  const out = {};
  const bodyKeys = Object.keys(components).filter(k => /^body_\d+$/.test(k)).sort((a, b) => +a.split('_')[1] - +b.split('_')[1]);
  for (const [k, v] of Object.entries(components)) if (!/^body_\d+$/.test(k)) out[k] = v;
  bodyKeys.forEach((k, i) => {
    if (i >= t.bodyVars.length) return;            // template has fewer variables — drop the extra
    const v = { ...components[k] };
    if (t.named) v.parameter_name = t.bodyVars[i]; else delete v.parameter_name;
    out[`body_${i + 1}`] = v;
  });
  return out;
}

function report() {
  return {
    syncedAt: state.syncedAt, error: state.error,
    types: Object.entries(TYPES).map(([key, d]) => {
      const r = state.resolved[key] || { name: null, source: 'not-synced', issues: [] };
      return { key, label: d.label, env: d.env, expectsVars: d.vars, using: r.name, source: r.source, language: r.language, issues: r.issues,
        templateVars: r.template ? r.template.bodyVars : null, bodyText: r.template ? r.template.bodyText : null };
    }),
    templates: state.templates.map(t => ({ name: t.name, language: t.language, status: t.status, category: t.category, vars: t.bodyVars, bodyText: t.bodyText }))
  };
}

module.exports = { TYPES, syncTemplates, resolveAll, parseTemplates, langFor, namespaceFor, fitComponents, report, _state: () => state };
