const test = require('node:test');
const assert = require('node:assert');
const T = require('../msg91/templates');

const body = text => [{ type: 'BODY', text }];
const sample = { status: 'success', data: [
  { name: 'dose_reminder', namespace: 'ns1', languages: [{ language: 'en_US', status: 'APPROVED', code: [...body('Time for {{1}} ({{2}}).'), { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Taken' }] }] }] },
  { name: 'biomexa_care_renewal', namespace: 'ns1', languages: [{ language: 'en', status: 'APPROVED', code: body('Hi {{1}}, {{2}}\n\nYour treatment: {{3}}\n\nRenew at biomexapharmaceuticals.com') }] },
  { name: 'course_complete', languages: [{ language: 'en', status: 'APPROVED', code: body('Hi {{patient_name}}, your {{medicine_name}} course is done. {{summary}} Thanks.') }] },
  { name: 'welcome_msg', languages: [{ language: 'en', status: 'REJECTED', code: body('Welcome {{1}} to Biomexa.') }] },
  { name: 'biomexa_otp', languages: [{ language: 'en', status: 'APPROVED', category: 'AUTHENTICATION', code: body('{{1}} is your verification code.') }] },
  { name: 'order_update', languages: [{ language: 'en', status: 'PENDING', code: body('Order {{1}} {{2}} {{3}} ok') }] },
] };

test('parses MSG91 templates with languages, status and variables', () => {
  const list = T.parseTemplates(sample);
  assert.equal(list.length, 6);
  const d = list.find(t => t.name === 'dose_reminder');
  assert.deepEqual([d.language, d.status, d.bodyVars.length, d.named], ['en_US', 'APPROVED', 2, false]);
  assert.equal(list.find(t => t.name === 'course_complete').named, true);
});

test('Render name used when approved; unset types matched only when name AND variables fit', () => {
  const r = T.resolveAll(T.parseTemplates(sample), { dose: 'dose_reminder', renewal: null, welcome: 'welcome_msg', order: null });
  assert.equal(r.dose.source, 'render'); assert.equal(r.dose.language, 'en_US');
  assert.equal(r.renewal.source, 'auto'); assert.equal(r.renewal.name, 'biomexa_care_renewal');
  assert.equal(r.course.name, 'course_complete');
  assert.equal(r.otp.name, 'biomexa_otp');
  assert.equal(r.welcome.source, 'render-unapproved');           // rejected template is flagged, not used silently
  assert.equal(r.order.name, null);                               // pending template never used
  assert.equal(r.risk.name, null);                                // nothing fits — no guessing
});

test('variables are fitted to the template at send time', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => sample });
  await T.syncTemplates({ authKey: 'k', integratedNumber: '91900', configured: {}, fetchImpl });
  assert.equal(T.langFor('dose_reminder', 'en'), 'en_US');
  assert.equal(T.langFor('unknown_tpl', 'en'), 'en');
  // positional template: parameter_name removed
  const pos = T.fitComponents('dose_reminder', { body_1: { type: 'text', value: 'Telmexa', parameter_name: 'medicine_name' }, body_2: { type: 'text', value: '1 tab', parameter_name: 'dosage' } });
  assert.deepEqual(pos, { body_1: { type: 'text', value: 'Telmexa' }, body_2: { type: 'text', value: '1 tab' } });
  // named template: its own names used
  const named = T.fitComponents('course_complete', { body_1: { type: 'text', value: 'Ravi' }, body_2: { type: 'text', value: 'Diabmexa' }, body_3: { type: 'text', value: '90%' } });
  assert.deepEqual(Object.values(named).map(v => v.parameter_name), ['patient_name', 'medicine_name', 'summary']);
  // extra values dropped, buttons kept
  const otp = T.fitComponents('biomexa_otp', { body_1: { type: 'text', value: '1234' }, body_2: { type: 'text', value: 'x' }, button_1: { subtype: 'url', type: 'text', value: '1234' } });
  assert.deepEqual(Object.keys(otp).sort(), ['body_1', 'button_1']);
});
