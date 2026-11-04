import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReport } from '../lib/data.js';
import { HUB_LINKS, makeTools, systemPrompt } from '../lib/brain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.REPORT_DATA_URL = path.join(ROOT, 'data.js');
process.env.REPORT_ENGINE_URL = path.join(ROOT, 'report.js');
const ctx = await loadReport();
const m = ctx.report;
const actions = [];
const tools = makeTools(ctx, actions);
const run = async (name, input) => JSON.parse(await tools.find((t) => t.name === name).run(input));

test('every tool has a JSON schema with additionalProperties false and the expected names', () => {
  assert.deepEqual(tools.map((t) => t.name), ['get_week_summary', 'tech_leaderboard', 'list_unpaid_invoices', 'list_open_quotes', 'list_callbacks', 'get_report_actions', 'find_customer', 'list_hub_links', 'open_link', 'add_reminder', 'search_hub']);
  for (const t of tools) {
    assert.equal(t.input_schema.additionalProperties, false, t.name);
    assert.equal(t.strict, t.name !== 'add_reminder', t.name);
    assert.ok(t.description.length > 20);
  }
});

test('get_week_summary matches the Engine for the latest week and an older one', async () => {
  const w = await run('get_week_summary', { weeks_ago: 0 });
  assert.equal(w.revenue, m.cur.revenue);
  assert.equal(w.jobs, m.cur.jobs);
  assert.equal(w.unpaid30, m.cur.unpaid30);
  assert.equal(w.callbacks, m.cur.callbacks);
  assert.equal(w.closeRate, Math.round(m.cur.closeRate * 100) + '%');
  assert.equal(w.scorecard.length, m.scorecard.length);
  assert.equal(w.scorecard[0].value, '$' + m.cur.revenue.toLocaleString('en-US'));
  const old = await run('get_week_summary', { weeks_ago: 3 });
  assert.equal(old.revenue, m.weeks[m.weeks.length - 4].revenue);
  assert.equal(old.scorecard, undefined);
  assert.equal((await run('get_week_summary', { weeks_ago: 99 })).revenue, m.cur.revenue, 'out of range falls back to last week');
});

test('tech_leaderboard ranks by revenue and flags the Engine\'s below-average tech', async () => {
  const t = await run('tech_leaderboard', { weeks_ago: 0 });
  assert.equal(t.techs[0].name, m.cur.techs.slice().sort((a, b) => b.revenue - a.revenue)[0].name);
  assert.deepEqual(t.techs.filter((x) => x.belowAverage).map((x) => x.name), [...m.leaks.items.filter((x) => x.kind === 'tech').map((x) => x.flag.tech.name)]);
  assert.equal(t.teamAverage.revenue, Math.round(m.team.revenue));
});

test('list_unpaid_invoices and list_open_quotes total what the report shows', async () => {
  const u = await run('list_unpaid_invoices', { min_days: 30 });
  assert.equal(u.total, m.cur.unpaid30);
  assert.equal(u.count, m.cur.unpaid30List.length);
  assert.equal((await run('list_unpaid_invoices', {})).total, m.cur.unpaid30, 'defaults to 30 days');
  const stale = await run('list_open_quotes', { stale_only: true });
  const leak = m.leaks.items.find((x) => x.kind === 'quotes');
  assert.equal(stale.total, leak.amount);
  assert.equal(stale.count, leak.list.length);
  const all = await run('list_open_quotes', { stale_only: false });
  assert.equal(all.total, m.pipeline.openValue);
  assert.equal(all.quotes.shown, 40, 'capped at 40 rows');
});

test('list_callbacks, get_report_actions and find_customer answer from the report', async () => {
  const cb = await run('list_callbacks', { weeks_ago: 0 });
  assert.equal(cb.count, m.cur.callbacks);
  assert.equal(cb.callbacks.length, m.cur.callbackList.length);
  const a = await run('get_report_actions', {});
  assert.deepEqual(a.actions.map((x) => x.title), [...m.actions.map((x) => x.title)]);
  assert.deepEqual(a.summary, [...m.summary]);
  const f = await run('find_customer', { name: 'doug k' });
  assert.ok(f.invoices.some((x) => x.id === 'PL-I5501' && x.paid === 'unpaid'));
  assert.deepEqual(await run('find_customer', { name: '' }), { error: 'name is required' });
  assert.deepEqual(await run('list_hub_links', {}), HUB_LINKS);
});

test('UI tools only record actions, and validate their input', async () => {
  assert.deepEqual(await run('open_link', { link_id: 'van' }), { ok: true });
  assert.deepEqual(await run('open_link', { link_id: 'nope' }), { error: 'unknown link id' });
  assert.deepEqual(await run('add_reminder', { text: 'Call Herb', due: 'tomorrow' }), { ok: true });
  assert.deepEqual(await run('add_reminder', { text: ' ' }), { error: 'text is required' });
  assert.deepEqual(await run('search_hub', { query: 'routes' }), { ok: true });
  assert.deepEqual(actions, [{ type: 'open_link', linkId: 'van', label: 'Open Van app' }, { type: 'add_reminder', text: 'Call Herb' }, { type: 'search', query: 'routes' }]);
});

test('the system prompt carries the persona, the hub links and the glossary', () => {
  const p = systemPrompt(ctx.company);
  assert.ok(p.includes('You are Nova') && p.includes('SPEAK:') && p.includes('- booking: Online booking'));
  assert.ok(p.includes('(none in this data set)'), 'demo data has no labels/notes/playbook');
  const live = systemPrompt({ labels: { callback: 'callback' }, notes: { revenue: 'Revenue = completed jobs' }, playbook: { checklistSteps: ['Lube each O-ring.'] } });
  assert.ok(live.includes('Revenue = completed jobs') && live.includes('Lube each O-ring.'));
});
