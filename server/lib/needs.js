// The "Needs you" inbox, computed from the report for the latest week. Ids are stable so the UI can dismiss them.
const ENV_URL = 'https://vercel.com/shanemichael631-3943/nova-hub-gvz6r/settings/environment-variables';
const REPORT_URL = 'https://nova-owner-report.vercel.app';
const money = (n) => '$' + Math.round(Math.abs(n || 0)).toLocaleString('en-US');
const fmt = (s) => new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const day = (s) => Date.parse(s + 'T00:00:00Z');
const daysBetween = (a, b) => Math.round((day(b) - day(a)) / 864e5);
const isMonday = (s) => new Date(day(s)).getUTCDay() === 1;
const ask = (query) => ({ label: 'Ask Nova', kind: 'ask', query });
const open = { label: 'Open', kind: 'open' };
const RANK = { high: 0, medium: 1, low: 2 };

// A missing Anthropic key is not an item: chat is optional, so the hub hides Ask Nova instead (see chat in api/needs.js).
export function setupItems(dataOk) {
  const items = [];
  if (!dataOk) items.push({ id: 'setup:data', kind: 'setup', severity: 'high', title: 'Report data is unreachable', detail: 'Nova could not fetch or read the report data. Check REPORT_DATA_URL and REPORT_BYPASS_SECRET in Vercel.', url: ENV_URL, action: open });
  return items;
}

export function buildNeeds({ report: m, company: c, Engine, asOf }, today) {
  const items = setupItems(true);
  const week = m.cur.start;
  const leak = (kind) => m.leaks.items.find((x) => x.kind === kind);
  if (isMonday(today) && asOf === today) items.push({ id: 'report:new:' + asOf, kind: 'report', severity: 'medium', title: 'New Owner Report is out', detail: 'The week of ' + fmt(week) + ' in numbers: leaks, techs and 3 things to do.', url: REPORT_URL, linkId: 'report-nova', since: asOf, action: open });
  if (daysBetween(asOf, today) > 8) items.push({ id: 'report:stale', kind: 'report', severity: 'medium', title: "Report data hasn't been refreshed since " + fmt(asOf), detail: 'Everything below is from the week of ' + fmt(week) + '. Rebuild data.js from Jobber to refresh it.', since: asOf, action: ask('How old is the report data?') });

  const unpaid = ((leak('unpaid') || {}).list || []).slice().sort((a, b) => b.amount - a.amount);
  unpaid.slice(0, 8).forEach((x) => items.push({ id: 'unpaid:' + x.id, kind: 'unpaid', severity: x.amount >= 500 ? 'high' : 'medium', title: x.customer + ' owes ' + money(x.amount), detail: x.description + ', ' + x.daysOutstanding + ' days unpaid.', amount: x.amount, since: x.issuedDate, action: ask('What is the story with ' + x.customer + "'s unpaid invoice?") }));
  if (unpaid.length > 8) items.push({ id: 'unpaid:summary', kind: 'unpaid', severity: 'medium', title: (unpaid.length - 8) + ' more invoices unpaid 30+ days', detail: money(unpaid.reduce((s, x) => s + x.amount, 0)) + ' across ' + unpaid.length + ' invoices in all.', since: week, action: ask('List every invoice unpaid 30 days or more.') });

  ((leak('quotes') || {}).list || []).slice(0, 8).forEach((q) => items.push({ id: 'quote:' + q.id, kind: 'quote', severity: 'medium', title: q.customer + "'s quote has waited " + q.ageDays + ' days', detail: q.service + ', ' + money(q.amount) + ', sent ' + fmt(q.sentDate) + (c.quoteTracking === 'viewed' ? (q.viewedDate ? ', opened by the customer.' : ', never opened.') : ', no follow-up yet.'), amount: q.amount, since: q.sentDate, action: ask('What should I do about ' + q.customer + "'s quote?") }));

  m.leaks.items.filter((x) => x.kind === 'tech').forEach((x) => {
    const t = x.flag.tech, p = x.flag.peer;
    items.push({ id: 'tech:' + t.id, kind: 'tech', severity: 'low', title: t.name + ' is below the ' + (t.group ? t.group.toLowerCase() : 'team') + ' average', detail: t.jobs + ' jobs and ' + money(t.revenue) + ' vs an average of ' + Math.round(p.jobs) + ' jobs and ' + money(p.revenue) + '. Gap: ' + money(x.flag.gap) + '.', amount: Math.round(x.flag.gap), since: week, action: ask('How did ' + t.name + ' do last week?') });
  });

  if (m.cur.callbacks >= Engine.CONFIG.highCallbacks) {
    const cb = leak('callbacks');
    items.push({ id: 'callbacks:' + week, kind: 'callbacks', severity: 'medium', title: m.cur.callbacks + ' callbacks in the week of ' + fmt(week), detail: cb ? cb.detail : '', amount: cb ? Math.round(cb.amount) : undefined, since: week, action: ask("What were last week's callbacks?") });
  }

  m.actions.forEach((a, i) => items.push({ id: 'action:' + (i + 1) + ':' + week, kind: 'action', severity: 'low', title: a.title, detail: a.detail + ' ' + a.impact, since: week, action: ask('Help me with this: ' + a.title) }));
  items.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return { asOf, weekOf: week, items };
}
