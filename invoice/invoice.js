// ========== BIOMEXA — GST INVOICE PDF ==========
// Builds the invoice PDF for one Biomexa Care payment. Seller details come from Render env:
//   BIOMEXA_GSTIN          your GSTIN — when set the PDF is a TAX INVOICE with the GST split;
//                          when not set it is a PAYMENT RECEIPT (no GST shown: GST can only be
//                          charged and shown by a registered business)
//   INVOICE_LEGAL_NAME     default "Biomexa Pharmaceuticals"
//   INVOICE_ADDRESS        default "Supertech Cape Town, Sector 75, Noida, Uttar Pradesh 201301"
//   INVOICE_STATE / INVOICE_STATE_CODE   default "Uttar Pradesh" / "09"
//   INVOICE_SAC            default "998439" (other online content / services n.e.c.) — confirm with your CA
//   GST_RATE               default 18 (plan prices are GST-inclusive)
//   INVOICE_EMAIL / INVOICE_PHONE        shown in the header
// Amounts are in rupees. Place of supply = seller's state (B2C, no recipient address on record),
// so GST is split CGST + SGST; set the patient's state on the payment to get IGST instead.
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const LOGO = path.join(__dirname, '..', 'images', 'logo-invoice.png');

function seller() {
  const env = process.env;
  return {
    name: env.INVOICE_LEGAL_NAME || 'Biomexa Pharmaceuticals',
    address: env.INVOICE_ADDRESS || 'Supertech Cape Town, Sector 75, Noida, Uttar Pradesh 201301',
    state: env.INVOICE_STATE || 'Uttar Pradesh',
    stateCode: env.INVOICE_STATE_CODE || '09',
    gstin: (env.BIOMEXA_GSTIN || '').trim().toUpperCase(),
    sac: env.INVOICE_SAC || '998439',
    rate: Number(env.GST_RATE || 18),
    email: env.INVOICE_EMAIL || 'biomexapharmaceuticals@gmail.com',
    phone: env.INVOICE_PHONE || '',
    website: 'biomexapharmaceuticals.com'
  };
}

