/* Biomexa UI — gentle 3D tilt for cards across the platform.
   Only on devices with a real pointer (mouse/trackpad) and when the user hasn't asked for
   reduced motion; phones keep a flat, fast UI. Cards added later (e.g. lists rendered from
   the API) are picked up automatically. */
(function () {
  if (!window.matchMedia || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const SELECTOR = [
    '.card', '.stat-card', '.feature-card', '.product-card', '.drug-card', '.info-card', '.metric-card',
    '.kpi', '.panel', '.gallery-card', '.solution-card', '.problem-card', '.portal-card', '.step-card',
    '.pricing-card', '.testimonial-card', '.tile', '.promise', '.help', '.fact', '.info'
  ].join(',');
  const MAX = 5; // degrees — subtle, never seasick

  function enhance(el) {
    if (el.dataset.bx3d || el.closest('form') === el || el.offsetWidth > 900) return; // skip page-wide panels
    el.dataset.bx3d = '1';
    el.classList.add('bx-3d');
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    // Cards with form fields only get the lift shadow — tilting while typing is irritating.
    if (el.querySelector('input, textarea, select')) return;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.style.transform = `perspective(1000px) rotateX(${(0.5 - y) * MAX}deg) rotateY(${(x - 0.5) * MAX}deg) translateY(-3px)`;
      el.style.setProperty('--bx-mx', `${x * 100}%`);
      el.style.setProperty('--bx-my', `${y * 100}%`);
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  }

  function scan(root) { (root.querySelectorAll ? root.querySelectorAll(SELECTOR) : []).forEach(enhance); }
  document.addEventListener('DOMContentLoaded', () => {
    scan(document);
    new MutationObserver((muts) => muts.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(SELECTOR)) enhance(n);
      scan(n);
    }))).observe(document.body, { childList: true, subtree: true });
  });
})();
