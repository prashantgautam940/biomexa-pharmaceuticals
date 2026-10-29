// ========== Biomexa — vitals charts & end-of-treatment analysis ==========
// The general patient portal and the doctor dashboard draw a patient's vitals the same way the
// IVF portal draws a cycle: one chart per recorded vital on a shared calendar axis, treatment
// phases shaded behind it, a crosshair tooltip, a table view, and a final analysis report.
// Chart drawing is IVFCharts.timeChart (js/ivf-charts.js); the numbers come from
// /api/patient/vitals-progress or /api/doctor/patient/:phone/vitals-progress (vitals/progress.js).
(function () {
  const COL = { a: '#2a78d6', b: '#c2477b', adh: '#1c9a55' };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtD = d => { if (!d) return '—'; const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MON[m - 1]} ${y}`; };
  const fmtShort = d => { if (!d) return '—'; const [, m, dd] = d.split('-').map(Number); return `${dd} ${MON[m - 1]}`; };
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const unitSp = u => u === '°F' ? '°F' : ' ' + u;
  const VERDICT = { improved: ['Improved', 'good'], in_range: ['In target', 'good'], unchanged: ['Little change', 'watch'], worsened: ['Needs attention', 'bad'], not_enough: ['Too few readings', 'neutral'] };

  function card(grid, title, sub, wide) {
    const c = h('section', 'pg-card' + (wide ? ' wide' : ''));
    const head = h('div', 'pg-card-head'); head.appendChild(h('h3', '', title)); if (sub) head.appendChild(h('span', 'pg-card-sub', sub));
    c.appendChild(head); grid.appendChild(c); return c;
  }
  // every reading of that day, so two readings on one day are both visible
  const readingsNote = p => p.n > 1 ? `${p.n} readings: ${p.readings.map(r => `${r.time} → ${r.v}`).join(' · ')}` : (p.readings && p.readings[0] ? `at ${p.readings[0].time}` : '');
  function statStrip(c, st) {
    const row = h('div', 'vp-stats');
    const add = (k, v) => { const b = h('div', 'vp-stat'); b.appendChild(h('span', '', k)); b.appendChild(h('b', '', v)); row.appendChild(b); };
    const u = unitSp(st.unit);
    add('First', `${st.first.v}${u}`); add('Latest', `${st.latest.v}${u}`);
    add('Lowest', `${st.lowest.v}`); add('Highest', `${st.highest.v}`);
    add('Average', `${st.average}`); add('In target', `${st.inTargetPct}%`);
    c.appendChild(row);
  }

  function render(host, pr, { audience = 'patient' } = {}) {
    host.replaceChildren();
    host.classList.add('vp-root');
    const S = pr.summary, st = pr.stats, base = { range: pr.range, stages: pr.stages };
    const you = audience === 'patient';

    // ---- tiles ----
    const tiles = h('div', 'pg-tiles');
    const tile = (label, value, delta, tone) => { const t = h('div', 'pg-tile'); t.appendChild(h('div', 'pg-tile-label', label)); t.appendChild(h('div', 'pg-tile-value', value)); if (delta) t.appendChild(h('div', 'pg-tile-delta ' + (tone || ''), delta)); tiles.appendChild(t); };
    tile(S.treatmentStatus === 'completed' ? 'Treatment complete' : 'Treatment day', S.treatmentStatus === 'completed' ? `${pr.dayNo} days` : `Day ${pr.dayNo}`, `${fmtShort(pr.report.period.from)} – ${S.treatmentStatus === 'completed' ? fmtShort(pr.report.period.to) : 'today'}`);
    tile('Medicines taken', S.adherencePct !== null ? `${S.adherencePct}%` : '—', S.adherencePct === null ? 'No doses due yet' : `${S.taken} of ${S.taken + S.missed} doses`, S.adherencePct === null ? '' : S.adherencePct >= 90 ? 'good' : 'watch');
    tile('Readings logged', String(S.totalReadings), S.lastReading ? `Last on ${fmtShort(S.lastReading)}` : 'None yet', S.readingDays7 >= 3 ? 'good' : 'watch');
    tile('Flagged readings', String(S.flaggedCount), S.flaggedCount ? 'In a dangerous range' : 'None in a dangerous range', S.flaggedCount ? 'watch' : 'good');
    host.appendChild(tiles);

    // ---- what changed ----
    const ch = h('section', 'pg-changes'); ch.appendChild(h('h3', '', you ? 'What changed during your treatment' : 'Changes during treatment'));
    const ul = h('ul');
    for (const i of pr.insights) { const li = h('li', 'tone-' + i.tone); li.appendChild(h('span', 'pg-ic', i.icon)); li.appendChild(h('span', '', i.text)); ul.appendChild(li); }
    if (!pr.insights.length) ul.appendChild(h('li', 'tone-neutral', you ? 'Changes appear here after you log your first readings.' : 'No readings or doses recorded yet.'));
    ch.appendChild(ul); host.appendChild(ch);

    // ---- one chart per recorded vital ----
    const grid = h('div', 'pg-grid'); host.appendChild(grid);
    const sr = pr.series;
    const missing = [];
    if (sr.bpSystolic.length && sr.bpDiastolic.length) {
      const c = card(grid, 'Blood pressure', `mmHg · ${st.bpSystolic.n} reading${st.bpSystolic.n === 1 ? '' : 's'} · target below 140/90`, true);
      IVFCharts.timeChart(c, { ...base, title: 'Blood pressure', unit: 'mmHg', height: 230,
        series: [{ name: 'Systolic (top)', color: COL.a, points: sr.bpSystolic }, { name: 'Diastolic (bottom)', color: COL.b, points: sr.bpDiastolic.map(p => ({ ...p, noNote: true })) }],
        refLines: [{ v: 140, label: '140' }, { v: 90, label: '90' }], tipExtra: p => p.noNote ? '' : readingsNote(p),
        tableExtra: { title: 'Readings that day', value: p => p.readings.map(r => r.time).join(', ') } });
      const row = h('div', 'vp-stats');
      const add = (k, v) => { const b = h('div', 'vp-stat'); b.appendChild(h('span', '', k)); b.appendChild(h('b', '', v)); row.appendChild(b); };
      const a = st.bpSystolic, b = st.bpDiastolic;
      add('First', `${a.first.v}/${b.first.v}`); add('Latest', `${a.latest.v}/${b.latest.v}`);
      add('Average', `${Math.round(a.average)}/${Math.round(b.average)}`); add('Highest top', String(a.highest.v));
      add('In target', `${Math.min(a.inTargetPct, b.inTargetPct)}%`);
      c.appendChild(row);
    } else missing.push('blood pressure');
    for (const [key, title, unit] of [['glucose', 'Blood sugar', 'mg/dL'], ['temperature', 'Temperature', '°F'], ['heartRate', 'Pulse', 'bpm']]) {
      if (!sr[key].length) { missing.push(title.toLowerCase()); continue; }
      const s = st[key];
      const c = card(grid, title, `${unit} · ${s.n} reading${s.n === 1 ? '' : 's'} · target ${s.target.lo}–${s.target.hi}`);
      IVFCharts.timeChart(c, { ...base, title, unit, height: 190, series: [{ name: title, color: COL.a, points: sr[key] }],
        bands: [{ lo: s.target.lo, hi: s.target.hi, label: 'target' }], tipExtra: readingsNote,
        tableExtra: { title: 'Readings that day', value: p => p.readings.map(r => `${r.time} ${r.v}`).join(', ') } });
      statStrip(c, s);
    }
    if (missing.length === 4) {
      const c = card(grid, 'No vitals yet', '', true);
      c.appendChild(h('div', 'pg-empty', you ? 'Log your BP, sugar, temperature or pulse below, or reply with the numbers on WhatsApp after a dose — each vital gets its own chart here.' : 'This patient has not logged any vitals yet.'));
    } else if (missing.length) {
      grid.appendChild(h('div', 'vp-missing', `Not recorded yet: ${missing.join(', ')}.`));
    }

    // ---- adherence ----
    const ac = card(grid, 'Medicines taken', '% of doses confirmed each day', true);
    if (pr.adherence.length) IVFCharts.timeChart(ac, { ...base, kind: 'bar', title: 'Medicines taken', series: [{ name: 'Taken', color: COL.adh, points: pr.adherence }],
      yDomain: [0, 100], yLabels: { 0: '0%', 50: '50%', 100: '100%' }, height: 170, valueFmt: v => v + '%',
      tipExtra: p => `${p.taken} of ${p.taken + p.missed} doses taken`, tableExtra: { title: 'Doses', value: p => `${p.taken} of ${p.taken + p.missed}` } });
    else ac.appendChild(h('div', 'pg-empty', 'Doses appear here once a medicine is added and its first dose is due.'));

    // ---- analysis report ----
    host.appendChild(renderReport(pr, audience));
  }

  function renderReport(pr, audience) {
    const R = pr.report, you = audience === 'patient';
    const box = h('section', 'vp-report');
    const head = h('div', 'vp-report-head');
    const hl = h('div'); hl.appendChild(h('h3', '', R.title));
    hl.appendChild(h('div', 'vp-report-sub', `${pr.patient?.name ? pr.patient.name + ' · ' : ''}${fmtD(R.period.from)} – ${R.status === 'completed' ? fmtD(R.period.to) : 'today'} · ${R.period.days} day${R.period.days === 1 ? '' : 's'}${R.status === 'ongoing' ? ' · treatment ongoing' : ''}`));
    head.appendChild(hl);
    const btn = h('button', 'vp-print', '⬇ Download / print report'); btn.type = 'button';
    btn.onclick = () => printReport(box.closest('.vp-root'));
    head.appendChild(btn); box.appendChild(head);
    if (R.status === 'ongoing') box.appendChild(h('div', 'vp-note', you ? 'Your treatment is still going on — this report updates with every reading. The final version is ready the day your last medicine course ends.' : 'Treatment still ongoing — this becomes the end-of-treatment report when the last course ends.'));

    const sum = h('ul', 'vp-summary'); for (const l of R.summary) sum.appendChild(h('li', '', l)); box.appendChild(sum);

    // medicines
    if (R.medicines.length) {
      box.appendChild(h('h4', '', 'Medicines'));
      const t = table(['Medicine', 'Dose', 'Started', 'Ended', 'Status']);
      for (const m of R.medicines) row(t, [m.name, m.dosage || '—', fmtShort(m.startDate), m.endDate ? fmtShort(m.endDate) : 'Ongoing', m.status === 'stopped' ? 'Stopped early' : m.status === 'completed' ? 'Completed' : 'Ongoing']);
      box.appendChild(wrapT(t));
      box.appendChild(h('div', 'vp-line', R.adherence.pct === null ? 'No doses were due yet.' : `Doses confirmed taken: ${R.adherence.taken} of ${R.adherence.taken + R.adherence.missed} (${R.adherence.pct}%).`));
    }

    // vitals analysis
    box.appendChild(h('h4', '', 'Vitals analysis'));
    const t = table(['Vital', 'Readings', 'First', 'Latest', 'Lowest', 'Highest', 'Average', 'In target', 'Result']);
    for (const v of R.vitals) {
      if (!v.n) { row(t, [v.label, '0', '—', '—', '—', '—', '—', '—', 'Not recorded']); continue; }
      const [vt, tone] = VERDICT[v.verdict] || ['—', 'neutral'];
      const tr = row(t, [v.label + ` (${v.unit})`, String(v.n), `${v.first.v} · ${fmtShort(v.first.date)}`, `${v.latest.v} · ${fmtShort(v.latest.date)}`, String(v.lowest.v), String(v.highest.v), String(v.average), `${v.inTargetPct}% (${v.target.lo}–${v.target.hi})`, vt]);
      tr.lastChild.className = 'vp-v-' + tone; tr.lastChild.title = v.text + (v.earlyAvg != null ? ` Early average ${v.earlyAvg}, late average ${v.lateAvg}.` : '');
    }
    box.appendChild(wrapT(t));
    const phases = R.vitals.filter(v => v.byPhase && v.byPhase.before && v.byPhase.on);
    if (phases.length) box.appendChild(h('div', 'vp-line', 'Before vs during treatment (average): ' + phases.map(v => `${v.label} ${v.byPhase.before.avg} → ${v.byPhase.on.avg}`).join(' · ')));

    if (R.flaggedReadings.length) {
      box.appendChild(h('h4', '', `Readings in a dangerous range (${R.flaggedReadings.length})`));
      const ft = table(['Date', 'Time', 'Reason']);
      for (const f of R.flaggedReadings.slice().reverse()) row(ft, [fmtShort(f.date), f.time, f.reason]).lastChild.className = 'vp-v-bad';
      box.appendChild(wrapT(ft));
    }
    if (R.ignoredReadings.length) {
      const d = h('details', 'vp-ignored'); d.appendChild(h('summary', '', `${R.ignoredReadings.length} reading${R.ignoredReadings.length === 1 ? '' : 's'} left out as likely typos`));
      const it = table(['Date', 'Time', 'Reading', 'Source']);
      for (const f of R.ignoredReadings) row(it, [fmtShort(f.date), f.time, f.reading, f.source]);
      d.appendChild(wrapT(it)); box.appendChild(d);
    }
    box.appendChild(h('div', 'vp-foot', `${R.note} Generated ${new Date(R.generatedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.`));
    return box;
  }
  function table(cols) { const t = h('table', 'vp-table'); const tr = h('tr'); cols.forEach(c => tr.appendChild(h('th', '', c))); const th = h('thead'); th.appendChild(tr); t.appendChild(th); t.appendChild(h('tbody')); return t; }
  function row(t, cells) { const tr = h('tr'); cells.forEach(c => tr.appendChild(h('td', '', c))); t.tBodies[0].appendChild(tr); return tr; }
  function wrapT(t) { const w = h('div', 'vp-table-wrap'); w.appendChild(t); return w; }

  // Prints only the charts + report (the browser's "Save as PDF" makes the downloadable copy).
  // A copy is placed straight under <body> and everything else is hidden, so the page's own
  // layout (grids, fixed modals, scroll areas) can't push it onto blank pages or cut it off.
  function printReport(root) {
    if (!root) return window.print();
    const sheet = root.cloneNode(true);
    sheet.classList.add('vp-print-sheet');
    sheet.querySelectorAll('.pg-tip').forEach(n => { n.hidden = true; });
    document.body.appendChild(sheet);
    document.body.classList.add('vp-printing');
    let cleaned = false;
    const done = () => { if (cleaned) return; cleaned = true; document.body.classList.remove('vp-printing'); sheet.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }

  window.VitalsCharts = { render };
})();
