// ========== BIOMEXA — COURSE JOURNEY REPORT (PDF) ==========
// Sent to the patient on WhatsApp the moment a medicine course ends. It walks them through their
// whole course in plain words: how many doses they took, how they did week by week, which dose
// times were easy or hard, a day-by-day calendar, their BP / sugar readings from start to end,
// and what to do next. Everything is worked out from their own dose and vitals records — no
// guessing — and it always ends with "talk to your doctor", never medical advice.
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const LOGO = path.join(__dirname, '..', 'images', 'logo-invoice.png');

const NAVY = '#16336b', GREEN = '#1c9a55', RED = '#d0454c', AMBER = '#d48a10', MUTED = '#5b6b86', LINE = '#dfe5ef', TEXT = '#13213d', SOFT = '#f6f8fc';

const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';
const fmtShort = s => { const d = new Date(s + 'T12:00:00+05:30'); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }); };
const fmtTime = t => { const [h, m] = String(t || '00:00').split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const pctOf = (a, b) => b ? Math.round(100 * a / b) : null;

// ---- turn raw rows into the story -------------------------------------------------------------
// input: { patientName, phone, medicine: {name, dosage, times[], startDate, endDate, completedAt,
//          durationDays, foodNote, stoppedByPatient}, rows: [{date, time, outcome}] (taken|missed),
//          vitals: [{at, sys, dia, glucose, hr}], refillUrl }
function analyseJourney(input) {
  const rows = (input.rows || []).filter(r => r.outcome === 'taken' || r.outcome === 'missed')
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const taken = rows.filter(r => r.outcome === 'taken').length, due = rows.length, missed = due - taken;
  const pct = pctOf(taken, due);

  // Per day
  const byDay = new Map();
  for (const r of rows) {
    const d = byDay.get(r.date) || { date: r.date, taken: 0, due: 0 };
    d.due++; if (r.outcome === 'taken') d.taken++;
    byDay.set(r.date, d);
  }
  const days = [...byDay.values()];
  const perfectDays = days.filter(d => d.taken === d.due).length;
  // Longest run of days with every dose taken
  let streak = 0, best = 0;
  for (const d of days) { if (d.taken === d.due) { streak++; best = Math.max(best, streak); } else streak = 0; }

  // Per week (week 1 = first 7 days of the course)
  const weeks = [];
  days.forEach((d, i) => {
    const w = Math.floor(i / 7);
    weeks[w] = weeks[w] || { label: `Week ${w + 1}`, from: d.date, to: d.date, taken: 0, due: 0 };
    weeks[w].to = d.date; weeks[w].taken += d.taken; weeks[w].due += d.due;
  });
  weeks.forEach(w => { w.pct = pctOf(w.taken, w.due); });

  // Per dose time
  const byTime = new Map();
  for (const r of rows) {
    const t = byTime.get(r.time) || { time: r.time, taken: 0, due: 0 };
    t.due++; if (r.outcome === 'taken') t.taken++;
    byTime.set(r.time, t);
  }
  const times = [...byTime.values()].map(t => ({ ...t, pct: pctOf(t.taken, t.due) })).sort((a, b) => a.time.localeCompare(b.time));

  // Weekday pattern (only meaningful over 2+ weeks)
  const WD = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  const byWd = Array.from({ length: 7 }, () => ({ taken: 0, due: 0 }));
  for (const d of days) { const w = new Date(d.date + 'T12:00:00+05:30').getUTCDay(); byWd[w].taken += d.taken; byWd[w].due += d.due; }
  const wdRates = byWd.map((x, i) => ({ name: WD[i], pct: pctOf(x.taken, x.due), due: x.due })).filter(x => x.due >= 2);
  const hardestDay = days.length >= 14 && wdRates.length ? wdRates.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;

  // Vitals: first vs last reading of each kind inside the course
  const v = (input.vitals || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at));
  const pick = (f) => { const xs = v.filter(f); return xs.length ? { first: xs[0], last: xs[xs.length - 1], count: xs.length } : null; };
  const bp = pick(x => x.sys && x.dia), sugar = pick(x => x.glucose), hr = pick(x => x.hr);

  // Trend: first half vs second half
  const half = Math.floor(days.length / 2);
  const firstHalf = days.slice(0, half), secondHalf = days.slice(half);
  const sum = (arr, k) => arr.reduce((a, d) => a + d[k], 0);
  const p1 = pctOf(sum(firstHalf, 'taken'), sum(firstHalf, 'due')), p2 = pctOf(sum(secondHalf, 'taken'), sum(secondHalf, 'due'));
  const trend = p1 === null || p2 === null || days.length < 4 ? 'steady' : p2 - p1 >= 10 ? 'improved' : p1 - p2 >= 10 ? 'dropped' : 'steady';

  const level = pct === null ? 'none' : pct >= 90 ? 'excellent' : pct >= 80 ? 'good' : pct >= 60 ? 'fair' : 'low';
  return { rows, taken, missed, due, pct, days, perfectDays, bestStreak: best, weeks, times, hardestDay, bp, sugar, hr, trend, p1, p2, level };
}

