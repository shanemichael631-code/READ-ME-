// Nova: the system prompt, the tools over the report data, the model call and the MOCK_MODEL adapter.
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';

export const modelName = () => (process.env.MOCK_MODEL === '1' ? 'mock' : process.env.ANTHROPIC_MODEL || 'claude-opus-5-5');

// Mirrors the HUB array in hub.html (id, title, purpose) so Nova can offer open_link chips.
export const HUB_LINKS = [
  ['report-nova', 'Nova Filters Owner Report', 'last week in numbers: money leaks, tech leaderboard, 3 things to do'],
  ['report-demo', 'Monday Owner Report demo', 'public demo of the report with made-up companies'],
  ['booking', 'Online booking', 'customer-facing booking form'],
  ['booking-hub', 'Booking hub', 'staff view of incoming online bookings'],
  ['warehouse', 'Warehouse hub', 'inventory and warehouse app'],
  ['routes', 'Route map', 'tech routing map'],
  ['van', 'Van app', 'truck stock and van checklist'],
  ['jobber', 'Jobber', 'schedule, quotes, jobs and invoices'],
  ['amazon', 'Amazon Seller Central', 'FBM orders, listings and ads'],
  ['ebay', 'eBay Seller Hub', 'orders, listings and messages'],
  ['jarvis', 'Jarvis assistant', 'notes, tasks and reminders'],
].map(([id, title, purpose]) => ({ id, title, purpose }));

const money = (n) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n || 0)).toLocaleString('en-US');
const pct = (x) => (x === null || x === undefined ? null : Math.round(x * 100) + '%');
const fmt = (s, o) => new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...o });
const weekLabel = (w) => 'week of ' + fmt(w.start) + ' (' + fmt(w.start) + ' to ' + fmt(w.end) + ')';
const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const rows = (list, n = 40) => (list.length > n ? { shown: n, of: list.length, rows: list.slice(0, n) } : list);
const total = (list) => list.reduce((s, x) => s + x.amount, 0);

const glossary = (c) => ['labels', 'notes', 'playbook'].filter((k) => c[k]).map((k) => k + ': ' + JSON.stringify(c[k], null, 1)).join('\n') || '(none in this data set)';

export const systemPrompt = (company) => `You are Nova, the assistant inside the Nova Hub for Nova Filters (also Superior Filters) in Wildwood, FL: water filtration install, service and e-commerce. Shane is the owner. You talk with the team: office, sales and technicians.
Voice: plain-spoken, short, practical. Answer in 1 to 4 short sentences unless asked for detail. Short markdown is fine (bold, bullets). Write money as $1,234. Name the week you mean ("the week of Sep 28").
Rules:
- Every number about the business comes from a tool. Never invent or estimate figures. When the tools have no data, say so and point to the "Needs you" list for the fix.
- Customer names and balances stay inside the team. No medical or legal advice.
- Outside the data, be a helpful water-treatment expert: RO, softeners, whole-house filtration, UV, plumbing.
- To offer a page call open_link, to set a reminder call add_reminder, to search the hub call search_hub. They show as tap chips and the user decides.
- End every answer with one last line that starts with "SPEAK:" and gives a 1 to 3 sentence spoken version: no markdown, no URLs, numbers in words ("about twelve hundred dollars").
Hub links (id: title, purpose):
${HUB_LINKS.map((l) => '- ' + l.id + ': ' + l.title + ', ' + l.purpose).join('\n')}
Business glossary, quoted from the report data:
${glossary(company)}`;

