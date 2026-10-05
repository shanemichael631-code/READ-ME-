#!/usr/bin/env node
/*
 * Independent math check for the Monday Owner Report.
 *   node tools/verify-math.js
 * Recomputes every scorecard number straight from data.js (without report.js helpers)
 * and compares it to what the report engine shows. Exits 1 on any mismatch.
 */
global.window = {};
require("../data.js");
const Engine = require("../report.js");
const data = window.REPORT_DATA;
const asOf = data.meta.asOf;

let fails = 0, passes = 0;
function check(label, a, b, tol = 1e-9) {
  if (Math.abs(a - b) > tol) { fails++; console.log("  FAIL", label, a, "!=", b); } else passes++;
}
const day = (s) => Date.parse(s + "T00:00:00Z");
const plusDays = (s, n) => new Date(day(s) + n * 864e5).toISOString().slice(0, 10);

for (const c of data.companies) {
  console.log("\n" + c.name);
  const m = Engine.buildReport(c, asOf);
  c.weeks.forEach((w, i) => {
    const start = w.weekStart, end = plusDays(start, 6), snap = plusDays(start, 7);
    const techRev = w.techStats.reduce((s, t) => s + t.revenue, 0);
    const techJobs = w.techStats.reduce((s, t) => s + t.jobs, 0);
    check(`${start} tech revenue = company revenue`, techRev, w.revenue);
    check(`${start} tech jobs = company jobs`, techJobs, w.jobsCompleted);
    check(`${start} daily revenue = company revenue`, w.dailyRevenue.reduce((a, b) => a + b, 0), w.revenue);
    const sent = c.quotes.filter((q) => q.sentDate >= start && q.sentDate <= end).length;
    const won = c.quotes.filter((q) => q.status === "won" && q.decidedDate >= start && q.decidedDate <= end).length;
    const mw = m.weeks[i];
    check(`${start} quotes sent`, mw.quotesSent, sent);
    check(`${start} quotes won`, mw.quotesWon, won);
    if (sent) check(`${start} close rate`, mw.closeRate, Math.min(1, won / sent));
    else check(`${start} close rate is null when nothing sent`, mw.closeRate === null ? 1 : 0, 1);
    check(`${start} avg ticket`, mw.avgTicket, w.revenue / w.jobsCompleted);
    const unpaid = c.invoices.filter((x) => x.issuedDate <= end && (!x.paidDate || x.paidDate > end) && (day(snap) - day(x.issuedDate)) / 864e5 >= 30)
      .reduce((s, x) => s + x.amount, 0);
    check(`${start} unpaid 30+`, mw.unpaid30, unpaid);
    const cbs = c.callbacks.filter((x) => x.date >= start && x.date <= end).length;
    check(`${start} callbacks`, mw.callbacks, cbs);
    check(`${start} tech callbacks sum = company callbacks`, mw.techs.reduce((s, t) => s + t.callbacks, 0), cbs);
  });

  // Scorecard % changes and 4-week averages
  m.scorecard.forEach((t) => {
    const series = m.weeks.map((w) => w[t.key]);
    const cur = series[7], prev = series[6];
    const avg4 = (series[3] + series[4] + series[5] + series[6]) / 4;
    check(`scorecard ${t.key} value`, t.value, cur);
    check(`scorecard ${t.key} 4-wk avg`, t.avg4, avg4);
    if (t.def.points) check(`scorecard ${t.key} change (pts)`, t.delta, cur - prev);
    else if (prev) check(`scorecard ${t.key} % change`, t.delta, (cur - prev) / prev);
  });

  // Sales pipeline: every open quote lands in exactly one bucket
  const open = c.quotes.filter((q) => q.status === "open");
  check("pipeline bucket counts = open quotes", m.pipeline.buckets.reduce((s, b) => s + b.count, 0), open.length);
  check("pipeline bucket $ = open quote $", m.pipeline.buckets.reduce((s, b) => s + b.amount, 0), open.reduce((s, q) => s + q.amount, 0));
  check("pipeline open value", m.pipeline.openValue, open.reduce((s, q) => s + q.amount, 0));
  const staleB = m.pipeline.buckets.find((b) => b.key === "stale");
  const staleLeak = m.leaks.items.find((x) => x.kind === "quotes");
  check("pipeline 'no follow-up' = quote leak", staleB.amount, staleLeak ? staleLeak.amount : 0);
  check("funnel quotes sent = scorecard", m.pipeline.sent, m.cur.quotesSent);
  check("funnel quotes won = scorecard", m.pipeline.won, m.cur.quotesWon);

  // Invoice aging: buckets cover every open invoice once; 30+ buckets = Unpaid 30+
  const openInv = c.invoices.filter((x) => x.issuedDate <= m.cur.end && (!x.paidDate || x.paidDate > m.cur.end));
  check("aging counts = open invoices", m.aging.reduce((s, b) => s + b.count, 0), openInv.length);
  check("aging $ = open invoice $", m.aging.reduce((s, b) => s + b.amount, 0), openInv.reduce((s, x) => s + x.amount, 0));
  check("aging 30+ buckets = Unpaid 30+", m.aging.filter((b) => b.key !== "current").reduce((s, b) => s + b.amount, 0), m.cur.unpaid30);

  // Tech history (tech sheet) adds up to company totals every week
  const hist = c.techs.map((t) => Engine.techHistory(m.weeks, t.id));
  m.weeks.forEach((w, i) => {
    check(`${w.start} tech history revenue`, hist.reduce((s, h) => s + h[i].revenue, 0), w.revenue);
    check(`${w.start} tech history jobs`, hist.reduce((s, h) => s + h[i].jobs, 0), w.jobs);
    check(`${w.start} tech history callbacks`, hist.reduce((s, h) => s + h[i].callbacks, 0), w.callbacks);
  });

  // Actions: at most 3, sorted by value. Changes: at most 4, totals add up.
  check("actions <= 3", Math.min(m.actions.length, 3), m.actions.length);
  m.actions.slice(1).forEach((a, i) => check(`action ${i + 2} value <= action ${i + 1}`, Math.min(a.value, m.actions[i].value), a.value));
  check("changes <= 4", Math.min(m.changes.items.length, 4), m.changes.items.length);
  check("changes yearly total", m.changes.yearlyTotal, m.changes.items.reduce((s, x) => s + x.yearly, 0));
  check("changes one-time total", m.changes.oneTimeTotal, m.changes.items.reduce((s, x) => s + x.oneTime, 0));
  const fu = m.changes.items.find((x) => x.key === "followup");
  const cr = m.scorecard.find((t) => t.key === "closeRate");
  if (fu && cr.avg4 - cr.value > 0.03) {
    const weeklySent = m.weeks.slice(-5, -1).reduce((s, w) => s + w.quotesSentValue, 0) / 4;
    check("follow-up yearly = weekly $ sent × drop × 52 × share", fu.yearly, weeklySent * (cr.avg4 - cr.value) * 52 * Engine.CONFIG.recoverShare, 1e-6);
  }
  const col = m.changes.items.find((x) => x.key === "collections");
  if (col) check("collections one-time = unpaid30 × collect rate", col.oneTime, m.cur.unpaid30 * Engine.CONFIG.collectRate, 1e-6);

  // Hero "Upside" = Changes sheet headline = yearly + one-time
  check("upside = yearly + one-time", m.changes.yearlyTotal + m.changes.oneTimeTotal, m.changes.items.reduce((s, x) => s + x.yearly + x.oneTime, 0));
  // Callback action and callback change use the same savings number
  const cbA = m.actions.find((a) => a.kind === "callbacks");
  const cbC = m.changes.items.find((x) => x.key === "callbacks");
  if (cbA && cbC) {
    const nums = (t) => (t.match(/\$[\d,]+/g) || []).slice(0, 1).join();
    check("callback savings match (action vs change): " + nums(cbA.impact) + " vs " + nums(cbC.impactText), nums(cbA.impact) === nums(cbC.impactText) ? 1 : 0, 1);
  }

  // Money leaks total = sum of items
  check("leaks total = sum of items", m.leaks.total, m.leaks.items.reduce((s, x) => s + x.amount, 0));
  const stale = c.quotes.filter((q) => q.status === "open" && !q.lastFollowUpDate && (day(asOf) - day(q.sentDate)) / 864e5 > 5);
  const sq = m.leaks.items.find((x) => x.kind === "quotes");
  if (stale.length) check("stale quote $", sq.amount, stale.reduce((s, q) => s + q.amount, 0));

  const cur = m.cur, prev = m.prev;
  const pctStr = (x) => (x * 100).toFixed(1) + "%";
  console.log(`  Last week: revenue $${cur.revenue.toLocaleString()} (${pctStr((cur.revenue - prev.revenue) / prev.revenue)} vs prior), jobs ${cur.jobs}, avg ticket $${cur.avgTicket.toFixed(2)}`);
  console.log(`  Quotes: ${cur.quotesWon} won / ${cur.quotesSent} sent = ${pctStr(cur.closeRate)}; $${cur.quotesWonValue.toLocaleString()} won of $${cur.quotesSentValue.toLocaleString()} sent`);
  console.log(`  Unpaid 30+: $${cur.unpaid30.toLocaleString()} | Callbacks: ${cur.callbacks} | Reviews: ${cur.newReviews} @ ${cur.avgRating && cur.avgRating.toFixed(2)}`);
  console.log(`  Money at risk: $${m.leaks.total.toLocaleString()} = ` + m.leaks.items.map((x) => `${x.kind} $${x.amount.toLocaleString()}`).join(" + "));
  console.log("  Summary: " + m.summary.join(" "));
  m.actions.forEach((a, i) => console.log(`  ${i + 1}. ${a.title}\n     ${a.detail}\n     ${a.impact}`));
  m.wins.forEach((w) => console.log(`  WIN ${w.title}: ${w.text}`));
  console.log(`  Pipeline: ${m.pipeline.buckets.map((b) => `${b.label} ${b.count} / $${b.amount.toLocaleString()}`).join(" | ")}`);
  console.log(`  Aging: ${m.aging.map((b) => `${b.label} $${b.amount.toLocaleString()}`).join(" | ")}`);
  console.log(`  Changes (~$${Math.round(m.changes.yearlyTotal).toLocaleString()}/yr + $${Math.round(m.changes.oneTimeTotal).toLocaleString()} now):`);
  m.changes.items.forEach((x) => console.log(`   - ${x.title}: ${x.impactText}`));
}
console.log(`\n${passes} checks passed, ${fails} failed.`);
process.exit(fails ? 1 : 0);
