/*
 * report.js — Monday Owner Report
 *
 * Layers (each one is swappable later):
 *   1. DataSource  — where raw data comes from. Today: window.REPORT_DATA (data.js).
 *                    Later: a Jobber API fetch that returns the same shape.
 *   2. Engine      — pure math. Turns raw data into weekly metrics, leaks, actions,
 *                    wins and recommended changes. No DOM access, so it also runs
 *                    in Node (tools/verify-math.js).
 *   3. Narrator    — writes "The Short Version". Today: template logic.
 *                    Later: swap summarize() for a Claude API call (server-side).
 *   4. View        — renders HTML strings, the detail sheet, and wires up taps.
 *
 * Nothing here is hardcoded per company: every number is computed from data.js.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // CONFIG — brand and thresholds live here.
  // ---------------------------------------------------------------------------
  var CONFIG = {
    brand: {
      name: "Vanbrief", // fictional product name for the demo
      tagline: "Your business, briefed before the first van rolls.",
    },
    deliveryTime: "7:00 AM",
    // Demo only: slide all dates forward so "last week" is always the most recent Mon–Sun.
    rollDatesToCurrentWeek: true,
    staleQuoteDays: 5, // open quote older than this with no follow-up = leak
    unpaidDays: 30, // invoice unpaid this many days = leak
    techBelowAvg: 0.75, // tech under 75% of team avg jobs or revenue = flag
    highCallbacks: 3, // a tech with this many callbacks in a week gets flagged
    collectRate: 0.6, // assume a focused call push collects 60% of 30+ day AR
    recoverShare: 0.33, // "Changes" section: assume you win back a third of a close-rate drop
    checklistCut: 0.3, // "Changes" section: a job checklist prevents ~30% of callbacks
  };

  var DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  var DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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
  function weekday(s) { return DAY_SHORT[(d(s).getUTCDay() + 6) % 7]; }

  function money(n) { return (n < 0 ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString("en-US"); }
  function moneyShort(n) {
    var a = Math.abs(n);
    if (a >= 1000) return (n < 0 ? "-$" : "$") + (a / 1000).toFixed(a >= 100000 ? 0 : 1).replace(/\.0$/, "") + "k";
    return money(n);
  }
  // Estimates get rounded so they don't look falsely precise.
  function approx(n) {
    var step = n >= 10000 ? 1000 : n >= 1000 ? 100 : 10;
    return money(Math.round(n / step) * step);
  }
  function pct(x, digits) { return (x * 100).toFixed(digits || 0) + "%"; }
  function rate(v) { return v === null || v === undefined ? "–" : pct(v); }
  function pts(x) { var n = Math.abs(Math.round(x * 100)); return n + (n === 1 ? " pt" : " pts"); }
  function sum(arr, fn) { return arr.reduce(function (s, x) { return s + (fn ? fn(x) : x); }, 0); }
  function mean(arr) { return arr.length ? sum(arr) / arr.length : 0; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function firstName(name) { return name.split(" ")[0]; }
  function initials(name) {
    return name.replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
  }
  // "Demo Plumbing Co." -> "PL", "Demo Air HVAC" -> "AH", "Demo Pest Control" -> "PC"
  function monogram(name) {
    var words = name.replace(/^Demo\s+/i, "").replace(/\s+(Co\.?|Inc\.?|LLC)$/i, "").split(/\s+/).filter(Boolean);
    return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
  }
  function openAttr(route) { return ' data-open="' + esc(route) + '"'; }
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
  function byDesc(fn) { return function (a, b) { return fn(b) - fn(a); }; }
  function find(arr, fn) { for (var i = 0; i < arr.length; i++) if (fn(arr[i])) return arr[i]; return null; }

  // Per-company switches. Demo companies use the defaults; a live account can turn off data it
  // doesn't have (e.g. Google reviews), rename things ("Installs" instead of add-ons), or tune copy.
  function feat(c, name) { return !c.features || c.features[name] !== false; }
  function termOf(c, key, fallback) { return (c.labels && c.labels[key]) || fallback; }
  function fill(tpl, vars) { return tpl.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] !== undefined ? vars[k] : "{" + k + "}"; }); }
  function viewedMode(c) { return c.quoteTracking === "viewed"; } // quotes carry "opened by customer", not "followed up"
  function fieldTechs(list) { return list.filter(function (t) { return t.field !== false; }); }
  function val(o, k) { return o[k] === undefined ? null : o[k]; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

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
    var reviews = (c.reviews || []).filter(function (r) { return inRange(r.date, start, end); });

    var techs = c.techs.map(function (t) {
      var s = find(w.techStats, function (x) { return x.techId === t.id; }) || { jobs: 0, revenue: 0, addOns: 0 };
      var cbs = callbacks.filter(function (cb) { return cb.techId === t.id; });
      return {
        id: t.id, name: t.name, role: t.role, field: t.field !== false, group: t.group || null,
        jobs: s.jobs, revenue: s.revenue, addOns: s.addOns,
        avgTicket: s.jobs ? s.revenue / s.jobs : 0,
        addOnRate: s.jobs ? s.addOns / s.jobs : 0,
        callbacks: cbs.length,
        callbackList: cbs,
        reviewMentions: reviews.filter(function (r) { return r.techId === t.id; }).length,
      };
    });

    var out = {
      index: i,
      start: start, end: end, snapshot: snapshot,
      revenue: w.revenue,
      jobs: w.jobsCompleted,
      avgTicket: w.jobsCompleted ? w.revenue / w.jobsCompleted : 0,
      newLeads: val(w, "newLeads"),
      quotesSent: sent.length,
      quotesWon: won.length,
      quotesSentList: sent,
      quotesWonList: won,
      quotesSentValue: sum(sent, function (q) { return q.amount; }),
      quotesWonValue: sum(won, function (q) { return q.amount; }),
      // won this week ÷ sent this week; null when nothing was sent, capped at 100%
      closeRate: sent.length ? Math.min(1, won.length / sent.length) : null,
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
      breakdown: w.breakdown || {},
    };
    // Company-specific weekly counts (e.g. jobs booked, systems sold) ride along as-is.
    Object.keys(w.metrics || {}).forEach(function (k) { out[k] = w.metrics[k]; });
    return out;
  }

  function change(cur, prev) { return prev ? (cur - prev) / prev : null; }

  var SCORECARD = [
    { key: "revenue", label: "Revenue", fmt: money, good: "up" },
    { key: "jobs", label: "Jobs", fmt: String, good: "up" },
    { key: "avgTicket", label: "Avg Ticket", fmt: money, good: "up" },
    { key: "closeRate", label: "Close Rate", fmt: rate, good: "up", points: true },
    { key: "newLeads", label: "New Leads", fmt: String, good: "up" },
    { key: "unpaid30", label: "Unpaid 30+ Days", fmt: money, good: "down" },
    { key: "callbacks", label: "Callbacks", fmt: String, good: "down" },
    { key: "newReviews", label: "New Reviews", fmt: String, good: "up" },
  ];

  // Tiles a company can pick instead of a default (company.scorecard lists the 8 keys in order).
  var EXTRA_TILES = [
    { key: "booked", label: "Jobs Booked", fmt: String, good: "up" },
    { key: "systems", label: "Systems Sold", fmt: String, good: "up" },
    { key: "leakCalls", label: "Leak Calls", fmt: String, good: "down" },
  ];

  function tileDefs(c) {
    if (!c || !c.scorecard) return SCORECARD;
    var all = SCORECARD.concat(EXTRA_TILES);
    return c.scorecard.map(function (k) {
      var def = find(all, function (x) { return x.key === k; });
      if (!def) throw new Error("Unknown scorecard tile: " + k);
      return Object.assign({}, def, { label: termOf(c, "tile_" + k, def.label) });
    });
  }

  function scorecard(weeks, c) {
    var cur = weeks[weeks.length - 1];
    var prev = weeks[weeks.length - 2];
    var base = weeks.slice(-5, -1); // the 4 weeks before last week
    return tileDefs(c).map(function (def) {
      var v = val(cur, def.key), p = val(prev, def.key);
      var known = base.map(function (w) { return val(w, def.key); }).filter(function (x) { return x !== null; });
      var avg4 = known.length ? mean(known) : null;
      var delta = v === null || p === null ? null : def.points ? v - p : p === 0 && v === 0 ? 0 : change(v, p);
      var vsAvg = v === null || avg4 === null ? null : def.points ? v - avg4 : change(v, avg4);
      return {
        key: def.key, label: def.label, def: def,
        value: v, prev: p, avg4: avg4,
        delta: delta, vsAvg: vsAvg,
        tone: tone(delta, def), avgTone: tone(vsAvg, def),
        series: weeks.map(function (w) { return val(w, def.key) === null ? 0 : w[def.key]; }),
      };
    });
  }

  function tone(delta, def) {
    if (delta === null || Math.abs(delta) < 0.005) return "flat";
    var up = delta > 0;
    return (def.good === "up") === up ? "good" : "bad";
  }

  // Field techs who worked last week (office / counter rows never count toward averages).
  function activeTechs(cur, group) {
    var pool = fieldTechs(cur.techs).filter(function (t) { return !group || t.group === group; });
    var a = pool.filter(function (t) { return t.jobs > 0; });
    return a.length ? a : pool;
  }

  function teamAverages(cur) {
    var a = activeTechs(cur);
    var team = {
      n: a.length,
      jobs: mean(a.map(function (t) { return t.jobs; })),
      revenue: mean(a.map(function (t) { return t.revenue; })),
      callbacks: mean(a.map(function (t) { return t.callbacks; })),
      avgTicket: cur.avgTicket,
      addOnRate: cur.jobs ? sum(cur.techs, function (t) { return t.addOns; }) / cur.jobs : 0,
      groups: {},
    };
    // Techs who do different work (installers vs. service techs) are compared within their group.
    fieldTechs(cur.techs).forEach(function (t) {
      if (!t.group || team.groups[t.group]) return;
      var g = activeTechs(cur, t.group);
      var gJobs = sum(g, function (x) { return x.jobs; });
      team.groups[t.group] = {
        name: t.group, n: g.length,
        jobs: mean(g.map(function (x) { return x.jobs; })),
        revenue: mean(g.map(function (x) { return x.revenue; })),
        callbacks: mean(g.map(function (x) { return x.callbacks; })),
        avgTicket: gJobs ? sum(g, function (x) { return x.revenue; }) / gJobs : 0,
      };
    });
    return team;
  }

  // The average a tech is fairly compared with: their group's, or the whole team's. null = no peers.
  function peerAvg(team, t) {
    if (!t.group) return team;
    var g = team.groups[t.group];
    return g && g.n >= 2 ? g : null;
  }
  function peerLabel(t) { return t.group ? t.group.toLowerCase() + " average" : "team average"; }

  function openQuotes(c, asOf) {
    return c.quotes.filter(function (q) { return q.status === "open"; }).map(function (q) {
      return Object.assign({}, q, { ageDays: daysBetween(q.sentDate, asOf) });
    });
  }

  // Quotes that need a call. With "viewed" tracking there's no follow-up log, so every quote
  // past the cutoff without a decision counts.
  function staleQuotes(c, asOf) {
    return openQuotes(c, asOf).filter(function (q) {
      return (viewedMode(c) || !q.lastFollowUpDate) && q.ageDays > CONFIG.staleQuoteDays;
    }).sort(byDesc(function (q) { return q.amount; }));
  }
  function neverOpened(list) {
    var n = list.filter(function (q) { return !q.viewedDate; }).length;
    return n === list.length ? (n === 1 ? "The customer hasn't opened it" : "None have been opened") : n ? n + " never opened" : "All have been opened";
  }

  // Sales pipeline: every open quote lands in exactly one bucket.
  function pipeline(c, asOf, cur) {
    var open = openQuotes(c, asOf);
    var defs = viewedMode(c) ? [
      { key: "new", label: "New", hint: "Sent in the last " + CONFIG.staleQuoteDays + " days", tone: "neutral",
        test: function (q) { return q.ageDays <= CONFIG.staleQuoteDays; } },
      { key: "working", label: "Opened, no answer", hint: "Older; the customer opened it but hasn't decided", tone: "neutral",
        test: function (q) { return q.ageDays > CONFIG.staleQuoteDays && !!q.viewedDate; } },
      { key: "stale", label: "Never opened", hint: "Older than " + CONFIG.staleQuoteDays + " days and never opened", tone: "bad",
        test: function (q) { return q.ageDays > CONFIG.staleQuoteDays && !q.viewedDate; } },
    ] : [
      { key: "new", label: "New", hint: "Sent in the last " + CONFIG.staleQuoteDays + " days", tone: "neutral",
        test: function (q) { return q.ageDays <= CONFIG.staleQuoteDays; } },
      { key: "working", label: "Followed up", hint: "Older, but someone has called", tone: "good",
        test: function (q) { return q.ageDays > CONFIG.staleQuoteDays && !!q.lastFollowUpDate; } },
      { key: "stale", label: "No follow-up", hint: "Older than " + CONFIG.staleQuoteDays + " days, nobody has called", tone: "bad",
        test: function (q) { return q.ageDays > CONFIG.staleQuoteDays && !q.lastFollowUpDate; } },
    ];
    var buckets = defs.map(function (b) {
      var list = open.filter(b.test).sort(byDesc(function (q) { return q.amount; }));
      return { key: b.key, label: b.label, hint: b.hint, tone: b.tone, list: list, count: list.length, amount: sum(list, function (q) { return q.amount; }) };
    });
    return {
      leads: cur.newLeads,
      sent: cur.quotesSent,
      won: cur.quotesWon,
      sentValue: cur.quotesSentValue,
      wonValue: cur.quotesWonValue,
      openCount: open.length,
      openValue: sum(open, function (q) { return q.amount; }),
      buckets: buckets,
    };
  }

  // Invoice aging as of the report date. Buckets cover every open invoice exactly once.
  function aging(cur) {
    var defs = [
      { key: "current", label: "Under 30 days", min: 0, max: CONFIG.unpaidDays - 1 },
      { key: "30", label: "30–44 days", min: CONFIG.unpaidDays, max: 44 },
      { key: "45", label: "45–59 days", min: 45, max: 59 },
      { key: "60", label: "60+ days", min: 60, max: Infinity },
    ];
    return defs.map(function (b) {
      var list = cur.openInvoices.filter(function (x) { return x.daysOutstanding >= b.min && x.daysOutstanding <= b.max; })
        .sort(byDesc(function (x) { return x.daysOutstanding; }));
      return { key: b.key, label: b.label, list: list, count: list.length, amount: sum(list, function (x) { return x.amount; }) };
    });
  }

  function techFlags(cur, team) {
    return fieldTechs(cur.techs).filter(function (t) {
      if (!t.jobs) return false; // out all week — not a performance problem
      var p = peerAvg(team, t);
      if (!p) return false; // nobody doing the same kind of work to compare with
      return t.jobs < p.jobs * CONFIG.techBelowAvg || t.revenue < p.revenue * CONFIG.techBelowAvg;
    }).map(function (t) {
      var p = peerAvg(team, t);
      return { tech: t, peer: p, gap: Math.max(0, p.revenue - t.revenue) };
    });
  }

  function isCallbackFlag(t, team) {
    return t.callbacks >= CONFIG.highCallbacks && t.callbacks >= team.callbacks * 2;
  }

  function callbackTech(weeks, team) {
    var cur = weeks[weeks.length - 1];
    var worst = fieldTechs(cur.techs).sort(byDesc(function (t) { return t.callbacks; }))[0];
    if (!worst || !isCallbackFlag(worst, team)) return null;
    var monthAgo = find(weeks[weeks.length - 5].techs, function (t) { return t.id === worst.id; });
    return { tech: worst, monthAgo: monthAgo ? monthAgo.callbacks : 0, teamTotal: cur.callbacks };
  }

  // Halving a tech's recent callback rate, per year (trailing 4 weeks incl. last week).
  function techCallbackSavings(c, weeks, techId) {
    var recent = weeks.slice(-4).map(function (w) { return find(w.techs, function (t) { return t.id === techId; }).callbacks; });
    return mean(recent) * c.callbackCostEstimate * 52 * 0.5;
  }

  function topIssue(list) {
    var counts = {};
    list.forEach(function (x) { counts[x.issue] = (counts[x.issue] || 0) + 1; });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || "";
  }

  // Per-tech history across all weeks (used by the tech detail sheet).
  function techHistory(weeks, techId) {
    return weeks.map(function (w) {
      var t = find(w.techs, function (x) { return x.id === techId; });
      return { start: w.start, revenue: t.revenue, jobs: t.jobs, addOns: t.addOns, callbacks: t.callbacks, avgTicket: t.avgTicket };
    });
  }

  function leaks(c, weeks, asOf) {
    var cur = weeks[weeks.length - 1];
    var team = teamAverages(cur);
    var items = [];

    var sq = staleQuotes(c, asOf);
    if (sq.length) {
      items.push({
        kind: "quotes",
        title: viewedMode(c) ? "Quotes waiting on an answer" : "Quotes with no follow-up",
        amount: sum(sq, function (q) { return q.amount; }),
        detail: viewedMode(c)
          ? plural(sq.length, "quote") + " older than " + CONFIG.staleQuoteDays + " days with no decision. " + neverOpened(sq) + "."
          : plural(sq.length, "quote") + " older than " + CONFIG.staleQuoteDays + " days. Nobody has called.",
        rows: sq.slice(0, 3).map(function (q) { return [q.customer, q.service + " · " + q.ageDays + " days", money(q.amount)]; }),
        more: sq.length - 3,
        list: sq,
      });
    }

    var ar = cur.unpaid30List.slice().sort(byDesc(function (x) { return x.daysOutstanding; }));
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
      var byTech = fieldTechs(cur.techs).filter(function (t) { return t.callbacks; }).sort(byDesc(function (t) { return t.callbacks; }));
      items.push({
        kind: "callbacks",
        title: "Callback cost last week",
        amount: cur.callbacks * c.callbackCostEstimate,
        detail: c.labels && c.labels.callbackLeakDetail
          ? fill(c.labels.callbackLeakDetail, { n: plural(cur.callbacks, termOf(c, "callback", "callback")), cost: money(c.callbackCostEstimate) })
          : plural(cur.callbacks, "redo visit") + " × ~" + money(c.callbackCostEstimate) + " each (labor, truck, parts). Nobody gets paid for these.",
        rows: byTech.slice(0, 3).map(function (t) { return [t.name, plural(t.callbacks, "callback"), money(t.callbacks * c.callbackCostEstimate)]; }),
        more: byTech.length > 3 ? cur.callbackList.length - 3 : 0,
        list: cur.callbackList,
      });
    }

    techFlags(cur, team).forEach(function (f) {
      items.push({
        kind: "tech",
        title: f.tech.name + " is well below " + (f.tech.group ? "the " : "") + peerLabel(f.tech),
        amount: f.gap,
        detail: f.tech.role + ". Revenue gap vs. the average " + (f.tech.group ? f.tech.group.toLowerCase() : "tech") + " last week.",
        rows: [
          [f.tech.name, f.tech.jobs + " jobs", money(f.tech.revenue)],
          [cap(peerLabel(f.tech)), Math.round(f.peer.jobs) + " jobs", money(f.peer.revenue)],
        ],
        more: 0,
        flag: f,
      });
    });

    items.sort(byDesc(function (x) { return x.amount; }));
    return { total: sum(items, function (x) { return x.amount; }), items: items };
  }

  // Add-on coaching numbers: best add-on seller vs. everyone else (weekly $).
  function addOnGap(c, cur) {
    var best = fieldTechs(cur.techs).sort(byDesc(function (t) { return t.addOnRate; }))[0];
    var rest = fieldTechs(cur.techs).filter(function (x) { return x.id !== best.id; });
    var restJobs = sum(rest, function (x) { return x.jobs; });
    var restRate = restJobs ? sum(rest, function (x) { return x.addOns; }) / restJobs : 0;
    var weekly = best.addOnRate > restRate ? (best.addOnRate - restRate) / 2 * restJobs * c.avgAddOnValue : 0;
    return { best: best, restRate: restRate, weekly: weekly };
  }

  // "Do these 3 things" — every candidate gets a dollar value; top 3 win.
  function actions(c, weeks, asOf, leakModel) {
    var cur = weeks[weeks.length - 1];
    var base = weeks.slice(-5, -1);
    var team = teamAverages(cur);
    var avgClose = mean(base.map(function (w) { return w.closeRate; }).filter(function (v) { return v !== null; }));
    var out = [];

    var q = find(leakModel.items, function (x) { return x.kind === "quotes"; });
    if (q) {
      var top = q.list.slice(0, 3);
      var others = q.list.length - 1;
      var expected = q.amount * avgClose;
      out.push({
        kind: "quotes",
        value: expected,
        title: "Call " + top[0].customer + (others ? " and " + plural(others, "other") : "") + " about " + money(q.amount) + " in open quotes.",
        detail: "Start with the biggest: " + listNames(top.map(function (x) { return x.customer + " (" + money(x.amount) + ")"; })) + ". All more than " + CONFIG.staleQuoteDays + " days old " + (viewedMode(c) ? "with no decision yet." : "with no follow-up."),
        impact: "At your normal " + pct(avgClose) + " close rate, that's about " + approx(expected) + " in booked work.",
        open: "leak:quotes",
      });
    }

    var u = find(leakModel.items, function (x) { return x.kind === "unpaid"; });
    if (u) {
      var oldest = u.list[0];
      var biggest = u.list.slice().sort(byDesc(function (x) { return x.amount; }))[0];
      var lead = biggest.amount >= oldest.amount * 2 ? biggest : oldest;
      var collect = u.amount * CONFIG.collectRate;
      out.push({
        kind: "unpaid",
        value: collect,
        title: "Call " + lead.customer + " (" + money(lead.amount) + ", " + lead.daysOutstanding + " days)" + (u.list.length > 1 ? " and " + plural(u.list.length - 1, "other") : "") + " about " + money(u.amount) + " unpaid 30+ days.",
        detail: (lead === oldest ? "Oldest first: " : "After " + firstName(lead.customer) + ", go oldest first: ") +
          listNames((lead === oldest ? u.list : u.list.filter(function (x) { return x !== lead; })).slice(0, 3).map(function (x) { return x.customer + " (" + x.daysOutstanding + " days)"; })) +
          ". Offer card-on-file or a 2-payment split today.",
        impact: "Collecting " + pct(CONFIG.collectRate) + " puts about " + approx(collect) + " back in the bank this week.",
        open: "leak:unpaid",
      });
    }

    var cb = callbackTech(weeks, team);
    if (cb) {
      var t = cb.tech;
      var planValue = sum(t.callbackList, function (x) { return x.recurringPlanValue || 0; });
      var badReview = find(cur.reviewList, function (r) { return r.techId === t.id && r.rating <= 3; });
      var busiest = fieldTechs(cur.techs).sort(byDesc(function (x) { return x.jobs; }))[0];
      var yearlySave = techCallbackSavings(c, weeks, t.id);
      out.push({
        kind: "callbacks",
        value: planValue + yearlySave / 12,
        title: "Ride along with " + t.name + " for half a day. " + (t.callbacks === cb.teamTotal ? "All " + t.callbacks : t.callbacks + " of the team's " + cb.teamTotal) + " callbacks were " + firstName(t.name) + "'s.",
        detail: "Up from " + cb.monthAgo + " a month ago. Most common: “" + topIssue(t.callbackList).toLowerCase() + ".”" + (badReview ? " One customer left a " + badReview.rating + "-star review about it." : "") +
          (busiest.id === t.id ? " " + firstName(t.name) + " also ran the most stops (" + t.jobs + "), so speed may be the issue." : ""),
        impact: "Cutting those in half saves about " + approx(yearlySave) + "/yr" + (planValue ? " and protects " + approx(planValue) + "/yr in recurring plans." : "."),
        open: "tech:" + t.id,
      });
    }

    leakModel.items.filter(function (x) { return x.kind === "tech"; }).forEach(function (l) {
      var t = l.flag.tech, peer = l.flag.peer;
      var mentor = fieldTechs(cur.techs).filter(function (x) { return x.group === t.group; }).sort(byDesc(function (x) { return x.revenue; }))[0];
      out.push({
        kind: "tech",
        value: l.amount / 2,
        title: "Pair " + t.name + " with " + mentor.name + " on 2 calls this week.",
        detail: firstName(t.name) + " did " + t.jobs + " jobs (" + money(t.revenue) + ") vs. a " + peerLabel(t) + " of " + Math.round(peer.jobs) + " (" + money(peer.revenue) + ").",
        impact: "Closing half the gap is worth about " + approx(l.amount / 2) + "/week.",
        open: "tech:" + t.id,
      });
    });

    var ag = feat(c, "addOnCoaching") ? addOnGap(c, cur) : null;
    if (ag && realAddOnGap(ag)) {
      out.push({
        kind: "addons",
        value: ag.weekly,
        title: "Have " + ag.best.name + " show the team how " + firstName(ag.best.name) + " offers add-ons at Friday's meeting.",
        detail: pct(ag.best.addOnRate) + " of " + firstName(ag.best.name) + "'s jobs had an add-on vs. " + pct(ag.restRate) + " for everyone else.",
        impact: "If the team gets halfway there, that's about " + approx(ag.weekly) + "/week in extra tickets.",
        open: "tech:" + ag.best.id,
      });
    }

    // Fallback: walk through last week's callbacks when no single tech stands out.
    if (!cb && cur.callbacks >= 2) {
      out.push({
        kind: "callback-review",
        value: cur.callbacks * c.callbackCostEstimate,
        title: "Go over last week's " + cur.callbacks + " callbacks at the Monday huddle.",
        detail: listNames(cur.callbackList.slice(0, 5).map(function (x) { return techNameIn(c, x.techId) + ": " + x.issue.toLowerCase(); })
          .concat(cur.callbackList.length > 5 ? [plural(cur.callbackList.length - 5, "more", "more")] : [])) + ". Five minutes, no blame: what would have prevented each one?",
        impact: "At about " + money(c.callbackCostEstimate) + " per " + termOf(c, "redoVisit", "redo visit") + ", last week's callbacks cost " + money(cur.callbacks * c.callbackCostEstimate) + ".",
        open: "metric:callbacks",
      });
    }

    out.sort(byDesc(function (a) { return a.value; }));
    return out.slice(0, 3);
  }

  function techNameIn(c, id) { var t = find(c.techs, function (x) { return x.id === id; }); return t ? t.name : id; }

  function realAddOnGap(ag) {
    return ag.weekly > 0 && ag.best.jobs >= 15 && ag.best.addOnRate - ag.restRate >= 0.05;
  }

  function wins(c, weeks) {
    var cur = weeks[weeks.length - 1];
    var out = [];
    var topTech = fieldTechs(cur.techs).sort(byDesc(function (t) { return t.revenue; }))[0];
    out.push({
      icon: "🏆",
      title: topTech.name + " led the team",
      text: money(topTech.revenue) + " on " + topTech.jobs + " jobs" + (topTech.addOns ? ", plus " + plural(topTech.addOns, termOf(c, "addOn", "add-on")) : "") + ".",
      open: "tech:" + topTech.id,
    });

    var best = cur.reviewList.filter(function (r) { return r.rating === 5; })
      .sort(byDesc(function (r) { return r.text.length; }))[0];
    if (best) {
      var tech = find(c.techs, function (t) { return t.id === best.techId; });
      out.push({
        icon: "⭐",
        title: "5-star review" + (tech ? " for " + firstName(tech.name) : ""),
        text: "“" + best.text + "” — " + best.customer,
        open: "metric:newReviews",
      });
    }

    var maxRev = Math.max.apply(null, weeks.map(function (w) { return w.revenue; }));
    if (cur.revenue === maxRev) {
      out.push({
        icon: "📈",
        title: "Best week in " + weeks.length + " weeks",
        text: money(cur.revenue) + " on " + cur.jobs + " jobs, " + pct(change(cur.revenue, mean(weeks.slice(-5, -1).map(function (w) { return w.revenue; })))) + " above your 4-week average.",
        open: "week:" + cur.index,
      });
    } else {
      var di = cur.dailyRevenue.indexOf(Math.max.apply(null, cur.dailyRevenue));
      out.push({ icon: "📈", title: DAY_NAMES[di] + " was the best day", text: money(cur.dailyRevenue[di]) + " billed in a single day.", open: "week:" + cur.index });
    }
    return out;
  }

  // "Changes worth making" — bigger, permanent fixes ranked by yearly value.
  // Each change only appears when the data shows the problem.
  function changes(c, model) {
    var weeks = model.weeks, cur = model.cur, team = model.team;
    var last4 = weeks.slice(-5, -1); // same 4-week baseline the scorecard uses
    var cr = find(model.scorecard, function (x) { return x.key === "closeRate"; });
    var stale = find(model.leaks.items, function (x) { return x.kind === "quotes"; });
    var out = [];

    // 1. Quote follow-up on autopilot
    var drop = !cr || cr.value === null || cr.avg4 === null ? 0 : cr.avg4 - cr.value;
    if (drop > 0.03 || stale) {
      var weeklySent = mean(last4.map(function (w) { return w.quotesSentValue; }));
      var yearly = drop > 0.03 ? weeklySent * drop * 52 * CONFIG.recoverShare : 0;
      var oneTime = stale ? stale.amount * (cr && cr.avg4 || 0) : 0;
      out.push({
        key: "followup",
        title: "Put quote follow-up on autopilot",
        evidence: drop > 0.03
          ? "Close rate slid from a " + pct(cr.avg4) + " average to " + pct(cr.value) + " while you were quoting about " + approx(weeklySent) + " a week. " + (stale ? plural(stale.list.length, "quote") + " (" + money(stale.amount) + ") " + (viewedMode(c) ? "are still waiting on a decision." : "have had no follow-up at all.") : "")
          : plural(stale.list.length, "quote") + " (" + money(stale.amount) + ") are more than " + CONFIG.staleQuoteDays + " days old with no " + (viewedMode(c) ? "decision yet." : "follow-up."),
        steps: [
          "Turn on automatic quote follow-ups in your field-service software: a text on day 2 and again on day 10.",
          "Make one person own the list. They call every open quote on day 5, biggest first.",
          "On day 14, mark each quote won or lost and note why. Fix the top lost reason each month.",
        ],
        effort: "Low",
        setup: "1 hour",
        yearly: yearly,
        oneTime: oneTime,
        impactText: yearly
          ? "Winning back a third of the drop is worth about " + approx(yearly) + "/yr."
          : "Working today's list is worth about " + approx(oneTime) + " in booked jobs.",
        open: "metric:closeRate",
      });
    }

    // 2. Collections: deposits + card on file + reminders
    if (cur.unpaid30 > 0) {
      var big = cur.unpaid30List.filter(function (x) { return x.amount >= 2000; });
      var pm = find(cur.unpaid30List, function (x) { return /property/i.test(x.description); });
      var over60 = cur.unpaid30List.filter(function (x) { return x.daysOutstanding >= 60; });
      var bigAmt = sum(big, function (x) { return x.amount; });
      var prev = model.prev.unpaid30;
      out.push({
        key: "collections",
        title: big.length ? "Take deposits and card-on-file on big jobs" : "Automate invoice reminders",
        evidence: money(cur.unpaid30) + " is " + CONFIG.unpaidDays + "+ days late" + (prev ? " (" + (cur.unpaid30 >= prev ? "up" : "down") + " from " + money(prev) + " a week ago)" : "") + "." +
          (big.length ? " " + plural(big.length, "invoice") + " over $2,000 make up " + money(bigAmt) + " of it." : ""),
        steps: (big.length ? [
          "Put a 30–50% deposit on every install quote, and don't schedule the job until it clears.",
          "Save a card on file at booking. The lead tech takes the balance at the final walkthrough.",
        ] : [
          "Turn on automatic invoice reminders with a pay-by-text link.",
          "Offer card-on-file at booking so payment happens the day the job is done.",
        ]).concat([
          pm ? "Get the property manager's AP contact and a work-order number before any job starts (" + pm.customer + " owes " + money(pm.amount) + ")."
            : "Every Monday, call the customer on every invoice 15+ days late and text a pay link.",
        ]).concat(over60.length ? [
          "For the " + plural(over60.length, "invoice") + " past 60 days, send a written demand now. Florida's lien deadline is 90 days after the last day of work, so talk to your attorney before then.",
        ] : []),
        source: over60.length ? { label: "Fla. Stat. 713.08 (claim of lien, 90-day deadline)", url: "https://www.flsenate.gov/Laws/Statutes/2024/713.08" } : null,
        effort: "Low",
        setup: "1–2 hours",
        yearly: 0,
        oneTime: cur.unpaid30 * CONFIG.collectRate,
        impactText: "Frees up about " + approx(cur.unpaid30 * CONFIG.collectRate) + " in cash now, and keeps the next big balance from going 30+ days.",
        open: "metric:unpaid30",
      });
    }

    // 3. Callbacks: coaching (if one tech stands out) or a job checklist
    var weeklyCb = mean(last4.map(function (w) { return w.callbacks; })); // = the Callbacks tile's 4-wk avg
    var yearlyCbCost = weeklyCb * c.callbackCostEstimate * 52;
    var cbt = callbackTech(weeks, team);
    if (cbt || weeklyCb >= 2) {
      var plans = cbt ? sum(cbt.tech.callbackList, function (x) { return x.recurringPlanValue || 0; }) : 0;
      var save = cbt ? techCallbackSavings(c, weeks, cbt.tech.id) : yearlyCbCost * CONFIG.checklistCut;
      out.push({
        key: "callbacks",
        title: cbt ? "Coach " + cbt.tech.name + " and cap daily stops" : termOf(c, "checklistTitle", "Add a 2-minute closeout checklist to every job"),
        evidence: cbt
          ? firstName(cbt.tech.name) + " had " + (cbt.tech.callbacks === cbt.teamTotal ? "all " + cbt.tech.callbacks : cbt.tech.callbacks + " of " + cbt.teamTotal) + " callbacks last week (up from " + cbt.monthAgo + " a month ago) while running " + cbt.tech.jobs + " stops vs. a team average of " + Math.round(team.jobs) + "."
          : "You averaged " + weeklyCb.toFixed(1) + " callbacks a week over the 4 weeks before last, about " + approx(yearlyCbCost) + "/yr in unpaid " + termOf(c, "redoVisit", "redo visit") + "s.",
        steps: (cbt ? (c.playbook && c.playbook.coachSteps) || [
          "Visit the callback homes and log the real cause: missed area, wrong ID, or product.",
          "Ride the route for a full day against a written service checklist.",
          "Cap {first}'s daily stops at the team average and move the overflow to the lightest route.",
          "Call every callback customer personally within 24 hours.",
        ] : (c.playbook && c.playbook.checklistSteps) || [
          "Add a required photo + checklist step before a job can be closed out.",
          "Tag every redo visit as a callback so the report can track it by tech.",
          "Review the week's callbacks at the Monday huddle, 5 minutes, no blame.",
        ]).map(function (x) { return fill(x, { first: cbt ? firstName(cbt.tech.name) : "" }); }),
        effort: cbt ? "Medium" : "Low",
        setup: cbt ? "Half a day" : "1 hour",
        yearly: save,
        oneTime: 0,
        impactText: (cbt ? "Halving " + firstName(cbt.tech.name) + "'s callbacks saves about " : "Saves about ") + approx(save) + "/yr in " + termOf(c, "redoVisit", "redo visit") + "s" + (plans ? " and protects " + approx(plans) + "/yr in recurring plans." : "."),
        open: cbt ? "tech:" + cbt.tech.id : "metric:callbacks",
      });
    }

    // 4. New-tech ramp plan
    techFlags(cur, team).filter(function () { return feat(c, "rampPlans"); }).forEach(function (f) {
      var mentor = fieldTechs(cur.techs).filter(function (x) { return x.group === f.tech.group; }).sort(byDesc(function (x) { return x.revenue; }))[0];
      var yr = f.gap * 0.2 * 52; // close a fifth of the gap, sustained for a year
      out.push({
        key: "ramp",
        title: "Give " + f.tech.name + " a 90-day ramp plan",
        evidence: firstName(f.tech.name) + " (" + f.tech.role.replace(/\s*\(.*\)/, "").toLowerCase() + ") did " + money(f.tech.revenue) + " last week vs. a " + peerLabel(f.tech) + " of " + money(f.peer.revenue) + ".",
        steps: [
          "Weeks 1–4: " + firstName(f.tech.name) + " rides with " + mentor.name + " and leads every other call.",
          "Weeks 5–8: solo on simple calls; " + firstName(mentor.name) + " reviews the tickets daily.",
          "Set targets: 55% of team average by day 30, 70% by 60, 85% by 90. Tie raises to hitting them.",
        ],
        effort: "Medium",
        setup: "90 days",
        yearly: yr,
        oneTime: 0,
        impactText: "Closing a fifth of the gap is worth about " + approx(yr) + "/yr.",
        open: "tech:" + f.tech.id,
      });
    });

    // 5. Add-on menu (only when the gap is real: 5+ points)
    var ag = feat(c, "addOnCoaching") ? addOnGap(c, cur) : null;
    if (ag && realAddOnGap(ag)) {
      var yrA = ag.weekly * 52;
      out.push({
        key: "addons",
        title: "Give every tech the same add-on menu",
        evidence: firstName(ag.best.name) + " adds something to " + pct(ag.best.addOnRate) + " of jobs; the rest of the team averages " + pct(ag.restRate) + ".",
        steps: [
          "Build good / better / best options for your 5 most common call types.",
          "Techs show all three options before starting work. " + firstName(ag.best.name) + " runs a 10-minute role-play at the next meeting.",
          "Post each tech's add-on rate here every week and pay a small bonus per add-on.",
        ],
        effort: "Low",
        setup: "1 meeting",
        yearly: yrA,
        oneTime: 0,
        impactText: "If the team gets halfway to " + firstName(ag.best.name) + "'s rate, that's about " + approx(yrA) + "/yr.",
        open: "tech:" + ag.best.id,
      });
    }

    // 6. Reviews (no dollar value, only if the list is short)
    var weeklyReviews = mean(last4.map(function (w) { return w.newReviews; }));
    if (feat(c, "reviews")) out.push({
      key: "reviews",
      title: "Ask every happy customer for a Google review",
      evidence: "You averaged " + weeklyReviews.toFixed(1) + " new Google reviews a week on about " + Math.round(mean(last4.map(function (w) { return w.jobs; }))) + " jobs over the 4 weeks before last.",
      steps: [
        "Copy your Google review link and QR code from your Business Profile.",
        "Techs mention it at the door; the office texts the link within 2 hours, with one reminder on day 3.",
        "Reply to every review within 48 hours, and call any 1–3 star reviewer the same day.",
      ],
      effort: "Low",
      setup: "30 minutes",
      yearly: 0,
      oneTime: 0,
      impactText: "More recent 5-star reviews mean more calls from Google, at no ad cost.",
      open: "metric:newReviews",
    });

    // The change that fixes this week's #1 problem goes first; the rest by dollar value.
    var KIND_TO_CHANGE = { quotes: "followup", unpaid: "collections", callbacks: "callbacks", "callback-review": "callbacks", tech: "ramp", addons: "addons" };
    var lead = model.actions[0] ? KIND_TO_CHANGE[model.actions[0].kind] : null;
    out.sort(function (a, b) {
      if ((a.key === lead) !== (b.key === lead)) return a.key === lead ? -1 : 1;
      return (b.yearly + b.oneTime) - (a.yearly + a.oneTime);
    });
    var picked = out.slice(0, 4);
    return {
      items: picked,
      yearlyTotal: sum(picked, function (x) { return x.yearly; }),
      oneTimeTotal: sum(picked, function (x) { return x.oneTime; }),
    };
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

  function buildReport(c, asOf, opts) {
    var weeks = c.weeks.map(function (_, i) { return weekMetrics(c, i); });
    var cur = weeks[weeks.length - 1];
    var leakModel = leaks(c, weeks, asOf);
    var model = {
      company: c,
      asOf: asOf,
      live: !!(opts && opts.live),
      weeks: weeks,
      cur: cur,
      prev: weeks[weeks.length - 2],
      team: teamAverages(cur),
      scorecard: scorecard(weeks, c),
      leaks: leakModel,
      pipeline: pipeline(c, asOf, cur),
      aging: aging(cur),
      actions: actions(c, weeks, asOf, leakModel),
      wins: wins(c, weeks),
      integrity: reconcile(c),
    };
    model.changes = changes(c, model);
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
      var open = m.company.revenueBasis === "completed"
        ? "Last week your team finished " + money(cur.revenue) + " of work on " + cur.jobs + " jobs"
        : "Last week you billed " + money(cur.revenue) + " on " + cur.jobs + " jobs";
      if (isRecord) open += ", your best week in " + m.weeks.length + " weeks";
      if (isRecord && vsAvg > 0.05) open += ", " + pct(vsAvg) + " above your 4-week average.";
      else if (Math.abs(revChg) < 0.02) open += ", about even with the week before.";
      else {
        open += ", " + (revChg > 0 ? "up " : "down ") + pct(Math.abs(revChg)) + " from the week before";
        open += Math.abs(vsAvg) >= 0.02 ? " and " + pct(Math.abs(vsAvg)) + (vsAvg > 0 ? " over" : " under") + " your 4-week average." : ".";
      }
      s.push(open);

      var lead = m.actions[0] ? m.actions[0].kind : null;
      var leakOf = function (k) { return find(m.leaks.items, function (x) { return x.kind === k; }); };
      var cr = find(m.scorecard, function (x) { return x.key === "closeRate"; });

      if (lead === "quotes") {
        var q = leakOf("quotes");
        if (viewedMode(m.company)) {
          var unopened = q.list.filter(function (x) { return !x.viewedDate; }).length;
          s.push("The leak is open quotes: " + plural(q.list.length, "quote") + " worth " + money(q.amount) + (q.list.length === 1 ? " is" : " are") + " more than " + CONFIG.staleQuoteDays + " days old with no decision" +
            (unopened ? ", and " + (unopened === q.list.length ? (unopened === 1 ? "the customer hasn't opened it" : "none have been opened") : unopened + " were never opened") : "") + ".");
          if (cr && cr.vsAvg !== null && cr.vsAvg < -0.03) s.push("Close rate slid to " + pct(cr.value) + " from a " + pct(cr.avg4) + " average while those sit.");
        } else {
          s.push("The leak is follow-up: " + plural(q.list.length, "quote") + " worth " + money(q.amount) + (q.list.length === 1 ? " is" : " are") + " sitting with no follow-up call.");
          if (cr && cr.vsAvg !== null && cr.vsAvg < -0.03) s.push("That's likely part of why your close rate slid to " + pct(cr.value) + " from a " + pct(cr.avg4) + " average: quotes go out, but nobody chases them.");
        }
      } else if (lead === "unpaid") {
        var u = leakOf("unpaid");
        var oldest = u.list[0];
        var unp = find(m.scorecard, function (x) { return x.key === "unpaid30"; });
        s.push("The problem is collections: " + money(u.amount) + " is sitting in invoices more than " + CONFIG.unpaidDays + " days old" + (unp && unp.prev ? ", up from " + money(unp.prev) + " a week ago" : "") + ".");
        s.push("You're doing the work, then waiting on the money: " + oldest.customer + " is at " + oldest.daysOutstanding + " days.");
      } else if (lead === "callbacks") {
        var cb = callbackTech(m.weeks, m.team);
        s.push("The one thing to watch is " + cb.tech.name + ": " + (cb.tech.callbacks === cb.teamTotal ? "all " + cb.tech.callbacks : cb.tech.callbacks + " of the team's " + cb.teamTotal) + " callbacks came from " + firstName(cb.tech.name) + "'s jobs, up from " + cb.monthAgo + " a month ago.");
        s.push("Callbacks cost twice: a free truck roll now and a cancelled plan later.");
      } else if (lead === "tech") {
        var lf = leakOf("tech").flag, t = lf.tech;
        s.push(t.name + " is running well behind " + (t.group ? "the other " + t.group.toLowerCase() + "s" : "the team") + ", with " + t.jobs + " jobs against an average of " + Math.round(lf.peer.jobs) + ".");
      } else if (m.leaks.items.length) {
        var top = m.leaks.items[0];
        s.push("The biggest item to look at: " + top.title + " (" + money(top.amount) + ").");
      } else {
        s.push("No big leaks this week.");
      }

      if (s.length < 3) {
        var leads = find(m.scorecard, function (x) { return x.key === "newLeads"; });
        if (leads && leads.vsAvg !== null && leads.vsAvg > 0.05) s.push("Leads are up " + pct(leads.vsAvg) + " over your 4-week average, so the phone is working.");
        else if (cur.avgRating) s.push(plural(cur.newReviews, "new review") + " averaging " + cur.avgRating.toFixed(1) + " stars. Customers are happy with the work.");
      }
      if (s.length < 4 && m.actions.length) s.push("Start with #1 below today.");
      return s.slice(0, 4);
    },
  };

  var Engine = {
    CONFIG: CONFIG, buildReport: buildReport, weekMetrics: weekMetrics, reconcile: reconcile,
    rollDates: rollDates, mostRecentMonday: mostRecentMonday, addDays: addDays, daysBetween: daysBetween,
    techHistory: techHistory,
  };

  // ---------------------------------------------------------------------------
  // 4. View
  // ---------------------------------------------------------------------------

  // Line icons (24×24, stroke = currentColor).
  var ICONS = {
    scorecard: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    leak: '<path d="M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>',
    trend: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3.5-4 3 2.5L19 8"/>',
    sales: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
    team: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5"/>',
    actions: '<path d="M5 12.5l4 4L19 7"/>',
    wins: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8.5 20h7"/>',
    changes: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/>',
    bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  };
  function icon(name, cls) {
    return '<svg class="ico ' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
  }

  // Product logo mark: a check mark that doubles as a "V", with a rising sun. Swap to rebrand.
  function logo(size) {
    var s = size || 28;
    return '<svg class="logo" width="' + s + '" height="' + s + '" viewBox="0 0 32 32" aria-hidden="true">' +
      '<rect width="32" height="32" rx="8.5" fill="var(--brand)"/>' +
      '<path d="M8 12.5l6 10L21.6 10" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="24.2" cy="8.6" r="2.9" fill="var(--brand-sun)"/>' +
      "</svg>";
  }
  function wordmark() {
    var n = CONFIG.brand.name;
    return n.length > 3 ? "<b>" + esc(n.slice(0, 3)) + "</b>" + esc(n.slice(3)) : esc(n);
  }

  var TRADE_COLORS = { Plumbing: "#2563eb", HVAC: "#0e9384", "Pest Control": "#7a5af8", "Water Treatment": "#0e7490" };

  function arrow(delta) {
    if (delta === null || Math.abs(delta) < 0.005) return '<span class="arr" aria-hidden="true">&ndash;</span>';
    return '<span class="arr" aria-hidden="true">' + (delta > 0 ? "&#9650;" : "&#9660;") + '</span><span class="sr">' + (delta > 0 ? "up " : "down ") + "</span>";
  }
  function fmtDelta(t) {
    if (t.delta === null) return t.prev === 0 && t.value > 0 ? "up from 0" : "–";
    if (t.def.points) return (t.delta >= 0 ? "+" : "−") + pts(t.delta);
    return pct(Math.abs(t.delta));
  }
  // Spoken good/bad cue, since the colour alone doesn't carry it.
  function toneSr(tone) {
    return tone === "good" ? '<span class="sr">, good</span>' : tone === "bad" ? '<span class="sr">, needs attention</span>' : "";
  }
  function fmtAvg(t) {
    if (t.avg4 === null) return "–";
    return t.def.points ? pct(t.avg4) : t.def.fmt === money ? moneyShort(t.avg4) : (Math.round(t.avg4 * 10) / 10).toString();
  }
  function fmtVsAvg(t) {
    var avgStr = fmtAvg(t);
    if (t.vsAvg === null) return "4-wk avg " + avgStr;
    if (Math.abs(t.vsAvg) < 0.005) return "Even with 4-wk avg " + avgStr;
    var amt = t.def.points ? pts(t.vsAvg) : pct(Math.abs(t.vsAvg));
    return amt + (t.vsAvg > 0 ? " above" : " below") + " 4-wk avg (" + avgStr + ")";
  }

  function stars(n) {
    var out = "";
    for (var i = 1; i <= 5; i++) out += i <= n ? '<span class="on">★</span>' : '<span class="off">☆</span>';
    return '<span class="stars" role="img" aria-label="' + n + ' out of 5 stars">' + out + "</span>";
  }

  // ---- Charts ----------------------------------------------------------------

  // Vertical bar chart. Last bar highlighted. Bars can open a detail view.
  function barChart(o) {
    var W = 340, H = o.height || 160, padL = 6, padR = 6, padT = 18, padB = 24;
    var vals = o.values;
    var max = Math.max.apply(null, vals.concat([0]));
    var top = o.top || (max > 0 ? max * 1.12 : 1); // no y-axis, so just leave room for the value label
    var plotH = H - padT - padB;
    var slot = (W - padL - padR) / vals.length;
    var barW = Math.min(30, slot - 10);
    var y = function (v) { return padT + plotH - (top ? (v / top) * plotH : 0); };
    var ya = o.avg !== undefined ? y(o.avg) : null;
    var hi = o.highlight === undefined ? vals.length - 1 : o.highlight;
    var bars = vals.map(function (v, i) {
      var x = padL + slot * i + (slot - barW) / 2;
      var h = Math.max(v > 0 ? 2 : 0, top ? (v / top) * plotH : 0);
      var yy = padT + plotH - h;
      var r = Math.min(4, barW / 2, h);
      var path = h ? "M" + x + "," + (yy + h) + "V" + (yy + r) + "Q" + x + "," + yy + " " + (x + r) + "," + yy + "H" + (x + barW - r) + "Q" + (x + barW) + "," + yy + " " + (x + barW) + "," + (yy + r) + "V" + (yy + h) + "Z" : "";
      var label = o.labelFor ? o.labelFor(i) : o.labels[i] + ": " + o.fmt(v);
      var opener = o.openFor ? o.openFor(i) : null;
      return (
        '<g class="bar' + (i === hi ? " bar-hi" : "") + (opener ? " is-link" : "") + '"' +
        (opener ? openAttr(opener) + ' role="button" tabindex="0"' : ' role="img"') +
        ' data-label="' + esc(label) + '" aria-label="' + esc(label) + '">' +
        '<rect class="hit" x="' + (padL + slot * i) + '" y="0" width="' + slot + '" height="' + H + '"></rect>' +
        (path ? '<path d="' + path + '"></path>' : "") +
        "</g>"
      );
    }).join("");
    // Value and date labels sit outside the bar buttons (aria-hidden), so each bar's spoken name is its full label.
    var texts = vals.map(function (v, i) {
      var x = padL + slot * i + slot / 2;
      var yy = padT + plotH - Math.max(v > 0 ? 2 : 0, top ? (v / top) * plotH : 0);
      return (i === hi && o.showValue !== false ? '<text class="val" x="' + x + '" y="' + ((ya !== null && Math.abs(yy - ya) < 14 ? Math.min(yy, ya) : yy) - 7) + '" text-anchor="middle">' + esc(o.short ? o.short(v) : o.fmt(v)) + "</text>" : "") +
        '<text class="xl' + (i === hi ? " xl-hi" : "") + '" x="' + x + '" y="' + (H - 7) + '" text-anchor="middle">' + esc(o.labels[i]) + "</text>";
    }).join("");
    var avgLine = ya !== null ? '<line class="avg" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ya + '" y2="' + ya + '"></line>' : "";
    var legend = ya !== null ? '<p class="chart-legend"><span class="dash" aria-hidden="true"></span>' + esc(o.avgLabel) + "</p>" : "";
    return legend + '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="group" aria-label="' + esc(o.title || "Chart") + '">' +
      '<line class="base" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (padT + plotH) + '" y2="' + (padT + plotH) + '"></line>' +
      bars + avgLine + '<g class="labels" aria-hidden="true">' + texts + "</g></svg>";
  }
  function sparkline(values, toneCls) {
    var W = 64, H = 22, p = 2;
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values);
    var span = max - min || 1;
    var pts2 = values.map(function (v, i) {
      return (p + (i * (W - 2 * p)) / (values.length - 1)).toFixed(1) + "," + (H - p - ((v - min) / span) * (H - 2 * p)).toFixed(1);
    });
    var last = pts2[pts2.length - 1].split(",");
    return '<svg class="spark ' + (toneCls || "") + '" viewBox="0 0 ' + W + " " + H + '" aria-hidden="true"><polyline points="' + pts2.join(" ") + '"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.2"/></svg>';
  }

  // Horizontal bars (HTML). rows: [{label, sub, value, display, open, tone}]
  function hbars(rows, opts) {
    opts = opts || {};
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([0])) || 1;
    return '<ul class="hbars">' + rows.map(function (r) {
      var inner =
        '<span class="hb-top"><span class="hb-label">' + esc(r.label) + (r.sub ? '<span class="hb-sub">' + esc(r.sub) + "</span>" : "") + '</span><span class="hb-val">' + esc(r.display) + "</span></span>" +
        '<span class="hb-track"><i class="' + (r.tone || "") + '" style="width:' + (r.value > 0 ? Math.max(1.5, (r.value / max) * 100) : 0).toFixed(1) + '%"></i></span>';
      return "<li>" + (r.open ? '<button type="button" class="hb-row is-link"' + openAttr(r.open) + ">" + inner + icon("chevron", "chev") + "</button>" : '<div class="hb-row">' + inner + "</div>") + "</li>";
    }).join("") + "</ul>" + (opts.note ? '<p class="note">' + esc(opts.note) + "</p>" : "");
  }

  // Simple data table. cols: [{label, num}], rows: [[cells]]; cells already escaped HTML.
  function table(cols, rows, opts) {
    opts = opts || {};
    return '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + cols.map(function (c) {
      return "<th" + (c.num ? ' class="num"' : "") + ">" + esc(c.label) + "</th>";
    }).join("") + "</tr></thead><tbody>" + rows.map(function (r) {
      var bc = r.btnCell || 0; // the cell that holds the row's real button
      return "<tr" + (r.open ? ' class="is-link"' + openAttr(r.open) : "") + ">" + r.cells.map(function (cell, i) {
        if (r.open && i === bc) cell = '<button type="button" class="row-btn">' + cell + "</button>";
        return "<td" + (cols[i].num ? ' class="num"' : "") + ">" + cell + "</td>";
      }).join("") + "</tr>";
    }).join("") + "</tbody>" + (opts.foot ? "<tfoot><tr>" + opts.foot.map(function (cell, i) {
      return "<td" + (cols[i].num ? ' class="num"' : "") + ">" + cell + "</td>";
    }).join("") + "</tr></tfoot>" : "") + "</table></div>";
  }

  function statGrid(items) {
    return '<div class="stat-grid' + (items.length === 3 ? " three" : items.length === 4 ? " four" : "") + '">' + items.map(function (s) {
      return '<div class="stat"><span class="stat-l">' + esc(s.label) + '</span><span class="stat-v">' + esc(s.value) + "</span>" +
        (s.sub ? '<span class="stat-s ' + (s.tone ? "tone-" + s.tone : "") + '">' + esc(s.sub) + "</span>" : "") + "</div>";
    }).join("") + "</div>";
  }

  // ---- Main report sections -------------------------------------------------

  function section(id, title, iconName, inner, opts) {
    opts = opts || {};
    return '<section class="card ' + (opts.cls || "") + '" id="' + id + '" aria-labelledby="' + id + '-h">' +
      '<div class="card-head"><h2 id="' + id + '-h">' + icon(iconName) + "<span>" + title + "</span></h2>" + (opts.aside ? '<span class="card-aside">' + opts.aside + "</span>" : "") + "</div>" +
      inner + "</section>";
  }

  function renderHeader(m) {
    var c = m.company;
    var color = TRADE_COLORS[c.trade] || "var(--accent)";
    return (
      '<header class="report-head">' +
      '<div class="co-row"><span class="co-avatar" style="--co:' + color + '">' + esc(monogram(c.name)) + "</span>" +
      '<div><p class="eyebrow">Monday Owner Report ' + (m.live ? '<span class="badge live">LIVE DATA</span>' : '<span class="badge">DEMO</span>') + "</p>" +
      "<h1>" + esc(c.name) + "</h1>" +
      '<p class="co-meta"><span>' + esc(c.trade) + "</span> <span>· " + esc(c.serviceArea) + "</span> <span>· " + plural(fieldTechs(c.techs).length, "tech") + "</span></p></div></div>" +
      '<div class="head-meta"><span class="pill-meta">' + icon("clock") + "Mon " + shortDate(m.cur.start) + " – Sun " + shortDate(m.cur.end) + ", " + d(m.cur.end).getUTCFullYear() + "</span>" +
      '<span class="pill-meta"><span class="dot" aria-hidden="true"></span>Delivered Monday, ' + shortDate(m.asOf) + " · " + CONFIG.deliveryTime + "</span></div>" +
      "</header>"
    );
  }

  function renderSummary(m) {
    return (
      '<section class="hero" id="summary" aria-labelledby="summary-h">' +
      '<h2 id="summary-h">' + icon("bolt") + "<span>The Short Version</span></h2>" +
      '<p class="summary">' + m.summary.map(esc).join(" ") + "</p>" +
      '<div class="hero-stats">' +
      '<button type="button" class="hero-stat is-link"' + openAttr("metric:revenue") + '><span>Revenue</span><b>' + money(m.cur.revenue) + "</b></button>" +
      '<button type="button" class="hero-stat is-link"' + openAttr("leaks") + '><span>Money leaks</span><b class="neg">' + money(m.leaks.total) + "</b></button>" +
      '<button type="button" class="hero-stat is-link"' + openAttr("changes") + '><span>Upside</span><b class="pos">' + approx(m.changes.yearlyTotal + m.changes.oneTimeTotal) + "</b></button>" +
      "</div></section>"
    );
  }

  function renderScorecard(m) {
    var tiles = m.scorecard.map(function (t) {
      var sub = t.key === "newReviews" && m.cur.avgRating ? '<span class="tile-sub">★ ' + m.cur.avgRating.toFixed(1) + "</span>" : "";
      return (
        '<button type="button" class="tile is-link"' + openAttr("metric:" + t.key) + ">" +
        '<span class="tile-label">' + t.label + "</span>" +
        '<span class="tile-value"><span>' + t.def.fmt(t.value) + "</span>" + sub + sparkline(t.series, "tone-" + t.avgTone) + "</span>" +
        '<span class="tile-delta tone-' + t.tone + '">' + arrow(t.delta) + fmtDelta(t) + ' <span class="muted">vs last wk</span>' + toneSr(t.tone) + "</span>" +
        '<span class="tile-avg tone-' + t.avgTone + '">' + fmtVsAvg(t) + toneSr(t.avgTone) + "</span>" +
        "</button>"
      );
    }).join("");
    return section("scorecard", "Scorecard", "scorecard", '<div class="tiles">' + tiles + "</div>", { aside: '<span class="hint">Tap any number</span>' });
  }

  function renderLeaks(m) {
    var L = m.leaks;
    if (!L.items.length) return section("leaks", "Money Leaks", "leak", '<p class="empty">No leaks flagged this week. Nice.</p>');
    var items = L.items.map(function (x) {
      var rows = x.rows.map(function (r) {
        return '<span class="lr"><span class="who">' + esc(r[0]) + '</span><span class="what">' + esc(r[1]) + '</span><span class="amt">' + esc(r[2]) + "</span></span>";
      }).join("");
      var opener = x.kind === "tech" ? "tech:" + x.flag.tech.id : "leak:" + x.kind;
      return (
        '<button type="button" class="leak is-link"' + openAttr(opener) + ">" +
        '<span class="leak-top"><span class="leak-title">' + esc(x.title) + '</span><span class="leak-amt">' + money(x.amount) + (x.kind === "tech" ? '<small>/wk</small>' : "") + "</span></span>" +
        '<span class="leak-detail">' + esc(x.detail) + "</span>" +
        '<span class="leak-rows">' + rows + "</span>" +
        '<span class="more">' + (x.more > 0 ? "See all " + (x.rows.length + x.more) : "See details") + icon("chevron") + "</span>" +
        "</button>"
      );
    }).join("");
    return section("leaks", "Money Leaks", "leak",
      '<div class="leak-total"><span class="big">' + money(L.total) + '</span><span class="label">tied up or lost across ' + plural(L.items.length, "item") + "</span></div>" +
      '<div class="leak-list">' + items + "</div>");
  }

  function renderTrend(m) {
    var weeks = m.weeks;
    var avg = mean(weeks.map(function (w) { return w.revenue; }));
    var svg = barChart({
      title: "Weekly revenue, last 8 weeks",
      values: weeks.map(function (w) { return w.revenue; }),
      labels: weeks.map(function (w) { return slashDate(w.start); }),
      fmt: money, short: moneyShort,
      avg: avg, avgLabel: "8-wk avg " + moneyShort(avg),
      labelFor: function (i) { return "Week of " + shortDate(weeks[i].start) + ": " + money(weeks[i].revenue) + " · " + weeks[i].jobs + " jobs"; },
      openFor: function (i) { return "week:" + i; },
    });
    var trend = change(m.cur.revenue, weeks[0].revenue);
    var caption = '<p class="chart-cap">' + esc("Week of " + shortDate(m.cur.start) + ": " + money(m.cur.revenue) + " · " + m.cur.jobs + " jobs") + "</p>";
    var note = '<p class="chart-note">' + (Math.abs(trend) < 0.03 ? "Flat over 8 weeks (" + (trend >= 0 ? "+" : "−") + pct(Math.abs(trend)) + ")." : (trend > 0 ? "Up " : "Down ") + pct(Math.abs(trend)) + " since " + shortDate(weeks[0].start) + ".") + ' <span class="muted screen-only">Tap a bar to open that week.</span></p>';
    return section("trend", "Revenue Trend", "trend", caption + svg + note);
  }

  function renderPipeline(m) {
    var p = m.pipeline;
    var funnel = (p.leads === null ? [] : [{ label: "New leads", value: p.leads, sub: "", open: "metric:newLeads" }]).concat([
      { label: "Quotes sent", value: p.sent, sub: money(p.sentValue), open: "metric:closeRate" },
      { label: "Quotes won", value: p.won, sub: money(p.wonValue), open: "metric:closeRate" },
    ]);
    var fmax = Math.max.apply(null, funnel.map(function (s) { return s.value; })) || 1;
    var f = '<div class="funnel">' + funnel.map(function (s) {
      return '<button type="button" class="fn-step is-link"' + openAttr(s.open) + ">" +
        '<span class="fn-bar"><i style="width:' + Math.max(4, (s.value / fmax) * 100).toFixed(1) + '%"></i></span>' +
        '<span class="fn-l">' + s.label + '</span><span class="fn-v">' + s.value + (s.sub ? '<small>' + s.sub + "</small>" : "") + "</span></button>";
    }).join("") + "</div>";
    var rateLine = '<p class="fn-rate">Close rate <b>' + rate(m.cur.closeRate) + "</b> · " + p.won + " won, " + p.sent + " new quotes sent last week</p>";
    var b = '<div class="buckets">' + p.buckets.map(function (bk) {
      return '<button type="button" class="bucket is-link tone-' + bk.tone + '"' + openAttr("pipeline:" + bk.key) + ">" +
        '<span class="bk-l">' + bk.label + '</span><span class="bk-v">' + money(bk.amount) + '</span><span class="bk-s">' + plural(bk.count, "quote") + "</span></button>";
    }).join("") + "</div>";
    return section("sales", "Sales Pipeline", "sales",
      f + rateLine + '<h3 class="sub-h">Open quotes · ' + money(p.openValue) + "</h3>" + b);
  }

  function renderLeaderboard(m) {
    var techs = fieldTechs(m.cur.techs).sort(byDesc(function (t) { return t.revenue; }));
    var maxRev = techs[0].revenue || 1;
    var rows = techs.map(function (t, i) {
      var flagged = isCallbackFlag(t, m.team);
      return (
        '<button type="button" class="lb-row is-link"' + openAttr("tech:" + t.id) + ">" +
        '<span class="lb-rank"><span class="sr">Rank </span>' + (i + 1) + "</span>" +
        '<span class="lb-name"><span class="lb-av" aria-hidden="true">' + esc(initials(t.name)) + '</span><span><b>' + esc(t.name) + "</b>" + (flagged ? ' <span class="pill">Check in</span>' : "") + '<span class="lb-role">' + esc(t.role) + (t.jobs ? "" : " · no jobs last week") + "</span>" +
        '<span class="lb-bar" aria-hidden="true"><i style="width:' + Math.round((t.revenue / maxRev) * 100) + '%"></i></span></span></span>' +
        '<span class="lb-num lb-rev" data-l="Revenue">' + money(t.revenue) + "</span>" +
        '<span class="lb-num" data-l="Jobs">' + t.jobs + "</span>" +
        '<span class="lb-num" data-l="Avg">' + money(t.avgTicket) + "</span>" +
        '<span class="lb-num" data-l="' + esc(termOf(m.company, "addOns", "Add-ons")) + '">' + t.addOns + "</span>" +
        '<span class="lb-num' + (flagged ? " cb-hi" : "") + '" data-l="Callbacks">' + t.callbacks + "</span>" +
        icon("chevron", "chev") +
        "</button>"
      );
    }).join("");
    var head =
      '<div class="lb-row lb-head" aria-hidden="true"><span>#</span><span>Tech</span><span class="lb-num">Revenue</span><span class="lb-num">Jobs</span><span class="lb-num">Avg</span><span class="lb-num">' + esc(termOf(m.company, "addOns", "Add-ons")) + '</span><span class="lb-num">Callbacks</span><span></span></div>';
    var flaggedNote = techs.some(function (t) { return isCallbackFlag(t, m.team); })
      ? '<p class="note">"Check in" = callbacks at 2× the team average or more. Worth a conversation, not a write-up.</p>' : "";
    var others = m.cur.techs.filter(function (t) { return t.field === false && t.jobs; });
    var otherNote = others.length ? '<p class="note">Not ranked: ' + esc(listNames(others.map(function (t) { return t.name + " (" + plural(t.jobs, "job") + ", " + money(t.revenue) + ")"; }))) + ".</p>" : "";
    return section("leaderboard", "Tech Leaderboard", "team", '<div class="lb">' + head + rows + "</div>" + flaggedNote + otherNote, { aside: '<span class="hint">Tap a tech</span>' });
  }

  function doneKey(m, i) { return "mor-done:" + m.company.id + ":" + m.cur.start + ":" + i; }
  function isDone(key) { try { return root.localStorage && localStorage.getItem(key) === "1"; } catch (e) { return false; } }

  function renderActions(m) {
    var items = m.actions.map(function (a, i) {
      var key = doneKey(m, i);
      var done = isDone(key);
      return '<li class="action' + (done ? " is-done" : "") + '">' +
        '<label class="check"><input type="checkbox" data-done="' + esc(key) + '"' + (done ? " checked" : "") + '><span class="anum">' + (i + 1) + '</span><span class="sr">Mark done</span></label>' +
        '<div><p class="a-title">' + esc(a.title) + '</p><p class="a-detail">' + esc(a.detail) + "</p>" +
        '<div class="a-foot"><span class="a-impact">' + esc(a.impact) + "</span>" +
        (a.open ? '<button type="button" class="a-link is-link"' + openAttr(a.open) + ">Details" + icon("chevron") + "</button>" : "") + "</div></div></li>";
    }).join("");
    var n = m.actions.length;
    var title = n === 1 ? "Do This 1 Thing This Week" : n ? "Do These " + n + " Things This Week" : "This Week";
    if (!n) return section("actions", title, "actions", '<p class="empty">Nothing urgent. Keep doing what you\'re doing.</p>', { cls: "card-actions" });
    return section("actions", title, "actions", '<ol class="actions">' + items + "</ol>" + '<p class="note screen-only">Tap a number to check it off. It stays checked on this phone.</p>', { cls: "card-actions" });
  }

  function renderWins(m) {
    var items = m.wins.map(function (w) {
      return '<li><button type="button" class="win is-link"' + openAttr(w.open) + '><span class="win-ico" aria-hidden="true">' + w.icon + '</span><span><span class="w-title">' + esc(w.title) + '</span><span class="w-text">' + esc(w.text) + "</span></span></button></li>";
    }).join("");
    return section("wins", "Wins", "wins", '<ul class="wins">' + items + "</ul>");
  }

  function renderChanges(m) {
    var ch = m.changes;
    var what = ch.items.length === 1 ? "this change" : "these " + ch.items.length + " changes";
    var head = '<div class="ch-summary"><p>If ' + esc(m.company.name) + " makes " + what + ", " +
      (ch.yearlyTotal
        ? "the numbers point to about <b>" + approx(ch.yearlyTotal) + " a year</b> in extra profit and revenue" + (ch.oneTimeTotal ? ", plus <b>" + approx(ch.oneTimeTotal) + "</b> in cash and jobs already sitting on the table." : ".")
        : ch.oneTimeTotal ? "there's about <b>" + approx(ch.oneTimeTotal) + "</b> in cash and jobs sitting on the table right now." : "it keeps the business running the way it is now.") +
      "</p></div>";
    var cards = ch.items.map(function (x, i) {
      return '<article class="change">' +
        '<div class="ch-top"><span class="ch-n">' + (i + 1) + '</span><h3>' + esc(x.title) + "</h3></div>" +
        '<p class="ch-why"><span class="lbl">What we see</span>' + esc(x.evidence) + "</p>" +
        '<details class="ch-how"><summary>How to do it <span class="muted">(' + x.steps.length + " steps)</span></summary>" +
        '<ol class="ch-steps">' + x.steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" +
        (x.source ? '<p class="ch-src">Source: <a href="' + esc(x.source.url) + '" target="_blank" rel="noopener">' + esc(x.source.label) + "</a></p>" : "") +
        "</details>" +
        '<div class="ch-foot"><span class="ch-impact">' + esc(x.impactText) + "</span>" +
        '<span class="ch-tags"><span class="tag">Effort: ' + x.effort + '</span><span class="tag">Setup: ' + esc(x.setup) + "</span></span></div>" +
        '<button type="button" class="a-link is-link"' + openAttr(x.open) + ">See the numbers" + icon("chevron") + "</button>" +
        "</article>";
    }).join("");
    return section("changes", "Changes Worth Making", "changes", head + '<div class="changes">' + cards + "</div>" +
      '<p class="note">Estimates come straight from this report\'s numbers and are rounded. They assume you recover part of each gap, not all of it.</p>', {});
  }

  function renderFooter(m) {
    var ok = m.integrity.ok;
    return (
      '<footer class="report-foot">' +
      '<div class="foot-brand">' + logo(30) + '<div><span class="wm">' + wordmark() + "</span><span>" + esc(CONFIG.brand.tagline) + "</span></div></div>" +
      "<p>Pulled automatically from your field-service software. No data entry.</p>" +
      '<p class="fine">' + (ok ? "All totals reconciled: tech and daily numbers match company totals for all " + m.weeks.length + " weeks." : "Data check failed: " + esc(m.integrity.problems.join("; "))) +
      (m.live ? " Live data from " + esc(m.company.sourceName || "your field-service software") + ", pulled " + shortDate(m.asOf) + ". Customer names are shortened to first name and last initial."
        : " Demo data. All names and numbers are fictional.") + "</p>" +
      "</footer>"
    );
  }

  function render(m) {
    return (
      renderHeader(m) +
      renderSummary(m) +
      renderScorecard(m) +
      renderLeaks(m) +
      renderTrend(m) +
      renderPipeline(m) +
      renderLeaderboard(m) +
      renderActions(m) +
      renderWins(m) +
      renderChanges(m) +
      renderFooter(m)
    );
  }

  // ---- Detail views (shown in the sheet) -------------------------------------

  function weekLabels(m) { return m.weeks.map(function (w) { return slashDate(w.start); }); }

  function metricChart(m, key, fmt, short) {
    var raw = m.weeks.map(function (w) { return w[key]; });
    var series = raw.map(function (v) { return v === null ? 0 : v; });
    var avg = mean(raw.filter(function (v) { return v !== null; }));
    var avgFmt = (short || fmt) === String ? function (v) { return (Math.round(v * 10) / 10).toString(); } : (short || fmt);
    return barChart({
      title: (scoreTile(m, key) ? scoreTile(m, key).label : key) + ", last 8 weeks", values: series, labels: weekLabels(m), fmt: fmt, short: short || fmt,
      avg: avg, avgLabel: "8-wk avg " + avgFmt(avg),
      openFor: function (i) { return "week:" + i; },
      labelFor: function (i) { return "Week of " + shortDate(m.weeks[i].start) + ": " + (raw[i] === null ? "–" : fmt(raw[i])); },
    });
  }

  function techRows(m, valueFn, displayFn, subFn) {
    return m.cur.techs.slice().sort(byDesc(valueFn)).map(function (t) {
      return { label: t.name, sub: subFn ? subFn(t) : "", value: valueFn(t), display: displayFn(t), open: "tech:" + t.id };
    });
  }

  function quoteRows(list, opts) {
    opts = opts || {};
    return table(
      [{ label: "Customer" }, { label: opts.dateLabel || "Age" }, { label: "Amount", num: true }],
      list.map(function (q) {
        return { cells: [
          "<b>" + esc(q.customer) + '</b><span class="cell-sub">' + esc(q.service) + (opts.showTech && q.techId ? ' · <span class="nowrap">' + esc(opts.techName(q.techId)) + "</span>" : "") + "</span>",
          opts.dateFn ? esc(opts.dateFn(q)) : '<span class="nowrap">' + esc(q.ageDays + " days") + "</span>" + (opts.hideFollow ? "" : q.viewedDate !== undefined ? (q.viewedDate ? '<span class="cell-sub ok">Opened ' + esc(shortDate(q.viewedDate)) + "</span>" : '<span class="cell-sub bad">Not opened</span>')
            : q.lastFollowUpDate ? '<span class="cell-sub ok">Called ' + esc(shortDate(q.lastFollowUpDate)) + "</span>"
            : q.ageDays <= CONFIG.staleQuoteDays ? '<span class="cell-sub nowrap">Not due yet</span>' : '<span class="cell-sub bad">No call yet</span>'),
          money(q.amount),
        ] };
      }),
      { foot: ["<b>Total</b>", plural(list.length, "quote"), "<b>" + money(sum(list, function (q) { return q.amount; })) + "</b>"] }
    );
  }

  function invoiceRows(list) {
    return table(
      [{ label: "Customer" }, { label: "Days", num: true }, { label: "Amount", num: true }],
      list.map(function (x) {
        return { cells: ["<b>" + esc(x.customer) + '</b><span class="cell-sub">' + esc(x.description) + " · issued " + esc(shortDate(x.issuedDate)) + "</span>", '<span class="' + (x.daysOutstanding >= 60 ? "bad" : x.daysOutstanding >= CONFIG.unpaidDays ? "warn" : "") + '">' + x.daysOutstanding + "</span>", money(x.amount)] };
      }),
      { foot: ["<b>Total</b>", "", "<b>" + money(sum(list, function (x) { return x.amount; })) + "</b>"] }
    );
  }

  function callbackRows(m, list) {
    return table(
      [{ label: "Customer" }, { label: "Tech" }, { label: "Day" }],
      list.map(function (x) {
        return { cells: ["<b>" + esc(x.customer) + '</b><span class="cell-sub">' + esc(x.issue) + (x.recurringPlanValue ? " · plan " + money(x.recurringPlanValue) + "/yr" : "") + "</span>", esc(techName(m, x.techId)), esc(weekday(x.date) + " " + shortDate(x.date))], open: "tech:" + x.techId, btnCell: 1 };
      })
    );
  }

  function reviewList(m, list, selfId) {
    if (!list.length) return '<p class="empty">No reviews.</p>';
    return '<ul class="reviews">' + list.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (r) {
      return '<li class="review' + (r.rating <= 3 ? " review-low" : "") + '"><div class="rv-top">' + stars(r.rating) + '<span class="rv-date">' + esc(shortDate(r.date)) + "</span></div>" +
        '<p class="rv-text">“' + esc(r.text) + '”</p><p class="rv-by">' + esc(r.customer) + " · " + (r.techId === selfId ? esc(techName(m, r.techId)) : '<button type="button" class="link is-link"' + openAttr("tech:" + r.techId) + ">" + esc(techName(m, r.techId)) + "</button>") + "</p></li>";
    }).join("") + "</ul>";
  }

  function techName(m, id) { return techNameIn(m.company, id); }

  // {label: count} -> horizontal bars, biggest first.
  function breakdownBars(obj, unit) {
    return hbars(Object.keys(obj).map(function (k) { return { label: k, value: obj[k], display: plural(obj[k], unit) }; })
      .sort(byDesc(function (r) { return r.value; })));
  }

  function scoreTile(m, key) { return find(m.scorecard, function (x) { return x.key === key; }); }

  function metricHeader(m, key) {
    var t = scoreTile(m, key);
    return '<div class="sheet-hero"><span class="sh-v">' + t.def.fmt(t.value) + "</span>" +
      '<span class="tile-delta tone-' + t.tone + '">' + arrow(t.delta) + fmtDelta(t) + ' <span class="muted">vs last wk</span>' + toneSr(t.tone) + "</span>" +
      '<span class="tile-avg tone-' + t.avgTone + '">' + fmtVsAvg(t) + toneSr(t.avgTone) + "</span></div>";
  }

  var VIEWS = {
    metric: function (m, key) {
      var cur = m.cur, t = scoreTile(m, key), body = metricHeader(m, key);
      var h3 = function (s) { return '<h3 class="sub-h">' + s + "</h3>"; };
      if (key === "revenue") {
        body += h3("Last 8 weeks") + metricChart(m, "revenue", money, moneyShort);
        body += h3("By tech") + hbars(techRows(m, function (x) { return x.revenue; }, function (x) { return money(x.revenue); }, function (x) { return x.jobs + " jobs"; }));
        body += h3("By day") + barChart({ title: "Revenue by day", values: cur.dailyRevenue, labels: DAY_SHORT, fmt: money, short: moneyShort, highlight: cur.dailyRevenue.indexOf(Math.max.apply(null, cur.dailyRevenue)), height: 150 });
      } else if (key === "jobs") {
        body += h3("Last 8 weeks") + metricChart(m, "jobs", String);
        body += h3("By tech") + hbars(techRows(m, function (x) { return x.jobs; }, function (x) { return x.jobs + " jobs"; }, function (x) { return money(x.avgTicket) + " avg"; }));
      } else if (key === "avgTicket") {
        body += h3("Last 8 weeks") + metricChart(m, "avgTicket", money);
        body += h3("By tech") + hbars(techRows(m, function (x) { return x.avgTicket; }, function (x) { return money(x.avgTicket); }, function (x) { return pct(x.addOnRate) + " " + termOf(m.company, "addOnRate", "of jobs had an add-on"); }),
          { note: "Average ticket = revenue ÷ jobs completed." });
      } else if (key === "closeRate") {
        body += statGrid([
          { label: "Quotes sent", value: String(cur.quotesSent), sub: money(cur.quotesSentValue) },
          { label: "Quotes won", value: String(cur.quotesWon), sub: money(cur.quotesWonValue) },
          { label: "Won by value", value: cur.quotesSentValue ? pct(cur.quotesWonValue / cur.quotesSentValue) : "–", sub: "$ won ÷ $ sent" },
        ]);
        body += h3("Last 8 weeks") + metricChart(m, "closeRate", rate);
        body += h3("Won last week") + (cur.quotesWonList.length ? quoteRows(cur.quotesWonList.slice().sort(byDesc(function (q) { return q.amount; })), { dateLabel: "Won", dateFn: function (q) { return weekday(q.decidedDate) + " " + shortDate(q.decidedDate); } }) : '<p class="empty">None.</p>');
        body += h3("Sent last week") + quoteRows(cur.quotesSentList.slice().sort(byDesc(function (q) { return q.amount; })), { dateLabel: "Status", dateFn: function (q) { return q.status === "won" ? "Won" : q.status === "lost" ? "Lost" : "Open"; } });
        body += '<p class="note">Close rate = quotes won that week ÷ new quotes sent that week. Most quotes won in a week were sent in earlier weeks.</p>';
      } else if (key === "newLeads") {
        body += h3("Last 8 weeks") + metricChart(m, "newLeads", String);
        body += statGrid([
          { label: "Leads", value: String(cur.newLeads) },
          { label: "Quotes sent", value: String(cur.quotesSent), sub: cur.newLeads ? pct(cur.quotesSent / cur.newLeads) + " of leads" : "" },
          { label: "Jobs done", value: String(cur.jobs) },
        ]);
      } else if (key === "unpaid30") {
        body += h3("Last 8 weeks") + metricChart(m, "unpaid30", money, moneyShort);
        body += h3("Every open invoice, by age") + hbars(m.aging.map(function (b) {
          return { label: b.label, sub: plural(b.count, "invoice"), value: b.amount, display: money(b.amount), tone: b.key === "current" ? "" : b.key === "60" ? "bad" : "warn", open: b.count ? "aging:" + b.key : null };
        }));
        body += h3(CONFIG.unpaidDays + "+ days late") + (cur.unpaid30List.length ? invoiceRows(cur.unpaid30List.slice().sort(byDesc(function (x) { return x.daysOutstanding; }))) : '<p class="empty">None. Nice.</p>');
      } else if (key === "callbacks") {
        body += h3("Last 8 weeks") + metricChart(m, "callbacks", String);
        body += h3("By tech, last week") + hbars(techRows(m, function (x) { return x.callbacks; }, function (x) { return plural(x.callbacks, "callback"); }, function (x) { return money(x.callbacks * m.company.callbackCostEstimate) + " est. cost"; }));
        body += h3("Every callback last week") + (cur.callbackList.length ? callbackRows(m, cur.callbackList) : '<p class="empty">None.</p>');
        if (cur.breakdown.callbacks) body += h3("Every leak call last week, by cause") + breakdownBars(cur.breakdown.callbacks, "leak call");
        body += '<p class="note">' + esc(m.company.labels && m.company.labels.callbackCostNote
          ? fill(m.company.labels.callbackCostNote, { cost: money(m.company.callbackCostEstimate) })
          : "Each redo visit is estimated at " + money(m.company.callbackCostEstimate) + " in labor, truck and parts.") + "</p>";
      } else if (key === "newReviews") {
        body += h3("Last 8 weeks") + metricChart(m, "newReviews", String);
        body += h3("Last week's reviews") + reviewList(m, cur.reviewList);
      } else {
        // Company-specific tiles: trend + last week's breakdown, when the data has one.
        body += h3("Last 8 weeks") + metricChart(m, key, t.def.fmt);
        if (cur.breakdown[key]) body += h3("Last week, by type") + breakdownBars(cur.breakdown[key], "job");
      }
      var note = m.company.notes && m.company.notes[key];
      if (note) body += '<p class="note">' + esc(note) + "</p>";
      return { kicker: "Scorecard", title: t.label, html: body };
    },

    tech: function (m, id) {
      var cur = m.cur, team = m.team;
      var t = find(cur.techs, function (x) { return x.id === id; });
      var ranked = fieldTechs(cur.techs).sort(byDesc(function (x) { return x.revenue; }));
      var rank = ranked.indexOf(t) + 1;
      var peer = (t.field !== false && peerAvg(team, t)) || team, pl = t.group ? t.group.toLowerCase() + " avg" : "team avg";
      var reviewsOn = feat(m.company, "reviews");
      var hist = techHistory(m.weeks, id);
      var cmp = function (v, avg, fmt, goodUp) {
        if (!avg) return { sub: "", tone: "" };
        if (!v) return { sub: "None (" + pl + " " + fmt(avg) + ")", tone: goodUp ? "bad" : "good" };
        var diff = change(v, avg);
        if (Math.abs(diff) < 0.03) return { sub: "≈ " + pl + " " + fmt(avg), tone: "flat" };
        return { sub: pct(Math.abs(diff)) + (diff > 0 ? " above" : " below") + " " + pl + " " + fmt(avg), tone: (diff > 0) === goodUp ? "good" : "bad" };
      };
      var rv = cmp(t.revenue, peer.revenue, moneyShort, true), jb = cmp(t.jobs, peer.jobs, function (v) { return v.toFixed(0); }, true),
        tk = cmp(t.avgTicket, peer.avgTicket, money, true), cbc = cmp(t.callbacks, peer.callbacks, function (v) { return v.toFixed(1); }, false);
      if (t.field === false) rv = jb = tk = cbc = { sub: "", tone: "" };
      var allCb = m.company.callbacks.filter(function (x) { return x.techId === id; });
      var allRv = (m.company.reviews || []).filter(function (x) { return x.techId === id; });
      var openQ = openQuotes(m.company, m.asOf).filter(function (q) { return q.techId === id; }).sort(byDesc(function (q) { return q.amount; }));
      var staleQ = openQ.filter(function (q) { return !q.lastFollowUpDate && q.ageDays > CONFIG.staleQuoteDays; });
      var body =
        '<div class="tech-hero"><span class="lb-av big">' + esc(initials(t.name)) + '</span><div><p class="th-role">' + esc(t.role) + "</p><p class=\"th-rank\">" + (rank ? "#" + rank + " of " + ranked.length + " by revenue last week" : "Not ranked with the field techs") + (isCallbackFlag(t, team) ? ' · <span class="pill">Check in</span>' : "") + "</p></div></div>" +
        statGrid([
          { label: "Revenue", value: money(t.revenue), sub: rv.sub, tone: rv.tone },
          { label: "Jobs", value: String(t.jobs), sub: jb.sub, tone: jb.tone },
          { label: "Avg ticket", value: money(t.avgTicket), sub: tk.sub, tone: tk.tone },
          { label: termOf(m.company, "addOns", "Add-ons"), value: String(t.addOns), sub: pct(t.addOnRate) + " of jobs (team " + pct(team.addOnRate) + ")" },
          { label: "Callbacks", value: String(t.callbacks), sub: cbc.sub, tone: cbc.tone },
          reviewsOn ? { label: "Reviews", value: String(t.reviewMentions), sub: "named " + firstName(t.name) + " last week" }
            : { label: "Share of revenue", value: cur.revenue ? pct(t.revenue / cur.revenue) : "–", sub: "of the company's week" },
        ]) +
        '<h3 class="sub-h">Revenue, last 8 weeks</h3>' +
        barChart({ title: t.name + " revenue", values: hist.map(function (h) { return h.revenue; }), labels: weekLabels(m), fmt: money, short: moneyShort,
          labelFor: function (i) { return "Week of " + shortDate(hist[i].start) + ": " + money(hist[i].revenue) + " · " + hist[i].jobs + " jobs"; } }) +
        '<h3 class="sub-h">Week by week</h3>' +
        table([{ label: "Week" }, { label: "Jobs", num: true }, { label: "Revenue", num: true }, { label: termOf(m.company, "addOns", "Add-ons"), num: true }, { label: "CB", num: true }],
          hist.slice().reverse().map(function (h, j) {
            return { cells: [esc(shortDate(h.start)), String(h.jobs), money(h.revenue), String(h.addOns), h.callbacks ? '<span class="' + (h.callbacks >= CONFIG.highCallbacks ? "bad" : "") + '">' + h.callbacks + "</span>" : "0"], open: "week:" + (hist.length - 1 - j) };
          }),
          { foot: ["<b>8 weeks</b>", String(sum(hist, function (h) { return h.jobs; })), "<b>" + money(sum(hist, function (h) { return h.revenue; })) + "</b>", String(sum(hist, function (h) { return h.addOns; })), String(sum(hist, function (h) { return h.callbacks; }))] });
      if (allCb.length) {
        body += '<h3 class="sub-h">Callbacks (8 weeks)</h3>' + table([{ label: "Customer" }, { label: "Day" }],
          allCb.slice().reverse().map(function (x) { return { cells: ["<b>" + esc(x.customer) + '</b><span class="cell-sub">' + esc(x.issue) + "</span>", esc(shortDate(x.date))] }; }));
      }
      if (openQ.length) {
        body += '<h3 class="sub-h">Open quotes ' + esc(firstName(t.name)) + " wrote" + (staleQ.length ? ' · <span class="bad">' + staleQ.length + (staleQ.length === 1 ? " needs" : " need") + " a call</span>" : "") + "</h3>" + quoteRows(openQ);
      }
      if (reviewsOn) body += '<h3 class="sub-h">Latest reviews that name ' + esc(firstName(t.name)) + "</h3>" + reviewList(m, allRv.slice(-4), id);
      return { kicker: "Tech", title: t.name, html: body };
    },

    week: function (m, i) {
      var w = m.weeks[+i];
      var body = statGrid([
        { label: "Revenue", value: money(w.revenue) },
        { label: "Jobs", value: String(w.jobs), sub: money(w.avgTicket) + " avg" },
        { label: "Close rate", value: rate(w.closeRate), sub: w.quotesWon + " won · " + w.quotesSent + " sent" },
        { label: "Callbacks", value: String(w.callbacks) },
      ]);
      body += '<h3 class="sub-h">By day</h3>' + barChart({ title: "Revenue by day", values: w.dailyRevenue, labels: DAY_SHORT, fmt: money, short: moneyShort, highlight: w.dailyRevenue.indexOf(Math.max.apply(null, w.dailyRevenue)), height: 150 });
      body += '<h3 class="sub-h">By tech</h3>' + hbars(w.techs.filter(function (x) { return x.field || x.jobs; }).sort(byDesc(function (x) { return x.revenue; })).map(function (x) {
        return { label: x.name, sub: x.jobs + " jobs" + (x.callbacks ? " · " + plural(x.callbacks, "callback") : ""), value: x.revenue, display: money(x.revenue), open: "tech:" + x.id };
      }));
      if (w.reviewList.length) body += '<h3 class="sub-h">Reviews</h3>' + reviewList(m, w.reviewList);
      return { kicker: "Week of", title: shortDate(w.start) + " – " + shortDate(w.end), html: body };
    },

    leak: function (m, kind) {
      var item = find(m.leaks.items, function (x) { return x.kind === kind; });
      var body = '<div class="sheet-hero"><span class="sh-v neg">' + money(item.amount) + '</span><span class="muted">' + esc(item.detail) + "</span></div>";
      if (kind === "quotes") body += quoteRows(item.list, { showTech: true, hideFollow: true, techName: function (id) { return techName(m, id); } });
      if (kind === "unpaid") body += invoiceRows(item.list);
      if (kind === "callbacks") body += callbackRows(m, item.list);
      return { kicker: "Money Leak", title: item.title, html: body };
    },

    leaks: function (m) {
      var body = '<div class="sheet-hero"><span class="sh-v neg">' + money(m.leaks.total) + '</span><span class="muted">tied up or lost across ' + plural(m.leaks.items.length, "item") + "</span></div>" +
        hbars(m.leaks.items.map(function (x) {
          return { label: x.title, sub: x.detail, value: x.amount, display: money(x.amount) + (x.kind === "tech" ? "/wk" : ""), tone: "bad", open: x.kind === "tech" ? "tech:" + x.flag.tech.id : "leak:" + x.kind };
        }));
      return { kicker: "Money Leaks", title: "Where the money is going", html: body };
    },

    pipeline: function (m, key) {
      var b = find(m.pipeline.buckets, function (x) { return x.key === key; });
      var body = '<div class="sheet-hero"><span class="sh-v">' + money(b.amount) + '</span><span class="muted">' + plural(b.count, "open quote") + " · " + esc(b.hint) + "</span></div>" +
        (b.list.length ? quoteRows(b.list, { showTech: true, hideFollow: key !== "working", techName: function (id) { return techName(m, id); } }) : '<p class="empty">None right now.</p>');
      return { kicker: "Sales Pipeline", title: b.label, html: body };
    },

    aging: function (m, key) {
      var b = find(m.aging, function (x) { return x.key === key; });
      return { kicker: "Invoices", title: b.label, html: '<div class="sheet-hero"><span class="sh-v">' + money(b.amount) + '</span><span class="muted">' + plural(b.count, "open invoice") + "</span></div>" + invoiceRows(b.list) };
    },

    changes: function (m) {
      var body = '<div class="sheet-hero"><span class="sh-v pos">' + approx(m.changes.yearlyTotal + m.changes.oneTimeTotal) + '</span><span class="muted">' + approx(m.changes.yearlyTotal) + " a year" + (m.changes.oneTimeTotal ? " + " + approx(m.changes.oneTimeTotal) + " sitting on the table now" : "") + "</span></div>" +
        hbars(m.changes.items.map(function (x) {
          return { label: x.title, sub: "Effort: " + x.effort + " · " + x.setup, value: x.yearly + x.oneTime,
            display: x.yearly ? approx(x.yearly) + "/yr" : x.oneTime ? approx(x.oneTime) + " now" : "No $ estimate", tone: "good", open: x.open };
        }));
      return { kicker: "Changes Worth Making", title: "The bigger picture", html: body };
    },
  };

  // ---- Sheet (native <dialog>) with a back stack ----------------------------

  var Sheet = {
    el: null, stack: [], scrolls: [], pushed: false, awaitingPop: false, getModel: null, navAt: 0,
    init: function (getModel) {
      this.getModel = getModel;
      var el = document.createElement("dialog");
      el.className = "sheet";
      el.setAttribute("aria-labelledby", "sheet-title");
      el.innerHTML =
        '<div class="sheet-inner">' +
        '<div class="sheet-grab" aria-hidden="true"></div>' +
        '<header class="sheet-head">' +
        '<button type="button" class="icon-btn sheet-back" aria-label="Back" hidden>' + icon("back") + "</button>" +
        '<div class="sheet-titles"><p class="sheet-kicker"></p><h2 id="sheet-title"></h2></div>' +
        '<button type="button" class="icon-btn sheet-close" aria-label="Close">' + icon("close") + "</button>" +
        "</header>" +
        '<div class="sheet-body" tabindex="0"></div></div>';
      document.body.appendChild(el);
      this.el = el;
      var self = this;
      el.querySelector(".sheet-close").addEventListener("click", function () { self.close(); });
      el.querySelector(".sheet-back").addEventListener("click", function () { self.back(); });
      el.addEventListener("cancel", function (e) { e.preventDefault(); self.close(); });
      el.addEventListener("click", function (e) { if (e.target === el && !self.justNavigated(e)) self.close(); });
      root.addEventListener("popstate", function () { self.onPop(); });
    },
    open: function (route) {
      if (this.el.open && this.stack[this.stack.length - 1] === route) return; // already showing it
      var view = buildView(this.getModel(), route);
      if (!view) return;
      var body = this.el.querySelector(".sheet-body");
      if (this.el.open) this.scrolls[this.stack.length - 1] = body.scrollTop; // remember where we were
      this.stack.push(route);
      this.navAt = performance.now();
      this.paint(view);
      if (!this.el.open) {
        if (this.el.showModal) this.el.showModal(); else this.el.setAttribute("open", "");
        body.scrollTop = 0;
        body.focus({ preventScroll: true });
        document.documentElement.classList.add("sheet-open");
        if (!this.awaitingPop) {
          try { history.pushState({ sheet: true }, ""); this.pushed = true; } catch (e) { this.pushed = false; }
        }
      }
    },
    back: function () {
      if (this.stack.length < 2) return this.close();
      this.stack.pop();
      this.navAt = performance.now();
      this.paint(buildView(this.getModel(), this.stack[this.stack.length - 1]));
      this.el.querySelector(".sheet-body").scrollTop = this.scrolls[this.stack.length - 1] || 0;
    },
    paint: function (view) {
      var el = this.el;
      el.querySelector(".sheet-kicker").textContent = view.kicker;
      el.querySelector("#sheet-title").textContent = view.title;
      el.querySelector(".sheet-back").hidden = this.stack.length < 2;
      var body = el.querySelector(".sheet-body");
      body.innerHTML = view.html;
      body.scrollTop = 0;
      if (el.open) body.focus({ preventScroll: true }); // the old focus target was just replaced
    },
    // The second tap of a quick double-tap lands on the view that the first tap just opened.
    justNavigated: function (e) { return this.el.open && e.timeStamp - (this.navAt || 0) < 400; },
    close: function (fromPop) {
      if (!this.el.open) return;
      this.stack = [];
      this.scrolls = [];
      this.el.querySelector(".sheet-body").scrollTop = 0;
      if (this.el.close) this.el.close(); else this.el.removeAttribute("open");
      document.documentElement.classList.remove("sheet-open");
      if (this.pushed && !fromPop) { this.pushed = false; this.awaitingPop = true; history.back(); } else { this.pushed = false; }
    },
    // The popstate caused by our own history.back() must not close a sheet opened right after.
    onPop: function () {
      if (this.awaitingPop) {
        this.awaitingPop = false;
        if (this.el.open && !this.pushed) {
          try { history.pushState({ sheet: true }, ""); this.pushed = true; } catch (e) { /* ignore */ }
        }
        return;
      }
      if (this.el.open) this.close(true);
    },
  };

  function buildView(m, route) {
    var i = route.indexOf(":");
    var fn = VIEWS[i < 0 ? route : route.slice(0, i)];
    try { return fn ? fn(m, i < 0 ? undefined : route.slice(i + 1)) : null; } catch (e) {
      if (root.console) console.error("Could not open " + route, e);
      return null;
    }
  }

  // Hover/focus on chart bars updates the chart caption (when there is one).
  function wireCharts(scope) {
    var cap = scope.querySelector(".chart-cap");
    if (!cap) return;
    scope.querySelectorAll("#trend .bar").forEach(function (g) {
      var sel = function () {
        scope.querySelectorAll("#trend .bar").forEach(function (b) { b.classList.toggle("bar-sel", b === g); });
        cap.textContent = g.getAttribute("data-label");
      };
      g.addEventListener("pointerenter", sel);
      g.addEventListener("focus", sel);
    });
  }

  function start() {
    var data = DataSource.load();
    var picker = document.getElementById("company");
    var out = document.getElementById("report");
    var state = { model: null };
    var params = new URLSearchParams(location.search);
    var hash = location.hash.replace("#", "") || params.get("co");

    document.querySelectorAll("[data-brand-name]").forEach(function (el) { el.innerHTML = wordmark(); el.setAttribute("aria-label", CONFIG.brand.name); });
    document.querySelectorAll("[data-brand-logo]").forEach(function (el) { el.innerHTML = logo(28); });

    var swLabel = document.querySelector(".sw-label");
    if (swLabel && data.meta.source !== "demo") swLabel.textContent = "Company";
    picker.innerHTML = data.companies.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>";
    }).join("");
    if (hash && data.companies.some(function (c) { return c.id === hash; })) picker.value = hash;

    Sheet.init(function () { return state.model; });

    function show(id) {
      var c = find(data.companies, function (x) { return x.id === id; }) || data.companies[0];
      state.model = buildReport(c, data.meta.asOf, { live: data.meta.source !== "demo" });
      if (!state.model.integrity.ok && root.console) console.warn("Data integrity problems", state.model.integrity.problems);
      out.innerHTML = render(state.model);
      wireCharts(out);
      var label = document.getElementById("company-label");
      if (label) label.textContent = c.name;
      document.title = c.name + " · Monday Owner Report";
      if (history.replaceState) history.replaceState(null, "", "#" + c.id);
    }

    // One delegated handler for every tappable number on the page and in the sheet.
    function onActivate(e) {
      var t = e.target.closest ? e.target.closest("[data-open]") : null;
      if (!t) return;
      if (e.type === "click" && (e.detail > 1 || Sheet.justNavigated(e))) return;
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      if (e.type === "keydown") e.preventDefault();
      Sheet.open(t.getAttribute("data-open"));
    }
    document.addEventListener("click", onActivate);
    document.addEventListener("keydown", function (e) {
      if (e.target.matches && e.target.matches("button")) return; // buttons already fire click
      onActivate(e);
    });

    // "Mark done" checkboxes on the 3 actions (remembered on this device only).
    out.addEventListener("change", function (e) {
      var box = e.target;
      if (!box.matches || !box.matches("input[data-done]")) return;
      try { if (box.checked) localStorage.setItem(box.getAttribute("data-done"), "1"); else localStorage.removeItem(box.getAttribute("data-done")); } catch (err) { /* private mode */ }
      var li = box.closest(".action");
      if (li) li.classList.toggle("is-done", box.checked);
    });

    picker.addEventListener("change", function () {
      show(picker.value);
      window.scrollTo({ top: 0, behavior: root.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
    root.addEventListener("hashchange", function () {
      var id = location.hash.slice(1);
      if (id && id !== picker.value && data.companies.some(function (c) { return c.id === id; })) {
        Sheet.close(true);
        picker.value = id;
        show(id);
        window.scrollTo(0, 0);
      }
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
