import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxMetrics, gameDuration, createEfficiencyContext, efficiencyProjection } from '../src/efficiency.js';
import { teamProjection, playerProjection, generateCandidates } from '../src/predict.js';
import { scheduleRow, espnGames } from '../src/normalize.js';
import { Store } from '../src/store.js';
import { populateSnapshot } from '../src/snapshot.js';

const asOf = '2026-11-12T16:00:00.000Z';
const home = { points: 110, fgm: 40, fga: 80, fg3m: 10, fg3a: 30, ftm: 20, fta: 25,
  offensive_rebounds: 10, defensive_rebounds: 30, turnovers: 12, assists: 25 };
const away = { ...home, points: 100, fgm: 35 };
function dataset() {
  const games = [], boxes = [];
  for (let i = 0; i < 20; i++) {
    const g = { game_id: `g${i}`, home_id: 'h', away_id: 'a', home_name: 'Home', away_name: 'Away', periods: 4,
      starts_at: new Date(Date.parse(asOf) - (i + 2) * 86400000).toISOString(), status: 'final', home_score: 110, away_score: 100, neutral: true };
    games.push(g); boxes.push({ ...home, game_id: g.game_id, team_id: 'h', starts_at: g.starts_at },
      { ...away, game_id: g.game_id, team_id: 'a', starts_at: g.starts_at });
  }
  const future = { ...games[0], game_id: 'future', starts_at: '2026-11-13T16:00:00.000Z', status: 'scheduled', home_score: null, away_score: null };
  return { games, boxes, future };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('known box scores produce possession ratings and supporting percentage metrics', () => {
  const r = boxMetrics(home, away, 'nba');
  close(r.possessions, 93); close(r.offensiveRating, 11000 / 93); close(r.defensiveRating, 10000 / 93);
  close(r.netRating, 1000 / 93); close(r.efg, 45 / 80);
  close(r.offensiveReboundPct, .25); close(r.defensiveReboundPct, .75);
  close(r.freeThrowRate, 25 / 80); close(r.assistToTurnover, 25 / 12); close(r.turnoverRate, 12 / 93);
  close(boxMetrics(home, away, 'ncaa').possessions, 93.875);
});
test('missing, impossible or zero-denominator inputs never become invented advanced metrics', () => {
  assert.equal(boxMetrics({ ...home, fga: null }, away, 'nba'), null);
  assert.equal(boxMetrics({ ...home, points: 111 }, away, 'nba'), null);
  assert.equal(boxMetrics({ ...home, fg3m: 50 }, away, 'nba'), null);
  assert.equal(boxMetrics({ ...home, turnovers: 0 }, away, 'nba').assistToTurnover, null);
  assert.equal(gameDuration({}, 'nba'), null);
});
test('overtime pace is normalized to 48 NBA minutes or 40 NCAA minutes', () => {
  assert.equal(gameDuration({ periods: 5 }, 'nba'), 53);
  assert.equal(gameDuration({ periods: 4 }, 'ncaa'), 50);
  const { games, boxes } = dataset();
  const regulation = createEfficiencyContext(games, boxes, 'nba', asOf);
  const overtime = createEfficiencyContext(games.map(g => ({ ...g, periods: 5 })), boxes, 'nba', asOf);
  close(overtime.ratings.get('h').pace, regulation.ratings.get('h').pace * 48 / 53);
  close(overtime.ratings.get('h').netRating, regulation.ratings.get('h').netRating);
});
test('target results, later games and games within six hours cannot change any league or opponent rating', () => {
  const { games, boxes, future } = dataset(), original = createEfficiencyContext(games, boxes, 'nba', asOf);
  const leaked = { ...future, status: 'final', home_score: 110, away_score: 100 };
  const recent = { ...leaked, game_id: 'recent', starts_at: '2026-11-12T14:00:00.000Z' };
  const extended = createEfficiencyContext([...games, leaked, recent], [...boxes,
    ...[leaked, recent].flatMap(g => [{ ...home, game_id: g.game_id, team_id: 'h' }, { ...away, game_id: g.game_id, team_id: 'a' }])], 'nba', asOf);
  assert.deepEqual(efficiencyProjection(future, extended), efficiencyProjection(future, original));
  assert.deepEqual(extended.coverage, original.coverage);
});
test('invalid box pairs are excluded and insufficient efficiency history gets a labeled fallback', () => {
  const { games, boxes, future } = dataset();
  const partial = createEfficiencyContext(games, boxes.slice(0, 14), 'nba', asOf);
  assert.equal(partial.coverage.usableGames, 7); assert.equal(partial.coverage.missingBoxes, 13);
  assert.equal(efficiencyProjection(future, partial), null);
  const fallback = teamProjection(future, games, asOf, partial);
  assert.equal(fallback.model, 'scoring-baseline'); assert.match(fallback.flags[0], /fallback/);
  const invalid = createEfficiencyContext(games, boxes.map(b => b.team_id === 'h' ? { ...b, points: 999 } : b), 'nba', asOf);
  assert.equal(invalid.coverage.invalidBoxes, 20);
});
test('efficiency forecasts use pace, adjusted ratings, net rating, and neutral-site context', () => {
  const { games, boxes, future } = dataset(), context = createEfficiencyContext(games, boxes, 'nba', asOf);
  const neutral = efficiencyProjection(future, context), hosted = efficiencyProjection({ ...future, neutral: false }, context);
  assert.equal(neutral.model, 'efficiency-v1'); assert.ok(neutral.homeMetrics.adjustedNetRating > 0);
  close(neutral.homeMean, neutral.expectedPossessions * neutral.homeMetrics.adjustedOffense * neutral.awayMetrics.adjustedDefense / neutral.leagueEfficiency / 100);
  close(hosted.margin - neutral.margin, 2); close(hosted.total, neutral.total);
  assert.ok(Number.isFinite(neutral.marginSd)); assert.ok(neutral.homeMetrics.factors.efg > 0);
});
test('opponent adjustment changes strength even when a team has identical own box scores', () => {
  const { games, boxes } = dataset(), initial = createEfficiencyContext(games, boxes, 'nba', asOf);
  for (let i = 0; i < 10; i++) {
    const g = { ...games[i], game_id: `extra${i}`, home_id: 'a', away_id: 'b', home_score: 120, away_score: 130 };
    games.push(g); boxes.push({ ...home, points: 120, ftm: 30, fta: 35, game_id: g.game_id, team_id: 'a' },
      { ...home, points: 130, fgm: 50, game_id: g.game_id, team_id: 'b' });
  }
  const adjusted = createEfficiencyContext(games, boxes, 'nba', asOf);
  close(initial.ratings.get('h').offensiveRating, adjusted.ratings.get('h').offensiveRating);
  assert.notEqual(initial.ratings.get('h').adjustedOffense, adjusted.ratings.get('h').adjustedOffense);
});
test('player minutes model responds to a recent role change without silently verifying availability', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ player_id: 'p', player_name: 'Player', team_id: 'h', points: i < 5 ? 10 : 30,
    minutes: i < 5 ? 10 : 30, starts_at: new Date(Date.parse(asOf) - (i + 2) * 86400000).toISOString() }));
  const projection = playerProjection(rows, 'Player', ['h'], 'points', asOf);
  close(projection.mean, 10); close(projection.perMinuteRate, 1); close(projection.minutes, 10);
  assert.ok(projection.flags.some(f => /not verified/.test(f)));
});
test('normalizers preserve periods needed for pace calculations', () => {
  const row = scheduleRow({ game_id: 'g', home_id: 'h', away_id: 'a', date: asOf, status_period: '5.0' });
  assert.equal(row.periods, 5);
  const rows = espnGames({ events: [{ id: 'g', date: asOf, status: { period: 4 }, competitions: [{ competitors: [
    { homeAway: 'home', team: { id: 'h' } }, { homeAway: 'away', team: { id: 'a' } }
  ] }] }] });
  assert.equal(rows[0].periods, 4);
});
test('deployment snapshot retains team metrics and produces identical efficiency candidates', t => {
  const dir = mkdtempSync(join(tmpdir(), 'efficiency-snapshot-'));
  const source = new Store(join(dir, 'source.sqlite')), deployed = new Store(join(dir, 'deployed.sqlite'));
  t.after(() => { source.close(); deployed.close(); rmSync(dir, { recursive: true, force: true }); });
  const { games, boxes, future } = dataset();
  for (const g of [...games, future]) source.put('game', 'nba', 'sportsdataverse', g.game_id, g, asOf);
  for (const b of boxes) source.put('team_box', 'nba', 'sportsdataverse', `${b.game_id}:${b.team_id}`, b, asOf);
  const counts = populateSnapshot(source, deployed, Date.parse(asOf)); assert.equal(counts.nba.teams, 40);
  const odds = { event_id: 'future', home_name: 'Home', away_name: 'Away', starts_at: future.starts_at, bookmaker: 'book',
    market: 'totals', price_updated_at: asOf, outcomes: [{ name: 'Over', point: 190.5, price: 1.9 }] };
  for (const store of [source, deployed]) store.put('odds', 'nba', 'odds', 'quote', odds, asOf);
  const local = generateCandidates(source, { asOf }), hosted = generateCandidates(deployed, { asOf });
  assert.equal(local.candidates.length, 1); assert.equal(local.candidates[0].projection.model, 'efficiency-v1');
  assert.deepEqual(hosted.candidates, local.candidates);
});
