// The real model path against a fake Anthropic API: request shape, the tool loop, refusal and auth errors.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start } from './_harness.js';

const calls = [];
let script = [];
const fake = http.createServer((req, res) => {
  let s = '';
  req.on('data', (d) => { s += d; }).on('end', () => {
    const body = JSON.parse(s);
    calls.push({ headers: req.headers, body });
    const [status, out] = script.shift()(body);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + fake.address().port;
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
process.env.MOCK_MODEL = '0';
process.env.HUB_PASSCODE = 'test';
const s = await start();
after(() => { fake.close(); return s.close(); });

const msg = (content, stop_reason, usage) => [200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20, ...usage } }];
const toolUse = (name, input) => msg([{ type: 'tool_use', id: 'toolu_' + calls.length, name, input }], 'tool_use', { cache_creation_input_tokens: 500 });
const chat = (content) => s.api('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content }], today: '2026-11-03', voice: true } });

test('tool loop: the request carries the documented params and the tool result feeds the reply', async () => {
  script = [
    () => toolUse('get_week_summary', { weeks_ago: 0 }),
    (body) => {
      const tr = body.messages.at(-1).content[0];
      assert.equal(tr.type, 'tool_result');
      const data = JSON.parse(typeof tr.content === 'string' ? tr.content : tr.content[0].text);
      return msg([{ type: 'text', text: 'Last week: $' + data.revenue.toLocaleString('en-US') + ' on ' + data.jobs + ' jobs.\nSPEAK: Last week came to about thirty-eight thousand dollars.' }], 'end_turn', { cache_read_input_tokens: 500 });
    },
  ];
  const r = await chat('How was last week?');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.reply, 'Last week: $38,465 on 97 jobs.');
  assert.equal(j.speak, 'Last week came to about thirty-eight thousand dollars.');
  assert.deepEqual(j.usage, { input: 1200, output: 40 });
  assert.deepEqual(j.actions, []);
  const { headers, body } = calls[0];
  assert.ok(headers['x-api-key'] === 'sk-ant-fake' || headers.authorization === 'Bearer sk-ant-fake', 'key sent');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 1500);
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.thinking, undefined);
  assert.ok(!body.stream, 'non-streaming');
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.match(body.system[0].text, /^You are Nova/);
  assert.equal(body.tools.length, 11);
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.tools[0].input_schema.additionalProperties, false);
  assert.equal(body.tools.find((t) => t.name === 'add_reminder').strict, false);
  assert.ok(body.tools.every((t) => t.run === undefined), 'run functions never leave the server');
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].content[0].text, /^Today is Tuesday, Nov 3, 2026\. The report data runs through Oct 4 \(as of 2026-10-05\); "last week" means the week of Sep 28/);
  assert.match(body.messages[0].content[0].text, /speaking, so keep it brief/);
  assert.equal(body.messages[0].content[1].text, 'How was last week?');
  assert.equal(calls[1].body.messages.length, 3, 'full history each turn, no thread');
  assert.equal(calls[1].body.thread, undefined);
  assert.equal(calls[1].body.tools.length, 11);
  assert.equal(calls[1].body.messages[1].content[0].type, 'tool_use');
});

test('UI tool calls become actions; the loop stops at 6 iterations with a fallback reply', async () => {
  calls.length = 0;
  script = Array.from({ length: 7 }, (_, i) => () => toolUse(i ? 'list_hub_links' : 'open_link', i ? {} : { link_id: 'jobber' }));
  const j = await (await chat('open jobber')).json();
  assert.equal(calls.length, 6);
  assert.deepEqual(j.actions, [{ type: 'open_link', linkId: 'jobber', label: 'Open Jobber' }]);
  assert.match(j.reply, /Ask that again/);
  assert.ok(j.speak);
});

test('a refusal gets a polite reply', async () => {
  script = [() => msg([], 'refusal')];
  const j = await (await chat('something off limits')).json();
  assert.match(j.reply, /can't help with that one/);
  assert.ok(!/SPEAK/.test(j.reply) && j.speak);
});

test('a rejected key -> 503 not_configured; another API error -> 502 upstream, never a stack trace', async () => {
  script = [() => [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }]];
  let r = await chat('hi');
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'not_configured');
  script = [() => [400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad effort' } }]];
  r = await chat('hi');
  assert.equal(r.status, 502);
  const e = (await r.json()).error;
  assert.equal(e.code, 'upstream');
  assert.ok(!/bad effort|at /.test(e.message));
});
