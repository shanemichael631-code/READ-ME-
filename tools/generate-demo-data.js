#!/usr/bin/env node
/*
 * Generates data.js — the fake demo data for the Monday Owner Report.
 *
 *   node tools/generate-demo-data.js > data.js
 *
 * Output is deterministic (seeded RNG), so re-running gives identical data.
 * Each company has a "story" baked into its parameters:
 *   Plumbing  — growing fast, quotes not followed up
 *   HVAC      — strong revenue, old unpaid invoices piling up
 *   Pest      — steady, one tech's callbacks rising
 * ALL NAMES AND NUMBERS ARE FAKE.
 */

const AS_OF = "2026-10-05"; // the Monday the report is delivered
const WEEKS = 8;

// ---------- helpers ----------
function rng(seed) {
  // mulberry32
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const toDate = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(toDate(s).getTime() + n * 864e5));
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
const round = (n, to) => Math.round(n / to) * to;

const FIRST = ["Linda", "Tom", "Rosa", "Greg", "Angela", "Brian", "Carmen", "Derek", "Elaine", "Frank",
  "Gloria", "Harold", "Irene", "Jerry", "Karen", "Larry", "Monica", "Neil", "Olivia", "Pete",
  "Quinn", "Rhonda", "Steve", "Tina", "Ursula", "Vince", "Wendy", "Xavier", "Yolanda", "Zach",
  "Barb", "Cliff", "Deb", "Earl", "Faye", "Gus", "Holly", "Ike", "Janet", "Kurt", "Lorraine",
  "Marty", "Nancy", "Otis", "Patty", "Roger", "Shirley", "Ted", "Valerie", "Walt", "Bonnie",
  "Chuck", "Dottie", "Ernie", "Fran", "Gail", "Herb", "Iris", "Joyce", "Kim", "Lou", "Mabel"];
const LAST_INITIALS = "ABCDEFGHJKLMNOPRSTVWY";

function namePicker(r, reserved) {
  const used = new Set(reserved);
  return function () {
    for (let i = 0; i < 500; i++) {
      const n = FIRST[Math.floor(r() * FIRST.length)] + " " + LAST_INITIALS[Math.floor(r() * LAST_INITIALS.length)] + ".";
      if (!used.has(n)) { used.add(n); return n; }
    }
    throw new Error("ran out of names");
  };
}

function pickWeighted(r, items) {
  const total = items.reduce((s, x) => s + (x.weight || 1), 0);
  let roll = r() * total;
  for (const x of items) { roll -= x.weight || 1; if (roll <= 0) return x; }
  return items[items.length - 1];
}

const WEEK_STARTS = Array.from({ length: WEEKS }, (_, i) => addDays(AS_OF, -7 * (WEEKS - i)));

