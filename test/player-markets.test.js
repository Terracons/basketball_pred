import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { odds, summaries } from '../src/collect.js';
import { generateCandidates, matchEvent, playerProjection } from '../src/predict.js';
import { countLineProbabilities } from '../src/count-distribution.js';
import { isFreshQuote } from '../src/markets.js';
import { preparePredictionData } from '../src/prepare-prediction.js';
import { loadPlayerPrices } from '../src/player-prices.js';
import { createPrediction } from '../src/slips.js';
import { Intelligence } from '../src/intelligence.js';

const asOf = '2026-11-13T20:00:00.000Z', date = '2026-11-14';
function setup(t, withProps = true) {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let i = 0; i < 12; i++) {
    const starts_at = new Date(Date.parse(asOf) - (i + 2) * 86400000).toISOString(), game_id = `past${i}`;
    store.put('game', 'nba', 'espn', game_id, { game_id, starts_at, home_id: 'h', away_id: 'a', status: 'final', home_score: 110, away_score: 100 }, asOf);
    for (const [id, rebounds] of [['High Player', 10], ['Low Player', 2]]) store.put('player_box', 'nba', 'espn', `${game_id}:${id}`, {
      game_id, starts_at, team_id: 'h', player_id: id, player_name: id, rebounds, minutes: 30
    }, asOf);
  }
  for (let i = 0; i < 8; i++) {
    const starts_at = `2026-11-14T0${i}:00:00.000Z`, game_id = `future${i}`, home_name = `Home ${i}`, away_name = `Away ${i}`;
    store.put('game', 'nba', 'espn', game_id, { game_id, starts_at, home_id: 'h', away_id: 'a', home_name, away_name, status: 'scheduled' }, asOf);
    const event = { event_id: game_id, starts_at, home_name, away_name, bookmaker: 'book', price_updated_at: asOf };
    store.put('odds', 'nba', 'odds', `total${i}`, { ...event, market: 'totals', outcomes: [{ name: 'Over', point: 199.5, price: 1.8 }] }, asOf);
    if (withProps) for (const bookmaker of ['book', 'other']) store.put('odds', 'nba', 'odds', `prop${i}:${bookmaker}`, {
      ...event, bookmaker, market: 'player_rebounds', outcomes: ['High Player', 'Low Player'].flatMap(description => ['Over', 'Under'].map(name => ({ description, name, point: 7.5, price: 1.8 })))
    }, asOf);
  }
  return store;
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} differs from ${b}`);

test('count models have exact push mass and no probability below zero', () => {
  const poisson = countLineProbabilities(2, 2, 0), geometric = countLineProbabilities(2, 6, 1);
  close(poisson.under, 0); close(poisson.push, Math.exp(-2));
  close(geometric.under, 1 / 3); close(geometric.push, 2 / 9); close(geometric.over, 4 / 9);
  for (const mean of [0, .1, 2, 10, 50]) for (const variance of [mean, mean + mean ** 2]) for (const line of [0, 1, 3.5, 30]) {
    const p = countLineProbabilities(mean, variance, line); close(p.over + p.under + p.push, 1);
    if (!Number.isInteger(line)) close(p.push, 0);
  }
});
test('clock skew accepts received quotes up to five minutes ahead but rejects future observations', () => {
  const now = Date.parse(asOf), quote = { observed_at: asOf, price_updated_at: '2026-11-13T20:04:00Z' };
  assert.equal(isFreshQuote(quote, now), true);
  assert.equal(isFreshQuote({ ...quote, price_updated_at: '2026-11-13T20:06:00Z' }, now), false);
  assert.equal(isFreshQuote({ ...quote, observed_at: '2026-11-13T20:00:01Z' }, now), false);
  assert.equal(isFreshQuote(quote, now + 7 * 3600000), false);
});
test('rebounds over/under filters are independent of game totals and retain real player prices', t => {
  const store = setup(t);
  for (const direction of ['over', 'under']) {
    const r = generateCandidates(store, { asOf, league: 'nba', type: 'player', playerStat: 'rebounds', playerDirection: direction, date });
    assert.equal(r.qualifyingGameCount, 8);
    assert.ok(r.candidates.every(p => p.market === 'player_rebounds' && p.label.includes(`: ${direction === 'over' ? 'Over' : 'Under'} `)));
    assert.ok(r.candidates.every(p => p.projection.model === 'minutes-count-v2'));
  }
  assert.throws(() => generateCandidates(store, { playerDirection: 'unknown' }), /filters/);
});
test('ranked player browser removes duplicate bookmakers and does not add correlated legs to the slip', async t => {
  const store = setup(t), result = await createPrediction(store, new Intelligence(store, { env: {} }), {
    asOf, league: 'nba', type: 'player', playerStat: 'rebounds', playerDirection: 'under', date, target: 5
  });
  assert.equal(result.availablePickCount, 8); assert.equal(result.slip.picks.length, 3);
  assert.equal(new Set(result.slip.picks.map(p => p.gameId)).size, 3);
  assert.equal(new Set(result.slip.picks.map(p => p.bookmaker)).size, 1);
  assert.ok(result.availablePicks.every((p, i, rows) => !i || p.probability <= rows[i - 1].probability));
});
test('fresh quotes on another date or for only half of mixed markets do not suppress refresh', async t => {
  const store = setup(t, false); let calls = 0;
  const deps = { now: new Date(asOf), getScoreboard: async () => [], getOdds: async () => { calls++; return { events: 0 }; } };
  await preparePredictionData(store, {}, { league: 'nba', type: 'over', date: '2026-11-15' }, 'test-key', deps);
  assert.equal(calls, 1);
  await preparePredictionData(store, {}, { league: 'nba', type: 'mixed', date }, 'test-key', deps);
  assert.equal(calls, 2);
});
test('building a missing player market fetches only the selected event and statistic', async t => {
  const store = setup(t, false), calls = [];
  await preparePredictionData(store, {}, { league: 'nba', type: 'player', playerStat: 'rebounds', playerDirection: 'under', playerEventId: 'future0', date }, 'test-key', {
    now: new Date(asOf), getScoreboard: async () => [], getOdds: async (...args) => { calls.push(args); return { snapshots: 1 }; }
  });
  assert.equal(calls.length, 1); assert.equal(calls[0][4], 'future0'); assert.deepEqual(calls[0][5], { playerStat: 'rebounds' });
});
test('player batch loads at most five matched events and stops at the quota guard', async t => {
  const store = setup(t, false); let calls = 0;
  const options = { league: 'nba', date, playerStat: 'rebounds' };
  const r = await loadPlayerPrices(store, {}, options, 'test-key', { now: Date.parse(asOf), getOdds: async () => { calls++; return { snapshots: 2 }; } });
  assert.equal(calls, 5); assert.equal(r.remainingEvents, 3); assert.equal(r.snapshots, 10);
  calls = 0;
  const partial = await loadPlayerPrices(store, {}, options, 'test-key', { now: Date.parse(asOf), getOdds: async () => { if (++calls === 3) throw new Error('odds: quota guard'); return { snapshots: 2 }; } });
  assert.equal(calls, 3); assert.equal(partial.events, 2); assert.equal(partial.remainingEvents, 6); assert.match(partial.errors[0], /quota guard/);
});
test('single prop fetch reserves one credit and empty markets are tracked without invented outcomes', async t => {
  const store = setup(t, false);
  const transport = { json: async (_provider, url, options) => {
    assert.equal(options.cost, 1); assert.match(url, /markets=player_rebounds&/);
    return { id: 'future0', commence_time: '2026-11-14T00:00:00Z', home_team: 'Home 0', away_team: 'Away 0', bookmakers: [] };
  } };
  const result = await odds(transport, store, 'nba', 'test-key', 'future0', { playerStat: 'rebounds' });
  assert.equal(result.snapshots, 0); assert.match(result.warning, /No rebounds/);
  assert.equal(store.rows('market_check', 'nba')[0].hasPrices, false);
});
test('empty checked player markets do not repeatedly block the next batch of games', async t => {
  const store = setup(t, false); store.put('market_check', 'nba', 'odds', 'future0:player_rebounds', {
    event_id: 'future0', market: 'player_rebounds', checked_at: asOf, hasPrices: false
  }, asOf);
  const ids = [];
  const r = await loadPlayerPrices(store, {}, { league: 'nba', date, playerStat: 'rebounds' }, 'test-key', {
    now: Date.parse(asOf), getOdds: async (...args) => { ids.push(args[4]); return { snapshots: 1 }; }
  });
  assert.equal(r.recentlyUnavailable, 1); assert.ok(!ids.includes('future0')); assert.equal(ids.length, 5);
});
test('NCAA abbreviated names match verified fixtures without fuzzy team substitutions', () => {
  const pairs = [['Florida St Seminoles', 'Florida State Seminoles', 'Texas A&M-CC Islanders', 'Texas A&M-Corpus Christi Islanders'],
    ['GW Revolutionaries', 'George Washington Revolutionaries', 'LIU Sharks', 'Long Island University Sharks'],
    ['South Dakota St Jackrabbits', 'South Dakota State Jackrabbits', 'N Colorado Bears', 'Northern Colorado Bears']];
  for (const [home, fullHome, away, fullAway] of pairs) assert.ok(matchEvent({ home_name: home, away_name: away, starts_at: asOf }, [{ home_name: fullHome, away_name: fullAway, starts_at: asOf }]));
  assert.equal(matchEvent({ home_name: 'North Carolina', away_name: 'Other', starts_at: asOf }, [{ home_name: 'North Carolina State', away_name: 'Other', starts_at: asOf }]), null);
});
test('a recent current-team appearance unlocks prior-team history for the same player ID', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ player_id: 'one', player_name: 'Transfer Player', team_id: i < 3 ? 'current' : 'previous',
    rebounds: 6, minutes: 24, starts_at: new Date(Date.parse(asOf) - (i + 2) * 86400000).toISOString() }));
  const p = playerProjection(rows, 'Transfer Player', ['current', 'opponent'], 'rebounds', asOf);
  assert.equal(p.samples, 12); assert.equal(p.teamId, 'current'); assert.ok(p.flags.some(f => /previous team/.test(f)));
  assert.equal(playerProjection(rows, 'Transfer Player', ['previous', 'opponent'], 'rebounds', asOf), null);
  assert.equal(playerProjection([...rows, { ...rows[0], player_id: 'different-person' }], 'Transfer Player', ['current'], 'rebounds', asOf), null);
});
test('summary collection processes a cross-source game once instead of duplicate requests', async t => {
  const store = new Store(':memory:'); t.after(() => store.close()); let requests = 0;
  const game = { game_id: 'g', starts_at: asOf, status: 'final', home_id: 'h', away_id: 'a', home_score: 10, away_score: 9 };
  for (const source of ['espn', 'sportsdataverse']) store.put('game', 'nba', source, 'g', game);
  await summaries({ json: async () => { requests++; return { boxscore: { teams: [], players: [] } }; } }, store, 'nba', 5);
  assert.equal(requests, 1);
});
