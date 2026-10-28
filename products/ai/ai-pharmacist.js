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
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode — fine */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* fine */ } }
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
  // AI answers use WhatsApp-style formatting (*bold*, "- " bullets). Turn that into safe HTML.
  function formatAnswer(text) {
    const lines = escapeHtml(String(text || '').trim()).split(/\n/);
    let html = '', inList = false;
    for (const raw of lines) {
      const line = raw.replace(/\*\*?([^*\n]+?)\*\*?/g, '<strong>$1</strong>');
      const bullet = line.match(/^\s*(?:[-•]|\d+[.)])\s+(.*)$/);
      if (bullet) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${bullet[1]}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      html += line.trim() ? `<p>${line}</p>` : '';
    }
    return html + (inList ? '</ul>' : '');
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

  // ---------- bigger text (for older patients) ----------
  function applySize(big) {
    document.documentElement.classList.toggle('big-text', big);
    const b = $('sizeBtn');
    if (b) { b.setAttribute('aria-pressed', String(big)); b.title = big ? 'Normal text size' : 'Bigger text'; }
  }
  applySize(store.get('biomexa_big_text', false));
  if ($('sizeBtn')) $('sizeBtn').addEventListener('click', () => {
    const big = !document.documentElement.classList.contains('big-text');
    store.set('biomexa_big_text', big); applySize(big);
    toast(big ? 'Bigger text on' : 'Normal text size');
  });

  // ---------- voice ----------
  const synth = window.speechSynthesis;
  const RATES = { slow: 0.8, normal: 0.95, fast: 1.12 };
  let rateKey = store.get('biomexa_voice_rate', 'normal');
  let speakToken = 0, onStop = null;
  // Voice choice lives in js/voice.js (best Apple Premium/Enhanced, Siri, or neural voice on the device).
  function pickVoice(text) { return window.BiomexaVoice ? window.BiomexaVoice.pick(window.BiomexaVoice.langFor(text)) : null; }
  function sentences(text) { return text.match(/[^.!?]+[.!?]+(\s|$)/g)?.map(s => s.trim()).filter(Boolean) || [text]; }

  // Speaks text sentence by sentence. opts.onSentence(i, total) lets callers highlight progress;
  // opts.onState(playing) lets callers swap their Listen/Stop button.
  function speak(text, opts = {}) {
    stopSpeaking();
    if (!synth) { toast('Voice is not supported in this browser — you can read the text instead.'); return; }
    const token = ++speakToken, parts = sentences(text); let i = 0;
    onStop = () => { opts.onState && opts.onState(false); opts.onSentence && opts.onSentence(-1, parts.length); };
    const next = () => {
      if (token !== speakToken) return;
      if (i >= parts.length) { const f = onStop; onStop = null; f && f(); return; }
      const said = parts[i].replace(/\*/g, '');
      const u = new SpeechSynthesisUtterance(said);
      if (window.BiomexaVoice) window.BiomexaVoice.apply(u, said, RATES[rateKey] || 0.95);
      else { u.lang = 'en-IN'; u.rate = RATES[rateKey] || 0.95; }
      const idx = i++;
      u.onstart = () => { opts.onState && opts.onState(true); opts.onSentence && opts.onSentence(idx, parts.length); };
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
    const f = onStop; onStop = null; f && f();
  }
  window.addEventListener('pagehide', stopSpeaking);

  // ---------- AI Medicine Guide ----------
  let activeTopic = Object.keys(P.guides)[0], guidePlaying = false;
  function setGuidePlaying(on) {
    guidePlaying = on;
    $('avatar').classList.toggle('speaking', on);
    $('playBtn').innerHTML = on ? '<i class="fas fa-stop"></i> Stop' : '<i class="fas fa-volume-high"></i> Listen';
  }
  function renderGuide() {
    $('guideTabs').innerHTML = Object.entries(P.guides).map(([k, g]) =>
      `<button class="tab ${k === activeTopic ? 'active' : ''}" data-topic="${k}" role="tab" aria-selected="${k === activeTopic}"><i class="fas ${g.icon}"></i>${g.title}</button>`).join('');
    const g = P.guides[activeTopic];
    $('guideText').innerHTML = sentences(g.text).map((s, i) => `<span class="sent" data-i="${i}">${escapeHtml(s)}</span>`).join(' ');
    const mins = Math.max(1, Math.round(g.text.split(/\s+/).length / 150));
    if ($('guideMeta')) $('guideMeta').textContent = `About ${mins} min to listen`;
    guideProgress(-1, 1);
  }
  function guideProgress(i, total) {
    document.querySelectorAll('.guide-text .sent').forEach(s => s.classList.toggle('now', +s.dataset.i === i));
    const bar = $('guideBar'); if (bar) bar.style.width = i < 0 ? '0%' : `${Math.round(((i + 1) / total) * 100)}%`;
    const now = document.querySelector('.guide-text .sent.now');
    if (now) {
      const box = $('guideText');
      const top = now.offsetTop - box.offsetTop;
      if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = top - 20;
    }
  }
  function playGuide() { speak(P.guides[activeTopic].text, { onSentence: guideProgress, onState: setGuidePlaying }); }
  $('guideTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    const wasPlaying = guidePlaying;
    activeTopic = b.dataset.topic; stopSpeaking(); renderGuide();
    if (wasPlaying) playGuide();
  });
  $('playBtn').addEventListener('click', () => { guidePlaying ? stopSpeaking() : playGuide(); });

  // Listening speed: Slow / Normal / Fast
  const speedBox = $('speed');
  function renderSpeed() {
    if (!speedBox) return;
    speedBox.querySelectorAll('button').forEach(b => {
      const on = b.dataset.rate === rateKey; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
  }
  if (speedBox) speedBox.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    rateKey = b.dataset.rate; store.set('biomexa_voice_rate', rateKey); renderSpeed();
    if (guidePlaying) playGuide();
  });
  renderSpeed();

  // ---------- Ask the AI pharmacist ----------
  const chatKey = `biomexa_chat_${P.slug}`;
  let history = store.get(chatKey, []), busy = false;
  const welcome = `Namaste! 🙏 I'm your AI Pharmacist for *${P.name}*. Ask me how to take it, what to eat, side effects, missed doses — in English or Hindi.`;

  function addMsg(role, text, opts = {}) {
    const row = document.createElement('div');
    row.className = `msg-row ${role}`;
    if (role === 'ai') row.innerHTML = '<span class="bot" aria-hidden="true"><i class="fas fa-user-doctor"></i></span>';
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    if (opts.typing) {
      el.classList.add('typing');
      el.innerHTML = '<span class="dots" aria-label="Thinking"><i></i><i></i><i></i></span>';
    } else if (role === 'ai') {
      el.innerHTML = formatAnswer(text);
      if (!opts.noTools) {
        const tools = document.createElement('div');
        tools.className = 'msg-tools';
        tools.innerHTML = '<button type="button" class="say"><i class="fas fa-volume-high"></i> Listen</button>';
        const sayBtn = tools.querySelector('.say');
        let playing = false;
        sayBtn.addEventListener('click', () => {
          if (playing) { stopSpeaking(); return; }
          speak(text, { onState: (on) => {
            playing = on;
            sayBtn.innerHTML = on ? '<i class="fas fa-stop"></i> Stop' : '<i class="fas fa-volume-high"></i> Listen';
          } });
        });
        el.appendChild(tools);
      }
    } else {
      el.textContent = text;
    }
    row.appendChild(el);
    $('chatMsgs').appendChild(row);
    $('chatMsgs').scrollTop = $('chatMsgs').scrollHeight;
    return row;
  }
  function renderChat() {
    $('chatMsgs').innerHTML = '';
    addMsg('ai', welcome, { noTools: true });
    history.forEach(h => addMsg(h.role === 'user' ? 'user' : 'ai', h.content));
    $('chatSuggest').hidden = history.length > 0;
  }
  async function ask(question) {
    question = (question || '').trim(); if (!question || busy) return;
    busy = true; $('chatSend').disabled = true; $('chatInput').value = '';
    $('chatSuggest').hidden = true;
    addMsg('user', question);
    const typing = addMsg('ai', '', { typing: true });
    try {
      const data = await postJSON('/api/product-chat', { productName: P.apiName, question, history });
      typing.remove();
      const answer = data.answer || 'Sorry, I could not answer that right now.';
      addMsg('ai', answer);
      history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      history = history.slice(-20); store.set(chatKey, history);
    } catch (err) {
      typing.remove();
      addMsg('ai', /fetch|network/i.test(err.message)
        ? 'I couldn\'t reach the AI pharmacist — please check your internet and try again.'
        : err.message, { noTools: true });
    } finally { busy = false; $('chatSend').disabled = false; }
  }
  $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); ask($('chatInput').value); });
  $('chatSuggest').innerHTML = P.suggestions.map(s => `<button type="button">${escapeHtml(s)}</button>`).join('');
  $('chatSuggest').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) ask(b.textContent); });
  if ($('chatClear')) $('chatClear').addEventListener('click', () => {
    history = []; store.del(chatKey); stopSpeaking(); renderChat(); toast('Started a new conversation');
  });

  // Ask from the hero: jump to the chat and send.
  if ($('heroAsk')) $('heroAsk').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('heroAskInput').value.trim(); if (!q) { $('heroAskInput').focus(); return; }
    $('heroAskInput').value = '';
    $('ask').scrollIntoView({ behavior: 'smooth', block: 'start' });
    ask(q);
  });

  // Speak your question (Chrome, Edge, Safari) — easier than typing for many patients.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.querySelectorAll('[data-mic]').forEach(btn => {
    if (!SR) { btn.hidden = true; return; }
    const target = $(btn.dataset.mic);
    let rec = null;
    btn.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'en-IN'; rec.interimResults = true; rec.maxAlternatives = 1;
      btn.classList.add('listening'); target.placeholder = 'Listening… speak now';
      rec.onresult = (ev) => {
        target.value = Array.from(ev.results).map(r => r[0].transcript).join('');
        if (ev.results[ev.results.length - 1].isFinal) target.form.requestSubmit();
      };
      rec.onerror = (ev) => { if (ev.error === 'not-allowed') toast('Allow microphone access to ask by voice'); };
      rec.onend = () => { btn.classList.remove('listening'); target.placeholder = target.dataset.ph || ''; rec = null; };
      rec.start();
    });
    target.dataset.ph = target.placeholder;
  });

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
  // Small trend line of the last 10 readings with the healthy band shaded.
  function renderTrend(list) {
    const box = $('trend'); if (!box) return;
    const pts = list.slice(0, 10).reverse();
    if (pts.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    const W = 320, H = 110, padX = 8, padY = 12;
    const series = P.vitals === 'bp'
      ? [{ key: 'sys', cls: 'l1', name: 'Upper' }, { key: 'dia', cls: 'l2', name: 'Lower' }]
      : [{ key: 'fasting', cls: 'l1', name: 'Fasting' }];
    const band = P.vitals === 'bp' ? [60, 140] : [70, 130];
    const vals = pts.flatMap(p => series.map(s => p[s.key])).concat(band);
    const lo = Math.min(...vals) - 10, hi = Math.max(...vals) + 10;
    const x = (i) => padX + (i * (W - padX * 2)) / (pts.length - 1);
    const y = (v) => padY + (H - padY * 2) * (1 - (v - lo) / (hi - lo));
    const lines = series.map(s => {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ');
      const dots = pts.map((p, i) => `<circle class="${s.cls}" cx="${x(i).toFixed(1)}" cy="${y(p[s.key]).toFixed(1)}" r="3"><title>${p[s.key]}</title></circle>`).join('');
      return `<path class="${s.cls}" d="${d}"/>${dots}`;
    }).join('');
    box.innerHTML = `
      <div class="trend-head"><strong>Your trend</strong><span>${series.map(s => `<i class="key ${s.cls}"></i>${s.name}`).join(' ')}<i class="key band"></i>Healthy range</span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend of your last ${pts.length} readings" preserveAspectRatio="none">
        <rect class="band" x="0" width="${W}" y="${y(band[1]).toFixed(1)}" height="${(y(band[0]) - y(band[1])).toFixed(1)}"/>
        ${lines}
      </svg>`;
  }
  function renderReadings() {
    const list = store.get(vKey, []);
    renderTrend(list);
    $('readingList').innerHTML = list.length ? list.slice(0, 5).map(r => {
      const [cls, label] = classify(r);
      const val = P.vitals === 'bp' ? `${r.sys}/${r.dia} mmHg` : `${r.fasting} mg/dL${r.pp ? ` · after meal ${r.pp}` : ''}`;
      return `<div class="reading"><div><div class="val">${val}</div><div class="hint" style="margin:0">${new Date(r.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${r.hr ? ` · ${r.hr} bpm` : ''}</div></div><span class="pill ${cls}">${label}</span></div>`;
    }).join('') : '<div class="empty">No readings yet — log your first one above.</div>';
  }
  if ($('vitalsForm')) $('vitalsForm').addEventListener('submit', async (e) => {
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

  // ---------- gentle reveal as sections scroll in ----------
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((entries) => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.wrap > .section, .wrap > .grid-2 > .card').forEach(el => { el.classList.add('reveal'); io.observe(el); });
  }

  // ---------- Adherence orbit: benefits revolve around the medicine (same motion as IVF Care) ----------
  document.querySelectorAll('.adh-orbit').forEach(orbit => {
    const nodes = Array.from(orbit.querySelectorAll('.adh-node'));
    const ring = orbit.querySelector('.adh-ring-a');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tilt = Math.cos(72 * Math.PI / 180); // matches the ring's rotateX(72deg)
    let base = 90, paused = false, last = performance.now(), visible = true;
    function place() {
      const rx = ring.offsetWidth / 2, ry = Math.max(rx * tilt, 60) + (rx < 130 ? 30 : 46);
      nodes.forEach((n, i) => {
        const a = (base + i * (360 / nodes.length)) * Math.PI / 180;
        const depth = (Math.sin(a) + 1) / 2;            // 0 = behind the medicine, 1 = closest
        const scale = 0.74 + depth * 0.3;
        n.style.transform = `translate(-50%, -50%) translate(${(Math.cos(a) * rx).toFixed(1)}px, ${(Math.sin(a) * ry).toFixed(1)}px) scale(${scale.toFixed(3)})`;
        n.style.opacity = (0.45 + depth * 0.55).toFixed(2);
        n.style.zIndex = depth > 0.5 ? 10 : 1;
        n.classList.toggle('front', depth > 0.92);
      });
    }
    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!paused && !reduce && visible && !document.hidden) { base += 12 * dt; place(); }
      requestAnimationFrame(tick);
    }
    orbit.addEventListener('mouseenter', () => { paused = true; });
    orbit.addEventListener('mouseleave', () => { paused = false; });
    orbit.addEventListener('touchstart', () => { paused = !paused; }, { passive: true }); // tap to pause/resume
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(orbit);
    window.addEventListener('resize', place);
    place(); requestAnimationFrame(tick);
  });

  // ---------- start ----------
  renderGuide(); renderChat(); if ($('readingList')) renderReadings(); prefill();
})();