// ---------- per-company builders ----------
function buildCompany(cfg) {
  const r = rng(cfg.seed);
  const pickName = namePicker(r, cfg.reservedNames || []);
  const weeks = [];

  // Weekly tech stats + daily revenue
  WEEK_STARTS.forEach((ws, w) => {
    const techStats = cfg.techs.map((t) => {
      const jobs = Math.max(1, Math.round(t.baseJobs * cfg.growth[w] * (t.ramp ? t.ramp[w] : 1) * (0.93 + r() * 0.14)));
      const revenue = round(jobs * t.ticket * (0.92 + r() * 0.16), 5);
      const addOns = Math.round(jobs * t.addOnRate * (0.8 + r() * 0.4));
      return { techId: t.id, jobs, revenue, addOns };
    });
    const revenue = techStats.reduce((s, t) => s + t.revenue, 0);
    const jobsCompleted = techStats.reduce((s, t) => s + t.jobs, 0);
    // split revenue Mon..Sun
    const weights = cfg.dayWeights.map((x, d) => x * (0.85 + r() * 0.3) * (w === WEEKS - 1 && d === cfg.lastWeekBestDay ? 1.25 : 1));
    const wSum = weights.reduce((a, b) => a + b, 0);
    const dailyRevenue = weights.map((x) => round((revenue * x) / wSum, 5));
    const drift = revenue - dailyRevenue.reduce((a, b) => a + b, 0);
    dailyRevenue[0] += drift; // keep the daily split summing exactly to the week total
    weeks.push({ weekStart: ws, revenue, jobsCompleted, newLeads: cfg.leads[w], dailyRevenue, techStats });
  });

  // Quotes: generated per week, won/lost decided week by week
  const quotes = [];
  let qn = 1;
  const pool = [];
  WEEK_STARTS.forEach((ws, w) => {
    for (let i = 0; i < cfg.quotesSent[w]; i++) {
      const svc = pickWeighted(r, cfg.services);
      const q = {
        id: cfg.id.slice(0, 2).toUpperCase() + "-Q" + String(1000 + qn++),
        customer: pickName(),
        service: svc.name,
        amount: round(svc.min + r() * (svc.max - svc.min), 25),
        techId: cfg.techs[Math.floor(r() * cfg.techs.length)].id,
        sentDate: addDays(ws, Math.floor(r() * 6)),
        status: "open",
        decidedDate: null,
        lastFollowUpDate: null,
      };
      quotes.push(q);
      pool.push(q);
    }
    const weekEnd = addDays(ws, 6);
    // wins this week, oldest-first-ish from quotes that are at least a day old
    const target = Math.round(cfg.quotesSent[w] * cfg.closeRate[w]);
    const eligible = pool.filter((q) => q.status === "open" && daysBetween(q.sentDate, weekEnd) >= 1)
      .sort((a, b) => (a.sentDate < b.sentDate ? -1 : 1) + (r() - 0.5) * 1.2);
    for (let i = 0; i < target && i < eligible.length; i++) {
      const q = eligible[i];
      const earliest = q.sentDate >= ws ? addDays(q.sentDate, 1) : ws;
      const span = Math.max(0, daysBetween(earliest, weekEnd));
      q.status = "won";
      q.decidedDate = addDays(earliest, Math.floor(r() * (span + 1)));
      if (daysBetween(q.sentDate, q.decidedDate) >= 2) q.lastFollowUpDate = addDays(q.sentDate, 1 + Math.floor(r() * (daysBetween(q.sentDate, q.decidedDate) - 1)));
    }
    // older open quotes slowly get lost / expire
    pool.filter((q) => q.status === "open" && daysBetween(q.sentDate, weekEnd) > 14).forEach((q) => {
      if (r() < cfg.lossRate) { q.status = "lost"; q.decidedDate = addDays(ws, Math.floor(r() * 7)); if (q.decidedDate < q.sentDate) q.decidedDate = q.sentDate; q.lastFollowUpDate = q.lastFollowUpDate || addDays(q.sentDate, 3); }
    });
  });
  // follow-up status on quotes still open at report time.
  // Quotes older than 2 weeks have mostly been marked lost; the rest got at least one follow-up.
  quotes.filter((q) => q.status === "open").forEach((q) => {
    const age = daysBetween(q.sentDate, AS_OF);
    if (age > 14) {
      if (r() < 0.8) { q.status = "lost"; q.decidedDate = addDays(q.sentDate, 14 + Math.floor(r() * (age - 14))); }
      q.lastFollowUpDate = addDays(q.sentDate, 3 + Math.floor(r() * 4));
    } else if (age >= 3 && r() < cfg.followUpRate) {
      q.lastFollowUpDate = addDays(q.sentDate, 2 + Math.floor(r() * Math.max(1, age - 3)));
    }
  });
  (cfg.quoteAnchors || []).forEach((a) => quotes.push(Object.assign({ id: cfg.id.slice(0, 2).toUpperCase() + "-Q" + String(1000 + qn++), status: "open", decidedDate: null, lastFollowUpDate: null }, a)));
  quotes.sort((a, b) => (a.sentDate < b.sentDate ? -1 : a.sentDate > b.sentDate ? 1 : 0));

  // Callbacks
  const callbacks = [];
  WEEK_STARTS.forEach((ws, w) => {
    cfg.techs.forEach((t) => {
      const n = cfg.callbacksByTech[t.id][w];
      for (let i = 0; i < n; i++) {
        const cb = { date: addDays(ws, Math.floor(r() * 6)), techId: t.id, customer: pickName(), issue: cfg.callbackIssues[Math.floor(r() * cfg.callbackIssues.length)] };
        if (cfg.recurringPlanValue) cb.recurringPlanValue = cfg.recurringPlanValue[Math.floor(r() * cfg.recurringPlanValue.length)];
        callbacks.push(cb);
      }
    });
  });
  callbacks.sort((a, b) => (a.date < b.date ? -1 : 1));

  // Reviews
  const reviews = [];
  WEEK_STARTS.forEach((ws, w) => {
    for (let i = 0; i < cfg.reviewsPerWeek[w]; i++) {
      const t = cfg.techs[Math.floor(r() * cfg.techs.length)];
      const rating = r() < 0.86 ? 5 : 4;
      const text = cfg.reviewTexts[Math.floor(r() * cfg.reviewTexts.length)].replace("{tech}", t.name.split(" ")[0]);
      reviews.push({ date: addDays(ws, Math.floor(r() * 7)), customer: pickName(), rating, techId: t.id, text });
    }
  });
  (cfg.reviewAnchors || []).forEach((a) => reviews.push(a));
  reviews.sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    id: cfg.id,
    name: cfg.name,
    trade: cfg.trade,
    serviceArea: cfg.serviceArea,
    callbackCostEstimate: cfg.callbackCostEstimate, // est. cost of one redo visit (labor + truck + materials)
    avgAddOnValue: cfg.avgAddOnValue, // avg $ of one add-on / upsell line item
    techs: cfg.techs.map((t) => ({ id: t.id, name: t.name, role: t.role })),
    weeks,
    quotes,
    invoices: cfg.invoices,
    callbacks,
    reviews,
  };
}

