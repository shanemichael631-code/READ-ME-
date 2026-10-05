#!/usr/bin/env node
/*
 * build-jobber-data.js — turn raw Jobber exports into the report's data shape (same as data.js).
 *
 *   node tools/build-jobber-data.js <rawDir> <out.js> [--asof YYYY-MM-DD] [--check]
 *
 * <rawDir> holds compact JSONL pulled from Jobber (one record per line):
 *   jobs-created-*.jsonl     jobs booked in the 8-week window   {id,n,t,c,d,s,ty,v,cid,cn}
 *   jobs-completed-*.jsonl   jobs completed from 5 weeks before  {same}
 *   visits-*.jsonl           visits: job id, assignees, leak notes {id,j,d,un,t,ins}
 *   invoices-*.jsonl         invoices not paid same day + all unpaid {id,n,s,i,u,v,p,b,cid,cn}
 *   quotes.jsonl             quotes created in the window       {id,n,t,s,c,sent,view,appr,u,v,cid,cn}
 *
 * Business rules (job title codes, systems, leak causes, test jobs) follow Nova Filters' weekly
 * totals playbook. Real customer data stays out of git: write <out.js> outside the repo.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const RAW = args[0];
const OUT = args[1];
const ASOF = (args.indexOf("--asof") >= 0 && args[args.indexOf("--asof") + 1]) || "2026-10-05";
const CHECK = args.includes("--check");
if (!RAW || !OUT) { console.error("usage: build-jobber-data.js <rawDir> <out.js> [--asof YYYY-MM-DD] [--check]"); process.exit(1); }

const WEEKS = 8;
const CALLBACK_WINDOW_DAYS = 30;

// ---------- dates (America/New_York) ----------
function nthSunday(year, month, n) { // month 0-based
  const first = new Date(Date.UTC(year, month, 1));
  const firstSun = 1 + ((7 - first.getUTCDay()) % 7);
  return firstSun + 7 * (n - 1);
}
function etOffsetHours(utc) { // -4 during DST (2nd Sun Mar 2am .. 1st Sun Nov 2am local), else -5
  const y = utc.getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7); // 2am EST = 07:00Z
  const end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6); // 2am EDT = 06:00Z
  return utc.getTime() >= start && utc.getTime() < end ? -4 : -5;
}
function etDate(ts) { // ISO timestamp (any offset) -> "YYYY-MM-DD" in Eastern time
  if (!ts) return null;
  const u = new Date(ts);
  if (isNaN(u)) return null;
  return new Date(u.getTime() + etOffsetHours(u) * 3600e3).toISOString().slice(0, 10);
}
function addDays(s, n) { return new Date(Date.parse(s + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
function dow(s) { return (new Date(s + "T00:00:00Z").getUTCDay() + 6) % 7; } // 0 = Monday

// ---------- load ----------
function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(file + ":" + (i + 1) + " bad JSON: " + l.slice(0, 120)); }
  });
}
function loadAll(prefix) {
  const files = fs.readdirSync(RAW).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl") && !f.endsWith(".pages.jsonl")).sort();
  const map = new Map();
  files.forEach((f) => readJsonl(path.join(RAW, f)).forEach((r) => map.set(r.id, Object.assign(map.get(r.id) || {}, r))));
  return { rows: [...map.values()], files };
}

const jobsAll = loadAll("jobs-");
const visitsAll = loadAll("visits-");
const invAll = loadAll("invoices-");
const quotesAll = fs.existsSync(path.join(RAW, "quotes.jsonl")) ? readJsonl(path.join(RAW, "quotes.jsonl")) : [];

// ---------- names (privacy: first name + last initial) ----------
function shortName(full) {
  const n = String(full || "").replace(/\s+/g, " ").trim();
  if (!n) return "Unknown";
  const parts = n.split(" ");
  if (parts.length === 1) return parts[0];
  const last = parts.pop();
  return parts.join(" ") + " " + last.replace(/[^A-Za-z]/g, "").charAt(0).toUpperCase() + ".";
}

// ---------- test / internal jobs ----------
const INTERNAL_CLIENTS = [/zztest/i, /^shane novak$/i, /^brad novak$/i];
function isTest(j) {
  const t = j.t || "", cn = (j.cn || "").trim();
  if (/\btest\b/i.test(t.replace(/water\s*test/ig, "")) || /drop\s*off/i.test(t)) return "title"; // "WATER TEST" is real work
  if (INTERNAL_CLIENTS.some((re) => re.test(cn))) return "internal client";
  if (/^alex$/i.test(cn)) return "Alex test client";
  return null;
}

// ---------- job title codes ----------
const FC_TOKEN = /(^|[^A-Z])FC([^A-Z]|$)/;
function isInstall(T) {
  if (/CONSULT|SERVICE/.test(T) || /^WHF BYPASS\b/.test(T)) return false;
  if (/^WHF\b/.test(T)) return true;
  return /^ADD SOFTY|^ADD RO\b|WHF & SOFTY & RO|SOFTY BOTH SALTS/.test(T);
}
const SERVICE = /SOFTY SERVICE|CHECK SOFTY|CHECK SYSTEM|CHECK WHF|CHECK GAUGE|INSPECT|GAUGE|BOTTLE SWAP|\bPR\b|PRESSURE REGULATOR|WHF BYPASS|CONSULT|RO SERVICE|WHF SERVICE|PR SERVICE|SALT D\/O|REINSTALL|UNINSTALL|REPROGRAM|REPLACE|NO WATER|PRESSURE PROBLEM/;
function bucketOf(title) {
  const T = (title || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (/\bF?PUP\b/.test(T)) return "Parts pickup"; // PUP / FPUP = customer parts pickup
  if (/LEAK|CANITER|SALT BUCKET OVERFLOW/.test(T)) return "Leak";
  if (/UPGRADE/.test(T)) return "Upgrade";
  if (isInstall(T)) return "New install";
  if (/^(CTS )?FC\b|^ROCH\b/.test(T)) return "Filter change"; // FC, FC OL#, CTS FC, ROCH FC, FC SALT D/O
  if (SERVICE.test(T)) return "Service/other"; // an "& FC" on these counts as a bundled FC
  if (FC_TOKEN.test(T)) return "Filter change";
  return "Other";
}
function bundledFC(title, bucket) {
  const T = (title || "").toUpperCase();
  return bucket !== "Filter change" && FC_TOKEN.test(T) && !/AFTER FC/.test(T);
}
function systemsOf(title) { // only meaningful for new installs
  const T = (title || "").toUpperCase();
  const noBypass = T.replace(/WHF BYPASS/g, "");
  return {
    WHF: /\bWHF\b/.test(noBypass) ? 1 : 0,
    Softener: /SOFTENER|SOFTY/.test(T) ? 1 : 0,
    RO: /(^|[^A-Z])RO([^A-Z]|$)/.test(T) ? 1 : 0,
    UV: /\bUV\b/.test(T) ? 1 : 0,
  };
}

// ---------- leak causes (from the visit notes, then the title) ----------
const CAUSES = ["Canister", "O-ring / not tightened", "Softener / salt overflow", "Gauge", "Pressure regulator", "RO", "Cause not noted"];
function causeOf(title, notes) {
  const T = (title || "").toUpperCase();
  const n = (notes || "").toLowerCase();
  if (/SALT BUCKET OVERFLOW|OVERFLOW/.test(T)) return "Softener / salt overflow";
  if (/O ?-?RING/.test(T)) return "O-ring / not tightened";
  if (/CANIT|CANITER|CANISTER/.test(T)) return "Canister";
  if (/crack|pinhole|pin hole|split|canister|canaster|cannister|housing|sump/.test(n)) return "Canister";
  if (/o-?ring|oring|o ring|not tight|loose|tighten|cross ?thread/.test(n)) return "O-ring / not tightened";
  if (/overflow|salt|brine|softener|softy/.test(n)) return "Softener / salt overflow";
  if (/gauge|gage/.test(n)) return "Gauge";
  if (/regulator|\bprv?\b|pressure reducing/.test(n)) return "Pressure regulator";
  if (/\bro\b|reverse osmosis|tank/.test(n)) return "RO";
  return "Cause not noted";
}

// ---------- weeks ----------
const lastMonday = addDays(ASOF, -7);
const weekStarts = Array.from({ length: WEEKS }, (_, i) => addDays(lastMonday, -7 * (WEEKS - 1 - i)));
const windowStart = weekStarts[0], windowEnd = addDays(lastMonday, 6);
function weekIndex(date) {
  if (!date || date < windowStart || date > windowEnd) return -1;
  return Math.floor(daysBetween(windowStart, date) / 7);
}

// ---------- jobs ----------
const dropped = [];
const jobs = [];
jobsAll.rows.forEach((j) => {
  const why = isTest(j);
  if (why) { dropped.push({ n: j.n, t: j.t, cn: j.cn, why }); return; }
  const bucket = bucketOf(j.t);
  jobs.push({
    id: j.id, n: j.n, title: j.t, bucket,
    created: etDate(j.c), completed: etDate(j.d),
    total: Math.round(Number(j.v) || 0),
    cid: j.cid, customer: shortName(j.cn),
  });
});
const jobById = new Map(jobs.map((j) => [j.id, j]));

// ---------- visits -> who did each job ----------
const visitsByJob = new Map();
visitsAll.rows.forEach((v) => { if (!visitsByJob.has(v.j)) visitsByJob.set(v.j, []); visitsByJob.get(v.j).push(v); });
// Who did the work: the assigned crew, or whoever marked the visit complete when nobody was assigned.
function crewOf(jobId) {
  const vs = (visitsByJob.get(jobId) || []).filter((v) => v.d && ((v.un && v.un.length) || v.by)).sort((a, b) => (a.d < b.d ? 1 : -1));
  if (!vs.length) return [];
  return vs[0].un && vs[0].un.length ? vs[0].un : [vs[0].by];
}
function notesOf(jobId) {
  return (visitsByJob.get(jobId) || []).map((v) => v.ins || "").filter(Boolean).join(" | ");
}

// Office staff: people who mark visits complete but are never assigned to field work.
const assignedNames = new Set();
visitsAll.rows.forEach((v) => { if (!/\bPUP\b/i.test(v.t || "")) (v.un || []).forEach((n) => assignedNames.add(n)); });
const OFFICE = new Set();
visitsAll.rows.forEach((v) => { if (v.by && v.by !== "Deleted User" && !assignedNames.has(v.by)) OFFICE.add(v.by); });
function displayName(full) { return full === "Deleted User" ? "Former tech (account deleted)" : shortName(full); }

// Completed work in the report (parts pickups are counter sales, not field jobs).
const done = jobs.filter((j) => j.completed && j.bucket !== "Parts pickup");
const techKey = (name) => "t-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const techMeta = new Map(); // id -> {id, name, full, revenue8, installRevenue8}
function techFor(job) {
  const crew = crewOf(job.id);
  const lead = crew[0];
  if (!lead) return "unassigned";
  if (OFFICE.has(lead)) return "office";
  const id = techKey(lead);
  if (!techMeta.has(id)) techMeta.set(id, { id, full: lead, name: displayName(lead), revenue8: 0, installRevenue8: 0, jobs8: 0 });
  return id;
}
done.forEach((j) => { j.techId = techFor(j); });

const inWindowDone = done.filter((j) => weekIndex(j.completed) >= 0);
inWindowDone.forEach((j) => {
  const m = techMeta.get(j.techId);
  if (!m) return;
  m.revenue8 += j.total; m.jobs8 += 1;
  if (j.bucket === "New install" || j.bucket === "Upgrade") m.installRevenue8 += j.total;
});

const techs = [...techMeta.values()].filter((m) => m.jobs8 > 0).sort((a, b) => b.revenue8 - a.revenue8).map((m) => {
  const installer = m.revenue8 > 0 && m.installRevenue8 / m.revenue8 >= 0.5;
  return { id: m.id, name: m.name, role: installer ? "Installer" : "Service tech", group: installer ? "Installer" : "Service tech" };
});
if (inWindowDone.some((j) => j.techId === "office")) techs.push({ id: "office", name: "Office", role: "Closed out by the office", field: false });
if (inWindowDone.some((j) => j.techId === "unassigned")) techs.push({ id: "unassigned", name: "No tech on record", role: "No visit found in Jobber", field: false });

// ---------- callbacks: leak calls traced to our own recent work ----------
const leakJobs = jobs.filter((j) => j.bucket === "Leak" && weekIndex(j.created) >= 0);
const priorByClient = new Map();
done.forEach((j) => { if (!priorByClient.has(j.cid)) priorByClient.set(j.cid, []); priorByClient.get(j.cid).push(j); });
const callbacks = [];
leakJobs.forEach((lj) => {
  lj.cause = causeOf(lj.title, notesOf(lj.id));
  const prior = (priorByClient.get(lj.cid) || [])
    .filter((p) => p.id !== lj.id && p.completed <= lj.created && daysBetween(p.completed, lj.created) <= CALLBACK_WINDOW_DAYS)
    .sort((a, b) => (a.completed < b.completed ? 1 : -1))[0];
  lj.prior = prior || null;
  if (prior && prior.techId !== "unassigned" && prior.techId !== "office") {
    callbacks.push({
      date: lj.created, techId: prior.techId, customer: lj.customer, issue: lj.cause,
      jobNumber: lj.n, after: prior.bucket.toLowerCase() + " on " + prior.completed + " (job #" + prior.n + ")",
    });
  }
});
callbacks.sort((a, b) => (a.date < b.date ? -1 : 1));

// ---------- weeks ----------
const weeks = weekStarts.map((ws, i) => {
  const wDone = inWindowDone.filter((j) => weekIndex(j.completed) === i);
  const booked = jobs.filter((j) => weekIndex(j.created) === i);
  const daily = [0, 0, 0, 0, 0, 0, 0];
  wDone.forEach((j) => { daily[dow(j.completed)] += j.total; });
  const byTech = new Map();
  wDone.forEach((j) => {
    const s = byTech.get(j.techId) || { techId: j.techId, jobs: 0, revenue: 0, addOns: 0 };
    s.jobs += 1; s.revenue += j.total;
    if (j.bucket === "New install" || j.bucket === "Upgrade") s.addOns += 1;
    byTech.set(j.techId, s);
  });
  const bookedBy = {};
  booked.forEach((j) => { bookedBy[j.bucket] = (bookedBy[j.bucket] || 0) + 1; });
  const sys = { WHF: 0, Softener: 0, RO: 0, UV: 0 };
  booked.filter((j) => j.bucket === "New install").forEach((j) => { const s = systemsOf(j.title); Object.keys(sys).forEach((k) => { sys[k] += s[k]; }); });
  Object.keys(sys).forEach((k) => { if (!sys[k]) delete sys[k]; });
  const leaks = booked.filter((j) => j.bucket === "Leak");
  const causes = {};
  leaks.forEach((j) => { causes[j.cause] = (causes[j.cause] || 0) + 1; });
  return {
    weekStart: ws,
    revenue: wDone.reduce((s, j) => s + j.total, 0),
    jobsCompleted: wDone.length,
    dailyRevenue: daily,
    techStats: [...byTech.values()],
    metrics: {
      booked: booked.length,
      systems: Object.values(sys).reduce((a, b) => a + b, 0),
      leakCalls: leaks.length,
      fcsBooked: (bookedBy["Filter change"] || 0) + booked.filter((j) => bundledFC(j.title, j.bucket)).length,
    },
    breakdown: { booked: bookedBy, systems: sys, callbacks: causes },
  };
});

// ---------- quotes ----------
const quotes = quotesAll.map((q) => {
  const st = q.s;
  const status = st === "approved" || st === "converted" ? "won" : st === "archived" ? "lost" : st === "awaiting_response" || st === "changes_requested" ? "open" : null;
  if (!status || !q.sent) return null;
  return {
    id: "Q" + q.n, customer: shortName(q.cn), service: String(q.t || "Quote").trim(), amount: Math.round(Number(q.v) || 0),
    techId: null, sentDate: etDate(q.sent), status,
    decidedDate: status === "won" ? etDate(q.appr || q.u) : status === "lost" ? etDate(q.u) : null,
    viewedDate: etDate(q.view),
  };
}).filter(Boolean).filter((q) => q.sentDate <= windowEnd).sort((a, b) => (a.sentDate < b.sentDate ? -1 : 1));

// ---------- invoices (only ones that could be open at a week's end) ----------
const invoices = invAll.rows.map((x) => {
  if (["bad_debt", "voided", "draft"].includes(x.s)) return null;
  const issued = etDate(x.i);
  if (!issued || issued > windowEnd) return null;
  const paid = x.s === "paid" ? etDate(x.paidAt || x.u) : null; // paidAt when verified, else last update
  if (paid && paid <= issued) return null; // paid the day it was issued: never open at a week's end
  return {
    id: "INV-" + x.n, customer: shortName(x.cn), description: "Invoice #" + x.n,
    amount: Math.round(x.s === "paid" ? Number(x.v) : Number(x.b) > 0 ? Number(x.b) : Number(x.v)),
    issuedDate: issued, paidDate: paid,
  };
}).filter(Boolean).sort((a, b) => (a.issuedDate < b.issuedDate ? -1 : 1));

// ---------- callback cost: the average filter-change ticket (the paid stop a free trip replaces) ----------
const fcDone = inWindowDone.filter((j) => j.bucket === "Filter change" && j.total > 0);
const avgFc = fcDone.length ? Math.round(fcDone.reduce((s, j) => s + j.total, 0) / fcDone.length) : 0;

const company = {
  id: "nova",
  name: "Nova Filters",
  trade: "Water Treatment",
  serviceArea: "Wildwood & The Villages, FL",
  sourceName: "Jobber",
  revenueBasis: "completed",
  quoteTracking: "viewed",
  callbackCostEstimate: avgFc,
  avgAddOnValue: 0,
  scorecard: ["revenue", "jobs", "avgTicket", "closeRate", "booked", "unpaid30", "callbacks", "systems"],
  features: { reviews: false, addOnCoaching: false, rampPlans: false },
  labels: {
    tile_jobs: "Jobs Done",
    addOns: "Installs", addOn: "install or upgrade", addOnRate: "of jobs were installs or upgrades",
    redoVisit: "free return visit", callback: "callback",
    callbackLeakDetail: "{n} within " + CALLBACK_WINDOW_DAYS + " days of our own visit × ~{cost} each. Each free trip back takes a paid route slot.",
    callbackCostNote: "A callback here is a leak call booked within " + CALLBACK_WINDOW_DAYS + " days of a completed Nova visit at the same customer, credited to the tech who did that visit. Each free trip back is valued at {cost}, your average filter-change ticket: the paid stop that slot could have been.",
    checklistTitle: "Add a leak check to every filter change",
  },
  notes: {
    revenue: "Revenue = the value of jobs completed that week in Jobber, before tax. Parts pickups at the counter are left out.",
    booked: "Counted by the day the job was booked in Jobber, done or not. Test and internal jobs are left out.",
    systems: "Systems on new installs booked that week (whole-house filter, softener, RO, UV). Bypasses, faucets, salt and upgrades don't count.",
    closeRate: "Quotes come from Jobber. Won = approved or converted to a job; lost = archived.",
  },
  playbook: {
    checklistSteps: [
      "Before leaving every filter change: clean and lube each O-ring, seat it, and tighten each canister the way the housing maker specifies.",
      "Turn the water back on, wait 2 minutes, and wipe every canister and the head with a dry paper towel. Take a photo in Jobber.",
      "Tag every leak call with its cause (canister, O-ring, salt overflow, gauge, regulator) so this report can trace it.",
      "Go over the week's callbacks at the Monday huddle, 5 minutes, no blame.",
    ],
    coachSteps: [
      "Pull {first}'s callback list and look for a pattern: canisters, O-rings, or one kind of system.",
      "Ride a full route with {first} and watch every closeout: O-rings, tightening, and the 2-minute dry check.",
      "Cap {first}'s daily stops at the team average until the callbacks drop.",
      "Call every callback customer personally within 24 hours.",
    ],
  },
  techs,
  weeks,
  quotes,
  invoices,
  callbacks,
  reviews: [],
};

const data = {
  meta: { asOf: ASOF, source: "jobber", note: "Real Nova Filters data from Jobber. Customer names shortened to first name + last initial." },
  companies: [company],
};

// ---------- output ----------
function line(o) { return JSON.stringify(o); }
const body =
  "/* Monday Owner Report data for Nova Filters, built from Jobber by tools/build-jobber-data.js.\n" +
  " * PRIVATE: real customer data. Do not commit or publish publicly. */\n" +
  "window.REPORT_DATA = {\n meta: " + line(data.meta) + ",\n companies: [{\n" +
  Object.keys(company).filter((k) => !Array.isArray(company[k])).map((k) => "  " + k + ": " + line(company[k])).join(",\n") + ",\n" +
  ["techs", "weeks", "quotes", "invoices", "callbacks", "reviews"].map((k) => "  " + k + ": [" + (company[k].length ? "\n" + company[k].map((x) => "   " + line(x)).join(",\n") + "\n  " : "") + "]").join(",\n") +
  "\n }],\n};\n";