const LEVEL = {
  excellent: { word: 'Excellent', color: GREEN, line: 'You took almost every dose — this is exactly what gives a medicine its best chance to work.' },
  good: { word: 'Good', color: GREEN, line: 'You took most of your doses. A few were missed, but you stayed on track overall.' },
  fair: { word: 'Fair', color: AMBER, line: 'You took more than half of your doses, but the missed ones add up — a medicine works best when it is taken every time.' },
  low: { word: 'Needs attention', color: RED, line: 'Many doses were missed in this course. That can make a medicine look like it isn\'t working when it simply wasn\'t taken. Please talk to your doctor about it.' },
  none: { word: 'Not enough data', color: MUTED, line: 'No doses were confirmed during this course, so we can\'t say how it went.' }
};

// Plain-language story paragraphs.
function narrative(input, a) {
  const first = String(input.patientName || 'there').trim().split(/\s+/)[0];
  const m = input.medicine;
  const out = [];
  const length = a.days.length;
  out.push(`Hi ${first}, this report tells the story of your ${m.durationDays ? m.durationDays + '-day ' : ''}course of ${m.name}${m.dosage ? ' (' + m.dosage + ')' : ''}, from ${fmtDate(m.startDate)} to ${fmtDate(m.completedAt || m.endDate)}. ${m.stoppedByPatient ? 'You stopped this medicine on Biomexa before the planned end, so this covers the days you were on it.' : 'Your course is now complete and its reminders have stopped.'}`);
  if (a.due) {
    out.push(`Over ${length} day${length === 1 ? '' : 's'}, ${a.due} dose${a.due === 1 ? ' was' : 's were'} due. You confirmed ${a.taken} and missed ${a.missed} — an adherence of ${a.pct}%. ${LEVEL[a.level].line}`);
    const streakTxt = a.bestStreak >= 2 ? ` Your longest run was ${a.bestStreak} days in a row without missing a single dose.` : '';
    out.push(`On ${a.perfectDays} of ${length} days you took every dose.${streakTxt}`);
    if (a.trend === 'improved') out.push(`You got better as the course went on — from ${a.p1}% in the first half to ${a.p2}% in the second half. Well done for building the habit.`);
    else if (a.trend === 'dropped') out.push(`Your doses slipped as the course went on — ${a.p1}% in the first half, ${a.p2}% in the second. This is very common once people start feeling better, but finishing the course matters.`);
    else out.push('You stayed about as regular at the end of the course as at the start.');
    if (a.times.length > 1) {
      const sorted = a.times.slice().sort((x, y) => x.pct - y.pct);
      const worst = sorted[0], bestT = sorted[sorted.length - 1];
      if (bestT.pct - worst.pct >= 15) out.push(`Your ${fmtTime(bestT.time)} dose was the easiest to remember (${bestT.pct}%), while the ${fmtTime(worst.time)} dose was missed most often (${worst.pct}%). Linking that dose to something you do every day — a meal, brushing your teeth, bedtime — usually helps.`);
    }
    if (a.hardestDay && a.hardestDay.pct !== null && a.pct - a.hardestDay.pct >= 15) out.push(`${a.hardestDay.name} were your hardest days (${a.hardestDay.pct}% taken).`);
  }
  if (a.bp) {
    const f = a.bp.first, l = a.bp.last;
    const ch = l.sys - f.sys;
    out.push(`Blood pressure: you logged ${a.bp.count} reading${a.bp.count === 1 ? '' : 's'}. It went from ${f.sys}/${f.dia} on ${fmtDate(f.at)} to ${l.sys}/${l.dia} on ${fmtDate(l.at)}${a.bp.count > 1 ? (ch <= -5 ? ' — lower by ' + Math.abs(ch) + ' (top number).' : ch >= 5 ? ' — higher by ' + ch + ' (top number). Please show this to your doctor.' : ' — about the same.') : '.'} A healthy target for most adults is below 140/90 (your doctor may set a different one).`);
  }
  if (a.sugar) {
    const f = a.sugar.first, l = a.sugar.last, ch = l.glucose - f.glucose;
    out.push(`Blood sugar: ${a.sugar.count} reading${a.sugar.count === 1 ? '' : 's'}, from ${f.glucose} mg/dL on ${fmtDate(f.at)} to ${l.glucose} mg/dL on ${fmtDate(l.at)}${a.sugar.count > 1 ? (ch <= -10 ? ' — lower by ' + Math.abs(ch) + ' mg/dL.' : ch >= 10 ? ' — higher by ' + ch + ' mg/dL. Please show this to your doctor.' : ' — about the same.') : '.'}`);
  }
  if (!a.bp && !a.sugar) out.push('You didn\'t log any BP or sugar readings during this course. Next time, send your readings on WhatsApp (for example "BP 130/85" or "sugar 140") — your report will then show how your body responded to the medicine.');
  return out;
}

