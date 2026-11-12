# Courtside: basketball prediction desk

Local and Vercel-ready NBA/NCAA prediction dashboard, with a statistical baseline, optional OpenRouter review, optional Tavily research, and a quota-managed data collector.

**Run the app:** `node src/server.js`, then open `http://127.0.0.1:3100`. **Host it:** follow [DEPLOYMENT.md](DEPLOYMENT.md). Tests: `node --test`. There are no npm package dependencies.

The dashboard lets you select overs, unders, individual player props, a team to win or lose, or mixed game markets. Team-to-lose means selecting its opponent's moneyline. Player projections cover points, rebounds, assists, and PRA; a pick requires an actual matching bookmaker price. The default player feed collects points/rebounds/assists prices, so PRA selections need separately available PRA quotes.

Target combined decimal odds are **5, 10, 50, 100, or 200**. Individual selections are ranked by their statistical probability, highest first, rather than by the size of the bookmaker price. Slips use one bookmaker, at most one selection per game, and positive estimated return under the uncalibrated baseline. They stop when the target is reached. If it cannot be reached, the available qualifying selections are saved as a partial result with their actual combined odds. JSON and ranked CSV downloads work for complete and partial slips. Local results are saved in `data/predictions/` and in SQLite; hosted reports use shared Redis state.

Statistics use the latest twenty eligible games, a recency-weighted scoring average blended with the opponent's points allowed, and a normal predictive distribution with a conservative variance floor. At least eight samples are required for each team or player. Only earlier games starting at least six hours before the prediction timestamp are used. Player estimates require an unambiguous identity and matching team. Missing/ambiguous matches and stale prices are excluded, rather than guessed. Estimates are not calibrated accuracy rates, and the model has not demonstrated profitable betting returns.

Your AI rule is enforced on the server: **at least 70% skips AI; below 70% may be reviewed, at most five network requests per slip**. Tavily searches share those five slots to bound costs. OpenRouter uses the exact model you choose, validates its catalog pricing, reserves a conservative per-request dollar amount, and checks daily/monthly request and dollar caps. AI can keep or veto a pick, but cannot raise its statistical probability. Requests that fail validation stay explicitly unreviewed; no second model is substituted automatically. Research snippets are reference material, not verified injury or lineup feeds.

Add `OPENROUTER_API_KEY`, your optional `OPENROUTER_MODEL`, and `TAVILY_API_KEY` to your private `.env` when available; see `.env.example` for budget settings. These integrations have been tested with mocked API responses, but cannot be live-tested until their keys and chosen model are supplied. Existing odds and CBBD keys have passed live tests.

`node src/evaluate.js` writes a walk-forward evaluation to `data/prediction-evaluation.json`. The initial recent sample tested 200 NBA games and 155 eligible NCAA games, with winner accuracy around 61% and 62%, respectively. These aggregate results do not validate individual quoted percentages, player props, accumulators, or betting profitability.

## Data collector

Local data collection for NBA and NCAA men's basketball. Node.js 22.18 or newer is required. There are no npm dependencies and no paid subscriptions are required for fixtures or historical box scores.

The collection commands below maintain the underlying dataset. The dashboard is a prediction prototype and does not place bets.

## Run

Run these commands from the project directory in PowerShell:

```powershell
node --test
node src/cli.js collect
node src/cli.js status
node src/cli.js export
```

After adding API keys, `node src/smoke.js` performs a small authenticated test: one NCAA fixture request, NBA and NCAA winner/total odds, and cached reruns to verify that quota and row counts stay unchanged. Results are saved to `data/api-smoke-report.json` without exposing keys. An uncached successful run reserves one CBBD call and four odds credits; retries are also budgeted.

`collect` uses today's date in Africa/Lagos and retrieves the previous, current, and following calendar dates from ESPN. ESPN groups its schedule by its own calendar conventions; fixtures retain their exact UTC start time. The surrounding dates help cover overnight games. NCAA uses `groups=50` to request Division I coverage rather than only ranked teams. Schedules can still include non-Division-I opponents. ESPN is unofficial and has no guaranteed service level.

