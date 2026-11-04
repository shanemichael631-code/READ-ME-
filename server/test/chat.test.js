import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start } from './_harness.js';

process.env.MOCK_MODEL = '1';
process.env.HUB_PASSCODE = 'test';
process.env.ANTHROPIC_API_KEY = 'REPLACE_ME';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const s = await start();
after(() => s.close());
const chat = (body) => s.api('/api/chat', { method: 'POST', body });

global.window = {};
const require = createRequire(import.meta.url);
require(path.join(ROOT, 'data.js'));
const m = require(path.join(ROOT, 'report.js')).buildReport(global.window.REPORT_DATA.companies[0], '2026-10-05');
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

test('"how was last week" runs get_week_summary and the numbers match Engine.buildReport', async () => {
  const r = await chat({ messages: [{ role: 'user', content: 'How was last week?' }], today: '2026-11-03' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.reply.includes(money(m.cur.revenue)), j.reply);
  assert.ok(j.reply.includes(m.cur.jobs + ' jobs'));
  assert.ok(j.reply.includes(money(m.cur.avgTicket)));
  assert.ok(j.reply.includes(money(m.cur.unpaid30)));
  assert.ok(j.reply.includes('week of Sep 28'));
  assert.ok(!j.reply.includes('SPEAK'));
  assert.ok(j.speak.includes(money(m.cur.revenue)) && !/[*#]/.test(j.speak));
  assert.deepEqual(j.actions, []);
  assert.deepEqual(j.usage, { input: 0, output: 0 });
});

test('"remind me" returns an add_reminder action with the device date as due', async () => {
  const j = await (await chat({ messages: [{ role: 'user', content: 'Remind me to call Doug about his invoice' }], today: '2026-11-03' })).json();
  assert.deepEqual(j.actions, [{ type: 'add_reminder', text: 'call Doug about his invoice', due: '2026-11-03' }]);
  assert.ok(j.reply && j.speak);
});

test('"open booking" returns an open_link action for the booking page', async () => {
  const j = await (await chat({ messages: [{ role: 'user', content: 'open booking please' }] })).json();
  assert.deepEqual(j.actions, [{ type: 'open_link', linkId: 'booking', label: 'Open Online booking' }]);
});

test('anything else echoes, and history with assistant turns is accepted', async () => {
  const j = await (await chat({ messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'thanks Nova' }] })).json();
  assert.equal(j.reply, 'You said: thanks Nova');
  assert.equal(j.speak, 'You said thanks Nova');
});

test('input validation -> 400 bad_request', async () => {
  const bad = [{}, { messages: [] }, { messages: 'hi' }, { messages: [{ role: 'system', content: 'x' }] }, { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }, { messages: [{ role: 'user' }] }, 'not json'];
  for (const body of bad) {
    const r = await chat(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).error.code, 'bad_request');
  }
});

test('without MOCK_MODEL a placeholder key -> 503 not_configured', async () => {
  process.env.MOCK_MODEL = '0';
  const r = await chat({ messages: [{ role: 'user', content: 'week' }] });
  process.env.MOCK_MODEL = '1';
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'not_configured');
});

test('health reports the configuration', async () => {
  const j = await (await s.api('/api/health')).json();
  assert.deepEqual(j, { ok: true, model: 'mock', hasKey: false, hasData: true, dataAsOf: '2026-10-05', company: 'Demo Plumbing Co.', engineOk: true, version: j.version });
  assert.ok(j.version);
});