function nextSteps(input, a) {
  const steps = [];
  steps.push('Show this report to your doctor at your next visit — it shows exactly how the course went.');
  if (input.medicine.stoppedByPatient) steps.push('If you stopped this medicine on your own, tell your doctor. Some medicines (especially for BP and diabetes) should not be stopped suddenly.');
  else steps.push('If your doctor wants you to continue this medicine, don\'t leave a gap — add it again on Biomexa and your reminders restart straight away.');
  if (a.level === 'fair' || a.level === 'low') steps.push('Missed doses are the most common reason a medicine doesn\'t seem to work. Tell your doctor how many you missed so they don\'t change your treatment for the wrong reason.');
  if (!a.bp && !a.sugar) steps.push('Log your BP / sugar on WhatsApp a few times a week — it lets you and your doctor see whether the medicine is helping.');
  if (input.refillUrl) steps.push(`Need a refill? Order it for home delivery: ${input.refillUrl}`);
  return steps;
}

function buildJourneyPdf(input) {
  const a = analyseJourney(input);
  const story = narrative(input, a);
  const steps = nextSteps(input, a);
  const m = input.medicine;
  const lv = LEVEL[a.level];

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 0 }, info: { Title: `Biomexa course report — ${m.name}`, Author: 'Biomexa Pharmaceuticals' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('R', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
    doc.registerFont('B', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));

    const W = doc.page.width, H = doc.page.height, L = 40, R = W - 40, CW = R - L;
    const txt = (s, x, y, o = {}) => {
      doc.font(o.bold ? 'B' : 'R').fontSize(o.size || 9.5).fillColor(o.color || TEXT);
      const w = doc.widthOfString(String(s));
      let cx = x;
      if (o.width && o.align === 'right') cx = x + o.width - w;
      if (o.width && o.align === 'center') cx = x + (o.width - w) / 2;
      doc.text(String(s), cx, y, { lineBreak: false });
      return w;
    };
    const para = (s, x, y, w, o = {}) => { doc.font(o.bold ? 'B' : 'R').fontSize(o.size || 10).fillColor(o.color || TEXT).text(String(s), x, y, { width: w, lineGap: 2.5 }); return doc.y; };
    let y = 0;
    const need = h => { if (y + h > H - 60) { footer(); doc.addPage(); y = 48; } };
    let pageNo = 1;
    function footer() {
      doc.font('R').fontSize(7.5).fillColor(MUTED).text('This report is made from the doses you confirmed and the readings you logged on Biomexa. It is not a diagnosis or medical advice — please discuss it with your doctor.  ·  biomexapharmaceuticals.com', L, H - 46, { width: CW - 40, lineGap: 1 });
      doc.text(`Page ${pageNo++}`, R - 40, H - 46, { width: 40, align: 'right', lineBreak: false });
    }
    const section = (title, icon) => { need(40); y += 8; txt(title, L, y, { bold: true, size: 13, color: NAVY }); y += 22; doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(1).stroke(); y += 10; };

    // ---- header
    doc.rect(0, 0, W, 6).fill(GREEN);
    try { doc.image(LOGO, L, 22, { height: 40 }); } catch { txt('BIOMEXA', L, 30, { bold: true, size: 16, color: NAVY }); }
    txt('YOUR COURSE REPORT', L, 24, { bold: true, size: 16, color: NAVY, width: CW, align: 'right' });
    txt(`Made on ${fmtDate(new Date())}`, L, 46, { size: 8.5, color: MUTED, width: CW, align: 'right' });
    y = 80;
    doc.roundedRect(L, y, CW, 64, 8).fillAndStroke(SOFT, LINE);
    txt(input.patientName || 'Biomexa patient', L + 14, y + 10, { bold: true, size: 13 });
    txt('+91 ' + String(input.phone || '').replace(/\D/g, '').slice(-10), L + 14, y + 30, { size: 9, color: MUTED });
    txt(`${m.name}${m.dosage ? '  ·  ' + m.dosage : ''}`, L + 14, y + 44, { bold: true, size: 10, color: NAVY });
    txt(`${fmtDate(m.startDate)}  to  ${fmtDate(m.completedAt || m.endDate)}`, L, y + 12, { size: 9.5, width: CW - 14, align: 'right' });
    txt((m.times || []).map(fmtTime).join(', ') + (m.foodNote ? '  ·  ' + m.foodNote : ''), L, y + 30, { size: 9, color: MUTED, width: CW - 14, align: 'right' });
    txt(m.stoppedByPatient ? 'Stopped before the planned end' : 'Course completed', L, y + 44, { size: 9, bold: true, color: m.stoppedByPatient ? AMBER : GREEN, width: CW - 14, align: 'right' });
    y += 80;

    // ---- big numbers
    const tiles = [
      ['Adherence', a.pct === null ? '—' : a.pct + '%', lv.color, lv.word],
      ['Doses taken', String(a.taken), GREEN, `of ${a.due} due`],
      ['Doses missed', String(a.missed), a.missed ? RED : MUTED, a.missed ? 'not confirmed' : 'none — well done'],
      ['Best streak', a.bestStreak + (a.bestStreak === 1 ? ' day' : ' days'), NAVY, 'every dose taken']
    ];
    const tw = (CW - 30) / 4;
    tiles.forEach(([k, v, c, s], i) => {
      const x = L + i * (tw + 10);
      doc.roundedRect(x, y, tw, 66, 8).fillAndStroke('#ffffff', LINE);
      txt(k.toUpperCase(), x + 10, y + 9, { bold: true, size: 7.5, color: MUTED });
      txt(v, x + 10, y + 22, { bold: true, size: 20, color: c });
      txt(s, x + 10, y + 50, { size: 8, color: MUTED });
    });
    y += 80;

    // adherence bar
    if (a.due) {
      const bw = CW, tk = Math.round(bw * a.taken / a.due);
      doc.roundedRect(L, y, bw, 10, 5).fill('#f3d4d6');
      if (tk) doc.roundedRect(L, y, tk, 10, 5).fill(GREEN);
      y += 16;
      txt(`${a.taken} taken`, L, y, { size: 8, color: GREEN }); txt(`${a.missed} missed`, L, y, { size: 8, color: RED, width: CW, align: 'right' });
      y += 16;
    }

    // ---- story
    section('Your journey');
    for (const p of story) { doc.font('R').fontSize(10); need(doc.heightOfString(p, { width: CW, lineGap: 2.5 }) + 8); y = para(p, L, y, CW) + 8; }

    // ---- week by week
    if (a.weeks.length > 1) {
      section('Week by week');
      const bh = 14, labelW = 150;
      for (const w of a.weeks) {
        need(bh + 8);
        txt(`${w.label}  (${fmtShort(w.from)} – ${fmtShort(w.to)})`, L, y + 1, { size: 9 });
        const bx = L + labelW, bwid = CW - labelW - 50;
        doc.roundedRect(bx, y + 2, bwid, bh - 4, 4).fill('#eef1f6');
        const p = w.pct || 0;
        if (p) doc.roundedRect(bx, y + 2, Math.max(6, bwid * p / 100), bh - 4, 4).fill(p >= 80 ? GREEN : p >= 60 ? AMBER : RED);
        txt(w.pct === null ? '—' : w.pct + '%', bx + bwid + 8, y + 1, { bold: true, size: 9.5 });
        y += bh + 6;
      }
    }

    // ---- dose times
    if (a.times.length) {
      section('Your dose times');
      for (const t of a.times) {
        need(18);
        txt(fmtTime(t.time), L, y, { bold: true, size: 10 });
        txt(`${t.taken} of ${t.due} taken`, L + 90, y, { size: 9.5, color: MUTED });
        txt(t.pct === null ? '—' : t.pct + '%', L, y, { bold: true, size: 10, color: t.pct >= 80 ? GREEN : t.pct >= 60 ? AMBER : RED, width: CW, align: 'right' });
        y += 18;
      }
    }

    // ---- calendar
    if (a.days.length) {
      section('Day by day');
      txt('Green = all doses taken   ·   Amber = some missed   ·   Red = all missed', L, y, { size: 8, color: MUTED }); y += 16;
      const cols = 10, cw = (CW - (cols - 1) * 6) / cols, ch = 30;
      a.days.forEach((d, i) => {
        const col = i % cols;
        if (col === 0) { need(ch + 6); if (i) y += ch + 6; }
        const x = L + col * (cw + 6);
        const c = d.taken === d.due ? GREEN : d.taken ? AMBER : RED;
        doc.roundedRect(x, y, cw, ch, 5).fill(c);
        txt(fmtShort(d.date), x, y + 4, { size: 7.5, bold: true, color: '#ffffff', width: cw, align: 'center' });
        txt(`${d.taken}/${d.due}`, x, y + 16, { size: 8, color: '#ffffff', width: cw, align: 'center' });
      });
      y += ch + 10;
    }

    // ---- readings
    if (a.bp || a.sugar || a.hr) {
      section('Your health readings');
      const rows = [];
      if (a.bp) rows.push(['Blood pressure', `${a.bp.first.sys}/${a.bp.first.dia}`, `${a.bp.last.sys}/${a.bp.last.dia}`, a.bp.count, 'mmHg']);
      if (a.sugar) rows.push(['Blood sugar', a.sugar.first.glucose, a.sugar.last.glucose, a.sugar.count, 'mg/dL']);
      if (a.hr) rows.push(['Heart rate', a.hr.first.hr, a.hr.last.hr, a.hr.count, 'bpm']);
      const cx = [L, L + 170, L + 290, L + 410];
      ['Reading', 'First', 'Last', 'Readings logged'].forEach((h, i) => txt(h, cx[i], y, { bold: true, size: 8.5, color: MUTED }));
      y += 16;
      for (const r of rows) {
        need(18);
        txt(r[0], cx[0], y, { bold: true }); txt(`${r[1]} ${r[4]}`, cx[1], y); txt(`${r[2]} ${r[4]}`, cx[2], y); txt(String(r[3]), cx[3], y);
        y += 18;
      }
    }

    // ---- next steps
    section('What to do next');
    steps.forEach((s, i) => {
      doc.font('R').fontSize(10); need(doc.heightOfString(s, { width: CW - 24, lineGap: 2.5 }) + 10);
      doc.circle(L + 8, y + 7, 8).fill(NAVY);
      txt(String(i + 1), L, y + 1.5, { bold: true, size: 9, color: '#ffffff', width: 16, align: 'center' });
      y = para(s, L + 24, y, CW - 24) + 8;
    });

    footer();
    doc.end();
  });
}

module.exports = { buildJourneyPdf, analyseJourney };
