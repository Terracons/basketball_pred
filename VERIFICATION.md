# Verification

## November 13, 2026: player markets and current coverage

The full automated suite passes 70 tests. Added cases cover selected rebound directions, nonnegative count probabilities and exact pushes, future-observation rejection and bounded provider clock skew, date-specific freshness, mixed-market completeness, one-market credit costs, five-event batches stopping at quota, empty-market checkpoints, verified NCAA aliases, safe prior-team player history, ranked browsing, and deduplicated summary collection. Existing target-odds, partial export, AI limits, authentication and local/hosted parity regressions still pass.

Live collection refreshed 25 NCAA completed-game summaries and four NBA summaries. At the refresh, all nine upcoming NBA priced events and all 69 upcoming NCAA priced events matched stored fixtures after explicit alias fixes. These are timestamped observations, not a guarantee that all listed games remain upcoming or have player prices. NCAA coverage is primarily men's Division I and their opponents; the pasted sportsbook list also contained Division II and live games outside this scope.

Live selected-market requests returned NBA rebound prices for 13 players in one game and NCAA rebound prices for two players in one game. Browser batch loading added two more NBA games before the conservative local daily credit guard stopped further calls. Existing quotes remained usable. The local ledger includes reserved failed network attempts, so it can exceed actual provider usage. No limits were reset or bypassed, and no AI requests were made.

The browser verified Player rebounds with Under only, three priced NBA games, 31 distinct ranked player choices, and a two-game slip at approximately 5.02 combined odds for a target of five. Both picks were unders, ordered by estimated probability. The available-picks disclosure opened correctly, and the browser reported no JavaScript errors. This is a recorded interface check, not a current recommendation. A screenshot is saved privately as `data/rebounds-ui.jpg`.

The `minutes-count-v2` rebound distribution comparison used the same projected mean for the old normal and new Poisson/negative-binomial distributions. Mean squared cumulative-probability error across fixed thresholds 0.5 through 29.5 was:

| League | Eligible played appearances | Previous normal score | Count-model score | Relative reduction |
| --- | ---: | ---: | ---: | ---: |
| NBA | 191 | 0.0393323 | 0.0384162 | 2.3% |
| NCAA men | 89 | 0.0394311 | 0.0386616 | 2.0% |

Lower is better. This modest retrospective improvement does not establish bookmaker-line accuracy, calibration, DNP handling, or profitability. Rookie and ambiguous identities remain excluded when eight valid appearances cannot be obtained. The model uses estimated minutes, without verified injuries or starting lineups.

The rerun also evaluated 200 NBA and 159 eligible NCAA team games. Winner accuracy changed from 61.0% to 67.0% and 62.9% to 75.5%; total-points MAE changed from 14.543 to 14.732 and 13.726 to 13.659. The NBA totals result still did not improve. On paired player-points targets, NBA MAE was 4.797 versus 4.806 across 180 appearances, and NCAA MAE was 4.137 versus 4.054 across 36. The report at `data/prediction-evaluation.json` is the November 13 rerun; historical results below retain their original date.

The updated Vercel build passed with a 78,082,048-byte seed containing 8,234 games, 15,340 team boxes and 111,433 player appearances. The rolling one-year window means these totals can decrease as older games expire. The refreshed local server runs at `http://127.0.0.1:3000`. Source changes are ready for deployment; a real Vercel deployment and Redis connection were not performed in this check.

## November 12, 2026: earlier verification

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
