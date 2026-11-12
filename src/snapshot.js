import { canonicalIterator } from './analytics.js';

// Public history only. Preserve the inputs used by the local prediction engine.
export function populateSnapshot(source, target, now = Date.now()) {
  const start = new Date(now - 365 * 86400000).toISOString(), end = new Date(now + 8 * 86400000).toISOString(), counts = {};
  for (const league of ['nba', 'ncaa']) {
    let games = 0, teams = 0, players = 0, batch = [];
    const save = () => { target.transaction(() => { for (const [kind, id, p, observed] of batch) target.put(kind, league, 'snapshot', id, p, observed); }); batch = []; };
    const gameIds = new Set();
    for (const g of canonicalIterator(source, 'game', league, { start, end })) {
      const p = { game_id: g.game_id, starts_at: g.starts_at, status: g.status, home_id: g.home_id, away_id: g.away_id,
        home_name: g.home_name, away_name: g.away_name, home_score: g.home_score, away_score: g.away_score, neutral: g.neutral,
        periods: g.periods, upstream_source: g.upstream_source ?? g.source };
      gameIds.add(g.game_id); batch.push(['game', g.game_id, p, g.observed_at]); games++; if (batch.length >= 500) save();
    }
    save();
    for (const row of canonicalIterator(source, 'team_box', league, { start, end })) if (gameIds.has(row.game_id)) {
      const p = Object.fromEntries(['game_id', 'team_id', 'opponent_id', 'starts_at', 'points', 'fgm', 'fga', 'fg3m', 'fg3a',
        'ftm', 'fta', 'offensive_rebounds', 'defensive_rebounds', 'turnovers', 'assists'].map(k => [k, row[k]]));
      p.upstream_source = row.upstream_source ?? row.source;
      batch.push(['team_box', `${p.game_id}:${p.team_id}`, p, row.observed_at]); teams++; if (batch.length >= 500) save();
    }
    save();
    const seen = new Map();
    const rows = source.db.prepare(`SELECT payload,observed_at,source FROM records WHERE kind='player_box' AND league=? AND starts_at>=? AND starts_at<?
      AND source IN ('espn','sportsdataverse','snapshot')
      ORDER BY starts_at DESC,observed_at DESC,CASE source WHEN 'espn' THEN 1 ELSE 0 END DESC`).iterate(league, start, new Date(now).toISOString());
    const duplicates = new Set();
    for (const row of rows) {
      const p = JSON.parse(row.payload), key = `${p.game_id}:${p.player_id}`;
      if (duplicates.has(key)) continue; duplicates.add(key);
      const rosterKey = `${p.player_id}:${p.team_id}`;
      const count = seen.get(rosterKey) ?? 0; if (count >= 20 || p.did_not_play || !(p.minutes > 0)) continue;
      seen.set(rosterKey, count + 1);
      batch.push(['player_box', key, { game_id: p.game_id, team_id: p.team_id, player_id: p.player_id, player_name: p.player_name,
        starts_at: p.starts_at, minutes: p.minutes, points: p.points, rebounds: p.rebounds, assists: p.assists, pra: p.pra,
        did_not_play: p.did_not_play, upstream_source: p.upstream_source ?? row.source }, row.observed_at]); players++;
      if (batch.length >= 500) save();
    }
    save(); counts[league] = { games, teams, players };
  }
  return counts;
}
