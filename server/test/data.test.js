import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasKey, loadData, loadEngine, loadReport, resetCache } from '../lib/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.REPORT_ENGINE_URL = path.join(ROOT, 'report.js');

test('parses the repo data.js from a disk path', async () => {
  resetCache();
  process.env.REPORT_DATA_URL = path.join(ROOT, 'data.js');
  const d = await loadData();
  assert.equal(d.meta.asOf, '2026-10-05');
  assert.equal(d.companies[0].name, 'Demo Plumbing Co.');
  assert.equal(await loadData(), d, 'second call is served from the cache');
});

test('parses the same file through a file: URL', async () => {
  resetCache();
  process.env.REPORT_DATA_URL = pathToFileURL(path.join(ROOT, 'data.js')).href;
  assert.equal((await loadData()).companies.length, 3);
});

test('evaluates report.js in a vm and the report matches a direct require of the Engine', async () => {
  const Engine = await loadEngine();
  assert.equal(typeof Engine.buildReport, 'function');
  const ctx = await loadReport();
  global.window = {};
  const require = createRequire(import.meta.url);
  require(path.join(ROOT, 'data.js'));
  const direct = require(path.join(ROOT, 'report.js')).buildReport(global.window.REPORT_DATA.companies[0], '2026-10-05');
  assert.equal(ctx.report.cur.start, '2026-09-28');
  assert.equal(ctx.report.cur.revenue, direct.cur.revenue);
  assert.equal(ctx.report.leaks.total, direct.leaks.total);
  assert.deepEqual([...ctx.report.actions.map((a) => a.title)], [...direct.actions.map((a) => a.title)]);
});

test('a missing data file or engine surfaces as not_configured', async () => {
  resetCache();
  process.env.REPORT_DATA_URL = '/nope/data.js';
  await assert.rejects(loadData(), (e) => e.code === 'not_configured');
  process.env.REPORT_DATA_URL = path.join(ROOT, 'hub.html');
  await assert.rejects(loadData(), (e) => e.code === 'not_configured');
  resetCache();
  process.env.REPORT_DATA_URL = path.join(ROOT, 'data.js');
});

test('hasKey is false for a missing or placeholder key', () => {
  process.env.ANTHROPIC_API_KEY = 'REPLACE_ME';
  assert.equal(hasKey(), false);
  process.env.ANTHROPIC_API_KEY = '';
  assert.equal(hasKey(), false);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  assert.equal(hasKey(), true);
});
