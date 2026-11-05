// Passcode, CORS, rate limits and JSON helpers shared by the three functions.
import { createHash, timingSafeEqual } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();
// Best effort only: these counters live in one serverless instance's memory and instances are ephemeral,
// so a determined caller can get more tries than this. The passcode is the real gate.
const hits = new Map();
function recent(key, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, list);
  return list;
}

export function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : '') || req.socket?.remoteAddress || 'unknown';
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
export const fail = (res, status, code, message) => send(res, status, { error: { code, message } });

// CORS, OPTIONS, method, passcode and per-IP limits. Returns true when the handler may continue.
export async function guard(req, res, opts = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-hub-pass');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return false; }
  if (opts.method && req.method !== opts.method) { fail(res, 405, 'method_not_allowed', 'Use ' + opts.method + '.'); return false; }
  const expected = process.env.HUB_PASSCODE;
  if (!expected) { fail(res, 503, 'not_configured', 'HUB_PASSCODE is not set on the server.'); return false; }
  const ip = ipOf(req);
  const bad = recent('bad:' + ip, 15 * 60e3);
  if (bad.length >= 10) { fail(res, 429, 'rate_limited', 'Too many wrong passcodes. Try again in 15 minutes.'); return false; }
  const given = String(req.headers['x-hub-pass'] || '');
  if (!given || !timingSafeEqual(sha(given), sha(expected))) {
    bad.push(Date.now());
    await new Promise((r) => setTimeout(r, 400));
    fail(res, 401, 'bad_passcode', 'That passcode is not right.');
    return false;
  }
  if (opts.chat) {
    const used = recent('chat:' + ip, 5 * 60e3);
    if (used.length >= 20) { fail(res, 429, 'rate_limited', 'Nova needs a breather. Try again in a few minutes.'); return false; }
    used.push(Date.now());
  }
  return true;
}

// JSON body: Vercel parses it into req.body; the dev harness and tests hand over the raw stream.
const parse = (s) => { try { return JSON.parse(s); } catch { throw new Error('body must be valid JSON'); } };
export async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? parse(req.body) : req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 65536) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? parse(Buffer.concat(chunks).toString('utf8')) : {};
}
