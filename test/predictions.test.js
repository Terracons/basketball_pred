import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Intelligence } from '../src/intelligence.js';
import { buildSlip, lineProbabilities, matchEvent, teamProjection, playerProjection, generateCandidates } from '../src/predict.js';
import { createPrediction, slipCsv } from '../src/slips.js';
import { preparePredictionData } from '../src/prepare-prediction.js';
import { createApplication } from '../src/application.js';
import { Readable } from 'node:stream';

const asOf = '2026-11-12T16:00:00.000Z';
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'court-predictions-')), store = new Store(join(dir, 'test.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const pick = (id, probability = 0.65, price = 2, eventId = id, bookmaker = 'book') => ({
  id, probability, odds: price, eventId, bookmaker, expectedReturn: probability * price - 1,
  home: 'Home', away: 'Away', startsAt: '2026-11-13T18:00:00Z', market: 'totals', label: 'Over 200.5', projection: {}, flags: []
});
function seed(store, { price = 2, line = 200.5, clock = asOf } = {}) {
  for (let i = 0; i < 20; i++) {
    const game = { game_id: `past-${i}`, home_id: 'h', away_id: 'a', home_name: 'Home', away_name: 'Away',
      starts_at: new Date(Date.parse(clock) - (i + 2) * 86400000).toISOString(), status: 'final', home_score: 110 + i % 3, away_score: 100 + i % 3 };
    store.put('game', 'nba', 'espn', game.game_id, game, clock);
  }
  for (let i = 0; i < 8; i++) {
    const starts_at = new Date(Date.parse(clock) + (i + 1) * 86400000).toISOString();
    store.put('game', 'nba', 'espn', `future-${i}`, { game_id: `future-${i}`, home_id: 'h', away_id: 'a', home_name: 'Home', away_name: 'Away', starts_at, status: 'scheduled' }, clock);
    store.put('odds', 'nba', 'odds', `price-${i}`, { event_id: `event-${i}`, starts_at, home_name: 'Home', away_name: 'Away', bookmaker: 'book', market: 'totals',
      price_updated_at: clock, outcomes: [{ name: 'Over', point: line, price }, { name: 'Under', point: line, price }] }, clock);
  }
}
test('integer lines reserve push probability and fractional lines have no push', () => {
  const integer = lineProbabilities(200, 15, 200), half = lineProbabilities(200, 15, 200.5);
  assert.ok(integer.push > 0); assert.ok(Math.abs(integer.over + integer.under + integer.push - 1) < 1e-9);
  assert.equal(half.push, 0); assert.ok(Math.abs(half.over + half.under - 1) < 1e-9);
});
test('matching needs exact canonical names, close start times, and a unique fixture', () => {
  const event = { home_name: 'Los Angeles Clippers', away_name: 'Team B', starts_at: asOf };
  const game = { home_name: 'LA Clippers', away_name: 'Team B', starts_at: asOf };
  assert.equal(matchEvent(event, [game]), game);
  assert.equal(matchEvent(event, [game, game]), null);
  assert.equal(matchEvent(event, [{ ...game, starts_at: '2026-12-01T00:00:00Z' }]), null);
  assert.equal(matchEvent(event, [{ home_name: game.away_name, away_name: game.home_name, starts_at: asOf, neutral: true }])?.neutral, true);
  assert.equal(matchEvent(event, [{ home_name: game.away_name, away_name: game.home_name, starts_at: asOf, neutral: false }]), null);
});
test('statistics exclude target game, later results and recently starting games', t => {
  const store = setup(t); seed(store);
  const past = store.rows('game', 'nba'), upcoming = past.find(g => g.status === 'scheduled');
  const before = teamProjection(upcoming, past, asOf);
  const after = teamProjection(upcoming, [...past, { ...upcoming, game_id: 'leak', status: 'final', home_score: 500, away_score: 0 }], asOf);
  assert.deepEqual(after, before);
  assert.equal(teamProjection(upcoming, past.slice(0, 4), asOf), null);
});
test('player projection rejects ambiguous names, DNPs and insufficient history', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ player_id: 'p1', player_name: 'Player', team_id: 'h', points: 20, minutes: 30,
    starts_at: new Date(Date.parse(asOf) - (i + 2) * 86400000).toISOString(), did_not_play: false }));
  assert.ok(Math.abs(playerProjection(rows, 'Player', ['h'], 'points', asOf).mean - 20) < 1e-10);
  assert.equal(playerProjection(rows.slice(0, 3), 'Player', ['h'], 'points', asOf), null);
  assert.equal(playerProjection([...rows, { ...rows[0], player_id: 'p2' }], 'Player', ['h'], 'points', asOf), null);
  assert.equal(playerProjection(rows.map(r => ({ ...r, did_not_play: true })), 'Player', ['h'], 'points', asOf), null);
});
test('candidate generation uses actual prices, filters market direction, and removes stale prices', t => {
  const store = setup(t); seed(store);
  const result = generateCandidates(store, { asOf, type: 'over' });
  assert.equal(result.candidates.length, 8); assert.ok(result.candidates.every(p => p.label.startsWith('Over') && p.odds === 2));
  assert.equal(generateCandidates(store, { asOf: '2026-11-13T00:00:00Z', type: 'over' }).candidates.length, 0);
});
test('slips never mix bookmakers or include opposing selections from the same game', () => {
  const result = buildSlip([pick('a'), pick('b', .7, 2, 'a'), pick('c'), pick('d', .7, 2, 'd', 'other'), pick('e')], 5);
  assert.equal(result.targetReached, true); assert.equal(result.picks.length, 3);
  assert.equal(new Set(result.picks.map(p => p.eventId)).size, 3); assert.equal(new Set(result.picks.map(p => p.bookmaker)).size, 1);
});
test('unreachable odds targets return an honest partial result', () => {
  const result = buildSlip([pick('a'), pick('b')], 200);
  assert.equal(result.targetReached, false); assert.equal(result.combinedOdds, 4); assert.equal(result.picks.length, 2);
  assert.ok(Math.abs(result.estimatedAllWinProbability - .65 ** 2) < 1e-10);
});
test('ranking prioritizes individual probability over a larger price or estimated return', () => {
  const result = buildSlip([pick('low', .55, 2.2), pick('best', .9, 1.4), pick('middle', .8, 1.7)], 5);
  assert.deepEqual(result.picks.map(p => p.id), ['best', 'middle', 'low']);
  assert.deepEqual(buildSlip([pick('low', .55, 10), pick('best', .9, 1.4)], 200).picks.map(p => p.id), ['best', 'low']);
});
test('five-odds selection returns the games making a 5.05 slip with individual and combined chances', () => {
  const result = buildSlip([pick('a', .8, 1.7), pick('b', .75, 1.8), pick('c', .7, 1.65)], 5);
  assert.equal(result.targetReached, true); assert.equal(result.closeToTarget, true);
  assert.equal(result.picks.length, 3); assert.ok(Math.abs(result.combinedOdds - 5.049) < 1e-10);
  assert.deepEqual(result.picks.map(p => p.probability), [.8, .75, .7]);
  assert.deepEqual(result.oddsCalculation, [1.7, 1.8, 1.65]);
  assert.ok(Math.abs(result.estimatedAllWinProbability - .42) < 1e-10);
});
test('combination search can choose another selection for a game to reach the target', () => {
  const result = buildSlip([pick('favorite', .9, 1.2, 'same'), pick('alternative', .75, 1.7, 'same'), pick('b', .74, 1.8), pick('c', .7, 1.65)], 5);
  assert.equal(result.targetReached, true); assert.equal(result.picks.length, 3);
  assert.ok(result.picks.some(p => p.id === 'alternative')); assert.ok(!result.picks.some(p => p.id === 'favorite'));
});
test('a partial slip uses the fuller available combination rather than a single at another bookmaker', () => {
  const result = buildSlip([pick('single', .9, 2, 'single', 'small'), pick('a', .8, 1.95, 'a', 'fuller'), pick('b', .7, 1.95, 'b', 'fuller')], 5);
  assert.equal(result.targetReached, false); assert.equal(result.picks.length, 2);
  assert.ok(Math.abs(result.combinedOdds - 3.8025) < 1e-10);
  assert.equal(result.picks[0].bookmaker, 'fuller');
});
test('all supported odds targets build real combinations and never repeat a canonical game', () => {
  const picks = Array.from({ length: 12 }, (_, i) => ({ ...pick(`p${i}`, .9 - i * .02, 1.7), gameId: `game${i}` }));
  picks.push({ ...pick('duplicate', .92, 1.8, 'different-event-id'), gameId: 'game0' });
  for (const target of [5, 10, 50, 100, 200]) {
    const result = buildSlip(picks, target); assert.equal(result.targetReached, true);
    assert.ok(result.combinedOdds >= target); assert.equal(new Set(result.picks.map(p => p.gameId)).size, result.picks.length);
    assert.ok(Math.abs(result.picks.reduce((total, p) => total * p.odds, 1) - result.combinedOdds) < 1e-8);
  }
});
test('chance-qualified games are not silently removed by an unrelated value filter', t => {
  const store = setup(t); seed(store, { price: 1.5, line: 209.5 });
  const result = generateCandidates(store, { asOf, type: 'over' });
  assert.equal(result.candidates.length, 8); assert.ok(result.candidates.every(p => p.expectedReturn < 0 && p.probability >= .5));
});
test('missing prices are fetched on build, while existing fresh prices do not spend more quota', async t => {
  const store = setup(t); let fixtureCalls = 0, oddsCalls = 0;
  const deps = { now: new Date(asOf), getScoreboard: async () => { fixtureCalls++; }, getOdds: async () => { oddsCalls++; return { events: 1 }; } };
  const result = await preparePredictionData(store, {}, { league: 'nba', type: 'over' }, 'test-only', deps);
  assert.equal(result.oddsRefreshed, true); assert.equal(fixtureCalls, 3); assert.equal(oddsCalls, 1);
  seed(store);
  await preparePredictionData(store, {}, { league: 'nba', type: 'over' }, 'test-only', deps);
  assert.equal(fixtureCalls, 3); assert.equal(oddsCalls, 1);
});
test('cold-start predict API loads real-shaped quotes then returns a multi-game slip without manual refresh', async t => {
  const store = setup(t); seed(store, { clock: new Date().toISOString() }); store.db.exec("DELETE FROM records WHERE kind='odds'");
  let calls = 0;
  const upcoming = store.rows('game', 'nba').filter(g => g.status === 'scheduled').slice(0, 3);
  const app = createApplication({ store, directory: join(tmpdir(), `courtside-api-${process.pid}`), env: { ODDS_API_KEY: 'test-only' }, fetcher: async url => {
    calls++;
    if (url.includes('espn.com')) return new Response(JSON.stringify({ events: [] }));
    return new Response(JSON.stringify(upcoming.map(g => ({ id: g.game_id, commence_time: g.starts_at, home_team: g.home_name, away_team: g.away_name,
      bookmakers: [{ key: 'book', last_update: new Date().toISOString(), markets: [{ key: 'totals', outcomes: [{ name: 'Over', point: 200.5, price: 1.8 }] }] }] }))));
  } });
  const dir = join(tmpdir(), `courtside-api-${process.pid}`);
  // App uses this directory for cache and exports; make it before taking its lock.
  const { mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  async function call(method, path, payload, token = '') {
    const req = Readable.from(payload ? [JSON.stringify(payload)] : []);
    Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:3100', 'x-app-token': token } });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await app.handler(req, res); return res;
  }
  const config = await call('GET', '/api/config');
  const result = await call('POST', '/api/predict', { league: 'nba', type: 'over', target: 5 }, config.body.actionToken);
  assert.equal(result.status, 200); assert.equal(result.body.slip.targetReached, true); assert.equal(result.body.slip.picks.length, 3);
  assert.equal(calls, 4);
  const repeat = await call('POST', '/api/predict', { league: 'nba', type: 'over', target: 5 }, config.body.actionToken);
  assert.equal(repeat.body.slip.picks.length, 3); assert.equal(calls, 4);
  assert.equal(store.db.prepare("SELECT SUM(units) n FROM usage WHERE provider='odds'").get().n, 2);
});
test('partial CSV export preserves ranking, actual prices and probabilities and escapes formula cells', () => {
  const result = { slip: { picks: [ { ...pick('a', .9, 1.4), away: '=SUM(1,2)', ai: { status: 'disabled' } }, { ...pick('b', .8, 1.6), ai: { status: 'disabled' } }] } };
  const csv = slipCsv(result), lines = csv.split('\r\n');
  assert.ok(lines[1].startsWith('"1"')); assert.ok(lines[1].includes("'=SUM(1,2)"));
  assert.ok(lines[1].includes('"0.9"')); assert.ok(lines[2].includes('"0.8"'));
});
test('AI skips 70 percent and above before any catalog or model network calls', async t => {
  const store = setup(t), ai = new Intelligence(store, { env: { OPENROUTER_API_KEY: 'SECRET' }, fetcher: () => assert.fail('No AI calls allowed') });
  assert.equal((await ai.review('s1', pick('a', .7), 'model')).status, 'skipped');
  assert.equal(ai.used('s1'), 0);
});
test('five-request ceiling is persisted and shared between searches and reviews', t => {
  const store = setup(t), ai = new Intelligence(store);
  for (let i = 0; i < 5; i++) ai.reserve('s1', i % 2 ? 'openrouter' : 'tavily', 0);
  assert.throws(() => ai.reserve('s1', 'openrouter', 0), /Five-request/);
  assert.equal(new Intelligence(store).used('s1'), 5);
  ai.reserve('s2', 'openrouter', 0); assert.equal(ai.used('s2'), 1);
});
test('dollar limit rejection is atomic and consumes no request allowance', t => {
  const store = setup(t), ai = new Intelligence(store, { env: { OPENROUTER_MAX_REQUEST_USD: '.001' } });
  assert.throws(() => ai.reserve('s1', 'openrouter', .01), /dollar budget/); assert.equal(ai.used('s1'), 0);
});
test('AI cannot invent citations or change probabilities, and cached reviews use no extra requests', async t => {
  const store = setup(t); let calls = 0;
  const ai = new Intelligence(store, { env: { OPENROUTER_API_KEY: 'SECRET' }, fetcher: async (url, options) => {
    calls++; const request = JSON.parse(options.body); assert.equal(request.model, 'chosen/model');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: 'keep', reason: 'Limited history', sourceIds: [] }) } }] }));
  } });
  ai.save('openrouter-models-v1', [{ id: 'chosen/model', promptPrice: 0, completionPrice: 0, requestPrice: 0, contextLength: 100000 }]);
  const selection = pick('a'), result = await ai.review('s1', selection, 'chosen/model');
  assert.equal(result.decision, 'keep'); assert.equal(selection.probability, .65);
  assert.equal((await ai.review('s1', selection, 'chosen/model')).cached, true); assert.equal(calls, 1);
});
test('invalid AI review fails closed without a retry', async t => {
  const store = setup(t); let calls = 0;
  const ai = new Intelligence(store, { env: { OPENROUTER_API_KEY: 'SECRET' }, fetcher: async () => {
    calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"keep","reason":"x","sourceIds":["invented"]}' } }] }));
  } });
  ai.save('openrouter-models-v1', [{ id: 'chosen/model', promptPrice: 0, completionPrice: 0, requestPrice: 0, contextLength: 100000 }]);
  await assert.rejects(ai.review('s1', pick('a'), 'chosen/model'), /validation/); assert.equal(calls, 1); assert.equal(ai.used('s1'), 1);
});
test('whole slip AI path obeys cap and persists estimates without arbitrary probability boosts', async t => {
  const store = setup(t); seed(store, { price: 2, line: 209.5 });
  const ai = new Intelligence(store, { env: { OPENROUTER_API_KEY: 'SECRET' }, fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"keep","reason":"Baseline only","sourceIds":[]}' } }] })) });
  ai.save('openrouter-models-v1', [{ id: 'chosen/model', promptPrice: 0, completionPrice: 0, requestPrice: 0, contextLength: 100000 }]);
  const result = await createPrediction(store, ai, { asOf, league: 'nba', type: 'over', target: 100, aiEnabled: true, model: 'chosen/model' });
  assert.equal(result.aiRequestsAndSearches, 5);
  assert.ok(result.slip.picks.every(p => p.probability < .7));
  assert.equal(store.rows('prediction', 'nba').length, 1);
});
