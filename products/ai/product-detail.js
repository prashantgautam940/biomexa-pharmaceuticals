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

  document.querySelectorAll('.qty button').forEach(b => b.addEventListener('click', () => {
    const q = $('orderQuantity'); q.value = Math.min(50, Math.max(1, (+q.value || 1) + (+b.dataset.q)));
  }));

  $('orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('orderMsg'); msg.className = 'form-msg'; msg.textContent = '';
    const fail = (t) => { msg.className = 'form-msg err'; msg.textContent = t; };
    const name = $('orderName').value.trim();
    const d = $('orderPhone').value.replace(/\D/g, ''); const phone10 = d.length > 10 ? d.slice(-10) : d;
    const address = $('orderAddress').value.trim();
    const quantity = Math.max(1, +$('orderQuantity').value || 1);
    if (!name) return fail('Please enter your name.');
    if (phone10.length !== 10) return fail('Please enter your 10-digit phone number.');
    if (address.length < 10) return fail('Please enter your full delivery address with PIN code.');

    const btn = $('orderBtn'); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
    try {
      const res = await fetch(API_URL + '/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...O, customerName: name, phone: '+91' + phone10, address, quantity })
      });
      const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = { message: text }; }
      if (!res.ok) throw new Error(data.message || 'Could not place the order — please try again.');
      me.name = name; me.phone = phone10; store.set('biomexa_me', me);
      msg.className = 'form-msg ok';
      msg.innerHTML = `✅ <strong>Request received!</strong> Our team will call you on +91 ${phone10} to confirm your ${quantity} strip${quantity > 1 ? 's' : ''} of ${O.productName}.`;
      $('orderAddress').value = ''; $('orderQuantity').value = 1;
    } catch (err) {
      fail(/fetch|network/i.test(err.message) ? 'Could not connect — please check your internet and try again.' : err.message);
    } finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Request delivery'; }
  });

  // Arriving from a WhatsApp refill link (…#orderForm): bring the order card into view.
  if (location.hash === '#orderForm') setTimeout(() => $('order').scrollIntoView({ block: 'start' }), 100);
})();
