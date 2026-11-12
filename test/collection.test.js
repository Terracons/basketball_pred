import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Http } from '../src/http.js';
import { csvRows } from '../src/csv.js';
import { espnGames, espnBox, stats, scheduleRow, boxRow } from '../src/normalize.js';
import { odds, history, cbbd, summaries } from '../src/collect.js';
import { canonical, exportLabels, headToHead } from '../src/analytics.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'basketball-test-')), store = new Store(join(dir, 'test.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
const game = { game_id: 'g1', home_id: 'h', away_id: 'a', starts_at: '2026-11-10T00:00:00.000Z', status: 'final', home_score: 100, away_score: 98 };
test('quota reservation is persistent, atomic, and rolls over by UTC month', t => {
  const { store } = setup(t), limits = { daily: 3, monthly: 5 };
  store.reserve('odds', 3, limits, new Date('2026-11-10'));
  assert.throws(() => store.reserve('odds', 1, limits, new Date('2026-11-10')), /quota guard/);
  store.reserve('odds', 2, limits, new Date('2026-11-11'));
  assert.throws(() => store.reserve('odds', 1, limits, new Date('2026-11-12')), /quota guard/);
  store.reserve('odds', 3, limits, new Date('2026-12-01'));
  assert.equal(store.status().usage.length, 3);
});
test('reported remaining balance blocks calls made after other apps use the key', t => {
  const { store } = setup(t); store.remoteRemaining('odds', 2);
  assert.throws(() => store.reserve('odds', 3, { daily: 14, monthly: 450 }), /quota guard/);
});
test('HTTP cache prevents repeat spending and keeps keys out of persisted metadata', async t => {
  const { store, dir } = setup(t); let calls = 0;
  const http = new Http(store, dir, { sleep: async () => {}, fetcher: async (url, options) => {
    calls++; assert.equal(options.headers['x-api-key'], 'SECRET'); return new Response('{"ok":true}');
  } });
  const options = { headers: { 'x-api-key': 'SECRET' }, cost: 3 };
  await http.json('odds', 'https://example.invalid/odds', options);
  await http.json('odds', 'https://example.invalid/odds', options);
  assert.equal(calls, 1); assert.equal(store.status().usage[0].units, 3);
  assert.ok(!JSON.stringify(store.status()).includes('SECRET'));
});
test('rate-limit retry is capped and every attempt consumes local quota', async t => {
  const { store, dir } = setup(t); let calls = 0;
  const http = new Http(store, dir, { sleep: async () => {}, fetcher: async () => {
    calls++; return calls < 3 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : new Response('{}');
  } });
  await http.json('espn', 'https://example.invalid');
  assert.equal(calls, 3); assert.equal(store.status().usage[0].units, 3);
});
test('authentication failure is not retried or leaked', async t => {
  const { store, dir } = setup(t); let calls = 0;
  const http = new Http(store, dir, { sleep: async () => {}, fetcher: async () => { calls++; return new Response('secret body', { status: 401 }); } });
  await assert.rejects(http.json('cbbd', 'https://example.invalid'), /^Error: cbbd: HTTP 401$/); assert.equal(calls, 1);
});
test('network failures retry three times and sanitize errors', async t => {
  const { store, dir } = setup(t);
  const http = new Http(store, dir, { sleep: async () => {}, fetcher: async () => { throw new Error('SECRET_KEY'); } });
  await assert.rejects(http.json('espn', 'https://example.invalid'), /network\/download failure after 3 attempts/);
  assert.equal(store.status().usage[0].units, 3);
});
test('CSV streaming handles quoted commas, escaped quotes and embedded newlines', async t => {
  const { dir } = setup(t), path = join(dir, 'input.csv');
  writeFileSync(path, 'id,name,note\r\n1,"Smith, Joe","a ""quote""\nnext"\r\n2,Other,done');
  const rows = []; for await (const r of csvRows(path)) rows.push(r);
  assert.deepEqual(rows, [{ id: '1', name: 'Smith, Joe', note: 'a "quote"\nnext' }, { id: '2', name: 'Other', note: 'done' }]);
});
test('malformed CSV fails explicitly', async t => {
  const { dir } = setup(t), path = join(dir, 'bad.csv'); writeFileSync(path, 'a,b\n"unclosed');
  await assert.rejects(async () => { for await (const r of csvRows(path)) void r; }, /Unterminated/);
});
test('missing stats stay null, real zeros stay zero, and PRA requires all components', () => {
  assert.equal(stats({ points: '', rebounds: 3, assists: 2 }).pra, null);
  assert.equal(stats({ points: 0, rebounds: 3, assists: 2 }).pra, 5);
  const p = stats({ MIN: '32:30', FG: '8-17', '3PT': '2-7', PTS: '22', REB: '7', AST: '4' });
  assert.equal(p.minutes, 32.5); assert.equal(p.fga, 17); assert.equal(p.pra, 33);
});
test('schedule parser rejects final games without scores', () => {
  assert.throws(() => scheduleRow({ game_id: '1', home_id: 'h', away_id: 'a', date: game.starts_at, status_type_completed: 'true' }), /scores/);
});
test('ESPN scoreboard and player box score parse actual API nesting', () => {
  const [g] = espnGames({ events: [{ id: 'g1', date: game.starts_at, status: { type: { completed: true } }, competitions: [{ competitors: [
    { homeAway: 'home', team: { id: 'h', displayName: 'Home' }, score: '100' },
    { homeAway: 'away', team: { id: 'a', displayName: 'Away' }, score: '98' }
  ] }] }] });
  assert.equal(g.home_score, 100);
  const result = espnBox({ boxscore: { players: [{ team: { id: 'h' }, statistics: [{ labels: ['MIN', 'PTS', 'REB', 'AST'], athletes: [
    { athlete: { id: 'p', displayName: 'Player' }, stats: ['30', '20', '8', '5'], starter: true },
    { athlete: { id: 'dnp' }, stats: [], didNotPlay: true }
  ] }] }] } }, g);
  assert.equal(result.players[0].pra, 33); assert.equal(result.players[1].points, null);
});
test('ESPN team shooting fields use hyphens in the real summary API', () => {
  const { teams } = espnBox({ boxscore: { teams: [{ team: { id: 'h' }, statistics: [
    { name: 'fieldGoalsMade-fieldGoalsAttempted', displayValue: '37-88' },
    { name: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', displayValue: '11-36' },
    { name: 'freeThrowsMade-freeThrowsAttempted', displayValue: '23-28' }
  ] }] } }, game);
  assert.equal(teams[0].fgm, 37); assert.equal(teams[0].fga, 88);
  assert.equal(teams[0].fg3m, 11); assert.equal(teams[0].fta, 28);
});
test('same source reruns upsert, cross-source records canonicalize, H2H excludes future games', t => {
  const { store } = setup(t);
  store.put('game', 'nba', 'sportsdataverse', 'g1', game, '2026-11-10T01:00:00Z');
  store.put('game', 'nba', 'espn', 'g1', { ...game, home_score: 101 }, '2026-11-11T00:00:00Z');
  store.put('game', 'nba', 'espn', 'g1', { ...game, home_score: 102 }, '2026-11-11T00:00:00Z');
  assert.equal(canonical(store, 'game', 'nba').length, 1);
  assert.equal(canonical(store, 'game', 'nba')[0].home_score, 102);
  assert.equal(headToHead(store, 'nba', 'a', 'h', '2026-11-09').length, 0);
  assert.equal(headToHead(store, 'nba', 'a', 'h', '2026-11-12').length, 1);
});
test('odds reruns preserve immutable snapshot and original observation time', async t => {
  const { store } = setup(t);
  const body = [{ id: 'event', commence_time: game.starts_at, home_team: 'Home', away_team: 'Away', bookmakers: [
    { key: 'book', last_update: '2026-11-09T00:00:00Z', markets: [{ key: 'totals', outcomes: [{ name: 'Over', point: 199.5, price: 1.9 }] }] }
  ] }];
  const http = { json: async (provider, url, options) => { assert.equal(options.cost, 2); assert.ok(!url.includes('SECRET')); return body; } };
  await odds(http, store, 'nba', 'SECRET'); const before = store.rows('odds', 'nba')[0];
  await odds(http, store, 'nba', 'SECRET'); assert.deepEqual(store.rows('odds', 'nba'), [before]);
});
test('missing optional keys skip without making calls', async t => {
  const { store } = setup(t), http = { json: () => assert.fail('Should not call provider') };
  assert.ok((await odds(http, store, 'nba')).skipped); assert.ok((await cbbd(http, store, '2026-11-12', '2026-11-12')).skipped);
});
test('summary checkpoint requires complete player scoring for both teams', async t => {
  const { store } = setup(t); store.put('game', 'nba', 'espn', game.game_id, game);
  const team = (id, points) => ({ team: { id }, statistics: [{ labels: ['PTS'], athletes: [
    { athlete: { id: `player-${id}` }, stats: [String(points)] }
  ] }] });
  const body = { boxscore: { teams: [{ team: { id: 'h' } }, { team: { id: 'a' } }], players: [team('h', 100)] } };
  const http = { json: async () => body };
  const first = await summaries(http, store, 'nba'); assert.equal(first.done, 0); assert.equal(first.errors.length, 1);
  body.boxscore.players.push(team('a', 98));
  assert.equal((await summaries(http, store, 'nba')).done, 1);
  assert.equal((await summaries({ json: () => assert.fail('completed summary refetched') }, store, 'nba')).done, 0);
});
test('historical import is restartable and idempotent', async t => {
  const { dir, store } = setup(t), file = join(dir, 'season.csv');
  writeFileSync(file, 'game_id,date,home_id,away_id,home_score,away_score,status_type_completed\n1,2026-01-01T00:00:00Z,h,a,110,105,true\n');
  const http = { file: async () => file };
  assert.deepEqual(await history(http, store, 'nba', 2026, ['schedule']), { schedule: 1 });
  await history(http, store, 'nba', 2026, ['schedule']); assert.equal(canonical(store, 'game', 'nba').length, 1);
});
test('invalid historical identities are quarantined without dropping later valid rows', async t => {
  const { dir, store } = setup(t), file = join(dir, 'players.csv');
  writeFileSync(file, 'game_id,team_id,athlete_id,game_date_time,points\ng1,h,p1,2026-01-01T00:00:00Z,10\ng1,h,,2026-01-01T00:00:00Z,99\ng1,h,p2,2026-01-01T00:00:00Z,20\n');
  store.db.prepare('INSERT INTO cache VALUES(?,?,?)').run('fixture', file, '2026-11-12T00:00:00Z');
  const http = { file: async () => file };
  const result = await history(http, store, 'nba', 2026, ['player_box']);
  assert.equal(result.player_box, 2); assert.equal(result.player_box_rejected, 1);
  assert.equal(store.rows('player_box', 'nba').length, 2);
  assert.equal(store.status().imports[0].state, 'complete');
  assert.equal(store.status().rejections[0].count, 1);
  writeFileSync(file, 'invalid changed data must not be parsed because completed download is checkpointed');
  assert.deepEqual(await history(http, store, 'nba', 2026, ['player_box']), result);
});
test('unreadable historical CSV leaves an incomplete import checkpoint', async t => {
  const { dir, store } = setup(t), file = join(dir, 'bad-history.csv');
  writeFileSync(file, 'game_id,team_id\n"unfinished');
  await assert.rejects(history({ file: async () => file }, store, 'nba', 2026, ['team_box']), /Unterminated/);
  assert.equal(store.status().imports[0].state, 'in_progress');
});
test('export includes final labels, excludes scheduled results, and keeps DNP labels null', t => {
  const { store, dir } = setup(t);
  store.put('game', 'nba', 'espn', 'g1', game);
  store.put('game', 'nba', 'espn', 'g2', { ...game, game_id: 'g2', status: 'scheduled' });
  store.put('player_box', 'nba', 'espn', 'g1:p', { game_id: 'g1', player_id: 'p', did_not_play: true, points: 0 });
  const out = join(dir, 'export'); const report = exportLabels(store, out);
  assert.equal(report.nba_games, 1);
  assert.equal(JSON.parse(readFileSync(join(out, 'nba_games.jsonl'))).total_points, 198);
  assert.equal(JSON.parse(readFileSync(join(out, 'nba_players.jsonl'))).points, null);
});
