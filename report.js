/*
 * report.js — Monday Owner Report
 *
 * Layers (each one is swappable later):
 *   1. DataSource  — where raw data comes from. Today: window.REPORT_DATA (data.js).
 *                    Later: a Jobber API fetch that returns the same shape.
 *   2. Engine      — pure math. Turns raw data into weekly metrics, leaks, actions, wins.
 *                    No DOM access, so it also runs in Node (tools/verify-math.js).
 *   3. Narrator    — writes "The Short Version". Today: template logic.
 *                    Later: swap summarize() for a Claude API call (server-side).
 *   4. View        — renders HTML strings into the page.
 *
 * Nothing here is hardcoded per company: every number is computed from data.js.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // CONFIG — change the brand name here.
  // ---------------------------------------------------------------------------
  var CONFIG = {
    brandName: "[MY COMPANY NAME]",
    deliveryTime: "7:00 AM",
    // Demo only: slide all dates forward so "last week" is always the most recent Mon–Sun.
    rollDatesToCurrentWeek: true,
    staleQuoteDays: 5, // open quote older than this with no follow-up = leak
    unpaidDays: 30, // invoice unpaid this many days = leak
    techBelowAvg: 0.75, // tech under 75% of team avg jobs or revenue = flag
    highCallbacks: 3, // a tech with this many callbacks in a week gets flagged
    collectRate: 0.6, // assume a focused call push collects 60% of 30+ day AR
  };

  var DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------------------------------------------------------------------------
  // Date + format helpers (dates are "YYYY-MM-DD" strings, treated as UTC days)
  // ---------------------------------------------------------------------------
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  function d(s) { return new Date(s + "T00:00:00Z"); }
  function iso(dt) { return dt.toISOString().slice(0, 10); }
  function addDays(s, n) { return iso(new Date(d(s).getTime() + n * 864e5)); }
  function daysBetween(a, b) { return Math.round((d(b) - d(a)) / 864e5); }
  function inRange(s, start, end) { return !!s && s >= start && s <= end; }
  function shortDate(s) { var x = d(s); return MONTHS[x.getUTCMonth()] + " " + x.getUTCDate(); }
  function slashDate(s) { var x = d(s); return x.getUTCMonth() + 1 + "/" + x.getUTCDate(); }

  function money(n) { return (n < 0 ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString("en-US"); }
  function moneyShort(n) {
    var a = Math.abs(n);
    if (a >= 1000) return (n < 0 ? "-$" : "$") + (a / 1000).toFixed(a >= 100000 ? 0 : 1).replace(/\.0$/, "") + "k";
    return money(n);
  }
  // Estimates get rounded so they don't look falsely precise.
  function approx(n) { return money(Math.round(n / (n >= 1000 ? 100 : 10)) * (n >= 1000 ? 100 : 10)); }
  function pct(x, digits) { return (x * 100).toFixed(digits || 0) + "%"; }
  function sum(arr, fn) { return arr.reduce(function (s, x) { return s + (fn ? fn(x) : x); }, 0); }
  function mean(arr) { return arr.length ? sum(arr) / arr.length : 0; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function firstName(name) { return name.split(" ")[0]; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function listNames(names) {
    if (names.length <= 1) return names.join("");
    if (names.length === 2) return names[0] + " and " + names[1];
    return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
  }

  // ---------------------------------------------------------------------------
  // 1. DataSource
  // ---------------------------------------------------------------------------
  var DataSource = {
    // Future: replace with fetch("/api/jobber/weekly?client=...") returning the same shape.
    load: function () {
      var data = root.REPORT_DATA;
      if (!data) throw new Error("REPORT_DATA missing — is data.js loaded?");
      if (CONFIG.rollDatesToCurrentWeek && data.meta.source === "demo") {
        data = rollDates(data, mostRecentMonday(new Date()));
      }
      return data;
    },
  };

  function mostRecentMonday(now) {
    var t = iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
    var dow = (d(t).getUTCDay() + 6) % 7; // 0 = Monday
    return addDays(t, -dow);
  }

  // Shift every ISO date in the demo data by whole weeks so weekdays stay put.
  function rollDates(data, targetMonday) {
    var delta = daysBetween(data.meta.asOf, targetMonday);
    delta = Math.round(delta / 7) * 7;
    if (delta === 0) return data;
    function walk(v) {
      if (typeof v === "string") return ISO_RE.test(v) ? addDays(v, delta) : v;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        var o = {};
        Object.keys(v).forEach(function (k) { o[k] = walk(v[k]); });
        return o;
      }
      return v;
    }
    return walk(data);
  }

  // ---------------------------------------------------------------------------
  // 2. Engine — all derived numbers
  // ---------------------------------------------------------------------------

  // Metrics for one week (index into company.weeks)
  function weekMetrics(c, i) {
    var w = c.weeks[i];
    var start = w.weekStart;
    var end = addDays(start, 6);
    var snapshot = addDays(start, 7); // Monday morning after the week

    var sent = c.quotes.filter(function (q) { return inRange(q.sentDate, start, end); });
    var won = c.quotes.filter(function (q) { return q.status === "won" && inRange(q.decidedDate, start, end); });

    var openInvoices = c.invoices.filter(function (inv) {
      return inv.issuedDate <= end && (!inv.paidDate || inv.paidDate > end);
    }).map(function (inv) {
      return Object.assign({}, inv, { daysOutstanding: daysBetween(inv.issuedDate, snapshot) });
    });
    var unpaid30 = openInvoices.filter(function (inv) { return inv.daysOutstanding >= CONFIG.unpaidDays; });

    var callbacks = c.callbacks.filter(function (cb) { return inRange(cb.date, start, end); });
    var reviews = c.reviews.filter(function (r) { return inRange(r.date, start, end); });

    var techs = c.techs.map(function (t) {
      var s = w.techStats.filter(function (x) { return x.techId === t.id; })[0] || { jobs: 0, revenue: 0, addOns: 0 };
      var cbs = callbacks.filter(function (cb) { return cb.techId === t.id; });
      return {
        id: t.id, name: t.name, role: t.role,
        jobs: s.jobs, revenue: s.revenue, addOns: s.addOns,
        avgTicket: s.jobs ? s.revenue / s.jobs : 0,
        callbacks: cbs.length,
        callbackList: cbs,
        reviewMentions: reviews.filter(function (r) { return r.techId === t.id; }).length,
      };
    });

    return {
      index: i,
      start: start, end: end, snapshot: snapshot,
      revenue: w.revenue,
      jobs: w.jobsCompleted,
      avgTicket: w.jobsCompleted ? w.revenue / w.jobsCompleted : 0,
      newLeads: w.newLeads,
      quotesSent: sent.length,
      quotesWon: won.length,
      quotesSentValue: sum(sent, function (q) { return q.amount; }),
      quotesWonValue: sum(won, function (q) { return q.amount; }),
      closeRate: sent.length ? won.length / sent.length : 0,
      openInvoices: openInvoices,
      unpaid30List: unpaid30,
      unpaid30: sum(unpaid30, function (x) { return x.amount; }),
      callbacks: callbacks.length,
      callbackList: callbacks,
      newReviews: reviews.length,
      reviewList: reviews,
      avgRating: reviews.length ? mean(reviews.map(function (r) { return r.rating; })) : null,
      dailyRevenue: w.dailyRevenue,
      techs: techs,
    };
  }

  function change(cur, prev) { return prev ? (cur - prev) / prev : null; }

  var SCORECARD = [
    { key: "revenue", label: "Revenue", fmt: money, good: "up" },
    { key: "jobs", label: "Jobs", fmt: String, good: "up" },
    { key: "avgTicket", label: "Avg Ticket", fmt: money, good: "up" },
    { key: "closeRate", label: "Close Rate", fmt: pct, good: "up", points: true },
    { key: "newLeads", label: "New Leads", fmt: String, good: "up" },
    { key: "unpaid30", label: "Unpaid 30+ Days", fmt: money, good: "down" },
    { key: "callbacks", label: "Callbacks", fmt: String, good: "down" },
    { key: "newReviews", label: "New Reviews", fmt: String, good: "up" },
  ];

  function scorecard(weeks) {
    var cur = weeks[weeks.length - 1];
    var prev = weeks[weeks.length - 2];
    var base = weeks.slice(-5, -1); // the 4 weeks before last week
    return SCORECARD.map(function (def) {
      var v = cur[def.key], p = prev[def.key];
      var avg4 = mean(base.map(function (w) { return w[def.key]; }));
      var delta = def.points ? v - p : change(v, p);
      var vsAvg = def.points ? v - avg4 : change(v, avg4);
      return {
        key: def.key, label: def.label, def: def,
        value: v, prev: p, avg4: avg4,
        delta: delta, vsAvg: vsAvg,
        tone: tone(delta, def), avgTone: tone(vsAvg, def),
      };
    });
  }

  function tone(delta, def) {
    if (delta === null || Math.abs(delta) < 0.005) return "flat";
    var up = delta > 0;
    return (def.good === "up") === up ? "good" : "bad";
  }

  function teamAverages(cur) {
    return {
      jobs: mean(cur.techs.map(function (t) { return t.jobs; })),
      revenue: mean(cur.techs.map(function (t) { return t.revenue; })),
      callbacks: mean(cur.techs.map(function (t) { return t.callbacks; })),
    };
  }

  function staleQuotes(c, asOf) {
    return c.quotes.filter(function (q) {
      return q.status === "open" && !q.lastFollowUpDate && daysBetween(q.sentDate, asOf) > CONFIG.staleQuoteDays;
    }).map(function (q) {
      return Object.assign({}, q, { ageDays: daysBetween(q.sentDate, asOf) });
    }).sort(function (a, b) { return b.amount - a.amount; });
  }

  function techFlags(cur, team) {
    return cur.techs.filter(function (t) {
      return t.jobs < team.jobs * CONFIG.techBelowAvg || t.revenue < team.revenue * CONFIG.techBelowAvg;
    }).map(function (t) {
      return { tech: t, gap: Math.max(0, team.revenue - t.revenue) };
    });
  }

  function callbackTech(weeks, team) {
    var cur = weeks[weeks.length - 1];
    var worst = cur.techs.slice().sort(function (a, b) { return b.callbacks - a.callbacks; })[0];
    if (!worst || worst.callbacks < CONFIG.highCallbacks || worst.callbacks < team.callbacks * 2) return null;
    var monthAgo = weeks[weeks.length - 5].techs.filter(function (t) { return t.id === worst.id; })[0];
    return { tech: worst, monthAgo: monthAgo ? monthAgo.callbacks : 0, teamTotal: cur.callbacks };
  }

  function leaks(c, weeks, asOf) {
    var cur = weeks[weeks.length - 1];
    var team = teamAverages(cur);
    var items = [];

    var sq = staleQuotes(c, asOf);
    if (sq.length) {
      items.push({
        kind: "quotes",
        title: "Quotes with no follow-up",
        amount: sum(sq, function (q) { return q.amount; }),
        detail: plural(sq.length, "quote") + " older than " + CONFIG.staleQuoteDays + " days. Nobody has called.",
        rows: sq.slice(0, 3).map(function (q) { return [q.customer, q.service + " · " + q.ageDays + " days", money(q.amount)]; }),
        more: sq.length - 3,
        list: sq,
      });
    }

    var ar = cur.unpaid30List.slice().sort(function (a, b) { return b.daysOutstanding - a.daysOutstanding; });
    if (ar.length) {
      items.push({
        kind: "unpaid",
        title: "Invoices unpaid " + CONFIG.unpaidDays + "+ days",
        amount: cur.unpaid30,
        detail: plural(ar.length, "invoice") + ". Oldest is " + ar[0].daysOutstanding + " days.",
        rows: ar.slice(0, 3).map(function (x) { return [x.customer, x.description + " · " + x.daysOutstanding + " days", money(x.amount)]; }),
        more: ar.length - 3,
        list: ar,
      });
    }

    if (cur.callbacks) {
      var byTech = cur.techs.filter(function (t) { return t.callbacks; })
        .sort(function (a, b) { return b.callbacks - a.callbacks; });
      items.push({
        kind: "callbacks",
        title: "Cost of callbacks",
        amount: cur.callbacks * c.callbackCostEstimate,
        detail: plural(cur.callbacks, "redo visit") + " × ~" + money(c.callbackCostEstimate) + " each (labor, truck, parts). Nobody gets paid for these.",
        rows: byTech.slice(0, 3).map(function (t) { return [t.name, plural(t.callbacks, "callback"), money(t.callbacks * c.callbackCostEstimate)]; }),
        more: byTech.length - 3,
      });
    }

    techFlags(cur, team).forEach(function (f) {
      items.push({
        kind: "tech",
        title: f.tech.name + " is well below team average",
        amount: f.gap,
        detail: f.tech.role + ". Revenue gap vs. the average tech last week.",
        rows: [
          [f.tech.name, f.tech.jobs + " jobs", money(f.tech.revenue)],
          ["Team average", Math.round(team.jobs) + " jobs", money(team.revenue)],
        ],
        more: 0,
        flag: f,
      });
    });

    items.sort(function (a, b) { return b.amount - a.amount; });
    return { total: sum(items, function (x) { return x.amount; }), items: items };
  }

  // "Do these 3 things" — every candidate gets a dollar value; top 3 win.
  function actions(c, weeks, asOf, leakModel) {
    var cur = weeks[weeks.length - 1];
    var base = weeks.slice(-5, -1);
    var team = teamAverages(cur);
    var avgClose = mean(base.map(function (w) { return w.closeRate; }));
    var out = [];

    var q = leakModel.items.filter(function (x) { return x.kind === "quotes"; })[0];
    if (q) {
      var top = q.list.slice(0, 3);
      var others = q.list.length - 1;
      var expected = q.amount * avgClose;
      out.push({
        kind: "quotes",
        value: expected,
        title: "Call " + top[0].customer + (others ? " and " + plural(others, "other") : "") + " about " + money(q.amount) + " in open quotes.",
        detail: "Start with the biggest: " + listNames(top.map(function (x) { return x.customer + " (" + money(x.amount) + ")"; })) + ". All more than " + CONFIG.staleQuoteDays + " days old with no follow-up.",
        impact: "At your normal " + pct(avgClose) + " close rate, that's about " + approx(expected) + " in booked work.",
      });
    }

    var u = leakModel.items.filter(function (x) { return x.kind === "unpaid"; })[0];
    if (u) {
      var oldest = u.list[0];
      var biggest = u.list.slice().sort(function (a, b) { return b.amount - a.amount; })[0];
      var lead = biggest.amount >= oldest.amount * 2 ? biggest : oldest;
      var collect = u.amount * CONFIG.collectRate;
      out.push({
        kind: "unpaid",
        value: collect,
        title: "Call " + lead.customer + " (" + money(lead.amount) + ", " + lead.daysOutstanding + " days)" + (u.list.length > 1 ? " and " + plural(u.list.length - 1, "other") : "") + " about " + money(u.amount) + " unpaid 30+ days.",
        detail: "Oldest first: " + listNames(u.list.slice(0, 3).map(function (x) { return x.customer + " (" + x.daysOutstanding + " days)"; })) + ". Offer card-on-file or a 2-payment split today.",
        impact: "Collecting " + pct(CONFIG.collectRate) + " puts about " + approx(collect) + " back in the bank this week.",
      });
    }

    var cb = callbackTech(weeks, team);
    if (cb) {
      var t = cb.tech;
      var planValue = sum(t.callbackList, function (x) { return x.recurringPlanValue || 0; });
      var counts = {};
      t.callbackList.forEach(function (x) { counts[x.issue] = (counts[x.issue] || 0) + 1; });
      var topIssue = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
      var badReview = cur.reviewList.filter(function (r) { return r.techId === t.id && r.rating <= 3; })[0];
      var busiest = cur.techs.slice().sort(function (a, b) { return b.jobs - a.jobs; })[0];
      var monthlySave = (t.callbacks / 2) * c.callbackCostEstimate * 4.33;
      out.push({
        kind: "callbacks",
        value: planValue + monthlySave,
        title: "Ride along with " + t.name + " for half a day. " + t.callbacks + " of the team's " + cb.teamTotal + " callbacks were " + firstName(t.name) + "'s.",
        detail: "Up from " + cb.monthAgo + " a month ago. Most common: “" + topIssue.toLowerCase() + ".”" + (badReview ? " One customer left a " + badReview.rating + "-star review about it." : "") +
          (busiest.id === t.id ? " " + firstName(t.name) + " also ran the most stops (" + t.jobs + "), so speed may be the issue." : ""),
        impact: "Cutting those in half saves about " + approx(monthlySave) + "/month" + (planValue ? " and protects " + approx(planValue) + "/yr in recurring plans." : "."),
      });
    }

    leakModel.items.filter(function (x) { return x.kind === "tech"; }).forEach(function (l) {
      var t = l.flag.tech;
      var mentor = cur.techs.slice().sort(function (a, b) { return b.revenue - a.revenue; })[0];
      out.push({
        kind: "tech",
        value: l.amount / 2,
        title: "Pair " + t.name + " with " + mentor.name + " on 2 calls this week.",
        detail: firstName(t.name) + " did " + t.jobs + " jobs (" + money(t.revenue) + ") vs. a team average of " + Math.round(team.jobs) + " (" + money(team.revenue) + ").",
        impact: "Closing half the gap is worth about " + approx(l.amount / 2) + "/week.",
      });
    });

    // Add-on coaching: best add-on seller vs. everyone else
    var rate = function (x) { return x.jobs ? x.addOns / x.jobs : 0; };
    var best = cur.techs.slice().sort(function (a, b) { return rate(b) - rate(a); })[0];
    var rest = cur.techs.filter(function (x) { return x.id !== best.id; });
    var restJobs = sum(rest, function (x) { return x.jobs; });
    var restRate = restJobs ? sum(rest, function (x) { return x.addOns; }) / restJobs : 0;
    if (rate(best) > restRate) {
      var gain = (rate(best) - restRate) / 2 * restJobs * c.avgAddOnValue;
      out.push({
        kind: "addons",
        value: gain,
        title: "Have " + best.name + " show the team how " + firstName(best.name) + " offers add-ons at Friday's meeting.",
        detail: pct(rate(best)) + " of " + firstName(best.name) + "'s jobs had an add-on vs. " + pct(restRate) + " for everyone else.",
        impact: "If the team gets halfway there, that's about " + approx(gain) + "/week in extra tickets.",
      });
    }

    out.sort(function (a, b) { return b.value - a.value; });
    return out.slice(0, 3);
  }

  function wins(c, weeks) {
    var cur = weeks[weeks.length - 1];
    var out = [];
    var topTech = cur.techs.slice().sort(function (a, b) { return b.revenue - a.revenue; })[0];
    out.push({
      icon: "🏆",
      title: topTech.name + " led the team",
      text: money(topTech.revenue) + " on " + topTech.jobs + " jobs" + (topTech.addOns ? ", plus " + plural(topTech.addOns, "add-on") : "") + ".",
    });

    var best = cur.reviewList.filter(function (r) { return r.rating === 5; })
      .sort(function (a, b) { return b.text.length - a.text.length; })[0];
    if (best) {
      var tech = c.techs.filter(function (t) { return t.id === best.techId; })[0];
      out.push({
        icon: "⭐",
        title: "5-star review" + (tech ? " for " + firstName(tech.name) : ""),
        text: "“" + best.text + "” — " + best.customer,
      });
    }

    var maxRev = Math.max.apply(null, weeks.map(function (w) { return w.revenue; }));
    if (cur.revenue === maxRev) {
      out.push({ icon: "📈", title: "Best week in " + weeks.length + " weeks", text: money(cur.revenue) + " on " + cur.jobs + " jobs, " + pct(change(cur.revenue, mean(weeks.slice(-5, -1).map(function (w) { return w.revenue; })))) + " above your 4-week average."});
    } else {
      var di = cur.dailyRevenue.indexOf(Math.max.apply(null, cur.dailyRevenue));
      out.push({ icon: "📈", title: DAY_NAMES[di] + " was the best day", text: money(cur.dailyRevenue[di]) + " billed in a single day." });
    }
    return out;
  }

  // Integrity checks — the numbers have to add up before we show them.
  function reconcile(c) {
    var problems = [];
    var checks = 0;
    c.weeks.forEach(function (w) {
      var tr = sum(w.techStats, function (t) { return t.revenue; });
      var tj = sum(w.techStats, function (t) { return t.jobs; });
      var dr = sum(w.dailyRevenue);
      checks += 3;
      if (tr !== w.revenue) problems.push(w.weekStart + ": tech revenue " + tr + " ≠ company " + w.revenue);
      if (tj !== w.jobsCompleted) problems.push(w.weekStart + ": tech jobs " + tj + " ≠ company " + w.jobsCompleted);
      if (dr !== w.revenue) problems.push(w.weekStart + ": daily revenue " + dr + " ≠ company " + w.revenue);
    });
    return { checks: checks, problems: problems, ok: problems.length === 0 };
  }

  function buildReport(c, asOf) {
    var weeks = c.weeks.map(function (_, i) { return weekMetrics(c, i); });
    var cur = weeks[weeks.length - 1];
    var leakModel = leaks(c, weeks, asOf);
    var model = {
      company: c,
      asOf: asOf,
      weeks: weeks,
      cur: cur,
      prev: weeks[weeks.length - 2],
      team: teamAverages(cur),
      scorecard: scorecard(weeks),
      leaks: leakModel,
      actions: actions(c, weeks, asOf, leakModel),
      wins: wins(c, weeks),
      integrity: reconcile(c),
    };
    model.summary = Narrator.summarize(model);
    return model;
  }

  // ---------------------------------------------------------------------------
  // 3. Narrator — "The Short Version"
  //    Future: POST the model (numbers only) to a server route that calls the
  //    Claude API and returns 3–4 sentences. Keep this template as the fallback.
  // ---------------------------------------------------------------------------
  var Narrator = {
    summarize: function (m) {
      var s = [];
      var cur = m.cur, prev = m.prev;
      var revChg = change(cur.revenue, prev.revenue);
      var avg4 = m.scorecard[0].avg4;
      var isRecord = cur.revenue === Math.max.apply(null, m.weeks.map(function (w) { return w.revenue; }));

      var vsAvg = change(cur.revenue, avg4);
      var open = "Last week you billed " + money(cur.revenue) + " on " + cur.jobs + " jobs";
      if (isRecord) open += ", your best week in " + m.weeks.length + " weeks";
      if (isRecord && vsAvg > 0.05) open += ", " + pct(vsAvg) + " above your 4-week average.";
      else if (Math.abs(revChg) < 0.02) open += ", about even with the week before.";
      else if (!isRecord && Math.abs(vsAvg) < 0.04) open += ", right in line with your 4-week average.";
      else open += ", " + (revChg > 0 ? "up " : "down ") + pct(Math.abs(revChg)) + " from the week before.";
      s.push(open);

      var lead = m.actions[0] ? m.actions[0].kind : null;
      var leakOf = function (k) { return m.leaks.items.filter(function (x) { return x.kind === k; })[0]; };
      var cr = m.scorecard.filter(function (x) { return x.key === "closeRate"; })[0];

      if (lead === "quotes") {
        var q = leakOf("quotes");
        s.push("The leak is follow-up: " + plural(q.list.length, "quote") + " worth " + money(q.amount) + " are sitting with no call back.");
        if (cr.vsAvg < -0.03) s.push("That's why your close rate slid to " + pct(cr.value) + " from a " + pct(cr.avg4) + " average: we're quoting work and walking away from it.");
      } else if (lead === "unpaid") {
        var u = leakOf("unpaid");
        var oldest = u.list[0];
        var unp = m.scorecard.filter(function (x) { return x.key === "unpaid30"; })[0];
        s.push("The problem is collections: " + money(u.amount) + " is sitting in invoices more than " + CONFIG.unpaidDays + " days old" + (unp.prev ? ", up from " + money(unp.prev) + " a week ago" : "") + ".");
        s.push("We're doing the work, then floating the bill: " + oldest.customer + " is at " + oldest.daysOutstanding + " days.");
      } else if (lead === "callbacks") {
        var cb = callbackTech(m.weeks, m.team);
        s.push("The one thing to watch is " + cb.tech.name + ": " + cb.tech.callbacks + " of the team's " + cb.teamTotal + " callbacks came from " + firstName(cb.tech.name) + "'s jobs, up from " + cb.monthAgo + " a month ago.");
        s.push("Callbacks cost us twice: a free truck roll now and a cancelled plan later.");
      } else if (lead === "tech") {
        var t = leakOf("tech").flag.tech;
        s.push(t.name + " is running well behind the team, with " + t.jobs + " jobs against an average of " + Math.round(m.team.jobs) + ".");
      } else {
        s.push("No big leaks this week.");
      }

      if (s.length < 3) {
        var leads = m.scorecard.filter(function (x) { return x.key === "newLeads"; })[0];
        if (leads.vsAvg > 0.05) s.push("Leads are up " + pct(leads.vsAvg) + " over your 4-week average, so the phone is working.");
        else if (cur.avgRating) s.push(plural(cur.newReviews, "new review") + " averaging " + cur.avgRating.toFixed(1) + " stars. Customers are happy with the work.");
      }
      if (s.length < 4) s.push("Start with #1 below today.");
      return s.slice(0, 4);
    },
  };

  var Engine = {
    CONFIG: CONFIG, buildReport: buildReport, weekMetrics: weekMetrics, reconcile: reconcile,
    rollDates: rollDates, mostRecentMonday: mostRecentMonday, addDays: addDays, daysBetween: daysBetween,
  };

  // ---------------------------------------------------------------------------
  // 4. View
  // ---------------------------------------------------------------------------
  function arrow(delta) {
    if (delta === null || Math.abs(delta) < 0.005) return '<span class="arr" aria-hidden="true">&ndash;</span>';
    return '<span class="arr" aria-hidden="true">' + (delta > 0 ? "&#9650;" : "&#9660;") + "</span>";
  }
  function fmtDelta(t) {
    if (t.delta === null) return "new";
    if (t.def.points) return (t.delta >= 0 ? "+" : "−") + Math.abs(Math.round(t.delta * 100)) + (Math.abs(Math.round(t.delta * 100)) === 1 ? " pt" : " pts");
    return pct(Math.abs(t.delta));
  }
  function fmtVsAvg(t) {
    var avgStr = t.def.points ? pct(t.avg4) : t.def.fmt === money ? moneyShort(t.avg4) : (Math.round(t.avg4 * 10) / 10).toString();
    if (t.vsAvg === null) return "4-wk avg " + avgStr;
    if (Math.abs(t.vsAvg) < 0.005) return "Even with 4-wk avg " + avgStr;
    var amt = t.def.points ? Math.abs(Math.round(t.vsAvg * 100)) + (Math.abs(Math.round(t.vsAvg * 100)) === 1 ? " pt" : " pts") : pct(Math.abs(t.vsAvg));
    return amt + (t.vsAvg > 0 ? " above" : " below") + " 4-wk avg (" + avgStr + ")";
  }

  function renderHeader(m) {
    return (
      '<header class="report-head">' +
      '<div class="eyebrow">Monday Owner Report <span class="badge">DEMO</span></div>' +
      "<h1>" + esc(m.company.name) + "</h1>" +
      '<p class="range">Last week: Mon ' + shortDate(m.cur.start) + " – Sun " + shortDate(m.cur.end) + ", " + d(m.cur.end).getUTCFullYear() + "</p>" +
      '<p class="delivered"><span class="dot" aria-hidden="true"></span>Delivered Monday, ' + shortDate(m.asOf) + " · " + CONFIG.deliveryTime + "</p>" +
      "</header>"
    );
  }

  function section(id, title, inner, extraClass) {
    return '<section class="card ' + (extraClass || "") + '" id="' + id + '" aria-labelledby="' + id + '-h"><h2 id="' + id + '-h">' + title + "</h2>" + inner + "</section>";
  }

  function renderSummary(m) {
    return section("summary", "The Short Version", '<p class="summary">' + m.summary.map(esc).join(" ") + "</p>", "card-summary");
  }

  function renderScorecard(m) {
    var tiles = m.scorecard.map(function (t) {
      var sub = t.key === "newReviews" && m.cur.avgRating ? '<span class="tile-sub">★ ' + m.cur.avgRating.toFixed(1) + " avg</span>" : "";
      return (
        '<div class="tile">' +
        '<div class="tile-label">' + t.label + "</div>" +
        '<div class="tile-value">' + t.def.fmt(t.value) + sub + "</div>" +
        '<div class="tile-delta tone-' + t.tone + '">' + arrow(t.delta) + fmtDelta(t) + ' <span class="muted">vs last wk</span></div>' +
        '<div class="tile-avg tone-' + t.avgTone + '">' + fmtVsAvg(t) + "</div>" +
        "</div>"
      );
    }).join("");
    return section("scorecard", "Scorecard", '<div class="tiles">' + tiles + "</div>");
  }

  function renderLeaks(m) {
    var L = m.leaks;
    if (!L.items.length) return section("leaks", "Money Leaks", '<p class="empty">No leaks flagged this week. Nice.</p>');
    var items = L.items.map(function (x) {
      var rows = x.rows.map(function (r) {
        return '<li><span class="who">' + esc(r[0]) + '</span><span class="what">' + esc(r[1]) + '</span><span class="amt">' + esc(r[2]) + "</span></li>";
      }).join("");
      return (
        '<div class="leak">' +
        '<div class="leak-top"><h3>' + esc(x.title) + '</h3><span class="leak-amt">' + money(x.amount) + "</span></div>" +
        '<p class="leak-detail">' + esc(x.detail) + "</p>" +
        '<ul class="leak-rows">' + rows + "</ul>" +
        (x.more > 0 ? '<p class="more">+ ' + x.more + " more</p>" : "") +
        "</div>"
      );
    }).join("");
    return section(
      "leaks", "Money Leaks",
      '<div class="leak-total"><span class="big">' + money(L.total) + '</span><span class="label">at risk right now across ' + plural(L.items.length, "item") + "</span></div>" + items
    );
  }

  function renderChart(m) {
    var W = 340, H = 190, padL = 6, padR = 6, padT = 26, padB = 26;
    var weeks = m.weeks;
    var max = Math.max.apply(null, weeks.map(function (w) { return w.revenue; }));
    var top = Math.ceil(max / 10000) * 10000;
    var avg = mean(weeks.map(function (w) { return w.revenue; }));
    var plotH = H - padT - padB;
    var slot = (W - padL - padR) / weeks.length;
    var barW = Math.min(30, slot - 10);
    var y = function (v) { return padT + plotH - (v / top) * plotH; };
    var bars = weeks.map(function (w, i) {
      var x = padL + slot * i + (slot - barW) / 2;
      var h = Math.max(2, (w.revenue / top) * plotH);
      var yy = padT + plotH - h;
      var last = i === weeks.length - 1;
      var r = Math.min(4, barW / 2);
      // bar with rounded top corners only
      var path = "M" + x + "," + (yy + h) + "V" + (yy + r) + "Q" + x + "," + yy + " " + (x + r) + "," + yy + "H" + (x + barW - r) + "Q" + (x + barW) + "," + yy + " " + (x + barW) + "," + (yy + r) + "V" + (yy + h) + "Z";
      var label = "Week of " + shortDate(w.start) + ": " + money(w.revenue) + " · " + w.jobs + " jobs";
      return (
        '<g class="bar' + (last ? " bar-last" : "") + '" data-i="' + i + '" data-label="' + esc(label) + '" tabindex="0" role="img" aria-label="' + esc(label) + '">' +
        '<rect class="hit" x="' + (padL + slot * i) + '" y="' + padT + '" width="' + slot + '" height="' + plotH + '"></rect>' +
        '<path d="' + path + '"></path>' +
        (last ? '<text class="val" x="' + (x + barW / 2) + '" y="' + (yy - 7) + '" text-anchor="middle">' + moneyShort(w.revenue) + "</text>" : "") +
        '<text class="xl" x="' + (x + barW / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + slashDate(w.start) + "</text>" +
        "</g>"
      );
    }).join("");
    var ya = y(avg);
    var svg =
      '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="group" aria-label="Weekly revenue, last 8 weeks">' +
      '<line class="base" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (padT + plotH) + '" y2="' + (padT + plotH) + '"></line>' +
      bars +
      '<line class="avg" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ya + '" y2="' + ya + '"></line>' +
      '<text class="avg-l" x="' + padL + '" y="' + (ya - 5) + '">8-wk avg ' + moneyShort(avg) + "</text>" +
      "</svg>";
    var first = weeks[0].revenue, last = m.cur.revenue;
    var trend = change(last, first);
    var caption = '<p class="chart-cap" aria-live="polite">' + esc("Week of " + shortDate(m.cur.start) + ": " + money(m.cur.revenue) + " · " + m.cur.jobs + " jobs") + "</p>";
    var note = '<p class="chart-note">' + (Math.abs(trend) < 0.03 ? "Flat over 8 weeks (" + (trend >= 0 ? "+" : "−") + pct(Math.abs(trend)) + ")." : (trend > 0 ? "Up " : "Down ") + pct(Math.abs(trend)) + " since " + shortDate(weeks[0].start) + ".") + ' <span class="muted">Tap a bar for details.</span></p>';
    return section("trend", "Revenue Trend", caption + svg + note);
  }

  function renderLeaderboard(m) {
    var techs = m.cur.techs.slice().sort(function (a, b) { return b.revenue - a.revenue; });
    var maxRev = techs[0].revenue || 1;
    var cbAvg = m.team.callbacks;
    var rows = techs.map(function (t, i) {
      var flagged = t.callbacks >= CONFIG.highCallbacks && t.callbacks >= cbAvg * 2;
      return (
        '<div class="lb-row' + (flagged ? " lb-flag" : "") + '" role="row">' +
        '<span class="lb-rank" role="cell">' + (i + 1) + "</span>" +
        '<span class="lb-name" role="cell"><b>' + esc(t.name) + "</b>" + (flagged ? ' <span class="pill">Check in</span>' : "") + '<span class="lb-role">' + esc(t.role) + "</span>" +
        '<span class="lb-bar" aria-hidden="true"><i style="width:' + Math.round((t.revenue / maxRev) * 100) + '%"></i></span></span>' +
        '<span class="lb-num lb-rev" role="cell" data-l="Revenue">' + money(t.revenue) + "</span>" +
        '<span class="lb-num" role="cell" data-l="Jobs">' + t.jobs + "</span>" +
        '<span class="lb-num" role="cell" data-l="Avg">' + money(t.avgTicket) + "</span>" +
        '<span class="lb-num" role="cell" data-l="Add-ons">' + t.addOns + "</span>" +
        '<span class="lb-num' + (flagged ? " cb-hi" : "") + '" role="cell" data-l="Callbacks">' + t.callbacks + "</span>" +
        "</div>"
      );
    }).join("");
    var head =
      '<div class="lb-row lb-head" role="row"><span role="columnheader">#</span><span role="columnheader">Tech</span><span class="lb-num" role="columnheader">Revenue</span><span class="lb-num" role="columnheader">Jobs</span><span class="lb-num" role="columnheader">Avg</span><span class="lb-num" role="columnheader">Add-ons</span><span class="lb-num" role="columnheader">Callbacks</span></div>';
    var flaggedNote = techs.some(function (t) { return t.callbacks >= CONFIG.highCallbacks && t.callbacks >= cbAvg * 2; })
      ? '<p class="note">"Check in" = callbacks at 2× the team average or more. Worth a conversation, not a write-up.</p>' : "";
    return section("leaderboard", "Tech Leaderboard", '<div class="lb" role="table" aria-label="Tech leaderboard, last week">' + head + rows + "</div>" + flaggedNote);
  }

  function renderActions(m) {
    var items = m.actions.map(function (a, i) {
      return '<li class="action"><span class="num">' + (i + 1) + '</span><div><p class="a-title">' + esc(a.title) + '</p><p class="a-detail">' + esc(a.detail) + '</p><p class="a-impact">' + esc(a.impact) + "</p></div></li>";
    }).join("");
    return section("actions", "Do These 3 Things This Week", '<ol class="actions">' + items + "</ol>", "card-actions");
  }

  function renderWins(m) {
    var items = m.wins.map(function (w) {
      return '<li class="win"><span class="win-ico" aria-hidden="true">' + w.icon + '</span><div><p class="w-title">' + esc(w.title) + '</p><p class="w-text">' + esc(w.text) + "</p></div></li>";
    }).join("");
    return section("wins", "Wins", '<ul class="wins">' + items + "</ul>");
  }

  function renderFooter(m) {
    var ok = m.integrity.ok;
    return (
      '<footer class="report-foot">' +
      "<p>Pulled automatically from your field-service software. No data entry.</p>" +
      '<p class="brand">Built by <span data-brand>' + esc(CONFIG.brandName) + "</span></p>" +
      '<p class="fine">' + (ok ? "All totals reconciled: tech and daily numbers match company totals for all " + m.weeks.length + " weeks." : "Data check failed: " + esc(m.integrity.problems.join("; "))) +
      " Demo data. All names and numbers are fictional.</p>" +
      "</footer>"
    );
  }

  function render(m) {
    return (
      renderHeader(m) +
      renderSummary(m) +
      renderScorecard(m) +
      renderLeaks(m) +
      renderChart(m) +
      renderLeaderboard(m) +
      renderActions(m) +
      renderWins(m) +
      renderFooter(m)
    );
  }

  function wireChart(el) {
    var cap = el.querySelector(".chart-cap");
    var bars = el.querySelectorAll(".bar");
    function select(g) {
      bars.forEach(function (b) { b.classList.toggle("bar-sel", b === g); });
      if (cap) cap.textContent = g.getAttribute("data-label");
    }
    bars.forEach(function (g) {
      g.addEventListener("pointerenter", function () { select(g); });
      g.addEventListener("click", function () { select(g); });
      g.addEventListener("focus", function () { select(g); });
    });
  }

  function start() {
    var data = DataSource.load();
    var picker = document.getElementById("company");
    var out = document.getElementById("report");
    var params = new URLSearchParams(location.search);
    var hash = location.hash.replace("#", "") || params.get("co");

    picker.innerHTML = data.companies.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + " · " + plural(c.techs.length, "tech") + "</option>";
    }).join("");
    if (hash && data.companies.some(function (c) { return c.id === hash; })) picker.value = hash;

    function show(id) {
      var c = data.companies.filter(function (x) { return x.id === id; })[0] || data.companies[0];
      var model = buildReport(c, data.meta.asOf);
      if (!model.integrity.ok && root.console) console.warn("Data integrity problems", model.integrity.problems);
      out.innerHTML = render(model);
      wireChart(out);
      document.title = "Monday Owner Report · " + c.name;
      if (history.replaceState) history.replaceState(null, "", "#" + c.id);
    }
    picker.addEventListener("change", function () {
      show(picker.value);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    var printBtn = document.getElementById("print");
    if (printBtn) printBtn.addEventListener("click", function () { window.print(); });
    show(picker.value);
  }

  if (typeof module !== "undefined" && module.exports) module.exports = Engine;
  root.MondayReport = Engine;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis);
