# Monday Owner Report (demo)

A one-page weekly report for home-service business owners: last week's numbers in plain English, where money is leaking, and 3 things to do this week. **All data is fake.**

Static site with no framework, no build step, and no external requests.

| File | What it does |
|---|---|
| `index.html` | Page shell and company dropdown |
| `styles.css` | Mobile-first styles, light and dark mode, print-to-PDF layout |
| `data.js` | Raw demo data only (3 companies × 8 weeks), shaped like Jobber records |
| `report.js` | Engine (math), Narrator (summary text), View (HTML + SVG chart) |
| `hub.html` | Nova Hub: the team launcher page with every Nova link (both reports, booking, warehouse, Jobber, marketplaces). Self-contained, see below |
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
- **Preview a date:** add `?today=2026-10-12` to the URL to see the Monday state on any day.
- **Deploy:** upload `hub.html` to the protected Vercel project (`nova-owner-report`) so it sits behind the same sign-in, or to its own project. It never caches offline and makes no requests except Google Fonts (it falls back to system fonts without them).

## Future phases (not built yet)

- **Jobber API:** replace `DataSource.load()` in `report.js` with a server-side fetch that returns the same shape as `data.js`.
- **Monday email/text:** a scheduled job (for example a Vercel Cron) renders the report per client and sends the link.
- **Claude-written summary:** replace `Narrator.summarize()` with a server route that calls the Claude API. Keep the template as the fallback.
- **Logins and multiple clients:** `data.companies` is already a list, so add auth and filter it per user.