fs.writeFileSync(OUT, body);

// ---------- report to the console ----------
const W = (i) => weeks[i];
console.log("files:", jobsAll.files.length, "job files,", visitsAll.files.length, "visit files,", invAll.files.length, "invoice files");
console.log("jobs:", jobs.length, "real,", dropped.length, "dropped as test/internal; completed in window:", inWindowDone.length, "; techs:", techs.map((t) => t.name + " (" + t.role + ")").join(", "));
console.log("unassigned completed jobs in window:", inWindowDone.filter((j) => j.techId === "unassigned").length, "; office:", inWindowDone.filter((j) => j.techId === "office").length, "; office staff:", [...OFFICE].join(", "));
console.log("leak calls in window:", leakJobs.length, "; traced callbacks:", callbacks.length, "; avg FC ticket:", avgFc);
console.log("quotes:", quotes.length, "(open", quotes.filter((q) => q.status === "open").length + ")", "; invoices kept:", invoices.length, "(unpaid now", invoices.filter((x) => !x.paidDate).length + ")");
weeks.forEach((w) => console.log(" ", w.weekStart, "rev", w.revenue, "jobs", w.jobsCompleted, "booked", w.metrics.booked, "systems", w.metrics.systems, "leaks", w.metrics.leakCalls, "FCs", w.metrics.fcsBooked, JSON.stringify(w.breakdown.booked)));
if (CHECK) {
  // Reference week from the weekly-totals playbook: Sep 21-27, 2026.
  const i = weekStarts.indexOf("2026-09-21");
  if (i >= 0) {
    const w = W(i);
    const booked = jobs.filter((j) => weekIndex(j.created) === i);
    console.log("\nCHECK Sep 21-27 (expected: 325 jobs; 50 installs = 66 systems (41 WHF, 23 softeners, 2 RO); 19 upgrades; 166 FCs + 16 bundled; 39 leaks: 24 canister, 6 softener/salt, 4 O-ring, 2 gauge, 1 PR, 1 RO, 1 unknown)");
    console.log("  got:", w.metrics.booked, "jobs;", w.breakdown.booked["New install"], "installs =", w.metrics.systems, "systems", JSON.stringify(w.breakdown.systems), ";", w.breakdown.booked.Upgrade, "upgrades;",
      w.breakdown.booked["Filter change"], "FCs +", booked.filter((j) => bundledFC(j.title, j.bucket)).length, "bundled;", w.metrics.leakCalls, "leaks", JSON.stringify(w.breakdown.callbacks));
    const other = booked.filter((j) => j.bucket === "Other");
    if (other.length) console.log("  Other titles:", other.map((j) => "#" + j.n + " " + j.title).join(" | "));
  }
  console.log("dropped:", dropped.slice(0, 40).map((d) => "#" + d.n + " " + d.t + " [" + d.cn + "] " + d.why).join(" | "));
}
