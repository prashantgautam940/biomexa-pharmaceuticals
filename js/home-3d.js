// Home page 3D: Biomexa Care orbit, rotating ecosystem cube, tilting AI Pharmacist phone.
(function () {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Biomexa Care: benefits orbit the core on a tilted ellipse ----------
  const orbit = document.getElementById('careOrbit');
  if (orbit) {
    const nodes = Array.from(orbit.querySelectorAll('.orbit-node'));
    const ring = orbit.querySelector('.orbit-ring-a');
    const tilt = Math.cos(72 * Math.PI / 180); // matches the ring's rotateX(72deg)
    let base = 90, paused = false, last = performance.now();
    function place() {
      const rx = ring.offsetWidth / 2, ry = Math.max(rx * tilt, 70) + 40;
      nodes.forEach((n, i) => {
        const a = (base + i * (360 / nodes.length)) * Math.PI / 180;
        const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
        const depth = (Math.sin(a) + 1) / 2;            // 0 = behind the core, 1 = closest
        const scale = 0.72 + depth * 0.32;
        n.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
        n.style.opacity = (0.45 + depth * 0.55).toFixed(2);
        n.style.zIndex = depth > 0.5 ? 10 : 1;          // behind the core when at the back
        n.classList.toggle('front', depth > 0.92);
      });
    }
    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!paused && !reduceMotion && !document.hidden) base += 12 * dt;
      place();
      requestAnimationFrame(tick);
    }
    orbit.addEventListener('mouseenter', () => { paused = true; });
    orbit.addEventListener('mouseleave', () => { paused = false; });
    window.addEventListener('resize', place);
    requestAnimationFrame(tick);
  }

  // ---------- Ecosystem: rotating glass cube with a step bar ----------
  const scene = document.getElementById('eco3d');
  const cube = document.getElementById('ecoRing');
  if (scene && cube) {
    const faces = Array.from(cube.querySelectorAll('.eco-stage'));
    const n = faces.length, step = 360 / n;
    const tabs = Array.from(document.querySelectorAll('#ecoSteps button'));
    faces.forEach((f, i) => f.style.setProperty('--i', i));
    const layout = () => cube.style.setProperty('--eco-r', (cube.offsetWidth / 2) + 'px');
    layout();
    window.addEventListener('resize', layout);

    let rot = 0, target = null, paused = false, dragging = false, lastX = 0, last = performance.now(), hold = 0;
    const speed = reduceMotion ? 0 : 14;

    function paint() {
      cube.style.setProperty('--eco-rot', rot + 'deg');
      let front = 0, best = -2;
      faces.forEach((f, i) => {
        const facing = Math.cos(((i * step + rot) % 360) * Math.PI / 180);
        f.style.opacity = (facing > 0 ? Math.max(0.15, facing) : 0.04).toFixed(2); // back faces: faint glass edge only, no mirrored text
        f.setAttribute('aria-hidden', facing < 0.6 ? 'true' : 'false');
        if (facing > best) { best = facing; front = i; }
      });
      tabs.forEach((t, i) => t.setAttribute('aria-selected', i === front ? 'true' : 'false'));
    }
    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (target !== null) {
        const d = target - rot; rot += d * Math.min(1, dt * 7);
        if (Math.abs(d) < 0.2) { rot = target; target = null; hold = 2.5; }
      } else if (hold > 0) {
        hold -= dt; // pause on each face for a moment after it settles
      } else if (!paused && !dragging && !document.hidden && speed) {
        rot -= speed * dt;
        // settle on the next face every quarter turn so each stage is readable
        const nextStop = Math.floor(rot / step) * step;
        if (rot - nextStop < 0.6) { rot = nextStop; hold = 2.5; }
      }
      paint();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    tabs.forEach((t, i) => t.addEventListener('click', () => {
      // shortest turn to face i
      const want = -i * step;
      const k = Math.round((rot - want) / 360);
      target = want + k * 360;
    }));
    scene.addEventListener('mouseenter', () => { paused = true; });
    scene.addEventListener('mouseleave', () => { paused = false; });
    scene.addEventListener('pointerdown', e => { dragging = true; target = null; lastX = e.clientX; scene.classList.add('dragging'); scene.setPointerCapture(e.pointerId); });
    scene.addEventListener('pointermove', e => { if (!dragging) return; rot += (e.clientX - lastX) * 0.45; lastX = e.clientX; });
    const end = () => { if (!dragging) return; dragging = false; scene.classList.remove('dragging'); target = Math.round(rot / step) * step; };
    scene.addEventListener('pointerup', end);
    scene.addEventListener('pointercancel', end);
  }

  // ---------- AI Pharmacist phone: follows the pointer ----------
  const phone = document.getElementById('aipPhone');
  const stage = phone && phone.closest('.holo, .aip-stage');
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
