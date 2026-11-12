# Deploy Courtside on Vercel

This repository supports Vercel's Node.js Functions and also runs locally. API keys and the large private local database are excluded from Git and deployment uploads.

## Create the project

1. In Vercel, choose **Add New Project** and import `Terracons/basketball_pred`. Select the pushed branch if Vercel does not select it automatically.
2. Use framework **Other**, Node.js **22.x**, build command **npm run build**, and output directory **public**. `vercel.json` already declares these build settings, the API rewrite, security headers, and function duration.
3. In the project's **Storage / Marketplace**, connect an **Upstash Redis** database. Use its free plan if it meets your usage. Confirm that `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are added to the project's environment variables. Legacy `KV_REST_API_URL` names are not used here.
4. Add the environment variables below, then deploy or redeploy. Use the same values for Preview if you want to test a preview deployment.
5. Open the deployment, sign in with `APP_PASSWORD`, select NBA or NCAA, and click **Refresh game prices**. This also updates recent fixtures and up to five missing game summaries. Game odds use up to two credits per selected league. Price and fixture caches avoid repeated spending.

| Variable | Required? | Purpose |
| --- | --- | --- |
| `APP_PASSWORD` | Yes | A private app password of at least 16 characters. Never place it in client code. |
| `UPSTASH_REDIS_REST_URL` | Yes | REST endpoint supplied by the Upstash integration. |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Server-side Redis token from that integration. |
| `ODDS_API_KEY` | For market predictions | Real bookmaker lines and prices. Without it the app cannot build priced selections. |
| `OPENROUTER_API_KEY` | For AI review | Your OpenRouter key. |
| `OPENROUTER_MODEL` | Optional | Exact model ID you choose. It pre-fills the model field; you can change it in the app. |
| `TAVILY_API_KEY` | For optional research | Search excerpts about teams and players. |
| `APP_ORIGIN` | Custom domain only | Exact HTTPS origin, such as `https://basketball.example.com`. Vercel's standard deployment and project domains are allowed automatically. |

The default API budget settings are in `.env.example`. They can be overridden in Vercel's environment settings. CBBD is used by the local supplementary collector; the hosted dashboard uses the included historical snapshot, ESPN updates, and bookmaker odds. No browser receives a provider key.

## How hosted data works

Vercel Functions have a read-only deployment filesystem and temporary writable scratch space. The 700 MB local research database is not deployed.

During `npm run build`, the app creates `runtime/seed.sqlite`: roughly one year of game results, eight days of future fixtures, and each player's latest twenty available appearances. If the local collected database exists, it is used as the source. On a clean Vercel build, the script downloads schedules and player box scores for the previous and current season directly from public SportsDataverse releases. The build needs no provider API keys. Its first run can take several minutes and download a few hundred MB. Unavailable releases or a failed import fail the build instead of publishing fake data.

Each function instance copies the compact seed into its temporary directory. Mutable records, API responses, quota usage, AI request counts, reserved AI dollar budgets, and the latest fifty prediction reports are synchronized through a compressed Redis state. A distributed lock serializes stateful requests across instances. Quota reservations are persisted before provider calls. If Redis is unavailable, requests stop rather than silently resetting quotas. State over the eight-MB encoded safety cap stops further API spending until the snapshot is rebuilt and storage needs are reviewed.

Provider calls in production have a 45-second timeout, and new external calls stop after three minutes of request processing. A request may therefore finish with fewer than five reviews. There are no automatic billed retries for AI or search. The five-call maximum counts AI reviews and optional searches together; picks at or above 70% skip both.

Prediction reports are saved in Redis, with JSON and CSV generated in the instance's temporary scratch space. Use the result's download buttons to keep a local copy, including partial slips. Temporary files are not durable cloud storage. The full outcome archive remains in your local project and is not uploaded.

Rebuild/redeploy periodically to refresh the historical seed. Between rebuilds, **Refresh game prices** updates the surrounding dates and a bounded recent-statistics backlog. This is an on-demand prototype, not an unattended live feed or an unlimited multi-user service. Do not run a separate local collector against the same provider keys without accounting for its quota usage.

## Privacy and access

The static app shell is public; all hosted data and paid-provider actions require the app password. Sessions use signed HttpOnly, Secure, SameSite cookies. Login attempts are limited in shared Redis. The app does not place bets. Keep the repository free of `.env`, Redis tokens, provider keys, raw responses, or local database files. Changing the app password invalidates existing sessions.

## Local run and validation

```powershell
node --test
node src/server.js
```

Open `http://127.0.0.1:3100`. Locally, Redis is unnecessary and a password is optional because the server listens only on loopback. Add keys to your existing private `.env` without replacing it. Restart the server after changing environment variables.

```powershell
node src/evaluate.js
node src/build-vercel.js
```

The evaluation is walk-forward scoring analysis, not a betting return backtest. The build verifies the compact database is below 180 MB, leaving room under Vercel's standard function bundle limit.

References: [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [function limits](https://vercel.com/docs/functions/limitations), [runtime filesystem](https://vercel.com/docs/functions/runtimes), [Vercel Redis setup](https://vercel.com/docs/redis), [Upstash free-plan pricing](https://upstash.com/pricing/redis), [Upstash REST API](https://upstash.com/docs/redis/features/restapi).