// ---------- the three demo companies ----------
const plumbing = buildCompany({
  seed: 101,
  id: "plumbing",
  name: "Demo Plumbing Co.",
  trade: "Plumbing",
  serviceArea: "Ocala & The Villages, FL",
  callbackCostEstimate: 185,
  avgAddOnValue: 140,
  reservedNames: ["Linda R.", "Tom B.", "Rosa M."],
  growth: [1.0, 1.04, 1.09, 1.13, 1.18, 1.23, 1.28, 1.42],
  leads: [58, 61, 65, 70, 72, 78, 83, 91],
  dayWeights: [1.0, 0.95, 0.97, 1.05, 0.92, 0.38, 0.06],
  lastWeekBestDay: 3,
  techs: [
    { id: "p1", name: "Mike D.", role: "Lead Plumber", baseJobs: 17, ticket: 465, addOnRate: 0.22 },
    { id: "p2", name: "Carlos R.", role: "Plumber", baseJobs: 16, ticket: 420, addOnRate: 0.12 },
    { id: "p3", name: "Jenna S.", role: "Plumber", baseJobs: 15, ticket: 435, addOnRate: 0.14 },
    { id: "p4", name: "Tyler B.", role: "Plumber", baseJobs: 14, ticket: 395, addOnRate: 0.09 },
    { id: "p5", name: "Andre W.", role: "Apprentice (hired Aug)", baseJobs: 12, ticket: 330, addOnRate: 0.05, ramp: [0.35, 0.4, 0.45, 0.5, 0.52, 0.55, 0.58, 0.6] },
  ],
  quotesSent: [12, 13, 14, 15, 16, 17, 18, 19],
  closeRate: [0.47, 0.44, 0.44, 0.42, 0.38, 0.35, 0.33, 0.27],
  lossRate: 0.35,
  followUpRate: 0.4,
  services: [
    { name: "Water heater replacement", min: 1650, max: 2450, weight: 5 },
    { name: "Tankless conversion", min: 3400, max: 4900, weight: 2 },
    { name: "Whole-home repipe (PEX)", min: 5800, max: 9200, weight: 1 },
    { name: "Sewer line spot repair", min: 2200, max: 4200, weight: 2 },
    { name: "Water softener + filter install", min: 1800, max: 3200, weight: 2 },
    { name: "Slab leak reroute", min: 1400, max: 2600, weight: 2 },
    { name: "Fixture + shutoff valve package", min: 450, max: 950, weight: 4 },
    { name: "Drain jetting + camera", min: 425, max: 725, weight: 4 },
  ],
  quoteAnchors: [
    { customer: "Linda R.", service: "Tankless conversion", amount: 3850, techId: "p1", sentDate: "2026-09-28" },
    { customer: "Tom B.", service: "Water heater replacement", amount: 1975, techId: "p3", sentDate: "2026-09-29" },
    { customer: "Rosa M.", service: "Sewer line spot repair", amount: 2650, techId: "p2", sentDate: "2026-09-26" },
  ],
  callbacksByTech: {
    p1: [0, 0, 1, 0, 0, 0, 1, 0],
    p2: [1, 0, 0, 1, 0, 1, 0, 1],
    p3: [0, 1, 0, 0, 1, 0, 0, 0],
    p4: [1, 0, 1, 0, 1, 1, 0, 1],
    p5: [0, 0, 1, 1, 0, 1, 1, 1],
  },
  callbackIssues: ["Drip at new shutoff valve", "Water heater pilot out again", "Slow drain returned", "Toilet still running", "Leak at PEX fitting", "Disposal jammed again"],
  reviewsPerWeek: [3, 4, 3, 5, 4, 5, 5, 6],
  reviewTexts: [
    "{tech} showed up on time, explained everything, and the price matched the quote. Will use again.",
    "Water heater went out on a Sunday and {tech} had us back in hot water by noon Monday. Lifesavers.",
    "Very professional. {tech} put on shoe covers and left the bathroom cleaner than before.",
    "{tech} found the leak fast and didn't try to upsell us on stuff we didn't need.",
    "Fair price, clear communication, and {tech} sent photos of the work. Highly recommend.",
    "Called at 8, {tech} was here by 11. Fixed our main line backup and walked me through the camera video.",
  ],
  reviewAnchors: [
    { date: "2026-10-01", customer: "Harriet K.", rating: 5, techId: "p1", text: "Mike replaced our 18-year-old water heater, hauled the old one away, and caught a bad expansion tank before it flooded the garage. Best plumber we've had in 20 years in The Villages." },
  ],
  invoices: [
    { id: "PL-I5501", customer: "Doug K.", description: "Slab leak reroute — balance", amount: 640, issuedDate: "2026-08-28", paidDate: null },
    { id: "PL-I5512", customer: "Ana P.", description: "Water heater replacement", amount: 1180, issuedDate: "2026-09-02", paidDate: null },
    { id: "PL-I5530", customer: "Rick H.", description: "Drain jetting", amount: 525, issuedDate: "2026-09-15", paidDate: null },
    { id: "PL-I5544", customer: "Lucy N.", description: "Fixture package", amount: 780, issuedDate: "2026-09-24", paidDate: null },
    { id: "PL-I5420", customer: "Martin G.", description: "Sewer spot repair", amount: 2950, issuedDate: "2026-07-22", paidDate: "2026-08-26" },
    { id: "PL-I5466", customer: "Bev T.", description: "Repipe deposit balance", amount: 1600, issuedDate: "2026-08-10", paidDate: "2026-09-14" },
    { id: "PL-I5478", customer: "Sid A.", description: "Water heater replacement", amount: 1890, issuedDate: "2026-08-14", paidDate: "2026-09-08" },
  ],
});

