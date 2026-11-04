import Anthropic from '@anthropic-ai/sdk';
import { fail, guard, readBody, send } from '../lib/auth.js';
import { hasKey, loadReport } from '../lib/data.js';
import { ask } from '../lib/brain.js';

// The client sends the last 12 turns; history must start and end with the user.
function clean(body) {
  const list = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  if (!list.length) throw new Error('messages must be a non-empty array');
  const messages = list.map((t) => {
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string' || !t.content.trim()) throw new Error('each message needs role user|assistant and non-empty string content');
    return { role: t.role, content: t.content.trim().slice(0, 4000) };
  });
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new Error('the last message must be from the user');
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || '') ? body.today : new Date().toISOString().slice(0, 10);
  return { messages, voice: body.voice === true, today };
}

export default async function handler(req, res) {
  if (!(await guard(req, res, { method: 'POST', chat: true }))) return;
  let input;
  try { input = clean(await readBody(req)); } catch (e) { return fail(res, 400, 'bad_request', e.message); }
  if (process.env.MOCK_MODEL !== '1' && !hasKey()) return fail(res, 503, 'not_configured', 'Nova is not set up yet: the Anthropic key is missing. See "Needs you".');
  let ctx;
  try {
    ctx = await loadReport();
  } catch (e) {
    console.error('chat: data unavailable:', e.message);
    return fail(res, 503, 'not_configured', 'Nova cannot reach the report data right now. See "Needs you".');
  }
  try {
    send(res, 200, await ask({ ctx, ...input }));
  } catch (e) {
    console.error('chat: model call failed:', e.status || '', e.message);
    if (e instanceof Anthropic.AuthenticationError) return fail(res, 503, 'not_configured', 'The Anthropic key was rejected. Check it in Vercel.');
    if (e instanceof Anthropic.RateLimitError) return fail(res, 502, 'upstream', 'Nova is busy right now. Try again in a minute.');
    fail(res, 502, 'upstream', 'Nova could not get an answer right now. Try again in a moment.');
  }
}
