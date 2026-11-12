# Prediction model and data coverage

Version `efficiency-v1` uses our own opponent-adjusted team ratings. These are neither official NBA ratings nor licensed KenPom/BPI ratings. Percentages are model estimates, not measured individual success rates.

## Inputs and formulas

Both teams need a valid box score matching the final game score. Required inputs are points, field goals and three-pointers made/attempted, free throws made/attempted, offensive/defensive rebounds, turnovers, and assists. Missing values stay missing. Impossible shooting totals and implausible pace are rejected.

For NBA, estimated possessions are `FGA - OREB + TO + 0.44 * FTA`. Average the two teams' estimates. Offensive/defensive ratings are points scored/allowed per 100 possessions; their difference is Net Rating. Pace adjusts possessions to 48 minutes, including five minutes per overtime when determining actual duration. These box-score definitions follow [SportsDataverse's advanced metrics guide](https://hoopr.sportsdataverse.org/articles/basketball-advanced-metrics.html).

NCAA uses a 0.475 free-throw coefficient and a 40-minute regulation game, consistent with the definitions in [Ken Pomeroy's ratings glossary](https://kenpom.com/blog/ratings-glossary/). Unknown period counts are excluded from efficiency calculations instead of assuming regulation time.

Supporting factors are eFG `(FGM + 0.5 * 3PM) / FGA`, offensive rebound share `OREB / (OREB + opponent DREB)`, defensive rebound share `DREB / (DREB + opponent OREB)`, turnovers per estimated possession, free-throw attempts per field-goal attempt, and assists per turnover. Ratios use weighted numerator/denominator totals. A zero denominator produces an unavailable value. See [Ken Pomeroy's factor definitions](https://kenpom.com/blog/four-factors/).

## Prediction rules

Only completed games that started more than six hours before the prediction timestamp and within the previous 365 days enter the ratings. This applies to the league average and every opponent, as well as the two selected teams. At least eight valid games per team are required. Each team uses its most recent twenty valid pairs, weighted by `exp(-index / 8)`.

Ratings are adjusted iteratively for opponent offense/defense, using a league-average reference, twelve damped iterations, and shrinkage equivalent to six average games. Older latest appearances increase shrinkage. This custom regularization is inspired by the opponent adjustment principle in [Pomeroy's methodology](https://kenpom.com/blog/ratings-explanation/); it is not a reproduction of his system.

Expected possessions are the mean of the teams' regulation pace. Matchup scoring efficiency combines one team's adjusted offense with the other's adjusted defense relative to league efficiency. Net strength is represented by the offense/defense difference, not added again as another independent score. Estimated possessions times matchup efficiency gives projected points.

Fixed, uncalibrated context assumptions are a home margin of two NBA points or three NCAA points, zero at a neutral venue, and 0.35 margin points per difference in rest days, capped at three rest days. Historical ratings remove these same context adjustments before opponent adjustment. A league-average overtime scoring allowance is added to totals. Venue and rest assumptions redistribute the margin without independently increasing the total.

Total and margin distributions use separate recent variances. Standard-deviation floors are 15/12 points for NBA totals/margins and 12/10 for NCAA. Normal distributions estimate market probabilities; integer total/prop lines retain a separate push probability. Supporting shooting, rebound and turnover factors explain the ratings and are included in optional AI review. They do not receive additional arbitrary additive weights.

If either team lacks eight valid paired boxes, a clearly labeled scoring-average fallback is used when eight score-only games exist for each team. Otherwise the game is excluded. This avoids inventing advanced statistics for incomplete history.

Player estimates use weighted per-minute production multiplied by estimated minutes from the latest five appearances with the most recently observed team. Matched team history supplies a bounded pace adjustment. Points props also receive a bounded, partial opponent-defense adjustment. Future minutes, usage, availability and lineups are not verified. Rebounds, assists and PRA do not inherit the points-only defense adjustment.

## Coverage and deployment

The local audit on 12 November 2026 found 8,280 NBA and 38,966 NCAA team rows with every required numeric field. Paired boxes cover all 4,140 completed NBA games and 19,482 of 19,494 NCAA games. In the latest year, 1,330 NBA games pass efficiency checks, with four missing duration; 6,364 NCAA games pass, with one missing pair and ten invalid pairs. All 30 NBA teams and 368 college teams/opponents have at least eight valid samples.

Latest stored game, team-box and player-box timestamps are 12 November 2026 at 03:00 UTC for NBA and 04:00 UTC for NCAA, corresponding to the US evening of November 11. These are game timestamps, not a promise of a continuously running feed. Run `npm run audit:data` for current coverage.

No verified injury feed, starting lineups, lineup Net Rating, on/off ratings, adjusted player plus-minus or clutch possessions are collected. Those features are not fabricated. Old roster periods are flagged.

Vercel builds include one year of team boxes and period metadata, plus recent player appearances per team. Clean builds download public team boxes alongside schedules and player boxes. The same module supplies local and hosted projections; a regression compares identical candidates from both stores. No additional paid data subscription is required for these features.

## Validation limits

See [VERIFICATION.md](VERIFICATION.md) for the paired walk-forward comparison and build checks. Winner accuracy improved in that sample; total-points error did not. Player points changed little for NBA and improved slightly in a small NCAA sample. We have not validated betting profit, real historical over/under line success, player-prop probabilities or accumulator probabilities. AI still skips picks at or above 70%, shares a maximum of five requests with optional search, and cannot inflate a statistical probability.
