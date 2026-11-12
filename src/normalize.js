export const num = value => value === '' || value === undefined || value === null || value === 'NA' || value === '--' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
export const bool = value => value === true || value === 'true' || value === 'TRUE';
export function iso(value) {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error('Missing or invalid game timestamp');
  return new Date(value).toISOString();
}
export function validateGame(g) {
  if ([g.game_id, g.home_id, g.away_id].some(v => !v || v === 'undefined' || v === 'null') || g.home_id === g.away_id) throw new Error('Invalid game identity');
  g.starts_at = iso(g.starts_at);
  if (g.status === 'final' && (g.home_score === null || g.away_score === null || g.home_score < 0 || g.away_score < 0)) throw new Error('Final game missing valid scores');
  return g;
}
export function scheduleRow(r) {
  return validateGame({ game_id: String(r.game_id || r.id), starts_at: r.date || r.game_date_time,
    season: num(r.season), season_type: r.season_type, periods: num(r.status_period), home_id: String(r.home_id), away_id: String(r.away_id),
    home_name: r.home_display_name, away_name: r.away_display_name,
    home_score: num(r.home_score), away_score: num(r.away_score), neutral: bool(r.neutral_site),
    status: bool(r.status_type_completed) ? 'final' : r.status_type_state === 'in' ? 'in_progress' : /POSTPONED|CANCELED|CANCELLED/.test(r.status_type_name) ? r.status_type_name.toLowerCase() : 'scheduled' });
}
const fields = {
  points: ['points', 'PTS'], rebounds: ['rebounds', 'total_rebounds', 'REB'], assists: ['assists', 'AST'],
  steals: ['steals', 'STL'], blocks: ['blocks', 'BLK'], turnovers: ['turnovers', 'total_turnovers', 'TO'],
  minutes: ['minutes', 'MIN'], fouls: ['fouls', 'PF'],
  fgm: ['field_goals_made'], fga: ['field_goals_attempted'],
  fg3m: ['three_point_field_goals_made'], fg3a: ['three_point_field_goals_attempted'],
  ftm: ['free_throws_made'], fta: ['free_throws_attempted'],
  offensive_rebounds: ['offensive_rebounds', 'OREB'], defensive_rebounds: ['defensive_rebounds', 'DREB']
};
export function stats(r) {
  const out = {};
  for (const [key, aliases] of Object.entries(fields)) {
    const value = aliases.map(a => r[a]).find(v => v !== undefined && v !== '' && v !== 'NA');
    out[key] = num(value);
  }
  if (typeof r.MIN === 'string' && r.MIN.includes(':')) { const [m, s] = r.MIN.split(':').map(Number); out.minutes = m + s / 60; }
  for (const [label, made, attempts] of [['FG', 'fgm', 'fga'], ['3PT', 'fg3m', 'fg3a'], ['FT', 'ftm', 'fta']]) {
    if (/^\d+-\d+$/.test(r[label])) [out[made], out[attempts]] = r[label].split('-').map(Number);
  }
  out.pra = out.points !== null && out.rebounds !== null && out.assists !== null ? out.points + out.rebounds + out.assists : null;
  return out;
}
export function boxRow(r, kind) {
  const player = kind === 'player_box';
  const out = { game_id: String(r.game_id), team_id: String(r.team_id), opponent_id: String(r.opponent_team_id),
    player_id: player ? String(r.athlete_id) : null, player_name: r.athlete_display_name ?? null,
    team_name: r.team_display_name, starts_at: iso(r.game_date_time || r.game_date),
    season: num(r.season), home_away: r.team_home_away || r.home_away,
    did_not_play: player ? bool(r.did_not_play) : false, starter: player ? bool(r.starter) : null,
    team_score: num(r.team_score), ...stats(r) };
  if (!player) out.points = num(r.team_score);
  if (!r.game_id || !r.team_id || (player && !r.athlete_id)) throw new Error('Box score missing identity');
  return out;
}
export function espnGames(body) {
  if (!Array.isArray(body.events)) throw new Error('ESPN scoreboard schema changed');
  return body.events.map(e => {
    const c = e.competitions?.[0], home = c?.competitors?.find(t => t.homeAway === 'home'), away = c?.competitors?.find(t => t.homeAway === 'away');
    if (!home || !away) throw new Error('ESPN game missing competitors');
    return validateGame({ game_id: String(e.id), starts_at: e.date, season: e.season?.year ?? body.leagues?.[0]?.season?.year,
      periods: num(e.status?.period ?? c.status?.period),
      home_id: String(home.team.id), away_id: String(away.team.id), home_name: home.team.displayName, away_name: away.team.displayName,
      home_score: num(home.score), away_score: num(away.score), neutral: Boolean(c.neutralSite),
      status: e.status?.type?.completed ? 'final' : e.status?.type?.state === 'in' ? 'in_progress' : /POSTPONED|CANCELED|CANCELLED/.test(e.status?.type?.name) ? e.status.type.name.toLowerCase() : 'scheduled' });
  });
}
export function espnBox(body, game) {
  if (!body.boxscore) throw new Error('ESPN summary missing boxscore');
  const players = [], teams = [];
  for (const t of body.boxscore.teams ?? []) {
    const values = Object.fromEntries((t.statistics ?? []).map(s => [s.name, s.displayValue]));
    const map = { assists: values.assists, total_rebounds: values.totalRebounds, steals: values.steals,
      blocks: values.blocks, turnovers: values.turnovers, fouls: values.fouls, offensive_rebounds: values.offensiveRebounds,
      defensive_rebounds: values.defensiveRebounds,
      FG: values['fieldGoalsMade-fieldGoalsAttempted'] ?? values.fieldGoalsMade_fieldGoalsAttempted,
      '3PT': values['threePointFieldGoalsMade-threePointFieldGoalsAttempted'] ?? values.threePointFieldGoalsMade_threePointFieldGoalsAttempted,
      FT: values['freeThrowsMade-freeThrowsAttempted'] ?? values.freeThrowsMade_freeThrowsAttempted };
    const home = String(t.team.id) === game.home_id;
    teams.push({ game_id: game.game_id, team_id: String(t.team.id), starts_at: game.starts_at,
      team_name: t.team.displayName, opponent_id: home ? game.away_id : game.home_id,
      home_away: home ? 'home' : 'away', ...stats(map), points: home ? game.home_score : game.away_score });
  }
  for (const t of body.boxscore.players ?? []) for (const group of t.statistics ?? []) for (const p of group.athletes ?? []) {
    const values = Object.fromEntries((group.labels ?? []).map((label, i) => [label, p.stats?.[i]]));
    players.push({ game_id: game.game_id, team_id: String(t.team.id), player_id: String(p.athlete.id),
      player_name: p.athlete.displayName, starts_at: game.starts_at,
      did_not_play: Boolean(p.didNotPlay), starter: Boolean(p.starter), ...stats(values) });
  }
  return { players, teams };
}
export function cbbdGame(r) {
  return validateGame({ game_id: String(r.id), external_espn_id: r.sourceId, starts_at: r.startDate, season: r.season,
    home_id: String(r.homeTeamId), away_id: String(r.awayTeamId), home_name: r.homeTeam, away_name: r.awayTeam,
    home_score: num(r.homePoints), away_score: num(r.awayPoints), neutral: r.neutralSite, status: r.status });
}