const hvac = buildCompany({
  seed: 202,
  id: "hvac",
  name: "Demo Air HVAC",
  trade: "HVAC",
  serviceArea: "Leesburg, Clermont & Lake County, FL",
  callbackCostEstimate: 240,
  avgAddOnValue: 225,
  growth: [1.0, 1.03, 1.0, 1.05, 1.02, 1.04, 1.01, 1.06],
  leads: [86, 90, 92, 88, 91, 87, 93, 95],
  dayWeights: [1.0, 1.02, 0.98, 1.0, 0.95, 0.45, 0.1],
  lastWeekBestDay: 1,
  techs: [
    { id: "h1", name: "Ray M.", role: "Install Lead", baseJobs: 13, ticket: 780, addOnRate: 0.25 },
    { id: "h2", name: "Luis G.", role: "Service Tech", baseJobs: 18, ticket: 520, addOnRate: 0.2 },
    { id: "h3", name: "Kevin H.", role: "Service Tech", baseJobs: 17, ticket: 505, addOnRate: 0.17 },
    { id: "h4", name: "Dana P.", role: "Service Tech", baseJobs: 17, ticket: 490, addOnRate: 0.22 },
    { id: "h5", name: "Josh T.", role: "Service Tech", baseJobs: 16, ticket: 470, addOnRate: 0.14 },
    { id: "h6", name: "Sam K.", role: "Maintenance Tech", baseJobs: 19, ticket: 345, addOnRate: 0.18 },
  ],
  quotesSent: [22, 24, 23, 25, 24, 26, 25, 27],
  closeRate: [0.5, 0.52, 0.48, 0.52, 0.5, 0.54, 0.52, 0.56],
  lossRate: 0.45,
  followUpRate: 0.85,
  services: [
    { name: "AC system replacement (3-ton)", min: 7800, max: 11800, weight: 2 },
    { name: "Air handler replacement", min: 3900, max: 5600, weight: 2 },
    { name: "Evaporator coil replacement", min: 2100, max: 3300, weight: 3 },
    { name: "Duct replacement", min: 4200, max: 7400, weight: 1 },
    { name: "Comfort Club maintenance plan", min: 189, max: 289, weight: 4 },
    { name: "UV light + IAQ package", min: 650, max: 1250, weight: 3 },
  ],
  callbacksByTech: {
    h1: [0, 1, 0, 0, 1, 0, 0, 0],
    h2: [1, 0, 0, 1, 0, 0, 1, 0],
    h3: [0, 1, 1, 0, 0, 1, 0, 1],
    h4: [0, 0, 0, 1, 1, 0, 1, 0],
    h5: [1, 1, 0, 0, 0, 1, 0, 1],
    h6: [0, 0, 1, 0, 1, 0, 1, 0],
  },
  callbackIssues: ["Capacitor failed again", "Condensate line clogged", "Thermostat not holding temp", "Refrigerant leak at service valve", "Float switch tripping"],
  reviewsPerWeek: [5, 4, 6, 5, 6, 5, 6, 7],
  reviewTexts: [
    "AC died in 95 degree heat. {tech} had it running in an hour. Can't thank them enough.",
    "{tech} was honest — said our system had a few years left and just fixed the capacitor. Earned a customer for life.",
    "Great install crew. {tech} explained the new thermostat and left the place spotless.",
    "On time, friendly, and {tech} showed me photos of the dirty coil before and after.",
    "Signed up for the maintenance plan after {tech}'s visit. Worth it for the priority service alone.",
  ],
  reviewAnchors: [
    { date: "2026-09-30", customer: "Bill & Jan F.", rating: 5, techId: "h1", text: "Ray and the crew swapped our whole system in one day, pulled the permit, and the house is 6 degrees cooler on the same setting. Power bill already looks better." },
  ],
  invoices: [
    { id: "HV-I8801", customer: "Victor L.", description: "Condenser replacement", amount: 1375, issuedDate: "2026-07-28", paidDate: null },
    { id: "HV-I8812", customer: "Gary P.", description: "AC system replacement — balance due", amount: 6850, issuedDate: "2026-08-06", paidDate: null },
    { id: "HV-I8834", customer: "Teresa W.", description: "Duct replacement", amount: 4275, issuedDate: "2026-08-20", paidDate: null },
    { id: "HV-I8841", customer: "Ron B.", description: "3 rental units — repairs (property mgr)", amount: 3120, issuedDate: "2026-08-25", paidDate: null },
    { id: "HV-I8850", customer: "Paula J.", description: "Evaporator coil replacement", amount: 2480, issuedDate: "2026-08-31", paidDate: null },
    { id: "HV-I8856", customer: "Hank S.", description: "Service call + capacitor", amount: 540, issuedDate: "2026-09-02", paidDate: null },
    { id: "HV-I8858", customer: "Dwayne H.", description: "Air handler motor", amount: 1940, issuedDate: "2026-09-03", paidDate: null },
    { id: "HV-I8860", customer: "Megan C.", description: "UV light + IAQ package", amount: 865, issuedDate: "2026-09-04", paidDate: null },
    { id: "HV-I8872", customer: "Alicia F.", description: "Air handler replacement", amount: 3600, issuedDate: "2026-09-12", paidDate: null },
    { id: "HV-I8879", customer: "Brent O.", description: "Duct repair", amount: 2150, issuedDate: "2026-09-18", paidDate: null },
    { id: "HV-I8890", customer: "Nora E.", description: "Service call + refrigerant", amount: 780, issuedDate: "2026-09-24", paidDate: null },
    { id: "HV-I8897", customer: "Omar Z.", description: "Coil cleaning + drain", amount: 1260, issuedDate: "2026-09-29", paidDate: null },
    { id: "HV-I8701", customer: "Craig N.", description: "Air handler replacement", amount: 2900, issuedDate: "2026-07-01", paidDate: "2026-08-21" },
    { id: "HV-I8722", customer: "Rita G.", description: "Coil replacement", amount: 1850, issuedDate: "2026-07-10", paidDate: "2026-09-01" },
    { id: "HV-I8730", customer: "Phil A.", description: "Duct replacement", amount: 3400, issuedDate: "2026-07-15", paidDate: "2026-08-28" },
    { id: "HV-I8744", customer: "Joan M.", description: "Service + parts", amount: 980, issuedDate: "2026-07-20", paidDate: "2026-09-10" },
    { id: "HV-I8790", customer: "Ed T.", description: "Condenser fan motor", amount: 2200, issuedDate: "2026-08-01", paidDate: "2026-09-22" },
    { id: "HV-I8822", customer: "Sandy V.", description: "Thermostat + wiring", amount: 1100, issuedDate: "2026-08-12", paidDate: "2026-09-16" },
  ],
});

