# Monday Owner Report (demo)

A one-page weekly report for home-service business owners: last week's numbers in plain English, where money is leaking, and 3 things to do this week. **All data is fake.**

Static site with no framework, no build step, and no external requests.

| File | What it does |
|---|---|
| `index.html` | Page shell and company dropdown |
| `styles.css` | Mobile-first styles, light and dark mode, print-to-PDF layout |
| `data.js` | Raw demo data only (3 companies × 8 weeks), shaped like Jobber records |
| `report.js` | Engine (math), Narrator (summary text), View (HTML + SVG chart) |
| `sw.js` | Offline cache so the page opens with no signal after the first visit |
| `tools/generate-demo-data.js` | Regenerates `data.js` (`node tools/generate-demo-data.js > data.js`) |
| `tools/verify-math.js` | Recomputes every number independently and checks it (`node tools/verify-math.js`) |

## Common changes

- **Your company name:** `CONFIG.brandName` at the top of `report.js`.
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

## Future phases (not built yet)

- **Jobber API:** replace `DataSource.load()` in `report.js` with a server-side fetch that returns the same shape as `data.js`.
- **Monday email/text:** a scheduled job (for example a Vercel Cron) renders the report per client and sends the link.
- **Claude-written summary:** replace `Narrator.summarize()` with a server route that calls the Claude API. Keep the template as the fallback.
- **Logins and multiple clients:** `data.companies` is already a list, so add auth and filter it per user.
