import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './_harness.js';

process.env.MOCK_MODEL = '1';
process.env.HUB_PASSCODE = 'test';
const s = await start();
after(() => s.close());

test('OPTIONS preflight answers 204 with CORS headers', async () => {
  const r = await s.api('/api/chat', { method: 'OPTIONS', pass: '' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-headers'), /content-type, x-hub-pass/);
});

test('wrong or missing passcode -> 401 bad_passcode after about 400 ms', async () => {
  const t0 = Date.now();
  const r = await s.api('/api/health', { pass: 'nope', ip: '10.0.0.1' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'bad_passcode');
  assert.ok(Date.now() - t0 >= 380);
  assert.equal((await s.api('/api/health', { pass: '', ip: '10.0.0.1' })).status, 401);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('10 bad passcodes lock that IP out with 429, even for the right passcode', async () => {
  await Promise.all(Array.from({ length: 10 }, () => s.api('/api/health', { pass: 'bad', ip: '10.0.0.2' })));
  const r = await s.api('/api/health', { pass: 'bad', ip: '10.0.0.2' });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.code, 'rate_limited');
  assert.equal((await s.api('/api/health', { pass: 'test', ip: '10.0.0.2' })).status, 429);
  assert.equal((await s.api('/api/health', { pass: 'test', ip: '10.0.0.9' })).status, 200);
});

test('chat is limited to 20 requests per 5 minutes per IP', async () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  const rs = await Promise.all(Array.from({ length: 20 }, () => s.api('/api/chat', { method: 'POST', body, ip: '10.0.0.3' })));
  assert.ok(rs.every((r) => r.status === 200));
  const r = await s.api('/api/chat', { method: 'POST', body, ip: '10.0.0.3' });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.code, 'rate_limited');
});

test('wrong method -> 405; missing HUB_PASSCODE -> 503 not_configured', async () => {
  assert.equal((await s.api('/api/chat', { method: 'GET' })).status, 405);
  const saved = process.env.HUB_PASSCODE;
  process.env.HUB_PASSCODE = '';
  const r = await s.api('/api/health');
  process.env.HUB_PASSCODE = saved;
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'not_configured');
});
