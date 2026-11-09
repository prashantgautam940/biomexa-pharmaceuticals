/* Biomexa product detail pages — order form. Shares the "remembered on this phone"
   name/number with the AI Pharmacist pages so patients never type them twice. */
(function () {
  const O = window.BIOMEXA_ORDER;
  const API_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://biomexa-api-f9f6.onrender.com';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, f) { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
  };
  const me = store.get('biomexa_me', {});
  if (me.name && !$('orderName').value) $('orderName').value = me.name;
  if (me.phone && !$('orderPhone').value) $('orderPhone').value = me.phone;
  if (me.address && !$('orderAddress').value) $('orderAddress').value = me.address;
  if (me.pin && !$('orderPin').value) $('orderPin').value = me.pin;

  const qty = $('orderQuantity');
  const clampQty = () => { qty.value = Math.min(50, Math.max(1, Math.round(+qty.value) || 1)); };
  document.querySelectorAll('.qty button').forEach(b => b.addEventListener('click', () => { qty.value = (+qty.value || 1) + (+b.dataset.q); clampQty(); }));
  qty.addEventListener('change', clampQty);
  $('orderPin').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });

  // Prescription: upload now, or show it when the team calls.
  const rxMode = () => (document.querySelector('input[name="rxMode"]:checked') || {}).value || 'upload';
  const syncRx = () => { $('rxUploadBox').hidden = rxMode() !== 'upload'; };
  document.querySelectorAll('input[name="rxMode"]').forEach(r => r.addEventListener('change', syncRx));
  syncRx();

  const msg = $('orderMsg');
  const fail = (t, el) => { msg.className = 'form-msg err'; msg.textContent = t; if (el) el.focus(); };

  $('orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.className = 'form-msg'; msg.textContent = '';
    const name = $('orderName').value.trim();
    const d = $('orderPhone').value.replace(/\D/g, ''); const phone10 = d.length > 10 ? d.slice(-10) : d;
    const street = $('orderAddress').value.trim();
    const pin = $('orderPin').value.trim();
    clampQty(); const quantity = +qty.value;
    if (!name) return fail('Please enter your name.', $('orderName'));
    if (!/^[6-9]\d{9}$/.test(phone10)) return fail('Please enter a valid 10-digit mobile number.', $('orderPhone'));
    if (street.length < 8) return fail('Please enter your full delivery address.', $('orderAddress'));
    if (!/^[1-9]\d{5}$/.test(pin)) return fail('Please enter your 6-digit PIN code.', $('orderPin'));

    const rxLater = rxMode() === 'later';
    const rxFiles = rxLater ? [] : Array.from($('orderRx').files || []);
    if (!rxLater && !rxFiles.length) return fail('Please add a photo of your prescription — or choose "Show it on the call".', $('orderRx'));
    if (rxFiles.length > 3) return fail('Please choose up to 3 prescription files.');
    const badType = rxFiles.find(f => !/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type));
    if (badType) return fail(`"${badType.name}" — please upload a JPG, PNG, WEBP or PDF.`);
    const tooBig = rxFiles.find(f => f.size > 5 * 1024 * 1024);
    if (tooBig) return fail(`"${tooBig.name}" is over 5 MB — please choose a smaller photo.`);
    const toB64 = f => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => bad(new Error('Could not read ' + f.name)); r.readAsDataURL(f); });

    const btn = $('orderBtn'); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Placing your order…';
    try {
      const res = await fetch(API_URL + '/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...O, customerName: name, phone: '+91' + phone10, address: `${street}, PIN ${pin}`, quantity,
          promoCode: ($('orderPromo')?.value || '').trim(),
          prescriptionFiles: await Promise.all(rxFiles.map(async f => ({ fileName: f.name, fileType: f.type, fileData: await toB64(f) }))),
          prescriptionLater: rxLater
        })
      });
      const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = { message: text }; }
      if (!res.ok) throw new Error(data.message || 'Could not place the order — please try again.');
      Object.assign(me, { name, phone: phone10, address: street, pin }); store.set('biomexa_me', me);

      $('doneRef').textContent = data.orderRef ? `Order ${data.orderRef}` : '';
      $('doneText').textContent =
        `${quantity} strip${quantity > 1 ? 's' : ''} of ${O.productName}${data.discountPct ? ` with ${data.discountPct}% off` : ''}. ` +
        (data.whatsappSent
          ? `We've sent the order details to your WhatsApp on +91 ${phone10}.`
          : `Our team will call you on +91 ${phone10} shortly.`);
      $('orderForm').hidden = true; $('orderDone').hidden = false;
      $('order').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      fail(/fetch|network/i.test(err.message) ? 'Could not connect — please check your internet and try again.' : err.message);
    } finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Place order'; }
  });

  $('orderAgain').addEventListener('click', () => {
    $('orderRx').value = ''; qty.value = 1; if ($('orderPromo')) $('orderPromo').value = '';
    $('orderDone').hidden = true; $('orderForm').hidden = false; msg.className = 'form-msg'; msg.textContent = '';
  });

  // Arriving from a WhatsApp refill link (…#orderForm): bring the order card into view.
  if (location.hash === '#orderForm') setTimeout(() => $('order').scrollIntoView({ block: 'start' }), 100);
})();
