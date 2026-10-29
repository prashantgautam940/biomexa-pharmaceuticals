// ========== Biomexa IVF Care — treatment progress graphs ==========
// Dependency-free SVG charts for the patient portal and the IVF centre dashboard.
// Every chart shares one x-axis (calendar days of the cycle) with the treatment stages shaded
// behind it, so a change can be read against where the patient was in the cycle.
// Spec: thin 2px lines, ringed 8px markers, hairline grid, one y-axis per chart, a crosshair
// tooltip (pointer + keyboard), a legend only when there are 2+ series, and a table view.
(function () {
  const C = {
    s1: '#c2477b',      // series 1 (IVF rose)
    s2: '#2a78d6',      // series 2 (blue) — validated pair, light surface
    flag: '#c62828',    // status: flagged day (always with ⚠ text in tooltip + table)
    grid: '#ebe8f0', axis: '#8a93a6', ink: '#13213d', muted: '#5b6b86', surface: '#ffffff',
    band: '#f6f3f9'
  };
  const NS = 'http://www.w3.org/2000/svg';
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parse = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
  const fmt = d => { const x = parse(d); return `${x.getDate()} ${MON[x.getMonth()]}`; };
  const addDays = (d, n) => { const x = parse(d); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  const el = (tag, attrs = {}, parent) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; };
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  function niceTicks(lo, hi, count = 4) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const span = hi - lo, raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
    const t0 = Math.floor(lo / step) * step, out = [];
    for (let v = t0; v <= hi + step * 0.001; v += step) out.push(+v.toFixed(6));
    if (out[out.length - 1] < hi) out.push(+(out[out.length - 1] + step).toFixed(6));
    return out;
  }
  const fmtNum = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : (Math.round(v * 10) / 10).toString();

  // ---------- generic time chart (line or bar) ----------
  // opts: { kind:'line'|'bar', series:[{name, color, points:[{date,v,flagged,flags,note}]}], range:{from,to},
  //         stages:[{label,from,to}], unit, yDomain:[lo,hi], yLabels:{value:label}, height, valueFmt, tipExtra(point) }
  function timeChart(host, opts) {
    const wrap = h('div', 'pg-chart');
    const legendNeeded = opts.series.length > 1;
    if (legendNeeded) {
      const lg = h('div', 'pg-legend');
      for (const s of opts.series) { const it = h('span', 'pg-legend-item'); const k = h('i'); k.style.background = s.color; it.appendChild(k); it.appendChild(document.createTextNode(s.name)); lg.appendChild(it); }
      wrap.appendChild(lg);
    }
    const plot = h('div', 'pg-plot'); plot.tabIndex = 0;
    plot.setAttribute('role', 'img');
    wrap.appendChild(plot);
    const tip = h('div', 'pg-tip'); tip.hidden = true; plot.appendChild(tip);
    host.appendChild(wrap);

    const from = opts.range.from, nDays = Math.max(1, daysBetween(from, opts.range.to) + 1);
    const all = opts.series.flatMap(s => s.points);
    const dates = [...new Set(all.map(p => p.date))].sort();
    plot.setAttribute('aria-label', `${opts.title || 'Chart'}: ${all.length} readings from ${fmt(from)} to ${fmt(opts.range.to)}`);
    let state = { idx: -1 };

    function draw() {
      [...plot.querySelectorAll('svg')].forEach(n => n.remove());
      const W = Math.max(260, plot.clientWidth || 600), H = opts.height || 200;
      const padL = opts.yLabels ? Math.max(44, Math.max(...Object.values(opts.yLabels).map(l => String(l).length)) * 6.6 + 12) : 44;
      const padR = opts.kind === 'bar' ? 26 : (opts.yLabels ? 78 : 46), padT = 22, padB = 26;
      const iw = W - padL - padR, ih = H - padT - padB;
      const xOf = d => padL + (nDays === 1 ? iw / 2 : (daysBetween(from, d) / (nDays - 1)) * iw);
      let lo, hi;
      if (opts.yDomain) [lo, hi] = opts.yDomain;
      else {
        // reference bands / lines (e.g. a target range) are kept on screen so a reading above
        // target is visibly above it, not just a line at the top of an auto-scaled chart
        const vs = all.map(p => p.v).concat((opts.bands || []).flatMap(b => [b.lo, b.hi]), (opts.refLines || []).map(r => r.v));
        lo = Math.min(...vs); hi = Math.max(...vs); const pad = (hi - lo) * 0.15 || Math.max(1, Math.abs(hi) * 0.02); lo -= pad; hi += pad;
      }
      const ticks = opts.yLabels ? Object.keys(opts.yLabels).map(Number) : niceTicks(lo, hi);
      if (!opts.yDomain) { lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]); }
      const yOf = v => padT + ih - ((v - lo) / (hi - lo || 1)) * ih;

      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
      plot.insertBefore(svg, tip);
      // stage bands
      const stg = opts.stages || [];
      stg.forEach((s, i) => {
        // each stage runs from the day it started to the day the next one started
        const x0 = i === 0 ? padL : Math.max(padL, xOf(s.from < from ? from : s.from));
        const x1 = i === stg.length - 1 ? padL + iw : Math.min(padL + iw, xOf(stg[i + 1].from));
        if (x1 - x0 < 1) return;
        if (i % 2 === 0) el('rect', { x: x0, y: padT, width: x1 - x0, height: ih, fill: C.band }, svg);
        if (i > 0) el('line', { x1: x0, x2: x0, y1: padT - 4, y2: padT + ih, stroke: '#ded8e8', 'stroke-width': 1 }, svg);
        const label = s.label.length * 6.2 + 8 < x1 - x0 ? s.label : (s.label.split(' ')[0].length * 6.2 + 8 < x1 - x0 ? s.label.split(' ')[0] : '');
        if (label) { const t = el('text', { x: x0 + 4, y: padT - 7, fill: C.muted, 'font-size': 11, 'font-weight': 600 }, svg); t.textContent = label; }
      });
      // target bands and reference lines (optional — used by the general patient portal)
      for (const b of opts.bands || []) {
        const y0 = Math.max(padT, yOf(Math.min(hi, b.hi))), y1 = Math.min(padT + ih, yOf(Math.max(lo, b.lo)));
        if (y1 - y0 > 0) el('rect', { x: padL, y: y0, width: iw, height: y1 - y0, fill: b.color || '#e3f4ea', opacity: 0.7 }, svg);
        if (b.label && y1 - y0 > 14) { const t = el('text', { x: padL + iw - 4, y: y0 + 12, 'text-anchor': 'end', fill: '#11663a', 'font-size': 10.5, 'font-weight': 600 }, svg); t.textContent = b.label; }
      }
      for (const r of opts.refLines || []) {
        if (r.v < lo || r.v > hi) continue;
        el('line', { x1: padL, x2: padL + iw, y1: yOf(r.v), y2: yOf(r.v), stroke: r.color || '#b45309', 'stroke-width': 1, 'stroke-dasharray': '4 4' }, svg);
        if (r.label) { const t = el('text', { x: padL + iw - 4, y: yOf(r.v) - 4, 'text-anchor': 'end', fill: r.color || '#b45309', 'font-size': 10.5, 'font-weight': 600 }, svg); t.textContent = r.label; }
      }
      // grid + y labels
      for (const v of ticks) {
        if (v < lo - 1e-9 || v > hi + 1e-9) continue;
        el('line', { x1: padL, x2: padL + iw, y1: yOf(v), y2: yOf(v), stroke: C.grid, 'stroke-width': 1 }, svg);
        const t = el('text', { x: padL - 8, y: yOf(v) + 4, 'text-anchor': 'end', fill: C.axis, 'font-size': 11, 'font-variant-numeric': 'tabular-nums' }, svg);
        t.textContent = opts.yLabels ? opts.yLabels[v] : fmtNum(v);
      }
      // x labels (about 5)
      const step = Math.max(1, Math.ceil(nDays / Math.max(2, Math.floor(iw / 80))));
      for (let i = 0; i < nDays; i += step) {
        const d = addDays(from, i), t = el('text', { x: xOf(d), y: H - 6, 'text-anchor': 'middle', fill: C.axis, 'font-size': 11 }, svg); t.textContent = fmt(d);
      }
      // marks
      if (opts.kind === 'bar') {
        const slot = nDays > 1 ? iw / (nDays - 1) : iw;
        const bw = Math.max(4, Math.min(24, slot * 0.6));
        const s = opts.series[0];
        for (const p of s.points) {
          const x = xOf(p.date) - bw / 2, y = yOf(p.v), base = yOf(lo), hh = Math.max(2, base - y), r = Math.min(4, bw / 2, hh);
          el('path', { d: `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z`, fill: p.flagged ? C.flag : s.color, opacity: state.idx >= 0 && dates[state.idx] === p.date ? 0.75 : 1 }, svg);
          // label only the days that fell short, so missed doses stand out
          if (p.v < 100) { const t = el('text', { x: x + bw / 2, y: Math.min(y, base - 2) - 6, 'text-anchor': 'middle', fill: C.ink, 'font-size': 11, 'font-weight': 700 }, svg); t.textContent = (opts.valueFmt || fmtNum)(p.v); }
        }
      } else {
        for (const s of opts.series) {
          const pts = s.points;
          if (pts.length > 1) el('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.date).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(''), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
          for (const p of pts) el('circle', { cx: xOf(p.date), cy: yOf(p.v), r: p.flagged ? 5.5 : 4, fill: p.flagged ? C.flag : s.color, stroke: C.surface, 'stroke-width': 2 }, svg);
          // direct label at the end (single series, or each series when they don't collide)
          const end = pts[pts.length - 1];
          if (end && (opts.series.length === 1 || opts.series.length === 2)) {
            const t = el('text', { x: xOf(end.date) + 8, y: yOf(end.v) + 4, fill: C.ink, 'font-size': 12, 'font-weight': 700, 'font-variant-numeric': 'tabular-nums' }, svg);
            t.textContent = opts.yLabels ? opts.yLabels[end.v] : (opts.valueFmt || fmtNum)(end.v);
          }
        }
      }
      // crosshair
      if (state.idx >= 0) {
        const d = dates[state.idx], x = xOf(d);
        el('line', { x1: x, x2: x, y1: padT, y2: padT + ih, stroke: C.axis, 'stroke-width': 1 }, svg);
        if (opts.kind !== 'bar') for (const s of opts.series) { const p = s.points.find(q => q.date === d); if (p) el('circle', { cx: x, cy: yOf(p.v), r: 6, fill: p.flagged ? C.flag : s.color, stroke: C.surface, 'stroke-width': 2 }, svg); }
        showTip(d, x, W);
      } else tip.hidden = true;
      plot._xOf = xOf; plot._W = W;
    }
    function showTip(d, x, W) {
      tip.replaceChildren();
      tip.appendChild(h('div', 'pg-tip-date', fmt(d) + stageAt(d)));
      for (const s of opts.series) {
        const p = s.points.find(q => q.date === d); if (!p) continue;
        const row = h('div', 'pg-tip-row'); const key = h('i'); key.style.background = s.color; row.appendChild(key);
        row.appendChild(h('b', '', (opts.yLabels ? opts.yLabels[p.v] : (opts.valueFmt || fmtNum)(p.v)) + (opts.unit && !opts.yLabels ? ' ' + opts.unit : '')));
        if (opts.series.length > 1) row.appendChild(h('span', '', s.name));
        tip.appendChild(row);
        const extra = opts.tipExtra && opts.tipExtra(p); if (extra) tip.appendChild(h('div', 'pg-tip-note', extra));
        if (p.flagged && p.flags && p.flags.length) tip.appendChild(h('div', 'pg-tip-flag', '⚠ ' + p.flags.slice(0, 2).join('; ')));
      }
      tip.hidden = false;
      const tw = tip.offsetWidth || 160;
      tip.style.left = Math.min(Math.max(4, x + 12 + tw > W ? x - tw - 12 : x + 12), W - tw - 4) + 'px';
    }
    function stageAt(d) { const s = [...(opts.stages || [])].reverse().find(s => d >= s.from); return s ? ' · ' + s.label : ''; }
    function nearest(px) {
      if (!dates.length) return -1;
      let best = 0, bd = Infinity; dates.forEach((d, i) => { const dd = Math.abs(plot._xOf(d) - px); if (dd < bd) { bd = dd; best = i; } }); return best;
    }
    plot.addEventListener('pointermove', e => { const r = plot.getBoundingClientRect(); const i = nearest(e.clientX - r.left); if (i !== state.idx) { state.idx = i; draw(); } });
    plot.addEventListener('pointerleave', () => { state.idx = -1; draw(); });
    plot.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); state.idx = Math.max(0, Math.min(dates.length - 1, (state.idx < 0 ? dates.length : state.idx) + (e.key === 'ArrowRight' ? 1 : -1))); draw(); }
      if (e.key === 'Escape') { state.idx = -1; draw(); }
    });
    plot.addEventListener('blur', () => { state.idx = -1; draw(); });
    draw();
    if (window.ResizeObserver) new ResizeObserver(() => draw()).observe(plot);

    // table view (the same values without hovering)
    const det = h('details', 'pg-table'); det.appendChild(h('summary', '', 'Show as table'));
    const tw = h('div', 'pg-table-wrap'); const table = h('table'); const thead = h('thead'); const trh = h('tr');
    trh.appendChild(h('th', '', 'Date')); trh.appendChild(h('th', '', 'Stage'));
    for (const s of opts.series) trh.appendChild(h('th', '', s.name + (opts.unit && !opts.yLabels ? ` (${opts.unit})` : '')));
    if (opts.tableExtra) trh.appendChild(h('th', '', opts.tableExtra.title));
    trh.appendChild(h('th', '', 'Flags'));
    thead.appendChild(trh); table.appendChild(thead);
    const tb = h('tbody');
    for (const d of [...dates].reverse()) {
      const tr = h('tr'); tr.appendChild(h('td', '', fmt(d))); tr.appendChild(h('td', '', stageAt(d).replace(' · ', '') || '—'));
      let flags = [];
      for (const s of opts.series) { const p = s.points.find(q => q.date === d); tr.appendChild(h('td', 'num', p ? (opts.yLabels ? opts.yLabels[p.v] : (opts.valueFmt || fmtNum)(p.v)) : '—')); if (p && p.flagged) flags = flags.concat(p.flags || ['Flagged']); }
      if (opts.tableExtra) { const p = opts.series[0].points.find(q => q.date === d); tr.appendChild(h('td', '', p ? opts.tableExtra.value(p) : '')); }
      tr.appendChild(h('td', flags.length ? 'flag' : '', flags.length ? '⚠ ' + [...new Set(flags)].join('; ') : ''));
      tb.appendChild(tr);
    }
    table.appendChild(tb); tw.appendChild(table); det.appendChild(tw); wrap.appendChild(det);
  }

  // ---------- full progress view ----------
  function card(grid, title, sub, wide) {
    const c = h('section', 'pg-card' + (wide ? ' wide' : ''));
    const head = h('div', 'pg-card-head'); head.appendChild(h('h3', '', title)); if (sub) head.appendChild(h('span', 'pg-card-sub', sub));
    c.appendChild(head); grid.appendChild(c); return c;
  }
  function empty(c, text) { c.appendChild(h('div', 'pg-empty', text)); }

  function renderProgress(host, pr, { audience = 'patient' } = {}) {
    host.replaceChildren();
    const S = pr.summary, base = { range: pr.range, stages: pr.stages };
    // stat tiles
    const tiles = h('div', 'pg-tiles');
    const tile = (label, value, delta, tone) => { const t = h('div', 'pg-tile'); t.appendChild(h('div', 'pg-tile-label', label)); t.appendChild(h('div', 'pg-tile-value', value)); if (delta) t.appendChild(h('div', 'pg-tile-delta ' + (tone || ''), delta)); tiles.appendChild(t); };
    tile('Treatment day', `Day ${pr.dayNo}`, pr.stage.label);
    tile('Weight', S.latestWeight !== null ? `${S.latestWeight} kg` : '—', S.weightChange !== null ? `${S.weightChange > 0 ? '+' : ''}${S.weightChange} kg since start` : 'No readings yet', S.weightChange >= 2 ? 'watch' : '');
    tile('Medicines taken', S.adherencePct !== null ? `${S.adherencePct}%` : '—', S.adherencePct === null ? 'No doses due yet' : S.adherencePct >= 90 ? 'On track' : 'Some doses missed', S.adherencePct !== null && S.adherencePct < 90 ? 'watch' : 'good');
    tile('Check-ins', `${S.checkinDays7}/${S.expected7}`, 'days, last 7 days', S.checkinDays7 >= S.expected7 - 1 ? 'good' : 'watch');
    host.appendChild(tiles);

    // what changed
    const ch = h('section', 'pg-changes'); ch.appendChild(h('h3', '', audience === 'doctor' ? 'Changes during treatment' : 'What changed during your treatment'));
    const ul = h('ul');
    for (const i of pr.insights) { const li = h('li', 'tone-' + i.tone); li.appendChild(h('span', 'pg-ic', i.icon)); li.appendChild(h('span', '', i.text)); ul.appendChild(li); }
    if (!pr.insights.length) ul.appendChild(h('li', 'tone-neutral', 'Changes appear here after your first check-ins.'));
    ch.appendChild(ul); host.appendChild(ch);

    const grid = h('div', 'pg-grid'); host.appendChild(grid);
    const sr = pr.series;
    // weight
    let c = card(grid, 'Weight', S.baselineWeight !== null ? `Start ${S.baselineWeight} kg` : 'kg', true);
    sr.weight.length ? timeChart(c, { ...base, title: 'Weight', series: [{ name: 'Weight', color: C.s1, points: sr.weight }], unit: 'kg', height: 220 })
      : empty(c, 'Weight readings from daily check-ins will appear here.');
    // pain
    c = card(grid, 'Pain', '0 = none, 10 = worst');
    sr.pain.length ? timeChart(c, { ...base, title: 'Pain', series: [{ name: 'Pain', color: C.s1, points: sr.pain }], yDomain: [0, 10], unit: '/10' }) : empty(c, 'No pain scores yet.');
    // bloating
    c = card(grid, 'Bloating', 'from daily check-ins');
    sr.bloating.length ? timeChart(c, { ...base, title: 'Bloating', series: [{ name: 'Bloating', color: C.s1, points: sr.bloating }], yDomain: [0, 3], yLabels: { 0: 'None', 1: 'Mild', 2: 'Moderate', 3: 'Severe' } }) : empty(c, 'No bloating answers yet.');
    // temperature
    c = card(grid, 'Temperature', '°F');
    sr.temperature.length ? timeChart(c, { ...base, title: 'Temperature', series: [{ name: 'Temperature', color: C.s1, points: sr.temperature }], unit: '°F' }) : empty(c, 'No temperature readings yet.');
    // blood pressure
    c = card(grid, 'Blood pressure', 'mmHg');
    sr.bpSystolic.length ? timeChart(c, { ...base, title: 'Blood pressure', series: [{ name: 'Systolic', color: C.s1, points: sr.bpSystolic }, { name: 'Diastolic', color: C.s2, points: sr.bpDiastolic }], unit: 'mmHg' }) : empty(c, 'No blood pressure readings yet.');
    // waist
    if (sr.girth.length) { c = card(grid, 'Waist / tummy size', 'cm'); timeChart(c, { ...base, title: 'Waist', series: [{ name: 'Waist', color: C.s1, points: sr.girth }], unit: 'cm' }); }
    // adherence
    c = card(grid, 'IVF medicines taken', '% of doses confirmed each day', true);
    pr.adherence.length ? timeChart(c, { ...base, kind: 'bar', title: 'Medicines taken', series: [{ name: 'Taken', color: C.s1, points: pr.adherence.map(d => ({ ...d, flagged: d.missed > 0 && d.trigger, flags: d.missed > 0 && d.trigger ? ['Trigger shot not confirmed'] : [] })) }], yDomain: [0, 100], yLabels: { 0: '0%', 50: '50%', 100: '100%' }, height: 180,
      tipExtra: p => `${p.taken} of ${p.taken + p.missed} doses taken${p.trigger ? ' · includes trigger shot' : ''}`, tableExtra: { title: 'Doses', value: p => `${p.taken} of ${p.taken + p.missed}` }, valueFmt: v => v + '%' })
      : empty(c, 'Medicine doses appear here once your centre adds your IVF medicines.');
    // labs (small multiples, one measure each)
    const L = pr.labs, labDefs = [['estradiol', 'Estradiol (E2)', 'pg/mL'], ['follicles', 'Follicle count', 'follicles'], ['leadFollicleMm', 'Lead follicle size', 'mm'], ['endometriumMm', 'Endometrium thickness', 'mm'], ['progesterone', 'Progesterone', 'ng/mL'], ['betaHcg', 'Beta-hCG', 'mIU/mL']];
    const anyLab = labDefs.some(([k]) => L[k] && L[k].length);
    const lh = h('div', 'pg-section-title', 'Hormone and scan results'); lh.appendChild(h('span', '', anyLab ? 'From reports reviewed by your IVF doctor' : '')); host.appendChild(lh);
    const lg = h('div', 'pg-grid'); host.appendChild(lg);
    if (!anyLab) empty(card(lg, 'No results yet', '', true), audience === 'doctor' ? 'Values you enter when analysing a report (E2, follicles, endometrium, beta-hCG) are plotted here.' : 'When your doctor reviews a report and records values like E2 or follicle count, they are plotted here.');
    for (const [k, label, unit] of labDefs) {
      if (!L[k] || !L[k].length) continue;
      c = card(lg, label, unit);
      timeChart(c, { ...base, title: label, series: [{ name: label, color: C.s1, points: L[k] }], unit, height: 170, tipExtra: p => p.report || '' });
    }
  }

  window.IVFCharts = { timeChart, renderProgress, colors: C };
})();
