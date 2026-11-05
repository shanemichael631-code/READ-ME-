# Nova Hub server

Three Vercel serverless functions (Node 22, ESM) behind the hub's "Ask Nova" and "Needs you" sheets:

- `GET /api/health` - configuration check: `{ok, model, hasKey, hasData, dataAsOf, company, engineOk, version}`.
- `GET /api/needs` - the inbox: `{asOf, weekOf, items}` computed from `Engine.buildReport` on the latest week.
- `POST /api/chat` - Nova: `{reply, speak, actions, usage}` from the Claude API with tools over the report data.

Every request needs the `x-hub-pass` header. Errors are `{error: {code, message}}`: 401 `bad_passcode`,
429 `rate_limited`, 503 `not_configured`, 502 `upstream`.

## Environment variables (Vercel project `nova-hub-gvz6r`)

| Name | Purpose |
|---|---|
| `HUB_PASSCODE` | The team passcode. Change it here; everyone types the new one on next use. |
| `ANTHROPIC_API_KEY` | Claude API key. Missing or `REPLACE_ME` means `setup:key` in Needs you and 503 on chat. |
| `ANTHROPIC_MODEL` | Model id, default `claude-opus-5-5`. |
| `ANTHROPIC_EFFORT` | `low` (default), `medium` or `high`; anything else falls back to `low`. |
| `REPORT_DATA_URL` | The private live `data.js` (served by `nova-owner-report`); a disk path or `file:` URL also works. |
| `REPORT_BYPASS_SECRET` | Sent as `x-vercel-protection-bypass` to `REPORT_DATA_URL` only: the URL must be https and a redirect is refused, so the secret never reaches another origin. |
| `REPORT_ENGINE_URL` | `report.js`, a GitHub raw URL pinned to a commit. Never shipped in the deploy. |
| `REPORT_ENGINE_SHA256` | Optional. When set, the fetched `report.js` must hash to it (`sha256sum report.js`, hex) or the engine is refused (`setup:data`). Update it with `REPORT_ENGINE_URL`. |
| `MOCK_MODEL` | `1` = fake model for local tests (no key needed). Leave unset in production. |

Data and engine are cached in module scope for 10 minutes. Both files run in an empty `vm` context (no host
objects, no `eval`/`Function`) and only JSON comes back out. Rate limits (10 bad passcodes per 15 min,
20 chats per 5 min, per IP) are in-memory and best effort. The model call has one 50 s deadline (20 s per
request, one retry, `max_tokens` 4000) so a stalled upstream answers `502 upstream` inside Vercel's 60 s.

## Local run

```
cd server && npm install
MOCK_MODEL=1 HUB_PASSCODE=test node dev.js        # http://localhost:8791, serves the repo root too
curl -H 'x-hub-pass: test' localhost:8791/api/health
curl -H 'x-hub-pass: test' -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"How was last week?"}]}' localhost:8791/api/chat
npm test                                          # or from the repo root: node --test 'server/test/*.test.js'
```

`dev.js` defaults `REPORT_DATA_URL` and `REPORT_ENGINE_URL` to the repo's demo `data.js` and `report.js`.
To talk to the real model locally, drop `MOCK_MODEL` and export `ANTHROPIC_API_KEY`. The mock answers a message
containing "week" with the real `get_week_summary` numbers, "remind" with an `add_reminder` chip, "open booking"
with an `open_link` chip, "search <words>" with a `search` chip, and echoes anything else. To point a hub page at
the harness, set the localStorage key `novahub.apiBase` to `"http://127.0.0.1:8791"` (the hub has no URL hook).

## Deploy

Vercel is not Git-connected. `node tools/build-hub.js` writes `tools/hub-deploy/manifest.json`, the list of
files to upload (`package.json`, `vercel.json`, `build.sh`, `api/*`, `lib/*`) with their SHA1 and size; the
orchestrator uploads exactly those through the Vercel API. The `build` script (`bash build.sh`) still pulls
`hub/` from GitHub into `public/`, so the static hub and the functions ship together. Keep the server files
pure ASCII and small: they are transcribed by hand into the upload call.

## Changing the passcode or the model

Edit `HUB_PASSCODE` or `ANTHROPIC_MODEL` in the Vercel project's environment variables and redeploy
(functions read them at request time, but a redeploy makes every instance pick them up). The hub asks
for the passcode again after the first 401.