Each run processes up to 25 pending completed-game summaries per league. Run it again to work through a backlog. A successful complete summary is not repeatedly fetched. Missing summaries are reported and retried on later runs. Historical downloads cover the larger backfill efficiently.

To backfill the last three completed seasons, including team and player statistics:

```powershell
node src/cli.js history --seasons 2024,2025,2026
```

Season names use the ENDING year. For example, 2026 means 2025/26. This imports 18 files, around 500 MB of CSV downloads. Files are streamed into SQLite in batches, retained locally, and reused. If an import fails, rerun the same command. Unchanged completed imports are skipped using a download checkpoint. Already imported rows are upserted rather than duplicated. Rows missing identities or valid game timestamps/scores are quarantined in the `rejections` table, including their original fields and reason. They are counted in quality reports and never given invented identities. Partial imports are tracked in `imports`; do not use incomplete seasons as finished training data.

For a smaller import:

```powershell
node src/cli.js history --seasons 2026 --league nba
node src/cli.js history --seasons 2026 --league ncaa --kinds schedule,team_box
```

The current 2026/27 season can be imported with `node src/cli.js history --seasons 2027`. Current-season files refresh at most once per day. Run the regular collector between bulk updates for newer fixtures and completed-game summaries.

## What gets stored

`data/basketball.sqlite` holds the database. `data/raw/` holds original response files addressed by a hash of the public request, and `data/latest-report.json` records the latest quality report. These files and API keys are ignored by Git.

| Dataset | Purpose |
| --- | --- |
| `game` | Fixtures, home/away, neutral venue, final scores and winner/total labels |
| `team_box` | Shooting, rebounds, turnovers, assists and other team statistics |
| `player_box` | Player identity, team, minutes, starter status, DNP, points, rebounds, assists, steals, blocks, shooting and PRA |
| `odds` | Timestamped bookmaker prices and lines for winners, game totals and selected player props |
| `game_supplement` | CBBD NCAA games, kept in their own source namespace |
| `summary_complete` | Checkpoint for successfully collected ESPN game summaries |

Raw source files preserve fields that the first normalized schema does not yet expose. All identities are strings. Missing values remain null instead of being converted to zero. DNP rows are retained; exported DNP outcomes are null because sportsbook settlement rules vary.

SportsDataverse and ESPN share ESPN game/player/team ids. Queries deduplicate those shared ids and use the most recently observed version. CBBD ids and The Odds API event ids are different: they are deliberately kept separate. Odds have team names, but there is no automatic fuzzy match. A verified cross-source mapping is needed before using prices to settle bets or build profitability reports.

## Free API keys and budgets

Copy `.env.example` to `.env` and add keys if you have them. Do not paste keys into source code or commit them. ESPN and SportsDataverse need no keys. The collector reports a clear skip for CBBD and odds until configured.

| Provider | Local daily cap | Local monthly cap | Default caching |
| --- | --- | --- | --- |
| ESPN | 250 requests | 7,500 requests | Fixtures 3 hours; incomplete summaries 24 hours |
| SportsDataverse | 30 downloads | 100 downloads | Completed seasons 365 days; current season 24 hours |
| CBBD | 24 requests | 900 requests | 6 hours |
| The Odds API | 14 credits | 450 credits | Game odds 12 hours; selected event props 24 hours |

The CBBD and odds caps leave room below their advertised free monthly allowances of 1,000 calls and 500 credits. ESPN and SportsDataverse caps are self-imposed, not provider guarantees. Usage is persisted across restarts and reserved before every network attempt, including retries and failures. Quotas reset by UTC calendar day/month locally. Check the provider dashboard for the actual billing reset and reduce local budgets if it differs. Provider-reported remaining credits also restrict further requests when available.