// Tools answered from the parsed data and the Engine model. UI tools only record an Action to return.
export function makeTools({ company: c, report: m, Engine }, actions) {
  const week = (ago) => m.weeks[m.weeks.length - 1 - int(ago, 0, m.weeks.length - 1, 0)];
  const techName = (id) => (c.techs.find((t) => t.id === id) || {}).name || id;
  const avgOf = (w) => {
    const a = w.techs.filter((t) => t.field && t.jobs), n = a.length || 1;
    return { techs: a.length, jobs: Math.round(a.reduce((s, t) => s + t.jobs, 0) / n), revenue: Math.round(a.reduce((s, t) => s + t.revenue, 0) / n) };
  };
  const def = (name, description, properties, required, run, strict = true) => betaTool({
    name, description, strict,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    run: async (input) => JSON.stringify(await run(input || {})),
  });
  const ago = { weeks_ago: { type: 'integer', description: '0 = last full week (the latest), 1 = the week before, up to ' + (m.weeks.length - 1) } };
  return [
    def('get_week_summary', 'Revenue, jobs, average ticket, close rate, unpaid 30+, callbacks and the other scorecard numbers for one week, with the change from the week before. Call it for any "how was the week" or scorecard question.', ago, ['weeks_ago'], ({ weeks_ago }) => {
      const w = week(weeks_ago), p = m.weeks[w.index - 1];
      const out = {
        week: weekLabel(w), revenue: w.revenue, jobs: w.jobs, avgTicket: Math.round(w.avgTicket), closeRate: pct(w.closeRate),
        quotesSent: w.quotesSent, quotesWon: w.quotesWon, quotesSentValue: w.quotesSentValue, quotesWonValue: w.quotesWonValue,
        unpaid30: w.unpaid30, callbacks: w.callbacks, newLeads: w.newLeads, newReviews: w.newReviews, ...(c.weeks[w.index].metrics || {}),
      };
      if (p) out.vsPriorWeek = { revenue: pct((w.revenue - p.revenue) / (p.revenue || 1)), jobs: w.jobs - p.jobs };
      if (w.index === m.cur.index) out.scorecard = m.scorecard.map((t) => ({ label: t.label, value: t.text[0], weekBefore: t.text[1], fourWeekAvg: t.text[2], tone: t.tone }));
      return out;
    }),
    def('tech_leaderboard', 'Per-tech jobs, revenue, average ticket and callbacks for one week, ranked by revenue, with the team average and who the report flags as below it.', ago, ['weeks_ago'], ({ weeks_ago }) => {
      const w = week(weeks_ago);
      const flagged = w.index === m.cur.index ? m.leaks.items.filter((x) => x.kind === 'tech').map((x) => x.flag.tech.id) : [];
      const techs = w.techs.filter((t) => t.jobs || t.field).sort((a, b) => b.revenue - a.revenue).map((t) => ({
        name: t.name, role: t.role, group: t.group || undefined, jobs: t.jobs, revenue: t.revenue, avgTicket: Math.round(t.avgTicket),
        callbacks: t.callbacks, belowAverage: flagged.includes(t.id) || undefined,
      }));
      return { week: weekLabel(w), teamAverage: avgOf(w), techs };
    }),
    def('list_unpaid_invoices', 'Open invoices at least min_days old as of the report date, biggest first, with the total. Use min_days 30 for the "unpaid 30+" number.', { min_days: { type: 'integer', description: 'Minimum days outstanding, usually 30' } }, ['min_days'], ({ min_days }) => {
      const d = int(min_days, 0, 365, 30);
      const list = m.cur.openInvoices.filter((x) => x.daysOutstanding >= d).sort((a, b) => b.amount - a.amount)
        .map((x) => ({ id: x.id, customer: x.customer, what: x.description, amount: x.amount, days: x.daysOutstanding, issued: x.issuedDate }));
      return { asOf: m.cur.snapshot, minDays: d, count: list.length, total: total(list), invoices: rows(list) };
    }),
    def('list_open_quotes', 'Open quotes (no decision yet) with their age in days, biggest first. stale_only true = only the ones the report flags as waiting too long.', { stale_only: { type: 'boolean' } }, ['stale_only'], ({ stale_only }) => {
      const leak = m.leaks.items.find((x) => x.kind === 'quotes');
      const stale = new Set((leak ? leak.list : []).map((q) => q.id));
      const list = c.quotes.filter((q) => q.status === 'open' && (!stale_only || stale.has(q.id))).sort((a, b) => b.amount - a.amount).map((q) => ({
        id: q.id, customer: q.customer, service: q.service, amount: q.amount, sent: q.sentDate, ageDays: Engine.daysBetween(q.sentDate, m.today),
        viewed: q.viewedDate || undefined, followedUp: q.lastFollowUpDate || undefined, stale: stale.has(q.id) || undefined,
      }));
      return { staleAfterDays: Engine.CONFIG.staleQuoteDays, count: list.length, total: total(list), quotes: rows(list) };
    }),
    def('list_callbacks', 'Callbacks (free return visits) in one week: date, tech, customer, issue, plus the estimated cost.', ago, ['weeks_ago'], ({ weeks_ago }) => {
      const w = week(weeks_ago);
      return { week: weekLabel(w), count: w.callbacks, estimatedCost: w.callbacks * (c.callbackCostEstimate || 0),
        callbacks: rows(w.callbackList.map((x) => ({ date: x.date, tech: techName(x.techId), customer: x.customer, issue: x.issue, after: x.after }))) };
    }),
    def('get_report_actions', 'The Owner Report\'s "3 things to do this week", its short summary and the money leaks for the latest week. Call it when asked what to do, what matters, or for the report\'s take.', {}, [], () => ({
      week: weekLabel(m.cur), summary: m.summary,
      actions: m.actions.map((a, i) => ({ n: i + 1, title: a.title, detail: a.detail, impact: a.impact })),
      moneyLeaks: m.leaks.items.map((x) => ({ kind: x.kind, title: x.title, amount: Math.round(x.amount) })),
    })),
    def('find_customer', 'Find a customer by name (case-insensitive, partial match) across quotes, invoices and callbacks. Call it whenever a customer is named.', { name: { type: 'string', description: 'Part of the customer name' } }, ['name'], ({ name }) => {
      const q = text(name, 60).toLowerCase();
      if (!q) return { error: 'name is required' };
      const hit = (x) => String(x.customer || '').toLowerCase().includes(q);
      return {
        quotes: rows(c.quotes.filter(hit).map((x) => ({ id: x.id, customer: x.customer, service: x.service, amount: x.amount, status: x.status, sent: x.sentDate, decided: x.decidedDate || undefined })), 20),
        invoices: rows(c.invoices.filter(hit).map((x) => ({ id: x.id, customer: x.customer, what: x.description, amount: x.amount, issued: x.issuedDate, paid: x.paidDate || 'unpaid' })), 20),
        callbacks: rows(c.callbacks.filter(hit).map((x) => ({ date: x.date, customer: x.customer, tech: techName(x.techId), issue: x.issue })), 20),
      };
    }),
    def('list_hub_links', 'The pages in the Nova Hub with their link ids, for open_link.', {}, [], () => HUB_LINKS),
    def('open_link', 'Offer a tap chip that opens a hub page. Use a link id from the hub list.', { link_id: { type: 'string', enum: HUB_LINKS.map((l) => l.id) } }, ['link_id'], ({ link_id }) => {
      const l = HUB_LINKS.find((x) => x.id === link_id);
      if (!l) return { error: 'unknown link id' };
      actions.push({ type: 'open_link', linkId: l.id, label: 'Open ' + l.title });
      return { ok: true };
    }),
    def('add_reminder', 'Offer a tap chip that saves a reminder on the user\'s device. due is optional, YYYY-MM-DD.', { text: { type: 'string', description: 'The reminder, under 200 characters' }, due: { type: 'string', description: 'YYYY-MM-DD' } }, ['text'], ({ text: t, due }) => {
      const body = text(t, 200);
      if (!body) return { error: 'text is required' };
      actions.push(/^\d{4}-\d{2}-\d{2}$/.test(due || '') ? { type: 'add_reminder', text: body, due } : { type: 'add_reminder', text: body });
      return { ok: true };
    }, false),
    def('search_hub', 'Offer a tap chip that fills the hub search box with a query.', { query: { type: 'string' } }, ['query'], ({ query }) => {
      const q = text(query, 80);
      if (!q) return { error: 'query is required' };
      actions.push({ type: 'search', query: q });
      return { ok: true };
    }),
  ];
}

