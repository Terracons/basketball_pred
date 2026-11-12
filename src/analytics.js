import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// ESPN ids are shared by ESPN and SportsDataverse. CBBD remains supplemental.
export function* canonicalIterator(store, kind, league) {
  const rows = store.db.prepare(`WITH ranked AS (
    SELECT rowid rid, ROW_NUMBER() OVER (PARTITION BY id ORDER BY observed_at DESC,
      CASE source WHEN 'espn' THEN 1 ELSE 0 END DESC) priority
    FROM records WHERE kind=? AND league=? AND source IN ('espn','sportsdataverse','snapshot'))
    SELECT records.payload,records.observed_at,records.source FROM ranked
    JOIN records ON records.rowid=ranked.rid WHERE priority=1`).iterate(kind, league);
  for (const r of rows) yield { ...JSON.parse(r.payload), source: r.source, observed_at: r.observed_at };
}
export const canonical = (store, kind, league) => [...canonicalIterator(store, kind, league)];
export function headToHead(store, league, first, second, before, limit = 10) {
  if (!Number.isFinite(Date.parse(before))) throw new Error('A valid as-of timestamp is required');
  return canonical(store, 'game', league)
    .filter(g => g.status === 'final' && g.starts_at < new Date(before).toISOString()
      && ((g.home_id === first && g.away_id === second) || (g.home_id === second && g.away_id === first)))
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, limit);
}
export function quality(store) {
  return Object.fromEntries(['nba', 'ncaa'].map(league => {
    const games = canonical(store, 'game', league);
    const finals = games.filter(g => g.status === 'final');
    const playerGames = new Set();
    const playerTotals = new Map();
    let playerCount = 0, teamCount = 0;
    for (const p of canonicalIterator(store, 'player_box', league)) {
      playerCount++;
      if (!p.did_not_play && p.points !== null) {
        playerGames.add(p.game_id);
        const key = `${p.game_id}:${p.team_id}`; playerTotals.set(key, (playerTotals.get(key) ?? 0) + p.points);
      }
    }
    const mismatches = finals.filter(g => playerGames.has(g.game_id) && (
      playerTotals.get(`${g.game_id}:${g.home_id}`) !== g.home_score || playerTotals.get(`${g.game_id}:${g.away_id}`) !== g.away_score));
    const teamCounts = new Map();
    for (const t of canonicalIterator(store, 'team_box', league)) { teamCount++; teamCounts.set(t.game_id, (teamCounts.get(t.game_id) ?? 0) + 1); }
    return [league, { games: games.length, final_games: finals.length, upcoming_games: games.filter(g => g.status === 'scheduled').length,
      team_rows: teamCount, player_rows: playerCount,
      finals_missing_player_stats: finals.filter(g => !playerGames.has(g.game_id)).length,
      finals_missing_two_team_boxes: finals.filter(g => teamCounts.get(g.game_id) !== 2).length,
      finals_player_point_sum_mismatch: mismatches.length,
      mismatch_sample_game_ids: mismatches.slice(0, 5).map(g => g.game_id),
      quarantined_rows: store.db.prepare('SELECT COUNT(*) n FROM rejections WHERE league=?').get(league).n,
      incomplete_imports: store.db.prepare("SELECT kind,season FROM imports WHERE league=? AND state<>'complete'").all(league),
      date_range: games.length ? [games.map(g => g.starts_at).sort()[0], games.map(g => g.starts_at).sort().at(-1)] : null }];
  }));
}
export function exportLabels(store, directory) {
  mkdirSync(directory, { recursive: true });
  const result = {};
  for (const league of ['nba', 'ncaa']) {
    const games = canonical(store, 'game', league).filter(g => g.status === 'final');
    const gameMap = new Map(games.map(g => [g.game_id, g]));
    const gameLabels = games.map(g => ({ league, game_id: g.game_id, starts_at: g.starts_at, home_id: g.home_id, away_id: g.away_id,
      home_score: g.home_score, away_score: g.away_score, total_points: g.home_score + g.away_score,
      home_win: g.home_score === g.away_score ? null : Number(g.home_score > g.away_score), margin: g.home_score - g.away_score }));
    writeFileSync(join(directory, `${league}_games.jsonl`), gameLabels.map(v => JSON.stringify(v)).join('\n') + (gameLabels.length ? '\n' : ''));
    result[`${league}_games`] = gameLabels.length;
    let count = 0, buffer = '';
    const fd = openSync(join(directory, `${league}_players.jsonl`), 'w');
    try {
      for (const p of canonicalIterator(store, 'player_box', league)) if (gameMap.has(p.game_id)) {
        const label = { league, game_id: p.game_id, starts_at: gameMap.get(p.game_id).starts_at, player_id: p.player_id,
          team_id: p.team_id, player_name: p.player_name, did_not_play: p.did_not_play,
          points: p.did_not_play ? null : p.points, rebounds: p.did_not_play ? null : p.rebounds,
          assists: p.did_not_play ? null : p.assists, pra: p.did_not_play ? null : p.pra,
          minutes: p.did_not_play ? null : p.minutes };
        buffer += JSON.stringify(label) + '\n'; count++;
        if (count % 512 === 0) { writeSync(fd, buffer); buffer = ''; }
      }
      if (buffer) writeSync(fd, buffer);
    } finally { closeSync(fd); }
    result[`${league}_players`] = count;
  }
  return result;
}
