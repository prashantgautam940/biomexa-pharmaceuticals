// "Report a problem" — floating button + form, on every portal.
// Include with: <script src="js/support.js" data-role="patient" defer></script>
// (data-role: patient | doctor | ivf_patient | ivf_centre | visitor; guessed from the page if missing)
(function () {
  if (window.__bxSupport) return; window.__bxSupport = true;
  const me = document.currentScript || document.querySelector('script[src*="support.js"]');
  const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:3000' : 'https://biomexa-api-f9f6.onrender.com';
  const page = location.pathname.split('/').pop() || 'index.html';
  const guess = { 'patient.html': 'patient', 'doctor.html': 'doctor', 'ivf.html': 'ivf_patient', 'ivf-doctor.html': 'ivf_centre' }[page] || 'visitor';
  const role = (me && me.dataset.role) || guess;
  const cats = [
    ['reminders', 'WhatsApp reminders'], ['login', 'Login / account'], ['reports', 'Reports / AI analysis'],
    ['doctor', 'Doctor connect'], ['payment', 'Payment / subscription'], ['ivf', 'IVF Care'],
    ['website', 'Website not working'], ['other', 'Something else']
  ];
  const roles = [['patient', 'Patient'], ['doctor', 'Doctor'], ['ivf_patient', 'IVF patient'], ['ivf_centre', 'IVF centre'], ['visitor', 'Other']];

  // Pre-fill from whoever is signed in on this browser (they can still edit it).
  function who() {
    const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
    const order = role === 'doctor' || role === 'ivf_centre' ? ['doctorProfile', 'ivfUser', 'user'] : role === 'ivf_patient' ? ['ivfUser', 'user', 'doctorProfile'] : ['user', 'ivfUser', 'doctorProfile'];
    for (const k of order) { const u = read(k); if (u && (u.name || u.phone)) return u; }
    return {};
  }

  const css = `
  .bxs-fab{position:fixed;left:16px;bottom:16px;z-index:9990;display:inline-flex;align-items:center;gap:8px;padding:11px 16px;border-radius:999px;border:1px solid #d6e0f3;background:#fff;color:#16336b;font:600 14px/1 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 10px 28px rgba(19,33,61,.16)}
  .bxs-fab:hover{border-color:#16336b}
  .bxs-fab:focus-visible,.bxs-modal button:focus-visible,.bxs-modal input:focus-visible,.bxs-modal select:focus-visible,.bxs-modal textarea:focus-visible{outline:3px solid #0aa6c9;outline-offset:2px}
  .bxs-bg{position:fixed;inset:0;z-index:9991;background:rgba(19,33,61,.5);display:none;align-items:center;justify-content:center;padding:16px}
  .bxs-bg.open{display:flex}
  .bxs-modal{width:100%;max-width:460px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:20px;padding:22px;box-shadow:0 24px 60px rgba(19,33,61,.3);font-family:Inter,system-ui,sans-serif;color:#13213d}
  .bxs-modal h3{margin:0 0 4px;font-size:1.15rem}
  .bxs-modal .sub{margin:0 0 14px;color:#5b6b86;font-size:.88rem;line-height:1.5}
  .bxs-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .bxs-f{margin-bottom:10px}
  .bxs-f label{display:block;font-size:.78rem;font-weight:600;color:#34425e;margin-bottom:4px}
  .bxs-f input,.bxs-f select,.bxs-f textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cfd8e6;border-radius:10px;font:inherit;font-size:.92rem;background:#fff;color:#13213d}
  .bxs-f textarea{min-height:110px;resize:vertical}
  .bxs-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap}
  .bxs-btn{padding:10px 18px;border-radius:10px;border:0;font:700 .9rem Inter,system-ui,sans-serif;cursor:pointer;background:#16336b;color:#fff}
  .bxs-btn.ghost{background:#fff;color:#16336b;border:1px solid #d6e0f3}
  .bxs-btn:disabled{opacity:.6;cursor:not-allowed}
  .bxs-err{color:#c0262d;font-size:.85rem;margin:6px 0 0;min-height:1em}
  .bxs-done{text-align:center;padding:8px 4px}
  .bxs-done .no{display:inline-block;margin:10px 0;padding:8px 14px;border-radius:10px;background:#e8f6ee;color:#11663a;font-weight:800;font-size:1.1rem;letter-spacing:.02em}
  .bxs-done p{color:#5b6b86;font-size:.9rem;line-height:1.55}
  .bxs-link{display:block;text-align:center;margin-top:10px;font-size:.82rem;color:#16336b}
  @media (max-width:600px){.bxs-fab span{display:none}.bxs-fab{padding:12px}.bxs-row{grid-template-columns:1fr}}
  @media print{.bxs-fab{display:none}}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.type = 'button'; fab.className = 'bxs-fab'; fab.setAttribute('aria-haspopup', 'dialog');
  fab.innerHTML = '🛟 <span>Report a problem</span>';
  fab.title = 'Report a problem';

  const bg = document.createElement('div');
  bg.className = 'bxs-bg';
  bg.innerHTML = `
  <div class="bxs-modal" role="dialog" aria-modal="true" aria-labelledby="bxsTitle">
    <form id="bxsForm" novalidate>
      <h3 id="bxsTitle">Report a problem</h3>
      <p class="sub">Tell us what went wrong. You'll get a ticket number, and we'll reply on WhatsApp.</p>
      <div class="bxs-row">
        <div class="bxs-f"><label for="bxsName">Your name</label><input id="bxsName" autocomplete="name" required></div>
        <div class="bxs-f"><label for="bxsPhone">WhatsApp number</label><input id="bxsPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="98765 43210" required></div>
      </div>
      <div class="bxs-row">
        <div class="bxs-f"><label for="bxsRole">I am a</label><select id="bxsRole">${roles.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="bxs-f"><label for="bxsCat">Problem with</label><select id="bxsCat">${cats.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      </div>
      <div class="bxs-f"><label for="bxsSubject">Short title (optional)</label><input id="bxsSubject" maxlength="140" placeholder="e.g. Not getting my 9 PM reminder"></div>
      <div class="bxs-f"><label for="bxsMsg">What happened?</label><textarea id="bxsMsg" maxlength="3000" placeholder="What were you trying to do, and what went wrong?" required></textarea></div>
      <p class="bxs-err" id="bxsErr" role="alert"></p>
      <div class="bxs-actions">
        <button type="button" class="bxs-btn ghost" data-close>Cancel</button>
        <button type="submit" class="bxs-btn" id="bxsSend">Send report</button>
      </div>
      <a class="bxs-link" href="${location.pathname.includes('/products/') ? '../' : ''}support.html#status">Check an existing ticket</a>
    </form>
    <div class="bxs-done" id="bxsDone" hidden>
      <div style="font-size:2.4rem">✅</div>
      <h3>Ticket raised</h3>
      <div class="no" id="bxsNo"></div>
      <p>We've sent the ticket number to your WhatsApp and will reply there. Keep the number to check the status later.</p>
      <div class="bxs-actions" style="justify-content:center"><button type="button" class="bxs-btn" data-close>Done</button></div>
    </div>
  </div>`;

  function open() {
    const u = who();
    const $ = id => bg.querySelector('#' + id);
    if (!$('bxsName').value) $('bxsName').value = u.name || '';
    if (!$('bxsPhone').value) $('bxsPhone').value = (u.phone || '').replace(/^\+91\s?/, '');
    $('bxsRole').value = role;
    if (role.startsWith('ivf')) $('bxsCat').value = 'ivf';
    $('bxsForm').hidden = false; $('bxsDone').hidden = true; $('bxsErr').textContent = '';
    bg.classList.add('open');
    setTimeout(() => ($('bxsName').value ? $('bxsMsg') : $('bxsName')).focus(), 30);
  }
  function close() { bg.classList.remove('open'); fab.focus(); }

  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && bg.classList.contains('open')) close(); });
  fab.addEventListener('click', open);
  window.openSupportTicket = open;

  bg.querySelector('#bxsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const $ = id => bg.querySelector('#' + id);
    const body = {
      name: $('bxsName').value.trim(), phone: $('bxsPhone').value.trim(), role: $('bxsRole').value,
      category: $('bxsCat').value, subject: $('bxsSubject').value.trim(), message: $('bxsMsg').value.trim(),
      page: location.pathname + location.hash
    };
    const err = $('bxsErr');
    if (!body.name) { err.textContent = 'Please enter your name.'; return; }
    if (body.phone.replace(/\D/g, '').length < 10) { err.textContent = 'Please enter your 10-digit WhatsApp number.'; return; }
    if (body.message.length < 10) { err.textContent = 'Please describe the problem in a little more detail.'; return; }
    const btn = $('bxsSend'); btn.disabled = true; btn.textContent = 'Sending…'; err.textContent = '';
    try {
      const r = await fetch(API + '/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not send your report. Please try again.');
      $('bxsNo').textContent = d.ticketNo;
      $('bxsForm').hidden = true; $('bxsDone').hidden = false;
      $('bxsSubject').value = ''; $('bxsMsg').value = '';
    } catch (ex) {
      err.textContent = /fetch|network/i.test(ex.message) ? 'Could not connect — check your internet and try again.' : ex.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Send report';
    }
  });

  const mount = () => { document.body.appendChild(fab); document.body.appendChild(bg); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
