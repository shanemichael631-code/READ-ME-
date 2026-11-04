// Report data and the report Engine, fetched on demand and cached in module scope for 10 minutes.
import { readFile } from 'node:fs/promises';
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
async function fetchText(url, headers) {
  if (!url) throw new ConfigError('URL not set');
  if (!/^https?:/.test(url)) return readFile(url.startsWith('file:') ? fileURLToPath(url) : path.resolve(url), 'utf8');
  const res = await fetch(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new ConfigError('HTTP ' + res.status);
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

// data.js does `window.REPORT_DATA = {...}`; run it in a bare context and copy the object out.
export function loadData() {
  return cached('data', async () => {
    const secret = process.env.REPORT_BYPASS_SECRET;
    const code = await fetchText(process.env.REPORT_DATA_URL, secret ? { 'x-vercel-protection-bypass': secret } : {});
    const sandbox = { window: {} };
    vm.runInNewContext(code, sandbox, { timeout: 5000 });
    const data = JSON.parse(JSON.stringify(sandbox.window.REPORT_DATA || null));
    if (!data?.meta?.asOf || !Array.isArray(data.companies?.[0]?.weeks)) throw new ConfigError('report data has an unexpected shape');
    return data;
  });
}

// report.js ends with `module.exports = Engine` when a module object exists; it never touches the DOM at load.
export function loadEngine() {
  return cached('engine', async () => {
    const code = await fetchText(process.env.REPORT_ENGINE_URL);
    const sandbox = { window: {}, module: { exports: {} }, console };
    vm.runInNewContext(code, sandbox, { timeout: 5000 });
    const Engine = sandbox.module.exports;
    if (typeof Engine?.buildReport !== 'function') throw new ConfigError('report engine did not export buildReport');
    return Engine;
  });
}

// Everything a request needs: the parsed data, the first company and its report for the latest full week.
export async function loadReport() {
  const [data, Engine] = await Promise.all([loadData(), loadEngine()]);
  const company = data.companies[0];
  return { data, Engine, company, asOf: data.meta.asOf, report: Engine.buildReport(company, data.meta.asOf) };
}
