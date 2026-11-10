# Builds the Biomexa sample patient report (demo data only) → sample-report.pdf
import sys, random, datetime as dt
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

out, logo = sys.argv[1], sys.argv[2]
pdfmetrics.registerFont(TTFont('D', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DB', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
NAVY, GREEN, RED, AMBER, MUTED, LINE, SOFT = HexColor('#16336b'), HexColor('#1c9a55'), HexColor('#c0392b'), HexColor('#d97706'), HexColor('#5b6b85'), HexColor('#dde4ef'), HexColor('#eef3fb')
W, H = A4; M = 40
random.seed(7)

# ---- demo data: 30 days, 3 doses a day ----
days = [dt.date(2026, 10, 1) + dt.timedelta(d) for d in range(30)]
missed = {(2,2),(5,1),(8,2),(9,2),(27,0),(28,2)}  # (day, dose) — 6 missed of 90
sys_bp = [148,147,149,145,146,144,143,142,141,140,139,140,138,137,136,135,134,135,133,132,131,132,130,129,130,128,127,128,126,125]
dia_bp = [94,94,95,93,92,92,91,90,90,89,88,88,87,87,86,86,85,85,84,84,83,84,82,82,82,81,80,81,80,79]
sugar_days = list(range(0,30,3)); sugar = [162,158,151,149,141,138,132,129,124,121]

def chart(path, x, series, band, ylab, ylim):
    fig, ax = plt.subplots(figsize=(7.4, 2.5), dpi=200)
    ax.axhspan(*band, color='#1c9a55', alpha=.09, lw=0)
    for ys, c, lab in series: ax.plot(x, ys, color=c, lw=2.2, marker='o', ms=3.2, label=lab)
    ax.set_ylim(*ylim); ax.set_ylabel(ylab, fontsize=8, color='#5b6b85')
    ax.set_xticks([0,7,14,21,29]); ax.set_xticklabels(['1 Oct','8 Oct','15 Oct','22 Oct','30 Oct'], fontsize=8)
    ax.tick_params(colors='#5b6b85', labelsize=8)
    for s in ['top','right']: ax.spines[s].set_visible(False)
    for s in ['left','bottom']: ax.spines[s].set_color('#c9d3e3')
    ax.grid(axis='y', color='#eef1f6', lw=.8)
    if len(series) > 1: ax.legend(fontsize=7.5, frameon=False, loc='upper right', ncol=2)
    fig.tight_layout(pad=.4); fig.savefig(path); plt.close(fig)
chart('/tmp/bp.png', range(30), [(sys_bp,'#16336b','Systolic (upper)'),(dia_bp,'#4f7bd8','Diastolic (lower)')], (60,139), 'mmHg', (60,160))
chart('/tmp/sugar.png', sugar_days, [(sugar,'#c2410c','Fasting sugar')], (70,130), 'mg/dL', (60,180))

c = canvas.Canvas(out, pagesize=A4)
c.setTitle('Biomexa — Sample Monthly Health Report'); c.setAuthor('Biomexa Pharmaceuticals')

def header(page):
    c.drawImage(ImageReader(logo), M, H-62, width=110, height=38, mask='auto')
    c.setFont('DB', 9); c.setFillColor(MUTED); c.drawRightString(W-M, H-38, 'MONTHLY HEALTH REPORT')
    c.setFont('D', 8.5); c.drawRightString(W-M, H-51, f'1 – 30 October 2026 · Page {page} of 2')
    c.setFillColor(HexColor('#fff4dc')); c.roundRect(M, H-92, W-2*M, 22, 6, stroke=0, fill=1)
    c.setFillColor(HexColor('#8a5a00')); c.setFont('DB', 8.6)
    c.drawCentredString(W/2, H-84.5, 'SAMPLE REPORT — made-up demo data to show what Biomexa sends you. Not a real patient.')
def footer():
    c.setStrokeColor(LINE); c.line(M, 44, W-M, 44)
    c.setFont('D', 7.6); c.setFillColor(MUTED)
    c.drawCentredString(W/2, 32, 'Biomexa Pharmaceuticals · biomexapharmaceuticals.com · WhatsApp +91 96253 39181')
    c.drawCentredString(W/2, 21, 'For information only — always follow your doctor\'s advice.')
def h2(y, t):
    c.setFont('DB', 12.5); c.setFillColor(NAVY); c.drawString(M, y, t)
def tile(x, y, w, h, label, big, sub, col):
    c.setFillColor(white); c.setStrokeColor(LINE); c.roundRect(x, y, w, h, 9, stroke=1, fill=1)
    c.setFont('D', 7.8); c.setFillColor(MUTED); c.drawString(x+10, y+h-16, label)
    c.setFont('DB', 19); c.setFillColor(col); c.drawString(x+10, y+h-40, big)
    c.setFont('D', 7.6); c.setFillColor(MUTED); c.drawString(x+10, y+10, sub)

# ================= PAGE 1 =================
header(1)
y = H-122
c.setFont('DB', 17); c.setFillColor(NAVY); c.drawString(M, y, 'Ravi Sharma')
c.setFont('D', 9.5); c.setFillColor(MUTED)
c.drawString(M, y-16, '56 years · Type 2 diabetes + high blood pressure · Hapur, UP   (sample patient)')
c.drawString(M, y-30, 'Doctor: Dr. A. Mehta (sample) · Reminders on WhatsApp since 2 Sep 2026')

y -= 116; tw = (W-2*M-3*10)/4
tile(M, y, tw, 66, 'Doses taken', '84 / 90', '93% on time — excellent', GREEN)
tile(M+(tw+10), y, tw, 66, 'Longest streak', '17 days', 'No dose missed 11–27 Oct', NAVY)
tile(M+2*(tw+10), y, tw, 66, 'Blood pressure', '125/79', 'was 148/94 on 1 Oct ↓', GREEN)
tile(M+3*(tw+10), y, tw, 66, 'Fasting sugar', '121', 'mg/dL · was 162 on 1 Oct ↓', GREEN)

y -= 30; h2(y, 'Your medicines this month')
rows = [('Diabmexa M 500 (Metformin 500 mg)', 'After breakfast & dinner', '55 / 60', '92%'),
        ('Telmexa AM (Telmisartan 40 + Amlodipine 5)', 'Morning, 8:00 AM', '29 / 30', '97%')]
y -= 12; cols = [M, M+238, M+380, M+455]
c.setFillColor(SOFT); c.rect(M, y-16, W-2*M, 18, stroke=0, fill=1)
c.setFont('DB', 8.4); c.setFillColor(NAVY)
for x, t in zip(cols, ['Medicine', 'When', 'Taken', 'On time']): c.drawString(x+6, y-11, t)
c.setFont('D', 8.8); c.setFillColor(HexColor('#1f2a3d'))
for r in rows:
    y -= 20
    for x, t in zip(cols, r): c.drawString(x+6, y-11, t)
    c.setStrokeColor(LINE); c.line(M, y-17, W-M, y-17)

y -= 42; h2(y, 'Dose calendar')
c.setFillColor(GREEN); c.roundRect(M+120, y-1, 9, 9, 2, stroke=0, fill=1)
c.setFillColor(RED); c.roundRect(M+168, y-1, 9, 9, 2, stroke=0, fill=1)
c.setFont('D', 8.2); c.setFillColor(MUTED); c.drawString(M+132, y, 'taken'); c.drawString(M+180, y, 'missed  ·  every box is one reminder sent on WhatsApp')
labels = ['Telmexa AM · 8 AM', 'Diabmexa M · 9 AM', 'Diabmexa M · 9 PM']
cell = (W-2*M-112)/30; y -= 14
for i, lab in enumerate(labels):
    yy = y - i*(cell+4) - cell
    c.setFont('D', 7.8); c.setFillColor(MUTED); c.drawString(M, yy+3, lab)
    for d in range(30):
        c.setFillColor(RED if (d, i) in missed else GREEN)
        c.roundRect(M+112+d*cell, yy, cell-2, cell-1, 2, stroke=0, fill=1)
yy -= 12; c.setFont('D', 7.2); c.setFillColor(MUTED)
for d in [0, 9, 19, 29]: c.drawCentredString(M+112+d*cell+cell/2, yy, f'{d+1} Oct')

y = yy - 34; h2(y, 'Blood pressure')
c.setFont('D', 8.2); c.setFillColor(MUTED); c.drawString(M+118, y, 'Green band = healthy range (below 140/90). 30 readings sent by WhatsApp.')
c.drawImage('/tmp/bp.png', M, y-176, width=W-2*M, height=(W-2*M)*2.5/7.4)
footer(); c.showPage()

# ================= PAGE 2 =================
header(2)
y = H-122; h2(y, 'Fasting blood sugar')
c.setFont('D', 8.2); c.setFillColor(MUTED); c.drawString(M+152, y, 'Green band = target before breakfast (70–130 mg/dL).')
c.drawImage('/tmp/sugar.png', M, y-176, width=W-2*M, height=(W-2*M)*2.5/7.4)

y -= 206; h2(y, 'What this means')
notes = [
  ('✓', GREEN, 'Medicines are working: BP is now inside the healthy range, and fasting sugar dropped 41 points.'),
  ('✓', GREEN, '93% of doses taken on time — good control usually needs 80% or more.'),
  ('!', AMBER, 'The 9 PM Diabmexa dose was missed 4 times. Tip: keep the strip next to your dinner plate.'),
  ('→', NAVY, 'Treatment effectiveness score 86 / 100. Share this report with Dr. Mehta at your next visit.'),
]
y -= 8
for sym, col, t in notes:
    y -= 20
    c.setFillColor(col); c.circle(M+8, y+3, 7, stroke=0, fill=1)
    c.setFillColor(white); c.setFont('DB', 8.5); c.drawCentredString(M+8, y, sym)
    c.setFillColor(HexColor('#1f2a3d')); c.setFont('D', 9.2); c.drawString(M+22, y, t)

y -= 34
c.setFillColor(SOFT); c.roundRect(M, y-276, W-2*M, 276, 12, stroke=0, fill=1)
c.setFont('DB', 13); c.setFillColor(NAVY); c.drawString(M+16, y-24, 'What Biomexa does for you')
feats = [
  ('Dose reminders on WhatsApp', 'A message at each dose time. Tap "Taken" — nothing to install.', 'FREE'),
  ('Your health dashboard', 'See every dose and reading any time on biomexapharmaceuticals.com.', 'FREE'),
  ('Log BP & sugar by WhatsApp', 'Just reply with your reading, e.g. "BP 130/84" or "sugar 120".', 'FREE'),
  ('Refill reminder', 'A heads-up before your course ends, with home delivery of your medicine.', 'FREE'),
  ('AI Pharmacist', 'Ask about your medicine — food, side effects, timing — in Hindi or English.', 'FREE'),
  ('Monthly report like this one', 'Charts of your doses, BP and sugar, sent to your WhatsApp.', 'CARE'),
  ('Prescription & lab report reading', 'Send a photo of your report — get it explained in simple words.', 'CARE'),
  ('Connect with your doctor', 'Your doctor sees your progress between visits.', 'CARE'),
]
yy = y - 48
for t, d, tag in feats:
    c.setFillColor(GREEN if tag == 'FREE' else NAVY); c.roundRect(M+16, yy-3, 40, 14, 7, stroke=0, fill=1)
    c.setFillColor(white); c.setFont('DB', 7); c.drawCentredString(M+36, yy+1, tag)
    c.setFillColor(HexColor('#1f2a3d')); c.setFont('DB', 9.2); c.drawString(M+66, yy, t)
    c.setFont('D', 8.4); c.setFillColor(MUTED); c.drawString(M+66, yy-11, d)
    yy -= 27
c.setFont('D', 8.2); c.setFillColor(MUTED)
c.drawString(M+16, y-264, 'FREE = always free.  CARE = Biomexa Care: 25 days free, then from ₹99 a month.')

y -= 292
c.setFillColor(GREEN); c.roundRect(M, y-44, W-2*M, 50, 12, stroke=0, fill=1)
c.setFillColor(white); c.setFont('DB', 12.5); c.drawCentredString(W/2, y-14, 'Start in 1 minute — reply on WhatsApp with your medicine name')
c.setFont('D', 9); c.drawCentredString(W/2, y-31, 'or sign up at biomexapharmaceuticals.com/reminders.html')
footer(); c.showPage(); c.save()
print('ok', out)
