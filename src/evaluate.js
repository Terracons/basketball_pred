import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { canonical } from './analytics.js';
import { teamProjection, baselineTeamProjection, normalCdf, playerProjection, weighted } from './predict.js';
import { createEfficiencyContext, MODEL_VERSION } from './efficiency.js';
import { countLineProbabilities } from './count-distribution.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const directory = resolve(process.env.DATA_DIR || './data'), store = new Store(join(directory, 'basketball.sqlite'));
const average = (rows, field) => rows.length ? rows.reduce((s, r) => s + r[field], 0) / rows.length : null;
function score(p, game) {
  const homeProbability = 1 - normalCdf(0, p.margin, p.marginSd ?? p.sd), actualHomeWin = Number(game.home_score > game.away_score);
  return { gameId: game.game_id, probability: Math.max(homeProbability, 1 - homeProbability),
    correct: Number((homeProbability >= .5) === Boolean(actualHomeWin)), brier: (homeProbability - actualHomeWin) ** 2,
    totalError: Math.abs(p.total - game.home_score - game.away_score), marginError: Math.abs(p.margin - game.home_score + game.away_score) };
}
function summarize(rows) {
  return { tested: rows.length, winnerAccuracy: average(rows, 'correct'), winnerBrier: average(rows, 'brier'),
    totalPointsMAE: average(rows, 'totalError'), marginMAE: average(rows, 'marginError'),
    probabilityBins: [[.5,.6],[.6,.7],[.7,.8],[.8,.9],[.9,1.01]].map(([low, high]) => {
      const group = rows.filter(r => r.probability >= low && r.probability < high);
      return { minimum: low, maximum: Math.min(1, high), count: group.length,
        meanEstimatedProbability: average(group, 'probability'), observedWinnerAccuracy: average(group, 'correct') };
    }) };
}
try {
  const report = { evaluatedAt: new Date().toISOString(), model: MODEL_VERSION,
    sample: 'Up to 200 most recent completed games per league. Both models compared on identical eligible games. Each context uses only games starting more than six hours before that target game.',
    caveat: 'Retrospective outcome test, not profitability, market-line accuracy or a calibrated success guarantee. Historical stats are as imported today. No reconstructed pregame injuries or rosters. Model constants were fixed before running this comparison.', leagues: {} };
  for (const league of ['nba', 'ncaa']) {
    const games = canonical(store, 'game', league), boxes = canonical(store, 'team_box', league);
    const targets = games.filter(g => g.status === 'final' && Date.parse(g.starts_at) + 6 * 3600000 < Date.now())
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 200);
    const baseline = [], upgraded = []; let fallback = 0, context;
    for (const [i, game] of targets.entries()) {
      if (context?.asOf !== game.starts_at) context = createEfficiencyContext(games, boxes, league, game.starts_at);
      const old = baselineTeamProjection(game, games, game.starts_at), next = teamProjection(game, games, game.starts_at, context);
      if (!old || !next) continue;
      baseline.push(score(old, game)); upgraded.push(score(next, game)); if (next.model === 'scoring-baseline') fallback++;
      if ((i + 1) % 50 === 0) console.log(league + ': compared ' + (i + 1) + '/' + targets.length);
    }
    const gameMap = new Map(games.map(g => [g.game_id, g])), appearances = [], seen = new Set();
    for (const row of store.db.prepare(`SELECT id,payload FROM records WHERE kind='player_box' AND league=?
      AND starts_at<? AND source IN ('espn','sportsdataverse','snapshot')
      ORDER BY starts_at DESC,observed_at DESC,CASE source WHEN 'espn' THEN 1 ELSE 0 END DESC LIMIT 2000`).iterate(league, new Date().toISOString())) {
      if (seen.has(row.id)) continue; seen.add(row.id);
      const p = JSON.parse(row.payload);
      if (!p.did_not_play && p.minutes > 0 && Number.isFinite(p.points) && gameMap.get(p.game_id)?.status === 'final') appearances.push(p);
      if (appearances.length === 200) break;
    }
    const playerIds = [...new Set(appearances.map(p => p.player_id))], histories = new Map();
    if (playerIds.length) {
      const cutoff = new Date(Date.parse(appearances.at(-1).starts_at) - 365 * 86400000).toISOString();
      for (const row of store.db.prepare(`SELECT id,payload FROM records WHERE kind='player_box' AND league=? AND starts_at>=?
        AND source IN ('espn','sportsdataverse','snapshot') AND player_id IN (${playerIds.map(() => '?').join(',')})
        ORDER BY observed_at,CASE source WHEN 'espn' THEN 1 ELSE 0 END`).iterate(league, cutoff, ...playerIds)) histories.set(row.id, JSON.parse(row.payload));
    }
    const playerRows = [...histories.values()], playerErrors = [], reboundErrors = [];
    for (const actual of appearances) {
      const game = gameMap.get(actual.game_id), teamIds = [game.home_id, game.away_id];
      if (context?.asOf !== game.starts_at) context = createEfficiencyContext(games, boxes, league, game.starts_at);
      const forecast = teamProjection(game, games, game.starts_at, context);
      const rebound = playerProjection(playerRows, actual.player_name, teamIds, 'rebounds', game.starts_at, context, game, forecast);
      if (rebound && Number.isFinite(actual.rebounds)) {
        const oldSd = Math.sqrt(Math.max(rebound.historicalVariance, 4)) * Math.max(1, rebound.mean / Math.max(rebound.historicalMean, 1));
        let normalRps = 0, countRps = 0;
        for (let k = 0; k < 30; k++) {
          const outcome = Number(actual.rebounds <= k);
          normalRps += (normalCdf(k + .5, rebound.mean, oldSd) - outcome) ** 2;
          countRps += (countLineProbabilities(rebound.mean, rebound.countVariance, k + .5).under - outcome) ** 2;
        }
        reboundErrors.push({ normalRps: normalRps / 30, countRps: countRps / 30 });
      }
      const p = playerProjection(playerRows, actual.player_name, teamIds, 'points', game.starts_at, context, game, forecast);
      if (!p) continue;
      const prior = playerRows.filter(r => r.player_id === actual.player_id && teamIds.includes(r.team_id) && !r.did_not_play && r.minutes > 0 && Number.isFinite(r.points)
        && Date.parse(r.starts_at) + 6 * 3600000 < Date.parse(game.starts_at) && Date.parse(game.starts_at) - Date.parse(r.starts_at) <= 365 * 86400000)
        .sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 20);
      if (prior.length >= 8) playerErrors.push({ baselineError: Math.abs(weighted(prior.map(r => r.points)).mean - actual.points), upgradedError: Math.abs(p.mean - actual.points) });
    }
    report.leagues[league] = { attempted: targets.length, skipped: targets.length - upgraded.length, fallbackGames: fallback,
      baseline: summarize(baseline), upgraded: summarize(upgraded), playerReboundsDistribution: { tested: reboundErrors.length,
        normalMeanScore: average(reboundErrors, 'normalRps'), countMeanScore: average(reboundErrors, 'countRps'),
        method: 'Mean squared CDF error over fixed thresholds 0.5 through 29.5. Lower is better. Same projected means for both distributions; played appearances only, not bookmaker-line accuracy.' },
      playerPoints: { attempted: appearances.length, tested: playerErrors.length,
        baselineMAE: average(playerErrors, 'baselineError'), upgradedMAE: average(playerErrors, 'upgradedError'),
        caveat: 'Played appearances only. Does not validate DNP/injury handling, rebounds, assists, PRA, prop-line win rates or probabilities.' } };
    console.log(JSON.stringify({ league, ...report.leagues[league] }, null, 2));
  }
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'prediction-evaluation.json'), JSON.stringify(report, null, 2));
} finally { store.close(); }
