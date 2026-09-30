/* Biomexa AI Pharmacist — shared logic for every product QR landing page.
   Each page defines window.BIOMEXA_PRODUCT (name, guide texts, reminder slots, vitals type)
   before loading this file; everything product-specific lives there, not here. */
(function () {
  const P = window.BIOMEXA_PRODUCT;
  const API_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://biomexa-api-f9f6.onrender.com';
  const $ = (id) => document.getElementById(id);

  // ---------- small helpers ----------
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode — fine */ } }
  };
  function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  // Any Indian number typed any way -> 10 digits (the server adds +91 consistently).
  function tenDigits(v) { const d = String(v || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }
  async function postJSON(path, body) {
    const res = await fetch(API_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { message: text || 'Something went wrong' }; }
    if (!res.ok) throw new Error(data.message || 'Something went wrong — please try again.');
    return data;
  }

  // Remembered on this phone only, so the patient doesn't retype name/number for vitals etc.
  const me = store.get('biomexa_me', {});
  function remember(name, phone10) {
    if (name) me.name = name; if (phone10) me.phone = phone10;
    store.set('biomexa_me', me); prefill();
  }
  function prefill() {
    document.querySelectorAll('[data-fill="name"]').forEach(el => { if (!el.value && me.name) el.value = me.name; });
    document.querySelectorAll('[data-fill="phone"]').forEach(el => { if (!el.value && me.phone) el.value = me.phone; });
    if (me.name) $('greeting').textContent = `Welcome back, ${me.name.split(' ')[0]} 👋 Your ${P.name} guide is ready.`;
  }

  // ---------- voice ----------
  const synth = window.speechSynthesis;
  let cachedVoice = null, speakToken = 0;
  function pickVoice() {
    if (cachedVoice || !synth) return cachedVoice;
    const voices = synth.getVoices(); if (!voices.length) return null;
    const preferred = ['Microsoft Kajal Online', 'Microsoft Kajal', 'Google हिन्दी', 'Microsoft Heera', 'Veena', 'en-IN-NeerjaNeural', 'Lekha'];
    for (const n of preferred) { const v = voices.find(x => x.name.includes(n)); if (v) return (cachedVoice = v); }
    let best = null, bestScore = -Infinity;
    for (const v of voices) {
      let s = 0;
      if (v.lang === 'en-IN' || v.lang === 'hi-IN') s += 10; else if (v.lang && v.lang.startsWith('en')) s += 2;
      if (/neural|natural|online|enhanced|premium/i.test(v.name)) s += 6;
      if (/female/i.test(v.name)) s += 3; if (/\bmale/i.test(v.name)) s -= 8;
      if (s > bestScore) { bestScore = s; best = v; }
    }
    return (cachedVoice = bestScore > 0 ? best : null);
  }
  function sentences(text) { return text.match(/[^.!?]+[.!?]+(\s|$)/g)?.map(s => s.trim()).filter(Boolean) || [text]; }

  // Speaks text sentence by sentence; onSentence(i) lets the guide highlight what's being read.
  function speak(text, onSentence) {
    stopSpeaking();
    if (!synth) { toast('Voice is not supported in this browser — you can read the guide below.'); return; }
    const token = ++speakToken, parts = sentences(text); let i = 0;
    const setPlaying = (on) => {
      $('avatar').classList.toggle('speaking', on);
      $('playBtn').innerHTML = on ? '<i class="fas fa-stop"></i> Stop' : '<i class="fas fa-volume-high"></i> Listen';
    };
    const next = () => {
      if (token !== speakToken) return;
      if (i >= parts.length) { setPlaying(false); onSentence && onSentence(-1); return; }
      const u = new SpeechSynthesisUtterance(parts[i]);
      u.lang = 'en-IN'; u.rate = 0.9; u.pitch = 1.03;
      const v = pickVoice(); if (v) u.voice = v;
      const idx = i++;
      u.onstart = () => { setPlaying(true); onSentence && onSentence(idx); };
      u.onend = () => { if (token === speakToken) setTimeout(next, 150); };
      u.onerror = () => { if (token === speakToken) setTimeout(next, 50); };
      synth.speak(u);
    };
    if (!synth.getVoices().length) { synth.onvoiceschanged = () => { synth.onvoiceschanged = null; next(); }; setTimeout(next, 400); }
    else next();
  }
  function stopSpeaking() {
    speakToken++;
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    const a = $('avatar'); if (a) a.classList.remove('speaking');
    const b = $('playBtn'); if (b) b.innerHTML = '<i class="fas fa-volume-high"></i> Listen';
    document.querySelectorAll('.guide-text .sent.now').forEach(s => s.classList.remove('now'));
  }
  window.addEventListener('pagehide', stopSpeaking);

  // ---------- AI Medicine Guide ----------
  let activeTopic = Object.keys(P.guides)[0];
  function renderGuide() {
    $('guideTabs').innerHTML = Object.entries(P.guides).map(([k, g]) =>
      `<button class="tab ${k === activeTopic ? 'active' : ''}" data-topic="${k}"><i class="fas ${g.icon}"></i>${g.title}</button>`).join('');
    const g = P.guides[activeTopic];
    $('guideText').innerHTML = sentences(g.text).map((s, i) => `<span class="sent" data-i="${i}">${escapeHtml(s)}</span>`).join(' ');
  }
  function highlight(i) {
    document.querySelectorAll('.guide-text .sent').forEach(s => s.classList.toggle('now', +s.dataset.i === i));
  }
  $('guideTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    const wasPlaying = $('avatar').classList.contains('speaking');
    activeTopic = b.dataset.topic; stopSpeaking(); renderGuide();
    if (wasPlaying) speak(P.guides[activeTopic].text, highlight);
  });
  $('playBtn').addEventListener('click', () => {
    if ($('avatar').classList.contains('speaking')) { stopSpeaking(); return; }
    speak(P.guides[activeTopic].text, highlight);
  });

  // ---------- Ask the AI pharmacist ----------
  let history = [], busy = false;
  function addMsg(role, text, extraClass) {
    const el = document.createElement('div');
    el.className = `msg ${role}${extraClass ? ' ' + extraClass : ''}`;
    el.textContent = text; $('chatMsgs').appendChild(el);
    $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight; return el;
  }
  async function ask(question) {
    question = (question || '').trim(); if (!question || busy) return;
    busy = true; $('chatSend').disabled = true; $('chatInput').value = '';
    addMsg('user', question);
    const typing = addMsg('ai', 'Thinking…', 'typing');
    try {
      const data = await postJSON('/api/product-chat', { productName: P.apiName, question, history });
      typing.remove();
      addMsg('ai', data.answer || 'Sorry, I could not answer that right now.');
      history.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer || '' });
      history = history.slice(-12);
    } catch (err) {
      typing.remove();
      addMsg('ai', /fetch|network/i.test(err.message)
        ? 'I couldn\'t reach the AI pharmacist — please check your internet and try again.'
        : err.message);
    } finally { busy = false; $('chatSend').disabled = false; }
  }
  $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); ask($('chatInput').value); });
  $('chatSuggest').innerHTML = P.suggestions.map(s => `<button type="button">${escapeHtml(s)}</button>`).join('');
  $('chatSuggest').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) ask(b.textContent); });

  // ---------- WhatsApp dose reminders ----------
  // (Pages now link to the free sign-up page, reminders.html; the inline form is only kept for
  // any page that still includes it.)
  if ($('remForm')) {
  $('remSlots').innerHTML = P.reminders.map((r, i) => `
    <label class="check">
      <input type="checkbox" data-slot="${i}" ${r.defaultOn ? 'checked' : ''}>
      <div style="flex:1">
        <div class="t">${r.label}</div>
        <div class="s">${r.sub}</div>
        <input type="time" class="time-in" data-time="${i}" value="${r.time}" aria-label="${r.label} time">
      </div>
    </label>`).join('');

  $('remForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('remMsg'); msg.className = 'form-msg'; msg.textContent = '';
    const name = $('remName').value.trim();
    const phone10 = tenDigits($('remPhone').value);
    const days = $('remDays').value;
    const slots = P.reminders.map((r, i) => ({ ...r, on: document.querySelector(`[data-slot="${i}"]`).checked, time: document.querySelector(`[data-time="${i}"]`).value }))
      .filter(s => s.on);
    if (!name) return fail('Please enter your name.');
    if (phone10.length !== 10) return fail('Please enter your 10-digit WhatsApp number.');
    if (!slots.length) return fail('Choose at least one reminder time.');
    if (slots.some(s => !s.time)) return fail('Please pick a time for each reminder.');

    const btn = $('remBtn'); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Setting up…';
    try {
      let last;
      for (const s of slots) {
        last = await postJSON('/api/quick-reminder', {
          name, phone: '+91' + phone10, medicineName: P.apiName, dosage: P.dosage,
          time: s.time, foodNote: s.foodNote, durationDays: days || undefined
        });
      }
      remember(name, phone10);
      const times = slots.map(s => fmtTime(s.time)).join(' & ');
      msg.className = 'form-msg ok';
      msg.innerHTML = `✅ <strong>Done!</strong> You'll get a WhatsApp reminder at ${times} every day${days ? ` for ${days} days` : ''}. `
        + (last && last.isNewAccount
          ? `We've also created your Biomexa account for <strong>+91 ${phone10}</strong> — use “Forgot password” on the login page to open your full dashboard.`
          : `It's been added to your Biomexa account.`)
        + `<br><span style="font-size:0.8rem">Tip: save Biomexa's WhatsApp number and reply to the first message so every reminder reaches you.</span>`;
      toast('Reminders activated ✅');
    } catch (err) { fail(err.message); }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fab fa-whatsapp"></i> Activate WhatsApp reminders'; }

    function fail(t) { msg.className = 'form-msg err'; msg.textContent = t; }
  });
  }
  function fmtTime(t) { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }

  // ---------- Track progress (vitals) ----------
  const vKey = `biomexa_readings_${P.slug}`;
  function classify(r) {
    if (P.vitals === 'bp') {
      if (r.sys >= 180 || r.dia >= 120) return ['bad', 'Very high — call your doctor'];
      if (r.sys >= 140 || r.dia >= 90) return ['warn', 'High'];
      if (r.sys < 90 || r.dia < 60) return ['warn', 'Low'];
      return ['ok', 'In range'];
    }
    const g = r.fasting;
    if (g >= 250 || g < 70) return ['bad', g < 70 ? 'Low — eat something now' : 'Very high — call your doctor'];
    if (g >= 130) return ['warn', 'Above target'];
    return ['ok', 'In range'];
  }
  function renderReadings() {
    const list = store.get(vKey, []);
    $('readingList').innerHTML = list.length ? list.slice(0, 5).map(r => {
      const [cls, label] = classify(r);
      const val = P.vitals === 'bp' ? `${r.sys}/${r.dia} mmHg` : `${r.fasting} mg/dL${r.pp ? ` · after meal ${r.pp}` : ''}`;
      return `<div class="reading"><div><div class="val">${val}</div><div class="hint" style="margin:0">${new Date(r.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${r.hr ? ` · ${r.hr} bpm` : ''}</div></div><span class="pill ${cls}">${label}</span></div>`;
    }).join('') : '<div class="empty">No readings yet — log your first one above.</div>';
  }
  $('vitalsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone10 = tenDigits($('vPhone').value);
    if (phone10.length !== 10) { toast('Enter your 10-digit WhatsApp number so this saves to your record'); return; }
    const hr = $('vHr').value ? +$('vHr').value : undefined;
    let reading, body;
    if (P.vitals === 'bp') {
      reading = { sys: +$('vSys').value, dia: +$('vDia').value, hr };
      body = { bpSystolic: reading.sys, bpDiastolic: reading.dia, heartRate: hr };
    } else {
      reading = { fasting: +$('vFasting').value, pp: $('vPp').value ? +$('vPp').value : undefined, hr };
      body = { glucose: reading.fasting, heartRate: hr };
    }
    const btn = $('vBtn'); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
    try {
      const data = await postJSON('/api/quick-vitals', { phone: '+91' + phone10, name: me.name, ...body });
      const list = store.get(vKey, []); list.unshift({ ...reading, at: Date.now() }); store.set(vKey, list.slice(0, 30));
      remember(null, phone10); renderReadings();
      e.target.querySelectorAll('input[type=number]').forEach(i => { i.value = ''; });
      const [cls, label] = classify(reading);
      toast(data.riskFlagged
        ? `⚠️ Saved — ${label}. This reading has been flagged for a Biomexa doctor to review.`
        : cls === 'bad' ? `⚠️ Saved — ${label}. Please contact your doctor.` : 'Saved to your Biomexa record ✅');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Save reading'; }
  });

  // ---------- start ----------
  renderGuide(); renderReadings(); prefill();
})();