// Today and the data's as-of date go in the first user turn so the system prompt and tools stay cacheable.
const dateLine = (today, m, voice) => 'Today is ' + fmt(today, { weekday: 'long', year: 'numeric' }) + '. The report data runs through ' + fmt(m.cur.end) +
  ' (as of ' + m.asOf + '); "last week" means the ' + weekLabel(m.cur) + '.' + (voice ? ' The user is speaking, so keep it brief.' : '');

const plain = (s) => s.replace(/https?:\/\/\S+/g, '').replace(/[*_`#>|]+/g, '').replace(/^\s*(?:[-+]|\d+[.)])\s+/gm, '')
  .replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');

function split(out) {
  if (out.stop === 'refusal') return { reply: "I can't help with that one. Ask me about the business or about water treatment.", speak: "I can't help with that one." };
  if (!out.text) return { reply: 'I lost the thread there. Ask that again in a shorter way.', speak: 'Ask that again in a shorter way.' };
  const i = out.text.lastIndexOf('SPEAK:');
  const reply = (i >= 0 ? out.text.slice(0, i) : out.text).trim();
  const speak = plain(i >= 0 ? out.text.slice(i + 6) : reply) || plain(reply);
  return { reply: reply || speak, speak };
}

// One deadline for the whole tool loop, inside Vercel's 60 s: 20 s per request, one retry, 50 s in all
// (NOVA_DEADLINE_MS shortens it for tests). An unsupported ANTHROPIC_EFFORT falls back to low.
const effort = () => (['low', 'medium', 'high'].includes(process.env.ANTHROPIC_EFFORT) ? process.env.ANTHROPIC_EFFORT : 'low');
async function live(ctx, messages, tools) {
  const runner = new Anthropic({ timeout: 20000, maxRetries: 1 }).beta.messages.toolRunner({
    model: modelName(),
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: effort() },
    system: [{ type: 'text', text: systemPrompt(ctx.company), cache_control: { type: 'ephemeral' } }],
    tools, messages, max_iterations: 6, thread: false,
  }, { signal: AbortSignal.timeout(Number(process.env.NOVA_DEADLINE_MS) || 50000) });
  const usage = { input: 0, output: 0 };
  let last;
  for await (const msg of runner) {
    last = msg;
    usage.input += msg.usage.input_tokens + (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0);
    usage.output += msg.usage.output_tokens;
  }
  return { text: (last?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), stop: last?.stop_reason, usage };
}

// MOCK_MODEL=1: no key needed. Runs the same tool objects, so tests cover tool execution end to end.
async function mock(lastText, tools, today) {
  const q = lastText.toLowerCase();
  const run = async (name, input) => JSON.parse(await tools.find((t) => t.name === name).run(input));
  let text;
  if (q.includes('week')) {
    const w = await run('get_week_summary', { weeks_ago: 0 });
    text = 'The ' + w.week + ': **' + money(w.revenue) + '** on ' + w.jobs + ' jobs.\n- Average ticket ' + money(w.avgTicket) + '\n- Close rate ' + (w.closeRate || 'n/a') +
      '\n- Unpaid 30+ days: ' + money(w.unpaid30) + '\n- Callbacks: ' + w.callbacks + '\nSPEAK: Last week came to ' + money(w.revenue) + ' on ' + w.jobs + ' jobs, with ' + w.callbacks + ' callbacks.';
  } else if (/\bsearch\b/.test(q)) {
    await run('search_hub', { query: (/\bsearch\s+(?:for\s+)?(.+)/i.exec(lastText) || [])[1] || lastText });
    text = 'Here is a search for that.\nSPEAK: Tap the chip to search the hub.';
  } else if (q.includes('remind')) {
    await run('add_reminder', { text: lastText.replace(/^.*?remind\s+(me\s+)?(to\s+)?/i, '').trim() || lastText, due: today });
    text = 'Added a reminder chip for you.\nSPEAK: Reminder ready. Tap it to save.';
  } else if (q.includes('open booking')) {
    await run('open_link', { link_id: 'booking' });
    text = 'Here is the booking page.\nSPEAK: Opening booking.';
  } else text = 'You said: ' + lastText + '\nSPEAK: You said ' + lastText;
  return { text, stop: 'end_turn', usage: { input: 0, output: 0 } };
}

export async function ask({ ctx, messages, today, voice }) {
  const actions = [];
  const tools = makeTools(ctx, actions);
  const turns = messages.map((t, i) => ({ role: t.role, content: i ? t.content : [{ type: 'text', text: dateLine(today, ctx.report, voice) }, { type: 'text', text: t.content }] }));
  const out = process.env.MOCK_MODEL === '1' ? await mock(messages[messages.length - 1].content, tools, today) : await live(ctx, turns, tools);
  return { ...split(out), actions, usage: out.usage };
}
