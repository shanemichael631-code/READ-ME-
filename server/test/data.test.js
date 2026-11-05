import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasKey, loadData, loadEngine, loadReport, resetCache } from '../lib/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.REPORT_ENGINE_URL = path.join(ROOT, 'report.js');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'nova-data-'));
const tmp = (name, code) => { const f = path.join(TMP, name); writeFileSync(f, code); return f; };
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  resetCache();
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetCache(); }
};

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

// Both loaders run fetched code: it must not reach the host through the globals the loader declares, nor via eval.
const ESCAPES = ['window.constructor.constructor', 'module.constructor.constructor', 'console.log.constructor', 'this.constructor.constructor', 'globalThis.constructor.constructor'];
const probe = ESCAPES.map((e) => '(function () { try { return ' + e + '("return process")().env.HUB_PASSCODE; } catch (err) { return "blocked: " + err.constructor.name; } })()').join(', ');
test('fetched data.js and report.js cannot read process.env through Function, eval or the declared globals', async () => {
  await withEnv({ HUB_PASSCODE: 'top-secret-pass', REPORT_DATA_URL: tmp('evil-data.js', 'window.REPORT_DATA = { meta: { asOf: "2026-10-05", leaks: [' + probe + '], ev: (function () { try { return eval("process"); } catch (e) { return "blocked: " + e.constructor.name; } })() }, companies: [{ weeks: [] }] };'),
    REPORT_ENGINE_URL: tmp('evil-report.js', 'module.exports = { CONFIG: {}, daysBetween: function () { return 0; }, buildReport: function () { return { leaks: [' + probe + '] }; } };') }, async () => {
    const d = await loadData();
    assert.deepEqual(d.meta.leaks, ESCAPES.map(() => 'blocked: EvalError'));
    assert.equal(d.meta.ev, 'blocked: EvalError');
    const Engine = await loadEngine();
    const m = Engine.buildReport({}, '2026-10-05');
    assert.deepEqual(m.leaks, ESCAPES.map(() => 'blocked: EvalError'));
    assert.ok(!JSON.stringify([d, m, Engine.CONFIG]).includes('top-secret'));
    assert.equal(Engine.daysBetween('a', 'b'), 0);
  });
});

test('the bypass secret needs https and never follows a redirect to another origin', async () => {
  const seen = [];
  const other = http.createServer((req, res) => { seen.push(['other', req.headers['x-vercel-protection-bypass']]); res.end('window.REPORT_DATA = {};'); });
  const origin = http.createServer((req, res) => { seen.push(['origin', req.headers['x-vercel-protection-bypass']]); res.writeHead(302, { location: 'http://127.0.0.1:' + other.address().port + '/data.js' }); res.end(); });
  await Promise.all([other, origin].map((srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r))));
  after(() => { other.close(); origin.close(); });
  const url = 'http://127.0.0.1:' + origin.address().port + '/data.js';
  await withEnv({ REPORT_DATA_URL: url, REPORT_BYPASS_SECRET: 'bypass-SECRET' }, () => assert.rejects(loadData(), (e) => e.code === 'not_configured' && /https/.test(e.message)));
  assert.deepEqual(seen, [], 'plain http with a secret is refused before any request');
  await withEnv({ REPORT_DATA_URL: url, REPORT_BYPASS_SECRET: undefined }, () => assert.rejects(loadData(), (e) => e.code === 'not_configured' && /redirect refused, HTTP 302/.test(e.message)));
  assert.deepEqual(seen, [['origin', undefined]], 'the 302 is not followed');
});

test('REPORT_ENGINE_SHA256 is enforced only when set', async () => {
  const sha = createHash('sha256').update(readFileSync(path.join(ROOT, 'report.js'))).digest('hex');
  await withEnv({ REPORT_ENGINE_SHA256: 'deadbeef' }, () => assert.rejects(loadEngine(), (e) => e.code === 'not_configured' && /REPORT_ENGINE_SHA256/.test(e.message)));
  await withEnv({ REPORT_ENGINE_SHA256: sha.toUpperCase() }, async () => assert.equal(typeof (await loadEngine()).buildReport, 'function'));
  await withEnv({ REPORT_ENGINE_SHA256: '' }, async () => assert.equal(typeof (await loadEngine()).buildReport, 'function'));
});
