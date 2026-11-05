import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start } from './_harness.js';
import { resetCache } from '../lib/data.js';

process.env.MOCK_MODEL = '1';
process.env.HUB_PASSCODE = 'test';
process.env.ANTHROPIC_API_KEY = 'REPLACE_ME';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const s = await start();
after(() => s.close());
const RANK = { high: 0, medium: 1, low: 2 };

global.window = {};
const require = createRequire(import.meta.url);
require(path.join(ROOT, 'data.js'));
const report = require(path.join(ROOT, 'report.js')).buildReport(global.window.REPORT_DATA.companies[0], '2026-10-05');

test('needs on the demo data lists unpaid, quote, tech, callbacks, action and stale items, and never nags about the key', async () => {
  const r = await s.api('/api/needs?today=2026-11-03');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.asOf, '2026-10-05');
  assert.equal(j.weekOf, '2026-09-28');
  const ids = j.items.map((i) => i.id);
  assert.ok(!ids.includes('setup:key'), 'a missing key is not a Needs-you item');
  assert.equal(j.chat, true, 'MOCK_MODEL=1 turns chat on');
  const big = j.items.find((i) => i.id === 'unpaid:PL-I5512');
  assert.equal(big.severity, 'high');
  assert.equal(big.amount, 1180);
  for (const u of j.items.filter((i) => i.kind === 'unpaid')) assert.equal(u.severity, u.amount >= 500 ? 'high' : 'medium', u.id);
  assert.equal(j.items.filter((i) => i.kind === 'unpaid').length, report.cur.unpaid30List.length);
  assert.ok(ids.includes('tech:p5'));
  assert.ok(ids.includes('callbacks:2026-09-28'));
  assert.ok(ids.includes('report:stale'));
  assert.ok(!ids.includes('setup:data'));
  const quotes = j.items.filter((i) => i.kind === 'quote');
  assert.equal(quotes.length, 8, 'capped at 8');
  assert.deepEqual(quotes.map((q) => q.id), report.leaks.items.find((x) => x.kind === 'quotes').list.slice(0, 8).map((q) => 'quote:' + q.id));
  const actions = j.items.filter((i) => i.kind === 'action');
  assert.deepEqual(actions.map((a) => a.id), report.actions.map((a, i) => 'action:' + (i + 1) + ':2026-09-28'));
  assert.equal(actions[0].title, report.actions[0].title);
  for (const it of j.items) {
    assert.ok(RANK[it.severity] !== undefined && it.title && typeof it.detail === 'string', it.id);
    assert.ok(['open', 'ask'].includes(it.action.kind), it.id);
    if (it.action.kind === 'open') assert.ok(it.url, it.id); else assert.ok(it.action.query, it.id);
  }
  for (let i = 1; i < j.items.length; i++) assert.ok(RANK[j.items[i - 1].severity] <= RANK[j.items[i].severity], 'sorted by severity');
});

test('ids are stable across calls', async () => {
  const a = (await (await s.api('/api/needs?today=2026-11-03')).json()).items.map((i) => i.id);
  const b = (await (await s.api('/api/needs?today=2026-11-03')).json()).items.map((i) => i.id);
  assert.deepEqual(a, b);
});

test('report:new appears on the Monday that matches asOf, and nothing is stale yet', async () => {
  const ids = (await (await s.api('/api/needs?today=2026-10-05')).json()).items.map((i) => i.id);
  assert.ok(ids.includes('report:new:2026-10-05'));
  assert.ok(!ids.includes('report:stale'));
  const tue = (await (await s.api('/api/needs?today=2026-10-06')).json()).items.map((i) => i.id);
  assert.ok(!tue.includes('report:new:2026-10-05'));
});

test('chat is off without a key and on with one; the key never shows up as an item; unreachable data gives setup:data', async () => {
  delete process.env.MOCK_MODEL;
  const off = await (await s.api('/api/needs')).json();
  assert.equal(off.chat, false);
  assert.ok(!off.items.some((i) => i.kind === 'setup'));
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const on = await (await s.api('/api/needs')).json();
  assert.equal(on.chat, true);
  assert.ok(!on.items.some((i) => i.kind === 'setup'));
  process.env.MOCK_MODEL = '1';
  const saved = process.env.REPORT_DATA_URL;
  resetCache();
  process.env.REPORT_DATA_URL = '/nope/data.js';
  const j = await (await s.api('/api/needs')).json();
  assert.equal(j.asOf, null);
  assert.deepEqual(j.items.map((i) => i.id), ['setup:data']);
  assert.equal(j.chat, true, 'chat flag is sent even when the data is down');
  const c = await s.api('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'week' }] } });
  assert.equal(c.status, 503);
  assert.equal((await c.json()).error.code, 'not_configured');
  process.env.REPORT_DATA_URL = saved;
  resetCache();
});