If a key has already been used elsewhere, set its monthly budget to the remaining allowance BEFORE running the collector. Sharing a key with another application cannot be fully managed by this local ledger.

Default odds collection requests one region and two markets: moneyline (`h2h`) and total (`totals`). Budget is two credits per league per refresh. Two refreshes per day across both leagues cost approximately 240 credits over 30 days, leaving 210 credits inside the local cap for selected player props. Cache hits spend nothing. A request may cost less if no prices are returned, but we count the reservation conservatively.

Player prop collection is optional and limited to explicitly selected events:

```powershell
node src/cli.js odds --league nba --event EVENT_ID_FROM_THE_ODDS_API
```

This requests points, rebounds, and assists for one event at a cost reservation of three credits. NCAA player markets may be unavailable for many games/books. Game-wide player prop polling across every fixture will not fit the free allowance. PRA outcomes can be calculated from player stats, but PRA bookmaker lines are not collected by this initial command. Empty prop results are valid and do not mean a player will not play.

## Outputs for the planned models

`node src/cli.js export` writes JSONL files into `data/exports/`:

* `nba_games.jsonl` and `ncaa_games.jsonl`: final scores, total points, home-win indicator and margin.
* `nba_players.jsonl` and `ncaa_players.jsonl`: final player points, rebounds, assists, PRA, minutes and DNP status, joined only to final games.

Game totals support over/under prediction once matched to a bookmaker line. Home-win labels support winner prediction. Player outcomes support player-level projection. An exact tie against a line is a push, not a loss. Overtime inclusion and DNP settlement must follow each bookmaker's rules. These exports are OUTCOME LABELS, not pregame features. Never use a target game's final box score as its prediction input. Build time-ordered train/test splits and only use information available before the prediction timestamp. Historical stats imported today do not reconstruct historical injury announcements or the exact time an old stat was first known.

Head-to-head from stored results uses ESPN team ids:

```powershell
node src/cli.js h2h --league nba --teams 18,24 --before 2026-11-12T00:00:00Z
```

The command returns up to ten completed meetings starting before that cutoff. It is a retrospective results query, not a guarantee that every returned result had been published before the cutoff.

Player prop modeling will also need reliable pregame injuries, availability, expected minutes, starting lineups, and bookmaker/player identity mappings. Those are not yet provided by this collector. Historical bookmaker odds are not included in the free odds plan. No model accuracy or betting profitability claim is made.

## Routine operation

Run `node src/cli.js collect` twice daily, for example at 08:00 and 20:00 Africa/Lagos, then run `status`. No background service or OS scheduled task is installed. The process runs only when invoked. The database survives restarts and prevents concurrent collectors with a PID lock. A crashed process's lock is recovered only when its PID is confirmed absent. API failures are isolated by step, written to the report, and result in a nonzero exit status. Successful steps remain stored.

Inspect quality counts before training: final games without player stats, missing pairs of team box scores, dates covered and row counts. Finalized historical files are cached, so data corrections require removing that file's cache entry or waiting for its TTL. Budget counters should not be reset to force more requests.

Node 22 prints an experimental warning for its built-in SQLite API. This project intentionally uses it to avoid installing a database package. The database and raw cache are private local data; keep attribution and provider restrictions when publishing an app.

## Provider documentation

* [SportsDataverse release store](https://github.com/sportsdataverse/sportsdataverse-data)
* [hoopR data guide](https://hoopr.sportsdataverse.org/articles/getting-started-hoopR.html)
* [CBBD API documentation](https://api.collegebasketballdata.com/getting-started)
* [CBBD access and coverage](https://collegebasketballdata.com/about)
* [CBBD use terms](https://collegebasketballdata.com/terms)
* [The Odds API pricing](https://the-odds-api.com/)
* [The Odds API request costs and endpoints](https://the-odds-api.com/liveapi/guides/v4/)
