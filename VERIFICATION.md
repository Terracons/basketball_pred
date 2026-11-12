# Verification, 12 November 2026

The automated suite now passes 40 tests, including prediction ranking, partial exports, AI thresholds and request caps, signed access, shared cloud quotas, distributed locking, and the data collector. The collector was also exercised against real ESPN responses and SportsDataverse season downloads. No paid AI calls were made.

## Initial import results

All 24 imports completed: schedules, team box scores, and player box scores for both leagues in seasons ending 2024, 2025, 2026, and 2027. The 2027 season is still in progress, so its future schedule and statistics will change.

| Measure | NBA | NCAA men |
| --- | ---: | ---: |
| Games, including upcoming fixtures | 5,187 | 24,937 |
| Completed games | 4,140 | 19,494 |
| Team game records | 8,280 | 38,966 |
| Player game records | 109,694 | 624,023 |
| Completed games missing player stats | 0 | 6 |
| Completed games missing two team box scores | 0 | 12 |
| Games with player points inconsistent with final team scores | 7 | 54 |
| Quarantined player rows without usable identities | 33 | 44 |
| Incomplete imports | 0 | 0 |

These are the initial completed import counts, not a promise of complete provider coverage. Current counts appear in `data/latest-report.json` after each command. Original rejected rows and reasons remain in the database's `rejections` table. Reported scoring inconsistencies require investigation before those games are used for player-model evaluation.

## Checks performed

* Real NBA and NCAA fixtures fetched, including unranked college coverage.
* Real live player and team summaries collected and normalized.
* Historical files imported and restarted successfully after discovering invalid identities.
* Quarantining preserves bad source rows and allows later valid rows to import.
* Persistent daily/monthly quota guards, cached reruns, rate-limit retries, and authentication failures tested.
* Player DNP and missing statistics stay distinct from recorded zero outcomes.
* Repeated odds snapshots keep their first observation time and do not duplicate rows.
* Final-game label exports and retrospective head-to-head cutoffs tested.
* Canonical source records and player exports stream from SQLite to limit memory use.

## Authenticated API smoke test

Both supplied keys were tested successfully on 12 November 2026. CBBD returned 56 NCAA games in one request. The Odds API returned 8 NBA events and 24 NCAA events, storing 411 bookmaker/market snapshots for winner and game-total markets. The odds requests consumed four credits, with 496 remaining reported by the provider. Cached reruns consumed no further quota and created no duplicate records. There were no test errors, and no keys were printed or committed. Full results are in `data/api-smoke-report.json`.

Run `node src/smoke.js` to repeat this small test. Player prop odds were not requested in this smoke test; NCAA player props depend on bookmaker availability.

The statistical prediction baseline and local dashboard are implemented. A walk-forward recent-game evaluation tested 200 NBA games and 155 eligible NCAA games, with winner accuracy of 61% and approximately 62%, respectively. Baseline probabilities are uncalibrated. OpenRouter and Tavily flows use mocked integration tests until their real keys and the chosen model are provided. Pregame injury/lineup feeds, broader identity mappings, player-model evaluation and profitability testing remain future work. The collector does not run in the background automatically.

The Vercel snapshot build passed at 66,002,944 bytes (about 63 MiB), containing 8,202 games and 106,263 recent player appearances. Hosted Redis behavior has been tested with a REST mock across two independent local SQLite instances. A real Vercel deployment and Redis connection still require the user's hosting project and environment configuration.

Browser checks verified the local dashboard and a real partial 200-odds result, with individual probability ranking and no forced selections. No horizontal overflow was found at viewport widths 320, 768, 1024, 1280, and 1536. The saved ranked CSV was verified on disk; the browser download-event check timed out, so download-event completion was not confirmed through browser automation.

Run `node --test` to repeat the suite, `node src/cli.js status` to inspect collection health, and `node src/cli.js export` to rebuild the JSONL datasets.
