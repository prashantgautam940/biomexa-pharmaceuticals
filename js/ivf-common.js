// ========== Biomexa IVF Care — shared browser helpers (ivf.html + ivf-doctor.html) ==========
const IVF_API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : 'https://biomexa-api-f9f6.onrender.com';

const IVF = {
  meta: null,

  async api(path, { method = 'GET', body, token } = {}) {
    const res = await fetch(IVF_API + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.message || `Request failed (${res.status})`);
      err.status = res.status; err.code = data.code;
      throw err;
    }
    return data;
  },

  async loadMeta() {
    if (!this.meta) this.meta = await this.api('/api/ivf/meta');
    return this.meta;
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  // WhatsApp-style *bold* → <b>, after escaping
  rich(s) { return this.esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>'); },

  fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; },
  fmtDateTime(d) { return d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; },
  fmtTime(d) { return d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'; },
  ago(d) {
    if (!d) return 'never';
    const m = Math.round((Date.now() - new Date(d)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  },
  // For <input type="datetime-local"> values
  toLocalInput(d) {
    if (!d) return '';
    const x = new Date(d); const p = n => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
  },
  toDateInput(d) { return d ? this.toLocalInput(d).slice(0, 10) : ''; },
  countdown(d) {
    const ms = new Date(d) - Date.now();
    if (ms <= 0) return 'now';
    const h = Math.floor(ms / 36e5), m = Math.round((ms % 36e5) / 60000);
    return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : h ? `in ${h}h ${m}m` : `in ${m} min`;
  },

  sevBadge(sev) {
    const map = { critical: ['b-critical', 'Critical'], high: ['b-high', 'High'], watch: ['b-watch', 'Watch'], normal: ['b-ok', 'Stable'] };
    const [cls, label] = map[sev] || map.normal;
    return `<span class="badge ${cls}">${label}</span>`;
  },

  protocolLabel(p) {
    return ({ antagonist: 'Antagonist', long_agonist: 'Long agonist', short_agonist: 'Short agonist', mild_stimulation: 'Mild stimulation', natural_cycle: 'Natural cycle', frozen_embryo_transfer: 'Frozen embryo transfer', iui: 'IUI', other: 'To be decided' })[p] || p;
  },

  stepperHtml(stageKey) {
    const stages = (this.meta?.stages || []).filter(s => s.key !== 'closed');
    const idx = stages.findIndex(s => s.key === stageKey);
    return `<div class="stepper" aria-label="Treatment progress">${stages.map((s, i) =>
      `<div class="step ${i < idx || stageKey === 'closed' ? 'done' : i === idx ? 'current' : ''}"><div class="bar"></div><div class="lbl">${this.esc(s.label)}</div></div>`).join('')}</div>`;
  },

  toast(msg, isErr) {
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), isErr ? 5000 : 3200);
  },

  readFiles(input, max = 3) {
    const files = Array.from(input.files || []);
    if (files.length > max) return Promise.reject(new Error(`Please choose up to ${max} files.`));
    return Promise.all(files.map(f => new Promise((resolve, reject) => {
      if (f.size > 5 * 1024 * 1024) return reject(new Error(`"${f.name}" is larger than 5MB.`));
      const r = new FileReader();
      r.onload = () => resolve({ fileName: f.name, fileType: f.type, fileData: String(r.result).split(',')[1] });
      r.onerror = () => reject(new Error(`Couldn't read "${f.name}".`));
      r.readAsDataURL(f);
    })));
  },

  // Opens an uploaded file in a modal (image inline, PDF in an iframe).
  showFile(file) {
    const bytes = Uint8Array.from(atob(file.fileData), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: file.fileType }));
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${this.esc(file.fileName)}">
      <div class="modal-head"><b class="small">${this.esc(file.fileName)}</b>
        <div class="row"><a class="btn btn-ghost btn-sm" href="${url}" download="${this.esc(file.fileName)}">Download</a>
        <button class="btn btn-ghost btn-sm" data-close>Close</button></div></div>
      <div class="modal-body">${file.fileType === 'application/pdf' ? `<iframe src="${url}" title="${this.esc(file.fileName)}"></iframe>` : `<img src="${url}" alt="${this.esc(file.fileName)}">`}</div></div>`;
    const close = () => { bg.remove(); URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    bg.addEventListener('click', e => { if (e.target === bg || e.target.hasAttribute('data-close')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
  },

  // Tiny inline SVG line chart for a numeric series [{t: Date, v: Number}] (oldest first).
  sparkline(points, unit = '') {
    const pts = points.filter(p => Number.isFinite(p.v));
    if (pts.length < 2) return '<div class="empty small">Not enough readings yet for a trend.</div>';
    const W = 600, H = 80, P = 20;
    const vs = pts.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
    const x = i => P + (i * (W - 2 * P)) / (pts.length - 1);
    const y = v => H - 16 - ((v - lo) / span) * (H - 30);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Trend from ${lo}${unit} to ${hi}${unit}">
      <path class="line" d="${d}"/>${pts.map((p, i) => `<circle class="dot" cx="${x(i)}" cy="${y(p.v)}" r="3"><title>${this.fmtDate(p.t)}: ${p.v}${unit}</title></circle>`).join('')}
      <text class="axis" x="${P}" y="${H - 2}">${lo}${unit}</text><text class="axis" x="${W - P}" y="${H - 2}" text-anchor="end">${hi}${unit}</text></svg>`;
  },

  // Human summary of one daily check-in.
  logSummary(l) {
    const v = l.vitals || {}, s = l.symptoms || {};
    return [
      v.weightKg && `Weight ${v.weightKg} kg`, v.abdominalGirthCm && `Girth ${v.abdominalGirthCm} cm`,
      v.temperatureF && `Temp ${v.temperatureF}°F`, v.bpSystolic && `BP ${v.bpSystolic}/${v.bpDiastolic || '?'}`,
      v.heartRate && `Pulse ${v.heartRate}`, Number.isFinite(s.painScore) && `Pain ${s.painScore}/10`,
      s.bloating && s.bloating !== 'none' && `Bloating: ${s.bloating}`, s.nausea && s.nausea !== 'none' && `Nausea: ${s.nausea}`,
      s.bleeding && s.bleeding !== 'none' && `Bleeding: ${s.bleeding}`, s.breathlessness && 'Breathless',
      s.reducedUrine && 'Less urine', s.headache && 'Headache', s.injectionSiteReaction && 'Injection-site reaction',
      s.mood && `Mood: ${s.mood.replace('_', ' ')}`
    ].filter(Boolean).join(' · ');
  }
};
