# Verification, 12 November 2026

The automated suite now passes 58 tests, including possession/efficiency formulas, overtime normalization, opponent adjustment, league-wide time cutoffs, invalid box-score rejection, labeled fallbacks, recent player role changes, local/hosted prediction parity, cached normalization upgrades, target-odds combinations, ranking, partial exports, quote loading, AI caps, authentication, shared cloud quotas, and the collector. No paid AI calls were made.

Regression checks verify a 5-odds request returns three selections at 1.70, 1.80 and 1.65, with actual combined odds 5.049 and estimated individual chances 80%, 75%, and 70%. Their estimated all-win probability is 42% under independence. The test values are fixtures, not real betting recommendations. A second regression verifies the app exports a fuller 3.8025 partial combination instead of stopping at a 2.00 single when 5 cannot be reached. All five supported target levels are tested.

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

## Efficiency model comparison

The new engine and old baseline were compared on identical recent games, rebuilding all team/opponent/league inputs before each target. Model constants were fixed before this comparison. Of 200 targets per league, all 200 NBA games and 155 NCAA games had enough history. Forty-five NCAA games were skipped; no evaluated game used the scoring fallback.

| Measure | NBA baseline | NBA efficiency | NCAA baseline | NCAA efficiency |
| --- | ---: | ---: | ---: | ---: |
| Winner accuracy | 61.0% | 66.5% | 61.9% | 74.8% |
| Winner Brier score, lower is better | 0.2215 | 0.2137 | 0.2207 | 0.1677 |
| Total-points mean absolute error | 14.24 | 14.43 | 14.27 | 14.28 |
| Margin mean absolute error | 12.45 | 12.22 | 16.85 | 13.19 |

Winner results improved in this sample; total-points error did not. This is not a test against historical bookmaker lines and does not establish over/under profitability. Probability bins, sample sizes and measured outcomes are saved in `data/prediction-evaluation.json`; estimates remain uncalibrated.

An additional comparison attempted the latest 200 played player appearances per league. Eligible NBA points projections numbered 182, with MAE changing from 4.385 to 4.388 points. Only 52 NCAA appearances had enough prior history, with MAE changing from 4.212 to 4.025. These results do not validate injuries/DNPs, rebounds, assists, PRA, prop-line success or individual probability estimates.

`npm run audit:data` verified all required numeric fields in 8,280 NBA and 38,966 NCAA team rows. In the most recent year, 1,330 NBA games passed paired-box and duration checks, with four missing duration. For NCAA, 6,364 passed, one lacked a pair and ten failed validity checks. Latest game/team/player timestamps were 12 November at 03:00 UTC for NBA and 04:00 UTC for NCAA, corresponding to the US evening of November 11. Coverage is recorded in `data/advanced-data-coverage.json`.

The real cached-data API check generated and saved an NBA partial slip (two selections, 3.5156 combined odds) and a complete NCAA slip (three selections, 6.330885 combined odds) for a target of five. Every selection used `efficiency-v1`; ranking and JSON exports matched. It used zero external requests. See `data/efficiency-api-smoke.json`. These are verification artifacts, not current betting recommendations.

OpenRouter and Tavily flows remain mock-tested until their real keys and chosen model are supplied. Verified injury/lineup feeds and profitability testing remain future work. The collector does not run in the background automatically.

The updated Vercel snapshot build passed at 78,065,664 bytes (about 74.4 MiB), containing 8,204 games, 15,416 team boxes and 111,338 recent player appearances. Team inputs and period counts now survive deployment. Hosted Redis behavior has been tested with a REST mock across two independent local SQLite instances. A real Vercel deployment and Redis connection still require the user's hosting project and environment configuration.

Browser checks verified the local dashboard and a real partial 200-odds result, with individual probability ranking and no forced selections. No horizontal overflow was found at viewport widths 320, 768, 1024, 1280, and 1536. The saved ranked CSV was verified on disk; the browser download-event check timed out, so download-event completion was not confirmed through browser automation.

Before the efficiency upgrade, the browser verified a 5-odds request against stored NBA prices returned three games, individual estimated chances, and the displayed calculation `1.87 × 1.88 × 1.88 = 6.61`. The actual combined value was 6.609328, above the requested minimum, with no closer target combination found in that feed. The estimated all-win probability was 16.9%, assuming independence. The app explicitly distinguishes this from each pick's chance. All three slip rows remained visible without horizontal overflow at the five tested viewport widths. These earlier scoring-model results are historical verification artifacts, not the new model's selections or current betting recommendations.

Run `node --test` to repeat the suite, `node src/cli.js status` to inspect collection health, and `node src/cli.js export` to rebuild the JSONL datasets.
