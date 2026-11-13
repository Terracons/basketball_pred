# Courtside: basketball prediction desk

Local and Vercel-ready NBA/NCAA prediction dashboard, with possession-based efficiency predictions, optional OpenRouter review, optional Tavily research, and a quota-managed data collector.

**Run the app:** `node src/server.js`, then open `http://127.0.0.1:3100`. **Host it:** follow [DEPLOYMENT.md](DEPLOYMENT.md). Tests: `node --test`. There are no npm package dependencies.

The dashboard has separate game-total over/under and player points, rebounds, assists, and PRA markets. Player markets have their own Over only, Under only, or Both selection. Team-to-lose means selecting its opponent's moneyline. Every pick requires an actual matching bookmaker price. Select a player statistic and date, then load one game's prices or use **Load up to 5 games**. Each uncached event reserves one odds credit for the selected statistic, including PRA. Already loaded prices are reused, and recent empty results are skipped for three hours so the next batch can check other games.

Target combined decimal odds are **5, 10, 50, 100, or 200**. The app searches combinations of actual priced selections at one bookmaker, with at most one pick per game. It prefers combinations within 5% above the target, then the highest estimated all-win chance within that range. If no close combination is found, it uses the closest combination it finds above the target and displays the actual total. For example, 1.70 × 1.80 × 1.65 produces a three-game 5.05-odds slip. Individual picks in the resulting slip are ranked by estimated probability, highest first. Your selected minimum chance determines eligibility; expected return is reported but does not silently remove picks.

The slip displays a game-by-game list of the selection, price, estimated chance and start time, the odds multiplication, and the estimated chance of all picks winning. If the available games cannot reach the target, the fullest available partial combination is saved and remains exportable. JSON and ranked CSV downloads work for complete and partial slips. Local results are saved in `data/predictions/` and in SQLite; hosted reports use shared Redis state. **Build my slip** automatically loads missing or stale game prices and fixtures under the existing quota guards. For players it can load the selected event's chosen statistic; loading several games remains an explicit action to protect the free allowance.

**Browse available statistical picks** shows up to 100 distinct qualifying player/market/direction choices, ranked by estimated probability. This list can include different bookmakers and several players in one game; it is not another combined slip. The actual slip still uses one bookmaker and at most one selection per game. AI reviews only selected slip picks. Coverage counts show scheduled, priced, matched and qualifying games, making missing quotes and insufficient history visible.

Team predictions use possession-based offensive/defensive efficiency, opponent-adjusted Net Rating, overtime-adjusted pace, and explicit venue/rest assumptions. eFG%, rebound shares, turnover rate, free-throw rate and assists/turnovers appear in the evidence and optional AI review without being double-counted as independent weights. Each team needs eight valid paired box scores; otherwise a labeled scoring fallback is used when enough score history exists. Player estimates combine per-minute production, recent minutes, pace and a points-only opponent adjustment, with Poisson or negative-binomial count probabilities. Recent transfers can use verified same-player prior-team history while minutes come from the latest team. See [MODEL.md](MODEL.md) for exact formulas, assumptions and unavailable inputs.

Statistics use up to twenty eligible recent games. Only completed games starting more than six hours before the prediction timestamp enter team, opponent and league calculations. Player estimates require an unambiguous identity and matching team. Missing/ambiguous matches and stale prices are excluded. Estimates are not calibrated accuracy rates, and the model has not demonstrated profitable betting returns.

Your AI rule is enforced on the server: **at least 70% skips AI; below 70% may be reviewed, at most five network requests per slip**. Tavily searches share those five slots to bound costs. OpenRouter uses the exact model you choose, validates its catalog pricing, reserves a conservative per-request dollar amount, and checks daily/monthly request and dollar caps. AI can keep or veto a pick, but cannot raise its statistical probability. Requests that fail validation stay explicitly unreviewed; no second model is substituted automatically. Research snippets are reference material, not verified injury or lineup feeds.

Add `OPENROUTER_API_KEY`, your optional `OPENROUTER_MODEL`, and `TAVILY_API_KEY` to your private `.env` when available; see `.env.example` for budget settings. These integrations have been tested with mocked API responses, but cannot be live-tested until their keys and chosen model are supplied. Existing odds and CBBD keys have passed live tests.

