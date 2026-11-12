import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { canonical } from './analytics.js';
import { teamProjection, normalCdf } from './predict.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const directory = resolve(process.env.DATA_DIR || './data'), store = new Store(join(directory, 'basketball.sqlite'));
try {
  const report = { evaluatedAt: new Date().toISOString(), sample: 'Up to 200 most recent completed games per league; walk-forward, using only games starting at least six hours earlier.',
    caveat: 'Retrospective scoring evaluation, not a betting profitability test. Historical injury/roster availability is not reconstructed. Baseline probabilities are not calibrated.', leagues: {} };
  for (const league of ['nba', 'ncaa']) {
    const games = canonical(store, 'game', league), targets = games.filter(g => g.status === 'final' && Date.parse(g.starts_at) + 6 * 3600000 < Date.now())
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 200);
    const results = [];
    for (const game of targets) {
      const p = teamProjection(game, games, game.starts_at); if (!p) continue;
      const homeProbability = 1 - normalCdf(0, p.margin, p.sd), actualHomeWin = Number(game.home_score > game.away_score);
      results.push({ gameId: game.game_id, probability: homeProbability >= .5 ? homeProbability : 1 - homeProbability,
        correct: Number((homeProbability >= .5) === Boolean(actualHomeWin)), brier: (homeProbability - actualHomeWin) ** 2,
        totalError: Math.abs(p.total - game.home_score - game.away_score) });
    }
    const average = (rows, field) => rows.length ? rows.reduce((s, r) => s + r[field], 0) / rows.length : null;
    const high = results.filter(r => r.probability >= .7);
    report.leagues[league] = { tested: results.length, skipped: targets.length - results.length,
      winnerAccuracy: average(results, 'correct'), winnerBrier: average(results, 'brier'), totalPointsMAE: average(results, 'totalError'),
      estimatesAtLeast70: { count: high.length, observedWinnerAccuracy: average(high, 'correct') } };
  }
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'prediction-evaluation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); }
