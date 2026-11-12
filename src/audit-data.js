import { existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { canonical } from './analytics.js';
import { createEfficiencyContext } from './efficiency.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const directory = resolve(process.env.DATA_DIR || './data'), store = new Store(join(directory, 'basketball.sqlite'));
const report = { auditedAt: new Date().toISOString(), leagues: {},
  unavailable: ['Verified injuries and starting lineups', 'Lineup and on/off ratings', 'Adjusted player plus-minus', 'Clutch possessions', 'Verified future player usage'] };
try {
  for (const league of ['nba', 'ncaa']) {
    const games = canonical(store, 'game', league), boxes = canonical(store, 'team_box', league);
    const finals = games.filter(g => g.status === 'final'), ids = new Set(boxes.map(b => `${b.game_id}:${b.team_id}`));
    const fields = ['points', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'offensive_rebounds', 'defensive_rebounds', 'turnovers', 'assists'];
    const context = createEfficiencyContext(games, boxes, league, report.auditedAt);
    report.leagues[league] = { completedGames: finals.length, teamBoxRows: boxes.length,
      pairedGames: finals.filter(g => ids.has(`${g.game_id}:${g.home_id}`) && ids.has(`${g.game_id}:${g.away_id}`)).length,
      finiteFieldCounts: Object.fromEntries(fields.map(k => [k, boxes.filter(b => Number.isFinite(b[k])).length])),
      latestCompletedGame: finals.map(g => g.starts_at).sort().at(-1), latestTeamBoxGame: boxes.map(b => b.starts_at).sort().at(-1),
      latestPlayerBoxGame: store.db.prepare("SELECT MAX(starts_at) latest FROM records WHERE kind='player_box' AND league=?").get(league).latest,
      latestYear: context.coverage, teamsWithEightValidGames: [...context.ratings.values()].filter(r => r.samples >= 8).length };
  }
  writeFileSync(join(directory, 'advanced-data-coverage.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); }
