// Box-score estimates, not official NBA ratings or proprietary KenPom ratings.
export const MODEL_VERSION = 'efficiency-v1';
const DAY = 86400000;
const finite = value => Number.isFinite(value) && value >= 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const ratio = (a, b) => b > 0 ? a / b : null;
const average = (rows, get) => {
  const usable = rows.filter(r => Number.isFinite(get(r)));
  const weight = usable.reduce((sum, r) => sum + r.weight, 0);
  return weight ? usable.reduce((sum, r) => sum + get(r) * r.weight, 0) / weight : null;
};
const sum = (rows, get) => rows.reduce((total, r) => total + get(r) * r.weight, 0);
export function gameDuration(game, league) {
  const regulation = league === 'nba' ? 48 : 40, periods = league === 'nba' ? 4 : 2;
  if (!Number.isInteger(game.periods) || game.periods < periods) return null;
  return regulation + (game.periods - periods) * 5;
}
export function boxMetrics(team, opponent, league) {
  const required = ['points', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'offensive_rebounds', 'defensive_rebounds', 'turnovers', 'assists'];
  const valid = box => box && required.every(k => finite(box[k])) && box.fga > 0
    && box.fgm <= box.fga && box.fg3m <= box.fgm && box.fg3m <= box.fg3a && box.fg3a <= box.fga
    && box.ftm <= box.fta && box.offensive_rebounds <= box.fga - box.fgm + box.fta - box.ftm
    && 2 * box.fgm + box.fg3m + box.ftm === box.points;
  if (!valid(team) || !valid(opponent)) return null;
  const coefficient = league === 'nba' ? .44 : .475;
  const estimate = box => box.fga - box.offensive_rebounds + box.turnovers + coefficient * box.fta;
  const possessions = (estimate(team) + estimate(opponent)) / 2;
  if (!(possessions > 0)) return null;
  return { possessions, offensiveRating: 100 * team.points / possessions, defensiveRating: 100 * opponent.points / possessions,
    netRating: 100 * (team.points - opponent.points) / possessions,
    efg: (team.fgm + .5 * team.fg3m) / team.fga,
    offensiveReboundPct: ratio(team.offensive_rebounds, team.offensive_rebounds + opponent.defensive_rebounds),
    defensiveReboundPct: ratio(team.defensive_rebounds, team.defensive_rebounds + opponent.offensive_rebounds),
    turnoverRate: team.turnovers / possessions, freeThrowRate: team.fta / team.fga,
    assistToTurnover: ratio(team.assists, team.turnovers) };
}
function factors(rows, defense = false) {
  const t = r => defense ? r.opponent : r.team, o = r => defense ? r.team : r.opponent;
  return { efg: ratio(sum(rows, r => t(r).fgm + .5 * t(r).fg3m), sum(rows, r => t(r).fga)),
    offensiveReboundPct: ratio(sum(rows, r => t(r).offensive_rebounds), sum(rows, r => t(r).offensive_rebounds + o(r).defensive_rebounds)),
    defensiveReboundPct: ratio(sum(rows, r => t(r).defensive_rebounds), sum(rows, r => t(r).defensive_rebounds + o(r).offensive_rebounds)),
    turnoverRate: ratio(sum(rows, r => t(r).turnovers), sum(rows, r => r.possessions)),
    freeThrowRate: ratio(sum(rows, r => t(r).fta), sum(rows, r => t(r).fga)),
    assistToTurnover: ratio(sum(rows, r => t(r).assists), sum(rows, r => t(r).turnovers)) };
}
export function createEfficiencyContext(games, boxes, league, asOf) {
  if (!['nba', 'ncaa'].includes(league) || !Number.isFinite(Date.parse(asOf))) throw new Error('Invalid efficiency context');
  const cutoff = Date.parse(asOf), regulation = league === 'nba' ? 48 : 40;
  const boxMap = new Map(boxes.map(b => [`${b.game_id}:${b.team_id}`, b])), byTeam = new Map(), byGame = new Map();
  const coverage = { eligibleGames: 0, usableGames: 0, missingBoxes: 0, invalidBoxes: 0, missingDuration: 0 };
  const eligible = games.filter(g => g.status === 'final' && Date.parse(g.starts_at) + 6 * 3600000 < cutoff
    && Date.parse(g.starts_at) >= cutoff - 365 * DAY && finite(g.home_score) && finite(g.away_score))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const lastPlayed = new Map(), homeAdvantage = league === 'nba' ? 2 : 3;
  let points = 0, possessions = 0, paceSum = 0, overtimePoints = 0;
  for (const game of eligible) {
    coverage.eligibleGames++;
    const home = boxMap.get(`${game.game_id}:${game.home_id}`), away = boxMap.get(`${game.game_id}:${game.away_id}`);
    const rest = id => lastPlayed.has(id) ? clamp((Date.parse(game.starts_at) - lastPlayed.get(id)) / DAY - 1, 0, 3) : 3;
    const restMargin = .35 * (rest(game.home_id) - rest(game.away_id));
    lastPlayed.set(game.home_id, Date.parse(game.starts_at)); lastPlayed.set(game.away_id, Date.parse(game.starts_at));
    if (!home || !away) { coverage.missingBoxes++; continue; }
    const hm = boxMetrics(home, away, league), am = boxMetrics(away, home, league);
    if (!hm || !am || home.points !== game.home_score || away.points !== game.away_score) { coverage.invalidBoxes++; continue; }
    const duration = gameDuration(game, league);
    if (!duration) { coverage.missingDuration++; continue; }
    const pace = hm.possessions * regulation / duration;
    // Reject implausible feeds rather than turn bad boxes into high confidence.
    if (pace < (league === 'nba' ? 60 : 40) || pace > (league === 'nba' ? 140 : 110)) { coverage.invalidBoxes++; continue; }
    const venueMargin = (game.neutral === true ? 0 : homeAdvantage) + restMargin;
    const pair = [];
    for (const [teamId, opponentId, team, opponent, metrics, sign] of [
      [game.home_id, game.away_id, home, away, hm, 1], [game.away_id, game.home_id, away, home, am, -1]
    ]) {
      const sample = { gameId: game.game_id, startsAt: game.starts_at, teamId, opponentId, team, opponent, ...metrics,
        pace, duration, neutralOffense: metrics.offensiveRating - sign * venueMargin * 50 / pace,
        neutralDefense: metrics.defensiveRating + sign * venueMargin * 50 / pace };
      if (!byTeam.has(teamId)) byTeam.set(teamId, []);
      byTeam.get(teamId).push(sample); pair.push(sample);
    }
    byGame.set(game.game_id, pair); coverage.usableGames++;
    points += home.points + away.points; possessions += 2 * hm.possessions; paceSum += pace;
    overtimePoints += (home.points + away.points) * (duration - regulation) / duration;
  }
  const leagueRating = possessions ? 100 * points / possessions : null;
  const leaguePace = coverage.usableGames ? paceSum / coverage.usableGames : null;
  const ratings = new Map();
  for (const [teamId, history] of byTeam) {
    const rows = history.reverse().slice(0, 20).map((r, i) => ({ ...r, weight: Math.exp(-i / 8) }));
    byTeam.set(teamId, rows);
    const effectiveGames = rows.length * Math.exp(-(cutoff - Date.parse(rows[0].startsAt)) / (180 * DAY));
    const reliability = effectiveGames / (effectiveGames + 6);
    ratings.set(teamId, { teamId, samples: rows.length, reliability,
      offensiveRating: average(rows, r => r.offensiveRating), defensiveRating: average(rows, r => r.defensiveRating),
      netRating: average(rows, r => r.netRating), pace: average(rows, r => r.pace),
      adjustedOffense: leagueRating, adjustedDefense: leagueRating,
      factors: factors(rows), opponentFactors: factors(rows, true) });
  }
  // Regularized, damped opponent adjustment. This is our own rating system.
  for (let iteration = 0; iteration < 12; iteration++) {
    const next = new Map();
    for (const [id, current] of ratings) {
      const rows = byTeam.get(id), shrink = current.reliability;
      const offense = average(rows, r => r.neutralOffense * leagueRating / ratings.get(r.opponentId).adjustedDefense);
      const defense = average(rows, r => r.neutralDefense * leagueRating / ratings.get(r.opponentId).adjustedOffense);
      next.set(id, { ...current,
        adjustedOffense: .5 * current.adjustedOffense + .5 * (leagueRating + shrink * (offense - leagueRating)),
        adjustedDefense: .5 * current.adjustedDefense + .5 * (leagueRating + shrink * (defense - leagueRating)) });
    }
    for (const [id, value] of next) ratings.set(id, value);
  }
  for (const rating of ratings.values()) rating.adjustedNetRating = rating.adjustedOffense - rating.adjustedDefense;
  return { league, asOf, regulation, ratings, byTeam, byGame, lastPlayed, homeAdvantage, leagueRating, leaguePace, coverage,
    expectedOvertimePoints: coverage.usableGames ? overtimePoints / coverage.usableGames : 0 };
}
export function efficiencyProjection(game, context) {
  const home = context.ratings.get(game.home_id), away = context.ratings.get(game.away_id);
  if (!home || !away || home.samples < 8 || away.samples < 8) return null;
  const homeRows = context.byTeam.get(game.home_id), awayRows = context.byTeam.get(game.away_id);
  const pace = (home.pace + away.pace) / 2;
  const homeEfficiency = home.adjustedOffense * away.adjustedDefense / context.leagueRating;
  const awayEfficiency = away.adjustedOffense * home.adjustedDefense / context.leagueRating;
  const rest = id => clamp((Date.parse(game.starts_at) - context.lastPlayed.get(id)) / DAY - 1, 0, 3);
  const restMargin = .35 * (rest(game.home_id) - rest(game.away_id));
  const venueMargin = game.neutral === true ? 0 : context.homeAdvantage;
  const adjustment = (venueMargin + restMargin) / 2;
  const homeMean = pace * homeEfficiency / 100 + adjustment + context.expectedOvertimePoints / 2;
  const awayMean = pace * awayEfficiency / 100 - adjustment + context.expectedOvertimePoints / 2;
  const variance = (rows, get) => { const center = average(rows, get); return average(rows, r => (get(r) - center) ** 2); };
  const totalVariance = (variance(homeRows, r => r.team.points + r.opponent.points) + variance(awayRows, r => r.team.points + r.opponent.points)) / 2;
  const marginVariance = (variance(homeRows, r => r.team.points - r.opponent.points) + variance(awayRows, r => r.team.points - r.opponent.points)) / 2;
  const oldRoster = [...homeRows, ...awayRows].some(r => Date.parse(context.asOf) - Date.parse(r.startsAt) > 120 * DAY);
  const sd = Math.sqrt(Math.max(totalVariance, (context.league === 'nba' ? 15 : 12) ** 2));
  return { model: MODEL_VERSION, homeMean, awayMean, total: homeMean + awayMean, margin: homeMean - awayMean, sd,
    marginSd: Math.sqrt(Math.max(marginVariance, (context.league === 'nba' ? 12 : 10) ** 2)),
    expectedPossessions: pace, paceMinutes: context.regulation, homeSamples: home.samples, awaySamples: away.samples,
    homeMetrics: home, awayMetrics: away, leagueEfficiency: context.leagueRating,
    adjustments: { venueMargin, restMargin, expectedOvertimePoints: context.expectedOvertimePoints },
    homeRecent: homeRows.slice(0, 5).map(r => ({ game_id: r.gameId, date: r.startsAt, scored: r.team.points, allowed: r.opponent.points })),
    awayRecent: awayRows.slice(0, 5).map(r => ({ game_id: r.gameId, date: r.startsAt, scored: r.team.points, allowed: r.opponent.points })),
    flags: ['Uncalibrated efficiency model; probabilities are estimates', 'Possessions estimated from box scores',
      'Venue and rest adjustments are fixed heuristics', 'Pregame injuries, lineups and player usage changes not verified',
      ...(oldRoster ? ['Sample includes an earlier roster period'] : [])] };
}
