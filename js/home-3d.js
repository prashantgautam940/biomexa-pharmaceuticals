// Home page 3D: rotating ecosystem ring + tilting AI Pharmacist phone.
(function () {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Ecosystem ring ----------
  const scene = document.getElementById('eco3d');
  const ring = document.getElementById('ecoRing');
  if (scene && ring) {
    const cards = Array.from(ring.querySelectorAll('.eco-stage'));
    const n = cards.length;
    const step = 360 / n;
    cards.forEach((c, i) => c.style.setProperty('--i', i));

    function layout() {
      const w = ring.offsetWidth;
      // Distance from the centre so neighbouring cards just clear each other, plus breathing room.
      const r = Math.round((w / 2) / Math.tan(Math.PI / n) + (window.innerWidth < 600 ? 40 : 90));
      ring.style.setProperty('--eco-r', r + 'px');
    }
    layout();
    window.addEventListener('resize', layout);

    let rot = 0, target = null, paused = false, dragging = false, lastX = 0, last = performance.now();
    const speed = reduceMotion ? 0 : 9; // degrees per second

    function paint() {
      ring.style.setProperty('--eco-rot', rot + 'deg');
      // Cards turning away fade out, so only the front stage is fully readable.
      cards.forEach((c, i) => {
        const a = ((i * step + rot) % 360 + 360) % 360;
        const facing = Math.cos(a * Math.PI / 180);
        c.style.opacity = Math.max(0.15, facing).toFixed(2);
        c.setAttribute('aria-hidden', facing < 0.5 ? 'true' : 'false');
      });
    }
    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (target !== null) {
        const d = target - rot;
        rot += d * Math.min(1, dt * 7);
        if (Math.abs(d) < 0.2) { rot = target; target = null; }
      } else if (!paused && !dragging && !document.hidden) {
        rot -= speed * dt;
      }
      paint();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    const snap = dir => {
      const base = target !== null ? target : rot;
      target = Math.round(base / step) * step + dir * step;
    };
    const prev = document.getElementById('ecoPrev'), next = document.getElementById('ecoNext');
    if (prev) prev.addEventListener('click', () => snap(1));
    if (next) next.addEventListener('click', () => snap(-1));

    scene.addEventListener('mouseenter', () => { paused = true; });
    scene.addEventListener('mouseleave', () => { paused = false; });
    scene.addEventListener('focusin', () => { paused = true; });
    scene.addEventListener('focusout', () => { paused = false; });
    scene.addEventListener('pointerdown', e => { dragging = true; target = null; lastX = e.clientX; scene.classList.add('dragging'); scene.setPointerCapture(e.pointerId); });
    scene.addEventListener('pointermove', e => { if (!dragging) return; rot += (e.clientX - lastX) * 0.4; lastX = e.clientX; });
    const end = () => { if (!dragging) return; dragging = false; scene.classList.remove('dragging'); target = Math.round(rot / step) * step; };
    scene.addEventListener('pointerup', end);
    scene.addEventListener('pointercancel', end);
    document.addEventListener('keydown', e => {
      if (!scene.matches(':hover') && !scene.contains(document.activeElement)) return;
      if (e.key === 'ArrowLeft') snap(1);
      if (e.key === 'ArrowRight') snap(-1);
    });
  }

  // ---------- AI Pharmacist phone: follows the pointer ----------
  const phone = document.getElementById('aipPhone');
  const stage = phone && phone.closest('.aip-stage');
  if (phone && stage && !reduceMotion && window.matchMedia('(hover: hover)').matches) {
    stage.addEventListener('mousemove', e => {
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      phone.classList.add('tilting');
      phone.style.transform = `rotateY(${(-14 + x * 26).toFixed(1)}deg) rotateX(${(6 - y * 16).toFixed(1)}deg) translateY(-6px)`;
    });
    stage.addEventListener('mouseleave', () => { phone.classList.remove('tilting'); phone.style.transform = ''; });
  }
})();