const r2 = n => Math.round(n * 100) / 100;
// Split a GST-inclusive amount into taxable value + tax so the parts add up exactly.
function gstSplit(total, rate, interState) {
  const taxable = r2(total / (1 + rate / 100));
  const tax = r2(total - taxable);
  if (interState) return { taxable, igst: tax, cgst: 0, sgst: 0, tax };
  const cgst = r2(tax / 2);
  return { taxable, cgst, sgst: r2(tax - cgst), igst: 0, tax };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function words(n) {
  n = Math.floor(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + words(n % 100) : '');
  if (n < 100000) return words(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + words(n % 1000) : '');
  if (n < 10000000) return words(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + words(n % 100000) : '');
  return words(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + words(n % 10000000) : '');
}
function amountInWords(amount) {
  const rupees = Math.floor(amount), paise = Math.round((amount - rupees) * 100);
  return 'Rupees ' + (words(rupees) || 'Zero') + (paise ? ' and ' + words(paise) + ' Paise' : '') + ' Only';
}
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';

// inv: { invoiceNo, invoiceDate, patientName, patientPhone, payerEmail, planName, planLabel,
//        periodStart, periodEnd, amount (₹), paymentId, orderId, method, methodDetail, paidAt,
//        refunded (₹), recipientState }
function buildInvoicePdf(inv) {
  const s = seller();
  const isTax = !!s.gstin;
  const inter = !!(inv.recipientState && inv.recipientState.toLowerCase() !== s.state.toLowerCase());
  const g = gstSplit(inv.amount, s.rate, inter);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${isTax ? 'Tax Invoice' : 'Payment Receipt'} ${inv.invoiceNo}`, Author: s.name } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Full Noto Sans (includes ₹). Licensed under the SIL Open Font License (assets/fonts/OFL-LICENSE.txt).
    doc.registerFont('R', path.join(FONT_DIR, 'NotoSans-Regular.ttf'));
    doc.registerFont('B', path.join(FONT_DIR, 'NotoSans-Bold.ttf'));

    const NAVY = '#16336b', GREEN = '#1c9a55', MUTED = '#5b6b86', LINE = '#dfe5ef', TEXT = '#13213d';
    const W = doc.page.width, L = 40, R = W - 40, CW = R - L;

    // One line of text, optionally aligned inside a width.
    function txt(str, x, y, o = {}) {
      doc.font(o.bold ? 'B' : 'R').fontSize(o.size || 9.5).fillColor(o.color || TEXT);
      const w = doc.widthOfString(String(str));
      let cx = x;
      if (o.width && o.align === 'right') cx = x + o.width - w;
      if (o.width && o.align === 'center') cx = x + (o.width - w) / 2;
      doc.text(String(str), cx, y, { lineBreak: false });
      return w;
    }
    function para(str, x, y, w, o = {}) {
      doc.font(o.bold ? 'B' : 'R').fontSize(o.size || 9).fillColor(o.color || TEXT).text(String(str), x, y, { width: w, lineGap: 1.5 });
      return doc.y;
    }

    // ---- header band
    doc.rect(0, 0, W, 6).fill(GREEN);
    try { doc.image(LOGO, L, 26, { height: 44 }); } catch { txt(s.name, L, 34, { bold: true, size: 16, color: NAVY }); }
    txt(isTax ? 'TAX INVOICE' : 'PAYMENT RECEIPT', L, 28, { bold: true, size: 18, color: NAVY, width: CW, align: 'right' });
    txt(isTax ? 'Original for recipient' : 'Not a tax invoice', L, 52, { size: 8.5, color: MUTED, width: CW, align: 'right' });

    // ---- seller / invoice meta
    let y = 92;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 12;
    const colW = CW / 2 - 10;
    txt(s.name, L, y, { bold: true, size: 11, color: NAVY });
    let ly = para(s.address, L, y + 16, colW, { color: MUTED });
    ly = para(`State: ${s.state} (code ${s.stateCode})`, L, ly + 1, colW, { color: MUTED });
    if (isTax) ly = para(`GSTIN: ${s.gstin}`, L, ly + 1, colW, { bold: true });
    ly = para([s.email, s.phone ? '+91 ' + s.phone : '', s.website].filter(Boolean).join('  ·  '), L, ly + 1, colW, { color: MUTED, size: 8.5 });

    const mx = L + CW / 2 + 10, mw = CW / 2 - 10;
    const meta = [
      [isTax ? 'Invoice no.' : 'Receipt no.', inv.invoiceNo],
      ['Date', fmtDate(inv.invoiceDate)],
      ['Place of supply', inter ? `${inv.recipientState}` : `${s.state} (${s.stateCode})`],
      ['Payment status', inv.refunded >= inv.amount ? 'Refunded' : inv.refunded > 0 ? 'Partly refunded' : 'Paid']
    ];
    let my = y;
    for (const [k, v] of meta) {
      txt(k, mx, my, { color: MUTED, size: 9 });
      txt(v, mx, my, { bold: true, size: 9.5, width: mw, align: 'right', color: k === 'Payment status' ? (inv.refunded > 0 ? '#b45309' : GREEN) : TEXT });
      my += 16;
    }
    y = Math.max(ly, my) + 14;

    // ---- bill to
    doc.roundedRect(L, y, CW, 58, 6).fillAndStroke('#f6f8fc', LINE);
    txt('BILLED TO', L + 12, y + 9, { bold: true, size: 8, color: MUTED });
    txt(inv.patientName || 'Biomexa patient', L + 12, y + 22, { bold: true, size: 11 });
    txt(['+91 ' + String(inv.patientPhone || '').replace(/\D/g, '').slice(-10), inv.payerEmail].filter(Boolean).join('  ·  '), L + 12, y + 39, { size: 9, color: MUTED });
    txt('Unregistered (B2C)', L + 12, y + 9, { size: 8, color: MUTED, width: CW - 24, align: 'right' });
    y += 74;

    // ---- items table
    const cols = isTax
      ? (inter
        ? [['#', 22, 'left'], ['Description', 200, 'left'], ['SAC', 50, 'left'], ['Qty', 30, 'right'], ['Taxable value', 82, 'right'], [`IGST ${s.rate}%`, 64, 'right'], ['Amount', CW - 448, 'right']]
        : [['#', 22, 'left'], ['Description', 170, 'left'], ['SAC', 46, 'left'], ['Qty', 26, 'right'], ['Taxable value', 76, 'right'], [`CGST ${s.rate / 2}%`, 58, 'right'], [`SGST ${s.rate / 2}%`, 58, 'right'], ['Amount', CW - 456, 'right']])
      : [['#', 22, 'left'], ['Description', 320, 'left'], ['Qty', 40, 'right'], ['Amount', CW - 382, 'right']];
    doc.rect(L, y, CW, 22).fill(NAVY);
    let cx = L;
    for (const [h, w, a] of cols) { txt(h, cx + 6, y + 6, { bold: true, size: 8.5, color: '#ffffff', width: w - 12, align: a }); cx += w; }
    y += 22;
    const desc = `Biomexa Care subscription — ${inv.planName} plan`;
    const sub = `${inv.planLabel ? inv.planLabel + ' · ' : ''}Service period ${fmtDate(inv.periodStart)} to ${fmtDate(inv.periodEnd)}. Includes Talk to a Doctor, AI treatment reports, prescription & lab report analysis and WhatsApp reminders.`;
    const descW = cols[1][1] - 12;
    doc.font('B').fontSize(9.5);
    const descH = doc.heightOfString(desc, { width: descW, lineGap: 1 });
    doc.font('R').fontSize(8);
    const subH = doc.heightOfString(sub, { width: descW, lineGap: 1 });
    const rowH = Math.max(34, 8 + descH + 4 + subH + 8);
    const vals = isTax
      ? (inter ? ['1', null, s.sac, '1', inr(g.taxable), inr(g.igst), inr(inv.amount)] : ['1', null, s.sac, '1', inr(g.taxable), inr(g.cgst), inr(g.sgst), inr(inv.amount)])
      : ['1', null, '1', inr(inv.amount)];
    cx = L;
    cols.forEach(([h, w, a], i) => {
      if (i === 1) {
        doc.font('B').fontSize(9.5).fillColor(TEXT).text(desc, cx + 6, y + 8, { width: descW, lineGap: 1 });
        doc.font('R').fontSize(8).fillColor(MUTED).text(sub, cx + 6, y + 8 + descH + 4, { width: descW, lineGap: 1 });
      } else txt(vals[i], cx + 6, y + 8, { size: 9.5, width: w - 12, align: a });
      cx += w;
    });
    y += rowH;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).stroke();

    // ---- totals
    y += 12;
    const tx = L + CW - 250, tw = 250;
    const rows = isTax
      ? [['Taxable value', inr(g.taxable)], ...(inter ? [[`IGST @ ${s.rate}%`, inr(g.igst)]] : [[`CGST @ ${s.rate / 2}%`, inr(g.cgst)], [`SGST @ ${s.rate / 2}%`, inr(g.sgst)]])]
      : [];
    for (const [k, v] of rows) { txt(k, tx, y, { color: MUTED }); txt(v, tx, y, { width: tw, align: 'right' }); y += 17; }
    doc.roundedRect(tx - 8, y - 3, tw + 16, 26, 5).fill('#e8f6ee');
    txt(isTax ? 'Total (incl. GST)' : 'Total paid', tx, y + 3, { bold: true, size: 10.5, color: '#11663a' });
    txt(inr(inv.amount), tx, y + 2, { bold: true, size: 12, width: tw, align: 'right', color: '#11663a' });
    y += 30;
    if (inv.refunded > 0) { txt('Refunded', tx, y, { color: '#b45309' }); txt('− ' + inr(inv.refunded), tx, y, { width: tw, align: 'right', color: '#b45309' }); y += 17; }
    para('Amount in words: ' + amountInWords(inv.amount), L, y + 4, CW, { size: 9, bold: true });
    y = doc.y + 18;

    // ---- payment details
    txt('PAYMENT DETAILS', L, y, { bold: true, size: 8, color: MUTED });
    y += 14;
    const method = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI' }[inv.method] || inv.method || 'Online (Razorpay)';
    const pay = [
      ['Paid on', inv.paidAt ? new Date(inv.paidAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—'],
      ['Paid with', method + (inv.methodDetail ? ` (${inv.methodDetail})` : '')],
      ['Razorpay payment ID', inv.paymentId || '—'],
      ['Order reference', inv.orderId || '—']
    ];
    for (const [k, v] of pay) { txt(k, L, y, { color: MUTED, size: 9 }); txt(v, L + 130, y, { size: 9 }); y += 15; }

    // ---- footer
    const fy = doc.page.height - 92;
    doc.moveTo(L, fy).lineTo(R, fy).strokeColor(LINE).stroke();
    para(isTax
      ? 'GST is included in the plan price. Tax is not payable on reverse charge. This is a computer-generated invoice and does not need a signature.'
      : 'This is a payment receipt, not a tax invoice. This is a computer-generated document and does not need a signature.',
      L, fy + 8, CW, { size: 8, color: MUTED });
    para(`Questions about this ${isTax ? 'invoice' : 'receipt'}? Message Biomexa on WhatsApp or write to ${s.email}.`, L, doc.y + 2, CW, { size: 8, color: MUTED });
    doc.rect(0, doc.page.height - 6, W, 6).fill(GREEN);
    doc.end();
  });
}

module.exports = { buildInvoicePdf, gstSplit, amountInWords, seller };
