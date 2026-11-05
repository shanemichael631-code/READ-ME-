# Monday Owner Report (demo)

A one-page weekly report for home-service business owners: last week's numbers in plain English, where money is leaking, and 3 things to do this week. **All data is fake.**

Static site with no framework, no build step, and no external requests.

| File | What it does |
|---|---|
| `index.html` | Page shell and company dropdown |
| `styles.css` | Mobile-first styles, light and dark mode, print-to-PDF layout |
| `data.js` | Raw demo data only (3 companies × 8 weeks), shaped like Jobber records |
| `report.js` | Engine (math), Narrator (summary text), View (HTML + SVG chart) |
| `hub.html` | Nova Hub: the team launcher page with every Nova link (both reports, booking, warehouse, Jobber, marketplaces), plus Ask Nova and the Needs-you inbox. Self-contained, see below |
| `server/` | The hub's three Vercel functions (`api/health`, `api/needs`, `api/chat`): passcode, the Needs-you list and Nova's chat on the Claude API. `server/README.md` has the details |
| `sw.js` | Offline cache so the demo opens with no signal after the first visit |
| `sw-retire.js` | Deployed as `sw.js` on live reports: removes any old offline cache and itself |
| `tools/generate-demo-data.js` | Regenerates `data.js` (`node tools/generate-demo-data.js > data.js`) |
| `tools/verify-math.js` | Recomputes every number independently and checks it (`node tools/verify-math.js`) |

## Common changes

- **Product name and tagline:** `CONFIG.brand.name` and `CONFIG.brand.tagline` at the top of `report.js` (currently the fictional "Vanbrief"). The logo is the `logo()` function in `report.js` plus `icon.svg`.
- **Thresholds** (5-day quotes, 30-day invoices, 75% of team average, and so on): `CONFIG` in `report.js`.
- **Deep links:** `/#plumbing`, `/#hvac`, `/#pest` open a specific demo company.
- **Dates:** the demo moves all dates forward automatically, so "last week" is always the most recent Mon–Sun. To turn that off, set `CONFIG.rollDatesToCurrentWeek = false`.

## How the numbers are computed

- **Close rate** = quotes won during the week ÷ quotes sent during the week (by count).
- **Avg ticket** = revenue ÷ jobs completed.
- **Unpaid 30+** = invoices issued on or before Sunday and still unpaid, at 30+ days old as of the next Monday.
- **4-wk avg** = the 4 weeks before last week.
- **Callback cost** = callbacks × the company's `callbackCostEstimate`.
- **Tech flag** = under 75% of the team average for jobs or revenue. The leak amount is the gap to the average.

## Deploying

The live demo is the Vercel project `monday-owner-report` at https://monday-owner-report.vercel.app. It's a static site with no build step, so Vercel just serves the files.

The first deploy was uploaded directly because this GitHub repo isn't connected to Vercel yet. To get automatic deploys on every push, connect it once in Vercel: Project → Settings → Git → Connect Git Repository → pick this repo. Set the production branch to the branch you want to show.

## Live version from Jobber (Nova Filters)

The same `report.js` also renders a real account. `tools/build-jobber-data.js` turns raw Jobber exports into a `data.js` with the same shape as the demo, plus a few per-company settings:

- `scorecard` picks the 8 tiles (for example "Jobs Booked" and "Systems Sold" instead of leads and reviews).
- `features` turns off sections that have no data (Google reviews, add-on coaching, new-hire ramp plans).
- `labels` / `notes` / `playbook` hold the company's own wording and steps.
- Tech `group` ("Installer" vs "Service tech") makes techs compare against peers who do the same kind of work. `field: false` rows (office, no tech on record) stay out of the leaderboard and averages.
- `quoteTracking: "viewed"` uses Jobber's "customer opened the quote" instead of a follow-up log.

```
node tools/build-jobber-data.js <rawDir> <outside-the-repo>/data.js --check
```

`--check` prints the reference week from Nova's weekly-totals playbook so the job-type rules can be compared against a known count. **The output contains real customer data: keep it out of git and deploy it only to a protected Vercel project.** Nova's copy lives in the Vercel project `nova-owner-report`, which has Vercel Authentication on every URL (only signed-in team members can open it). Deploy `sw-retire.js` there **as `sw.js`**: a private report never keeps an offline copy, because a cached copy hides an expired sign-in and keeps showing old numbers. `index.html` only registers the offline cache for the demo, and shows a loading / "didn't load" card instead of a blank page.

