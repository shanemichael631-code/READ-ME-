import { guard, send } from '../lib/auth.js';
import { hasKey, loadData, loadEngine } from '../lib/data.js';
import { modelName } from '../lib/brain.js';

export const VERSION = '2026.11.03';

export default async function handler(req, res) {
  if (!(await guard(req, res, { method: 'GET' }))) return;
  const [data, engine] = await Promise.all([loadData().catch(() => null), loadEngine().catch(() => null)]);
  const key = hasKey();
  send(res, 200, {
    ok: !!(data && engine), chat: key || process.env.MOCK_MODEL === '1',
    model: modelName(), hasKey: key, hasData: !!data,
    dataAsOf: data ? data.meta.asOf : null, company: data ? data.companies[0].name : null,
    engineOk: !!engine, version: VERSION,
  });
}