const pest = buildCompany({
  seed: 303,
  id: "pest",
  name: "Demo Pest Control",
  trade: "Pest Control",
  serviceArea: "Wildwood, Bushnell & Sumter County, FL",
  callbackCostEstimate: 95,
  avgAddOnValue: 60,
  recurringPlanValue: [396, 456, 516, 588],
  growth: [1.0, 1.01, 0.99, 1.0, 1.02, 1.0, 1.01, 1.0],
  leads: [38, 41, 37, 40, 39, 42, 38, 41],
  dayWeights: [1.0, 1.0, 1.0, 1.0, 1.0, 0.3, 0],
  lastWeekBestDay: 2,
  techs: [
    { id: "x1", name: "Marcus T.", role: "Route Tech", baseJobs: 41, ticket: 132, addOnRate: 0.06 },
    { id: "x2", name: "Bree L.", role: "Route Tech", baseJobs: 37, ticket: 141, addOnRate: 0.11 },
    { id: "x3", name: "Hector V.", role: "Termite Specialist", baseJobs: 28, ticket: 178, addOnRate: 0.09 },
    { id: "x4", name: "Nate C.", role: "Route Tech", baseJobs: 35, ticket: 136, addOnRate: 0.08 },
  ],
  quotesSent: [11, 12, 10, 12, 11, 13, 11, 12],
  closeRate: [0.55, 0.58, 0.6, 0.58, 0.55, 0.62, 0.55, 0.58],
  lossRate: 0.5,
  followUpRate: 0.8,
  services: [
    { name: "Quarterly pest plan (annual)", min: 396, max: 588, weight: 6 },
    { name: "Termite liquid treatment", min: 1100, max: 2400, weight: 2 },
    { name: "Rodent exclusion", min: 650, max: 1450, weight: 2 },
    { name: "Lawn pest + fire ant plan", min: 480, max: 780, weight: 3 },
    { name: "Mosquito plan (season)", min: 420, max: 690, weight: 2 },
  ],
  callbacksByTech: {
    x1: [0, 1, 0, 1, 2, 2, 3, 5],
    x2: [1, 0, 0, 0, 1, 0, 0, 0],
    x3: [0, 0, 1, 0, 0, 1, 0, 0],
    x4: [0, 1, 0, 0, 0, 0, 1, 1],
  },
  callbackIssues: ["Ants back inside within a week", "Roaches still active in kitchen", "Missed side of house on exterior spray", "Fire ant mounds returned", "Spiders on lanai — re-treat"],
  reviewsPerWeek: [3, 2, 3, 3, 2, 4, 3, 2],
  reviewTexts: [
    "{tech} is always on time and texts before every visit. No bugs inside since we signed up.",
    "Great service. {tech} took care of the fire ants around the pool cage in one visit.",
    "{tech} explained exactly what was being treated and why. Very knowledgeable.",
    "Switched from a big national company and the difference is night and day. Thanks {tech}!",
  ],
  reviewAnchors: [
    { date: "2026-10-02", customer: "Sharon D.", rating: 5, techId: "x3", text: "Hector found termite mud tubes the last company missed for two years, treated the whole slab, and sent us the warranty paperwork the same day. Honest and thorough." },
    { date: "2026-09-30", customer: "Phil W.", rating: 2, techId: "x1", text: "Ants were back in the kitchen 4 days after the service. Had to call twice to get someone out. Used to be great." },
  ],
  invoices: [
    { id: "PC-I3301", customer: "Ken R.", description: "Rodent exclusion", amount: 380, issuedDate: "2026-08-22", paidDate: null },
    { id: "PC-I3318", customer: "Joy S.", description: "Quarterly service", amount: 145, issuedDate: "2026-09-04", paidDate: null },
    { id: "PC-I3340", customer: "Arnie B.", description: "Termite treatment", amount: 1450, issuedDate: "2026-09-21", paidDate: null },
    { id: "PC-I3250", customer: "Lena O.", description: "Termite treatment", amount: 1800, issuedDate: "2026-07-20", paidDate: "2026-08-24" },
    { id: "PC-I3287", customer: "Russ E.", description: "Quarterly service", amount: 135, issuedDate: "2026-08-03", paidDate: "2026-09-09" },
  ],
});

