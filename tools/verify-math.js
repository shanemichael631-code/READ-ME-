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
    check(`${start} close rate`, mw.closeRate, won / sent);
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
}
console.log(`\n${passes} checks passed, ${fails} failed.`);
process.exit(fails ? 1 : 0);
