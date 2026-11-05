// Report data and the report Engine, fetched on demand and cached in module scope for 10 minutes.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const TTL = 10 * 60e3;
const cache = {};

export class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'not_configured'; }
}

export const hasKey = () => { const k = process.env.ANTHROPIC_API_KEY; return !!k && k !== 'REPLACE_ME'; };

// http(s) URLs are fetched; anything else (a disk path or a file: URL) is read locally for the dev harness.
// The bypass secret only ever reaches the exact origin in REPORT_DATA_URL: https only, and no redirect is followed.
async function fetchText(url, secret) {
  if (!url) throw new ConfigError('URL not set');
  if (!/^https?:/.test(url)) return readFile(url.startsWith('file:') ? fileURLToPath(url) : path.resolve(url), 'utf8');
  if (secret && !url.startsWith('https:')) throw new ConfigError('REPORT_DATA_URL must be https when REPORT_BYPASS_SECRET is set');
  const res = await fetch(url, { headers: secret ? { 'x-vercel-protection-bypass': secret } : {}, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new ConfigError((res.status < 400 ? 'redirect refused, HTTP ' : 'HTTP ') + res.status);
  return res.text();
}

async function cached(key, load) {
  const hit = cache[key];
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const value = await load();
    cache[key] = { at: Date.now(), value };
    return value;
  } catch (e) {
    throw e instanceof ConfigError ? e : new ConfigError(key + ': ' + e.message);
  }
}
export const resetCache = () => { for (const k of Object.keys(cache)) delete cache[k]; };

// Fetched code runs in an empty context: no host objects go in, eval/Function are off, and results come out as
// JSON only. The returned function evaluates an expression there, or calls one with JSON-encoded arguments.
function sandbox(code, prelude = '') {
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('var window = {}, module = { exports: {} }, console = { log() {}, warn() {}, error() {} };', ctx);
  vm.runInContext(code, ctx, { timeout: 5000 });
  vm.runInContext(prelude, ctx);
  return (expr, ...args) => {
    const out = vm.runInContext('JSON.stringify(' + (args.length ? expr + '(...' + JSON.stringify(args) + ')' : expr) + ')', ctx, { timeout: 5000 });
    return out === undefined ? null : JSON.parse(out);
  };
}

// data.js does `window.REPORT_DATA = {...}` (not plain JSON: the live file has unquoted keys), so it is executed.
export function loadData() {
  return cached('data', async () => {
    const code = await fetchText(process.env.REPORT_DATA_URL, process.env.REPORT_BYPASS_SECRET);
    const data = sandbox(code)('window.REPORT_DATA');
    if (!data?.meta?.asOf || !Array.isArray(data.companies?.[0]?.weeks)) throw new ConfigError('report data has an unexpected shape');
    return data;
  });
}

// report.js ends with `module.exports = Engine` when a module object exists; it never touches the DOM at load.
// Scorecard tiles format through functions, which cannot cross the boundary, so their text is rendered inside.
export function loadEngine() {
  return cached('engine', async () => {
    const code = await fetchText(process.env.REPORT_ENGINE_URL);
    const pin = (process.env.REPORT_ENGINE_SHA256 || '').toLowerCase();
    if (pin && createHash('sha256').update(code).digest('hex') !== pin) throw new ConfigError('report engine does not match REPORT_ENGINE_SHA256');
    const run = sandbox(code, 'var report = (c, d) => { var m = module.exports.buildReport(c, d); (m.scorecard || []).forEach((t) => { t.text = [t.value, t.prev, t.avg4].map((v) => (v == null ? null : t.def.fmt ? t.def.fmt(v) : v)); }); return m; };');
    if (run('typeof module.exports.buildReport') !== 'function') throw new ConfigError('report engine did not export buildReport');
    return { CONFIG: run('module.exports.CONFIG'), daysBetween: (a, b) => run('module.exports.daysBetween', a, b), buildReport: (company, asOf) => run('report', company, asOf) };
  });
}

// Everything a request needs: the parsed data, the first company and its report for the latest full week.
export async function loadReport() {
  const [data, Engine] = await Promise.all([loadData(), loadEngine()]);
  const company = data.companies[0];
  return { data, Engine, company, asOf: data.meta.asOf, report: Engine.buildReport(company, data.meta.asOf) };
}