Data rules worth knowing: revenue is job totals (they include sales tax), parts pickups are left out, invoice balances more than a year old and credits stay out of the weekly unpaid numbers (the Unpaid tile's note lists them), and Jobber's "paid" date is approximated by the invoice's last update.

## Nova Hub (`hub.html`)

`hub.html` is the team launcher: one self-contained page with every Nova link (both owner reports, online booking, the booking hub, warehouse hub, route map, van app, Jobber, Amazon, eBay, Jarvis). It needs no build step and no other file from this repo. Open it as a local file, or deploy it as a static file.

- **Edit links:** the `HUB` array near the top of the script in `hub.html` (look for `EDIT YOUR LINKS HERE`). Each entry has an id, title, one-line description, URL, group, icon name, and optional badges, note and sublinks. `DEFAULT_PINS` sets what a new device sees pinned; `GROUPS` sets group order, blurbs and layout.
- **What it does:** search filters links as you type (`/` focuses search, Enter opens the first match, Esc clears); star pins a link to the top row, saved per device; copy buttons copy a link to text to a customer; Light / Dark / System theme; a "New report today" marker on the Nova report every Monday; "Week of" and "Service week" computed from the device clock.
- **Desktop icon:** put `hub.html`, `nova-hub.ico` and `tools/Make Nova Hub Shortcut.cmd` in one folder and double-click the `.cmd`. It copies the files to Documents\Nova Hub and creates a desktop shortcut with the Nova icon. By hand: make a shortcut to `hub.html`, then Properties, Change Icon, pick `nova-hub.ico`. On a phone, Add to Home Screen uses the icon built into the page.
- **Preview a date:** add `?today=2026-10-12` to the URL to see the Monday state on any day.
- **Ask Nova:** the drop-shaped "Ask Nova" button in the top bar opens a chat with Nova, the team assistant. It answers from last week's report numbers (revenue, jobs, unpaid 30+, open quotes, callbacks, the tech leaderboard, the report's 3 things to do, a customer's quotes and invoices) through tools that run `Engine.buildReport` on the live data, and from general water-treatment knowledge for everything else. Replies can carry tap chips: open a hub page, add a reminder, or search the hub. Tap the mic to talk (Chrome and Safari); replies are read aloud when the voice toggle is on, and it turns on by itself when the question came by voice. The last 12 turns stay on the device; "New chat" clears them.
- **Needs you:** the bell shows a count of things that need a person: invoices unpaid 30+ days, quotes that went quiet, a tech under the team average, a high-callback week, the report's to-dos, a new or stale report, and unreachable report data. Each item has Open (or Open report) and, while Ask Nova is on, an Ask Nova button; Done hides it on this device (it comes back if it changes). Reminders from Ask Nova live here too. The list refreshes when the sheet opens, when you come back to the tab and every 10 minutes; a toast and a short vibration announce new items.
- **Passcode:** the bell (and Ask Nova, when it is on) asks for the team passcode once per device. It is the `HUB_PASSCODE` environment variable on the Vercel project `nova-hub-gvz6r`. Change it there and everyone types the new one on next use (an old stored passcode gets a 401 and the sheet asks again). "Forget passcode" in a sheet footer clears it from a device. Ten wrong passcodes lock an address out for 15 minutes.
- **The Anthropic key (optional, paid):** Ask Nova runs on the Claude API, which is billed per question and is not part of a Claude subscription. It needs `ANTHROPIC_API_KEY` on the same Vercel project (Settings, Environment Variables: https://vercel.com/shanemichael631-3943/nova-hub-gvz6r/settings/environment-variables), then a redeploy. Without a key, or while it is the placeholder `REPLACE_ME`, the hub hides the Ask Nova button and the Ask Nova buttons on bell items; the bell and everything else work as usual. Add a key and redeploy, and Ask Nova appears on the next check on any device that has entered the passcode (on a new device, tap the bell once). Optional: `ANTHROPIC_MODEL` (default `claude-opus-5-5`) and `ANTHROPIC_EFFORT` (default `low`). The numbers come from `REPORT_DATA_URL` + `REPORT_BYPASS_SECRET` (the private live `data.js`) and `REPORT_ENGINE_URL` (`report.js` at a pinned GitHub commit). The full table is in `server/README.md`.
- **Run it locally:** `node --test 'server/test/*.test.js'` runs the server suite. `MOCK_MODEL=1 HUB_PASSCODE=test node server/dev.js` serves the repo and the three routes on port 8791 with a fake model and the demo data; point any copy of the hub at it by setting the localStorage key `novahub.apiBase` to `"http://127.0.0.1:8791"` in devtools (there is no URL hook on purpose).
- **Live address:** https://nova-hub-gvz6r.vercel.app (Vercel project `nova-hub-gvz6r`, public, unlisted, `noindex`). On a phone, open it in Safari or Chrome and use Add to Home Screen; it installs with the Nova icon and opens like an app.
- **Deploy or redeploy:** edit `hub.html` or `server/`, run `node tools/build-hub.js` (rebuilds `hub/`, the checksums in `tools/hub-deploy/build.sh` and the upload list `tools/hub-deploy/manifest.json`), commit and push, then create a Vercel deployment for project `nova-hub-gvz6r` by uploading exactly the files in `manifest.json`: each entry gives the upload path, the source file, its SHA1 and size (`package.json`, `vercel.json`, `build.sh`, `api/*.js`, `lib/*.js`, about 32 KB in all). Vercel installs `@anthropic-ai/sdk`, runs `bash build.sh` (pulls `hub/` from GitHub and fails if any file's SHA1 differs, so the static hub always matches git) and builds `api/*.js` as Node functions. This repo is not Git-connected in Vercel, so pushes do not auto-deploy. The hub never caches offline and makes no requests except Google Fonts (system fonts without them) and, once a passcode is entered, its own `/api/*` routes.

## Future phases (not built yet)

- **Jobber API:** replace `DataSource.load()` in `report.js` with a server-side fetch that returns the same shape as `data.js`.
- **Monday email/text:** a scheduled job (for example a Vercel Cron) renders the report per client and sends the link.
- **Claude-written summary:** replace `Narrator.summarize()` with a server route that calls the Claude API. Keep the template as the fallback.
- **Logins and multiple clients:** `data.companies` is already a list, so add auth and filter it per user.