// ---------- output ----------
const out = {
  meta: {
    asOf: AS_OF,
    note: "ALL DATA IS FAKE. Demo companies, techs and customers are fictional.",
    source: "demo",
  },
  companies: [plumbing, hvac, pest],
};

const header = `/*
 * data.js — DEMO DATA for the Monday Owner Report. ALL DATA IS FAKE.
 * Generated by tools/generate-demo-data.js (do not hand-edit numbers; regenerate).
 *
 * Shape (mirrors what we'd pull from Jobber's GraphQL API later):
 *   companies[].techs        team members (Jobber: users)
 *   companies[].weeks[]      weekly rollup, oldest first. Mon-Sun.
 *       revenue / jobsCompleted   company totals as reported by the software
 *       dailyRevenue              Mon..Sun, sums to revenue
 *       techStats                 per tech: jobs, revenue, addOns (sums to totals)
 *       newLeads                  new requests that week (Jobber: requests)
 *   companies[].quotes       every quote sent in the window (Jobber: quotes)
 *   companies[].invoices     invoices not paid on the day of service (Jobber: invoices)
 *   companies[].callbacks    redo / callback visits (Jobber: jobs tagged "callback")
 *   companies[].reviews      new Google reviews
 *
 * Everything else (close rate, avg ticket, % changes, money leaks) is computed in report.js.
 */
`;
function pretty(v, indent) {
  const flat = JSON.stringify(v);
  const isLeaf = (x) => x === null || typeof x !== "object";
  // one record per line: inline anything whose values are all primitives
  if (isLeaf(v) || Object.values(v).every(isLeaf)) return flat;
  const pad = indent + " ";
  if (Array.isArray(v)) return "[\n" + v.map((x) => pad + pretty(x, pad)).join(",\n") + "\n" + indent + "]";
  return "{\n" + Object.keys(v).map((k) => pad + k + ": " + pretty(v[k], pad)).join(",\n") + "\n" + indent + "}";
}
process.stdout.write(header + "window.REPORT_DATA = " + pretty(out, "") + ";\n");