`npm run evaluate` compares models on identical historical targets and writes `data/prediction-evaluation.json`. The November 13 rebound comparison covered 191 NBA and 89 NCAA played appearances. The count model reduced mean squared cumulative-probability error by about 2.3% and 2.0% against the normal model using the same projected means. These are small retrospective distribution improvements, not measured bookmaker-line accuracy or profitable returns. Dated team and player results are in [VERIFICATION.md](VERIFICATION.md). `npm run audit:data` reports required-field coverage, rejected pairs and latest stored game timestamps in `data/advanced-data-coverage.json`.

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

`collect` uses today's date in Africa/Lagos and retrieves the previous, current, and following calendar dates from ESPN. ESPN groups its schedule by its own calendar conventions; fixtures retain their exact UTC start time. The surrounding dates help cover overnight games. The dashboard filters both fixtures and prices by the selected Lagos date and shows the latest stored completed-game timestamp. NCAA uses `groups=50` for men's Division I coverage, including unranked teams and their non-Division-I opponents. Complete Division II/III, women's and live-game coverage is not provided. ESPN is unofficial and has no guaranteed service level.

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
| `market_check` | Last selected player-market check, including unavailable quotes, to avoid repeated empty polling |

Raw source files preserve fields that the first normalized schema does not yet expose. All identities are strings. Missing values remain null instead of being converted to zero. DNP rows are retained; exported DNP outcomes are null because sportsbook settlement rules vary.

SportsDataverse and ESPN share ESPN game/player/team ids. Queries deduplicate those shared ids and use the most recently observed version. CBBD ids and The Odds API event ids are different: they are deliberately kept separate. Odds have team names, but there is no automatic fuzzy match. A verified cross-source mapping is needed before using prices to settle bets or build profitability reports.

## Free API keys and budgets

Copy `.env.example` to `.env` and add keys if you have them. Do not paste keys into source code or commit them. ESPN and SportsDataverse need no keys. The collector reports a clear skip for CBBD and odds until configured.

| Provider | Local daily cap | Local monthly cap | Default caching |
| --- | --- | --- | --- |
| ESPN | 250 requests | 7,500 requests | Fixtures 3 hours; incomplete summaries 24 hours |
| SportsDataverse | 30 downloads | 100 downloads | Completed seasons 365 days; current season 24 hours |
| CBBD | 24 requests | 900 requests | 6 hours |
| The Odds API | 14 credits | 450 credits | Game and selected-event prop responses 3 hours; predictions reject prices older than 6 hours |

The CBBD and odds caps leave room below their advertised free monthly allowances of 1,000 calls and 500 credits. ESPN and SportsDataverse caps are self-imposed, not provider guarantees. Usage is persisted across restarts and reserved before every network attempt, including retries and failures. Quotas reset by UTC calendar day/month locally. Check the provider dashboard for the actual billing reset and reduce local budgets if it differs. Provider-reported remaining credits also restrict further requests when available.

If a key has already been used elsewhere, set its monthly budget to the remaining allowance BEFORE running the collector. Sharing a key with another application cannot be fully managed by this local ledger.

Default odds collection requests one region and two markets: moneyline (`h2h`) and total (`totals`). Budget is two credits per league per refresh. Two refreshes per day across both leagues cost approximately 240 credits over 30 days, leaving 210 credits inside the local cap for selected player props. Cache hits spend nothing. A request may cost less if no prices are returned, but we count the reservation conservatively.

Player prop collection is optional and limited to explicitly selected events:

```powershell
node src/cli.js odds --league nba --event EVENT_ID_FROM_THE_ODDS_API
```

This CLI command requests points, rebounds, and assists for one event at a cost reservation of three credits. The dashboard requests only the selected statistic at one credit per event and also supports PRA quotes. NCAA player markets may be unavailable for many games/books. Full-schedule player prop polling will not fit the free allowance. Empty prop results are valid and do not mean a player will not play. The batch action stops at the quota guard and preserves everything already collected.

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
