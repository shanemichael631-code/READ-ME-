import { fail, guard, send } from '../lib/auth.js';
import { hasKey, loadReport } from '../lib/data.js';
import { buildNeeds, setupItems } from '../lib/needs.js';

export default async function handler(req, res) {
  if (!(await guard(req, res, { method: 'GET' }))) return;
  const q = new URL(req.url, 'http://x').searchParams.get('today') || '';
  const today = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
  let ctx;
  try {
    ctx = await loadReport();
  } catch (e) {
    console.error('needs: data unavailable:', e.message);
    return send(res, 200, { asOf: null, weekOf: null, items: setupItems(hasKey(), false) });
  }
  try {
    send(res, 200, buildNeeds(ctx, today, hasKey()));
  } catch (e) {
    console.error('needs:', e.message);
    fail(res, 502, 'upstream', 'Nova could not build the list right now. Try again in a moment.');
  }
}
