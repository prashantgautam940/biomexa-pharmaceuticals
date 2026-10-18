// ========== Biomexa IVF Care — doctor "Early pregnancy" tab ==========
// Records beta-hCG results and early scans, shows the published-criteria checks from
// ivf/pregnancy.js, and lets the doctor share an update in their own words.
// Uses the page globals from ivf-doctor.html: call(), current, IVF, IVFCharts.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => IVF.esc(s);
  const LEVEL = {
    good: ['b-ok', 'Within range'], info: ['b-neutral', 'Info'], watch: ['b-watch', 'Review'],
    suspicious: ['b-high', 'Suspicious'], diagnostic: ['b-critical', 'Meets failure criterion'], urgent: ['b-critical', 'Urgent']
  };
  const badge = l => `<span class="badge ${LEVEL[l]?.[0] || 'b-neutral'}">${LEVEL[l]?.[1] || l}</span>`;
  const fmt = d => d ? IVF.fmtDate(d) : '—';
  let cycleId = null, data = null;

  function sacForm(i) {
    const L = ['A', 'B', 'C', 'D'][i];
    return `<fieldset class="sac" data-i="${i}"><legend>Sac ${L}</legend>
      <div class="grid grid-4">
        <div class="field"><label>Mean sac diameter (mm)</label><input type="number" step="0.1" name="msdMm"></div>
        <div class="field"><label>Yolk sac</label><select name="yolkSac"><option value="">Not recorded</option><option value="true">Seen</option><option value="false">Not seen</option></select></div>
        <div class="field"><label>Yolk sac size (mm)</label><input type="number" step="0.1" name="yolkSacMm"></div>
        <div class="field"><label>Embryo</label><select name="embryo"><option value="">Not recorded</option><option value="true">Seen</option><option value="false">Not seen</option></select></div>
        <div class="field"><label>CRL (mm)</label><input type="number" step="0.1" name="crlMm"></div>
        <div class="field"><label>Heartbeat</label><select name="heartbeat"><option value="na">Not assessed</option><option value="yes">Present</option><option value="no">Absent</option></select></div>
        <div class="field"><label>Heart rate (bpm)</label><input type="number" name="fhrBpm"></div>
        <div class="field"><label class="check" style="margin-top:26px"><input type="checkbox" name="emptyAmnion"> Empty amnion</label></div>
      </div></fieldset>`;
  }

  function shell() {
    $('ptab-preg').innerHTML = `
      <div class="notice info"><b>Decision support for IVF doctors.</b> Checks the values you record against published reference criteria (SRU 2013, ACOG CO 700, Barnhart 2016, Doubilet &amp; Benson 1995, Robinson 1975). It does not diagnose or predict the outcome. Nothing here is shown to the patient unless you share it.</div>
      <div id="pgStatus"></div>
      <div class="pg-tiles" id="pgTiles"></div>
      <form class="card" id="pgSetup">
        <h2>Pregnancy dating</h2><p class="sub">IVF pregnancies are dated from the transfer date and embryo age, not redated by scan (ACOG CO 700).</p>
        <div class="grid grid-4">
          <div class="field"><label for="pgTransfer">Embryo transfer date</label><input type="date" id="pgTransfer" required></div>
          <div class="field"><label for="pgAge">Embryo age at transfer</label><select id="pgAge"><option value="5">Day 5 blastocyst</option><option value="6">Day 6 blastocyst</option><option value="3">Day 3 embryo</option></select></div>
          <div class="field"><label for="pgN">Embryos transferred</label><input type="number" id="pgN" min="1" max="4" value="1"></div>
          <div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Save dating</button></div>
          <div class="field"><label for="pgNextHcg">Next hCG test</label><input type="date" id="pgNextHcg"></div>
          <div class="field"><label for="pgNextScan">Next scan</label><input type="date" id="pgNextScan"></div>
          <div class="field" style="grid-column: span 2"><label>&nbsp;</label><p class="small muted">The patient gets a WhatsApp reminder on the morning of each planned test or scan.</p></div>
        </div>
      </form>
      <div class="grid grid-2">
        <form class="card" id="pgHcgForm"><h2>Add beta-hCG result</h2>
          <div class="grid grid-2"><div class="field"><label for="pgHcgDate">Test date</label><input type="date" id="pgHcgDate" required></div>
          <div class="field"><label for="pgHcgVal">Beta-hCG (mIU/mL)</label><input type="number" step="0.1" min="0" id="pgHcgVal" required></div></div>
          <button class="btn btn-primary" type="submit">Add result</button>
          <div id="pgHcgList" class="mt"></div>
        </form>
        <div class="card"><h2>Beta-hCG</h2><p class="sub">Rise per 48 hours compared with the minimum expected for a viable intrauterine pregnancy (Barnhart 2016).</p><div id="pgHcgChart"></div></div>
      </div>
      <form class="card" id="pgScanForm"><h2>Add early pregnancy scan</h2>
        <div class="grid grid-3">
          <div class="field"><label for="pgScanDate">Scan date</label><input type="date" id="pgScanDate" required></div>
          <div class="field"><label for="pgLoc">Location</label><select id="pgLoc"><option value="intrauterine">Intrauterine</option><option value="unknown">Pregnancy of unknown location</option><option value="ectopic_suspected">Suspected ectopic</option></select></div>
          <div class="field"><label>Gestational age on scan date</label><div id="pgScanGa" class="f-ga">—</div></div>
        </div>
        <div id="pgSacs">${sacForm(0)}</div>
        <div class="row"><button class="btn btn-ghost btn-sm" type="button" id="pgAddSac">+ Add another sac (twins)</button></div>
        <div class="field mt"><label for="pgScanNotes">Notes</label><input type="text" id="pgScanNotes" maxlength="1000"></div>
        <button class="btn btn-primary" type="submit">Add scan and check</button>
      </form>
      <div class="pg-grid">
        <section class="pg-card"><div class="pg-card-head"><h3>Crown–rump length vs IVF dates</h3><span class="pg-card-sub">mm · expected from Robinson 1975</span></div><div id="pgCrlChart"></div></section>
        <section class="pg-card"><div class="pg-card-head"><h3>Embryonic heart rate</h3><span class="pg-card-sub">bpm</span></div><div id="pgFhrChart"></div></section>
      </div>
      <div class="card"><h2>Scan findings</h2><div id="pgScans" class="list mt"></div></div>
      <form class="card" id="pgShare"><h2>Share an update with the patient</h2>
        <p class="sub">Write it in your own words. It appears in the patient's IVF Care app and is sent on WhatsApp. Automated checks are never sent to the patient.</p>
        <textarea id="pgShareText" maxlength="1500" placeholder="E.g. Your scan today shows a heartbeat and growth is as expected. Next scan in 2 weeks."></textarea>
        <button class="btn btn-primary mt" type="submit">Share with patient</button>
        <div id="pgShared" class="list mt"></div>
      </form>`;
    $('pgAddSac').onclick = () => { const n = $('pgSacs').querySelectorAll('.sac').length; if (n < 4) $('pgSacs').insertAdjacentHTML('beforeend', sacForm(n)); };
    $('pgScanDate').oninput = updateScanGa;
    $('pgSetup').onsubmit = e => { e.preventDefault(); send('PUT', '', { transferDate: $('pgTransfer').value, embryoAgeDays: $('pgAge').value, embryosTransferred: $('pgN').value, nextHcgDate: $('pgNextHcg').value, nextScanDate: $('pgNextScan').value }); };
    $('pgHcgForm').onsubmit = e => { e.preventDefault(); send('POST', '/hcg', { date: $('pgHcgDate').value, value: $('pgHcgVal').value }).then(ok => { if (ok) { $('pgHcgVal').value = ''; } }); };
    $('pgScanForm').onsubmit = e => {
      e.preventDefault();
      const fetuses = [...$('pgSacs').querySelectorAll('.sac')].map(fs => {
        const g = n => fs.querySelector(`[name=${n}]`);
        const tri = v => v === 'true' ? true : v === 'false' ? false : undefined;
        return { msdMm: g('msdMm').value, yolkSac: tri(g('yolkSac').value), yolkSacMm: g('yolkSacMm').value, embryo: tri(g('embryo').value), crlMm: g('crlMm').value, heartbeat: g('heartbeat').value, fhrBpm: g('fhrBpm').value, emptyAmnion: g('emptyAmnion').checked };
      });
      send('POST', '/scans', { date: $('pgScanDate').value, location: $('pgLoc').value, fetuses, notes: $('pgScanNotes').value }).then(ok => { if (ok) { $('pgSacs').innerHTML = sacForm(0); $('pgScanNotes').value = ''; } });
    };
    $('pgShare').onsubmit = e => { e.preventDefault(); send('POST', '/share', { text: $('pgShareText').value }).then(ok => { if (ok) $('pgShareText').value = ''; }); };
  }

  function updateScanGa() {
    const tr = data?.pregnancy?.transferDate, d = $('pgScanDate').value;
    if (!tr || !d) { $('pgScanGa').textContent = tr ? '—' : 'Save the transfer date first'; return; }
    const days = Math.round((new Date(d) - new Date(String(tr).slice(0, 10))) / 864e5) + (data.pregnancy.embryoAgeDays || 5) + 14;
    $('pgScanGa').textContent = `${Math.floor(days / 7)}w${days % 7}d by IVF dates`;
  }

  async function send(method, path, body) {
    try {
      const r = await call(`/api/ivf/doctor/cycles/${cycleId}/pregnancy${path}`, { method, body });
      IVF.toast(r.message); data = r; render(); return true;
    } catch (err) { IVF.toast(err.message, true); return false; }
  }

  function render() {
    const p = data.pregnancy, ev = data.evaluation;
    const st = ev.status;
    $('pgStatus').innerHTML = `<div class="notice ${({ good: 'ok', info: 'info', watch: 'watch', suspicious: 'high', diagnostic: 'critical', urgent: 'critical' })[st.level]}"><b>${esc(st.label)}.</b> ${esc(st.text)}${ev.repeatScanDue ? ` Suggested follow-up scan: <b>${fmt(ev.repeatScanDue.from)} – ${fmt(ev.repeatScanDue.to)}</b>.` : ''}</div>`;
    const lastHcg = ev.hcg.points[ev.hcg.points.length - 1];
    const tiles = [
      ['Gestational age today', ev.gaToday !== null ? ev.gaTodayLabel : '—', ev.gaToday !== null ? `Day-${ev.embryoAgeDays} transfer` : 'Add transfer date'],
      ['Due date', ev.edd ? fmt(ev.edd) : '—', 'Transfer + 266 − embryo age'],
      ['Latest scan', ev.latestSummary ? ev.latestSummary.ga : '—', ev.latestSummary ? `${ev.latestSummary.sacs} sac(s) · ${ev.latestSummary.heartbeats} heartbeat(s)` : 'No scans yet'],
      ['Latest beta-hCG', lastHcg ? `${lastHcg.value}` : '—', lastHcg ? `mIU/mL · ${fmt(lastHcg.date)}` : 'No results yet']
    ];
    $('pgTiles').innerHTML = tiles.map(([l, v, d]) => `<div class="pg-tile"><div class="pg-tile-label">${l}</div><div class="pg-tile-value">${esc(v)}</div><div class="pg-tile-delta">${esc(d)}</div></div>`).join('');
    if (p) {
      $('pgTransfer').value = p.transferDate ? String(p.transferDate).slice(0, 10) : '';
      $('pgAge').value = String(p.embryoAgeDays || 5); $('pgN').value = p.embryosTransferred || 1;
      $('pgNextHcg').value = p.nextHcgDate || ''; $('pgNextScan').value = p.nextScanDate || '';
    } else if (data.suggestedTransferDate) $('pgTransfer').value = String(data.suggestedTransferDate).slice(0, 10);
    // hCG list with 48h rises
    const rises = Object.fromEntries(ev.hcg.rises.map(r => [r.to, r]));
    const tests = (p?.hcgTests || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    $('pgHcgList').innerHTML = tests.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>mIU/mL</th><th>Rise / 48 h</th><th>Minimum expected</th><th></th></tr></thead><tbody>${tests.map(t => {
      const d = String(t.date).slice(0, 10), r = rises[d];
      return `<tr><td>${fmt(d)}${ev.gaToday !== null ? ` <span class="muted small">${gaOf(d)}</span>` : ''}</td><td class="num">${t.value}</td><td>${r ? `${r.rise48}% ${badge(r.level)}${r.doublingHours ? `<div class="small muted">doubling ${r.doublingHours} h</div>` : ''}` : '—'}</td><td>${r ? r.minExpected + '%' : '—'}</td><td><button class="btn btn-ghost btn-sm" type="button" data-del-hcg="${t._id}">Remove</button></td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">No hCG results yet.</div>';
    $('pgHcgList').querySelectorAll('[data-del-hcg]').forEach(b => b.onclick = () => send('DELETE', '/hcg/' + b.dataset.delHcg));
    // charts
    const allDates = [...ev.hcg.points.map(p => p.date), ...ev.crlSeries.map(p => p.date), ...ev.fhrSeries.map(p => p.date)].sort();
    const range = allDates.length ? { from: allDates[0], to: allDates[allDates.length - 1] > ev.today ? allDates[allDates.length - 1] : ev.today } : null;
    const chart = (id, opts, emptyText) => { const el = $(id); el.innerHTML = ''; if (range && opts.series.some(s => s.points.length)) IVFCharts.timeChart(el, { range, stages: [], ...opts }); else el.innerHTML = `<div class="pg-empty">${emptyText}</div>`; };
    chart('pgHcgChart', { title: 'Beta-hCG', series: [{ name: 'Beta-hCG', color: IVFCharts.colors.s1, points: ev.hcg.points.map(p => ({ date: p.date, v: p.value, flagged: (rises[p.date] || {}).level === 'watch' || (rises[p.date] || {}).level === 'suspicious', flags: rises[p.date] && rises[p.date].level !== 'good' ? [rises[p.date].text] : [] })) }], unit: 'mIU/mL', height: 200 }, 'Add two or more results to see the trend.');
    const labels = [...new Set(ev.crlSeries.map(p => p.label))];
    const sacColors = [IVFCharts.colors.s1, IVFCharts.colors.s2];
    chart('pgCrlChart', { title: 'CRL', series: [
      ...labels.slice(0, 2).map((L, i) => ({ name: labels.length > 1 ? `Sac ${L} measured` : 'Measured', color: sacColors[i], points: ev.crlSeries.filter(p => p.label === L).map(p => ({ date: p.date, v: p.v })) })),
      { name: 'Expected for IVF dates', color: '#8a93a6', points: [...new Map(ev.crlSeries.filter(p => p.expected !== null).map(p => [p.date, { date: p.date, v: p.expected }])).values()] }
    ], unit: 'mm', height: 190 }, 'CRL measurements from scans appear here.');
    const fl = [...new Set(ev.fhrSeries.map(p => p.label))];
    chart('pgFhrChart', { title: 'Heart rate', series: fl.slice(0, 2).map((L, i) => ({ name: fl.length > 1 ? `Sac ${L}` : 'Heart rate', color: sacColors[i], points: ev.fhrSeries.filter(p => p.label === L).map(p => ({ date: p.date, v: p.v })) })), unit: 'bpm', height: 190 }, 'Heart rates from scans appear here.');
    // scans with findings
    $('pgScans').innerHTML = ev.scans.length ? ev.scans.slice().reverse().map(s => `<div class="item ${['diagnostic', 'urgent'].includes(s.worst) ? 'critical' : ['suspicious', 'watch'].includes(s.worst) ? 'flagged' : ''}">
      <div class="spread"><div><b>${fmt(s.date)}</b> · ${esc(s.gaLabel)} by IVF dates · ${({ intrauterine: 'Intrauterine', unknown: 'Unknown location', ectopic_suspected: 'Suspected ectopic' })[s.location] || ''}${s.addedBy ? ` <span class="small muted">· ${esc(s.addedBy)}</span>` : ''}</div>
        <div class="row">${badge(s.worst)}<button class="btn btn-ghost btn-sm" type="button" data-del-scan="${s._id}">Remove</button></div></div>
      ${(s.fetuses || []).map(f => `<div class="sac-res"><div class="small"><b>Sac ${esc(f.label)}</b>: ${[f.msdMm && `MSD ${f.msdMm} mm`, f.yolkSac === true ? `yolk sac${f.yolkSacMm ? ' ' + f.yolkSacMm + ' mm' : ''}` : f.yolkSac === false ? 'no yolk sac' : '', f.crlMm ? `CRL ${f.crlMm} mm${f.crlGa ? ` (= ${Math.floor(f.crlGa / 7)}w${f.crlGa % 7}d)` : ''}` : f.embryo === false ? 'no embryo' : '', f.heartbeat === true ? `heartbeat ${f.fhrBpm ? f.fhrBpm + ' bpm' : 'present'}` : f.heartbeat === false ? 'no heartbeat' : '', f.emptyAmnion ? 'empty amnion' : ''].filter(Boolean).join(' · ')}</div>
        <ul class="findings">${f.findings.map(x => `<li>${badge(x.level)} <span>${esc(x.text)}</span> <span class="ref">${esc(x.ref)}</span></li>`).join('') || '<li class="muted small">No criteria triggered.</li>'}</ul></div>`).join('')}
      ${s.notes ? `<div class="small muted mt">“${esc(s.notes)}”</div>` : ''}</div>`).join('')
      : '<div class="empty">No scans yet. Add the first scan above.</div>';
    $('pgScans').querySelectorAll('[data-del-scan]').forEach(b => b.onclick = () => send('DELETE', '/scans/' + b.dataset.delScan));
    $('pgShared').innerHTML = (p?.sharedNotes || []).slice().reverse().map(n => `<div class="item"><div class="small muted">${IVF.fmtDateTime(n.at)} · ${esc(n.by || '')}</div><div class="pre">${esc(n.text)}</div></div>`).join('');
    updateScanGa();
  }
  function gaOf(d) {
    const tr = data?.pregnancy?.transferDate; if (!tr) return '';
    const days = Math.round((new Date(d) - new Date(String(tr).slice(0, 10))) / 864e5) + (data.pregnancy.embryoAgeDays || 5) + 14;
    return `${Math.floor(days / 7)}w${days % 7}d`;
  }

  async function load(id) {
    cycleId = id;
    if (!$('pgSetup')) shell();
    try { data = await call(`/api/ivf/doctor/cycles/${id}/pregnancy`); render(); }
    catch (err) { IVF.toast(err.message, true); }
  }
  window.PregnancyTab = { load, reset: () => { cycleId = null; data = null; const el = $('ptab-preg'); if (el) el.innerHTML = ''; } };
})();
