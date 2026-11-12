import { canonical } from './analytics.js';

export const TARGETS = [5, 10, 50, 100, 200];
export const TYPES = ['over', 'under', 'player', 'win', 'lose', 'mixed'];
export const playerMarkets = { points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists', pra: 'player_points_rebounds_assists' };
// Explicit aliases checked against paired provider fixtures, never fuzzy guesses.
const aliases = { laclippers: 'losangelesclippers', lalakers: 'losangeleslakers',
  umkckangaroos: 'kansascityroos', morganstbears: 'morganstatebears', coppinsteagles: 'coppinstateeagles',
  csubakersfieldroadrunners: 'calstatebakersfieldroadrunners',
  centralconnecticutstbluedevils: 'centralconnecticutbluedevils',
  fortwaynemastodons: 'purduefortwaynemastodons', loyolamdgreyhounds: 'loyolamarylandgreyhounds',
  oklahomastcowboys: 'oklahomastatecowboys', montanastbobcats: 'montanastatebobcats',
  newmexicostaggies: 'newmexicostateaggies', sanjosestspartans: 'sanjosestatespartans' };
export function normalizedName(value) {
  const name = String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return aliases[name] ?? name;
}
export const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
export function weighted(values) {
  const weights = values.map((_, i) => Math.exp(-i / 8)), total = weights.reduce((a, b) => a + b, 0);
  const average = values.reduce((s, v, i) => s + v * weights[i], 0) / total;
  const variance = values.reduce((s, v, i) => s + weights[i] * (v - average) ** 2, 0) / total;
  return { mean: average, variance, count: values.length };
}
export function normalCdf(x, average = 0, sd = 1) {
  const z = (x - average) / sd, t = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}
export function lineProbabilities(average, sd, line) {
  if (![average, sd, line].every(Number.isFinite) || sd <= 0) throw new Error('Invalid predictive distribution');
  const integer = Number.isInteger(line);
  const under = normalCdf(line - (integer ? 0.5 : 0), average, sd);
  const over = 1 - normalCdf(line + (integer ? 0.5 : 0), average, sd);
  return { under, over, push: Math.max(0, 1 - under - over) };
}
export function matchEvent(event, games) {
  const matches = games.filter(g => ((normalizedName(g.home_name) === normalizedName(event.home_name)
    && normalizedName(g.away_name) === normalizedName(event.away_name)) || (g.neutral === true
      && normalizedName(g.home_name) === normalizedName(event.away_name) && normalizedName(g.away_name) === normalizedName(event.home_name)))
    && Math.abs(Date.parse(g.starts_at) - Date.parse(event.starts_at)) <= 90 * 60000);
  return matches.length === 1 ? matches[0] : null;
}
export function teamProjection(game, past, asOf) {
  const cutoff = Date.parse(asOf), ageLimit = cutoff - 365 * 86400000;
  const history = teamId => past.filter(g => g.status === 'final' && Date.parse(g.starts_at) + 6 * 3600000 < cutoff
    && Date.parse(g.starts_at) >= ageLimit && g.home_score !== null && g.away_score !== null
    && (g.home_id === teamId || g.away_id === teamId))
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 20)
    .map(g => ({ game_id: g.game_id, date: g.starts_at, scored: g.home_id === teamId ? g.home_score : g.away_score,
      allowed: g.home_id === teamId ? g.away_score : g.home_score }));
  const home = history(game.home_id), away = history(game.away_id);
  if (home.length < 8 || away.length < 8) return null;
  const hs = weighted(home.map(g => g.scored)), ha = weighted(home.map(g => g.allowed));
  const as = weighted(away.map(g => g.scored)), aa = weighted(away.map(g => g.allowed));
  // Transparent baseline: recent scoring blended with the opponent's points allowed.
  const homeMean = (hs.mean + aa.mean) / 2, awayMean = (as.mean + ha.mean) / 2;
  const variance = (hs.variance + ha.variance + as.variance + aa.variance) / 2;
  const sd = Math.sqrt(Math.max(variance, 15 ** 2));
  return { homeMean, awayMean, total: homeMean + awayMean, margin: homeMean - awayMean, sd,
    homeSamples: home.length, awaySamples: away.length,
    homeRecent: home.slice(0, 5), awayRecent: away.slice(0, 5),
    flags: ['Uncalibrated statistical baseline', 'Pregame injuries and lineups not verified',
      ...(home.some(g => cutoff - Date.parse(g.date) > 120 * 86400000) || away.some(g => cutoff - Date.parse(g.date) > 120 * 86400000) ? ['Sample includes an earlier roster period'] : [])] };
}
export function playerProjection(rows, playerName, teamIds, stat, asOf) {
  const cutoff = Date.parse(asOf);
  const found = rows.filter(p => normalizedName(p.player_name) === normalizedName(playerName)
    && teamIds.includes(p.team_id) && !p.did_not_play && Number.isFinite(p[stat]) && p.minutes > 0
    && Date.parse(p.starts_at) + 6 * 3600000 < cutoff && cutoff - Date.parse(p.starts_at) <= 365 * 86400000);
  const ids = new Set(found.map(p => p.player_id));
  if (ids.size !== 1) return null;
  const samples = found.sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 20);
  if (samples.length < 8) return null;
  const recent = weighted(samples.map(p => p[stat]));
  return { mean: recent.mean, sd: Math.sqrt(Math.max(recent.variance, 4)), samples: samples.length,
    playerId: samples[0].player_id, minutes: weighted(samples.map(p => p.minutes)).mean,
    flags: ['Uncalibrated player baseline', 'Availability and expected minutes not verified'] };
}
export function generateCandidates(store, options = {}) {
  const { league = 'nba', type = 'over', playerStat = 'points', bookmaker = '', date,
    asOf = new Date().toISOString(), minProbability = 0.5, maxPriceAgeHours = 6 } = options;
  if (!['nba', 'ncaa'].includes(league) || !TYPES.includes(type) || !playerMarkets[playerStat]) throw new Error('Invalid prediction filters');
  if (!Number.isFinite(Date.parse(asOf)) || !Number.isFinite(minProbability) || minProbability < 0.5 || minProbability > 0.95) throw new Error('Invalid probability or timestamp');
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)))) throw new Error('Invalid prediction date');
  const now = Date.parse(asOf), games = canonical(store, 'game', league);
  const upcoming = games.filter(g => g.status === 'scheduled' && Date.parse(g.starts_at) > now
    && (!date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(g.starts_at)) === date));
  const snapshots = store.rows('odds', league).filter(r => Date.parse(r.starts_at) > now
    && Date.parse(r.observed_at) <= now && Date.parse(r.price_updated_at) <= now
    && now - Date.parse(r.price_updated_at) <= maxPriceAgeHours * 3600000 && (!bookmaker || r.bookmaker === bookmaker));
  const latest = new Map();
  for (const r of snapshots) {
    const key = `${r.event_id}:${r.bookmaker}:${r.market}`;
    if (!latest.has(key) || Date.parse(r.price_updated_at) > Date.parse(latest.get(key).price_updated_at)) latest.set(key, r);
  }
  const relevant = [...latest.values()].filter(r => type === 'player' ? r.market === playerMarkets[playerStat]
    : type === 'over' || type === 'under' ? r.market === 'totals' : type === 'win' || type === 'lose' ? r.market === 'h2h' : ['totals', 'h2h'].includes(r.market));
  const playerRows = [];
  if (type === 'player') {
    const teams = [...new Set(upcoming.flatMap(g => [g.home_id, g.away_id]))];
    if (teams.length) {
      const unique = new Map();
      for (const r of store.db.prepare(`SELECT id,payload,observed_at,source FROM records WHERE kind='player_box' AND league=?
        AND team_id IN (${teams.map(() => '?').join(',')}) AND starts_at>=? AND starts_at<?
        ORDER BY observed_at,CASE source WHEN 'espn' THEN 1 ELSE 0 END`).iterate(league, ...teams, new Date(now - 365 * 86400000).toISOString(), asOf)) {
        const p = JSON.parse(r.payload);
        unique.set(r.id, p);
      }
      playerRows.push(...unique.values());
    }
  }
  const candidates = [], excluded = { unmatchedEvents: 0, insufficientHistory: 0, belowThreshold: 0, staleOrUnavailable: 0 };
  const projections = new Map();
  for (const r of relevant) {
    const game = matchEvent(r, upcoming);
    if (!game) { excluded.unmatchedEvents++; continue; }
    if (!projections.has(game.game_id)) projections.set(game.game_id, teamProjection(game, games, asOf));
    const projection = projections.get(game.game_id);
    for (const outcome of r.outcomes ?? []) {
      if (!Number.isFinite(outcome.price) || outcome.price <= 1) continue;
      const isPlayer = r.market.startsWith('player_'), isTotal = r.market === 'totals';
      let probability, push = 0, label, detail = projection;
      if (isPlayer) {
        detail = playerProjection(playerRows, outcome.description, [game.home_id, game.away_id], playerStat, asOf);
        if (!detail || !['Over', 'Under'].includes(outcome.name) || !Number.isFinite(outcome.point)) { excluded.insufficientHistory++; continue; }
        const p = lineProbabilities(detail.mean, detail.sd, outcome.point); probability = p[outcome.name.toLowerCase()]; push = p.push;
        label = `${outcome.description}: ${outcome.name} ${outcome.point} ${playerStat.toUpperCase()}`;
      } else {
        if (!projection) { excluded.insufficientHistory++; continue; }
        if (isTotal) {
          if (!['Over', 'Under'].includes(outcome.name) || (type === 'over' && outcome.name !== 'Over') || (type === 'under' && outcome.name !== 'Under') || !Number.isFinite(outcome.point)) continue;
          const p = lineProbabilities(projection.total, projection.sd, outcome.point); probability = p[outcome.name.toLowerCase()]; push = p.push;
          label = `${outcome.name} ${outcome.point} total points`;
        } else {
          const home = normalizedName(outcome.name) === normalizedName(game.home_name), away = normalizedName(outcome.name) === normalizedName(game.away_name);
          if (!home && !away) continue;
          probability = home ? 1 - normalCdf(0, projection.margin, projection.sd) : normalCdf(0, projection.margin, projection.sd);
          label = type === 'lose' ? `${home ? game.away_name : game.home_name} to lose (${outcome.name} wins)` : `${outcome.name} to win`;
        }
      }
      probability = Math.max(0.02, Math.min(0.98, probability));
      if (probability < minProbability) { excluded.belowThreshold++; continue; }
      const expectedReturn = probability * outcome.price + push - 1;
      // Do not pad a target with statistically negative expected-return selections.
      if (expectedReturn <= 0) continue;
      candidates.push({ id: `${r.event_id}:${r.bookmaker}:${r.market}:${outcome.description ?? ''}:${outcome.name}:${outcome.point ?? ''}`,
        eventId: r.event_id, gameId: game.game_id, league, home: game.home_name, away: game.away_name,
        startsAt: game.starts_at, bookmaker: r.bookmaker, market: r.market, label, odds: outcome.price,
        line: outcome.point ?? null, probability, pushProbability: push, expectedReturn,
        priceUpdatedAt: r.price_updated_at, projection: detail, flags: detail.flags });
    }
  }
  excluded.staleOrUnavailable = snapshots.length ? 0 : 1;
  candidates.sort((a, b) => b.probability - a.probability || b.expectedReturn - a.expectedReturn);
  candidates.forEach((candidate, index) => { candidate.candidateRank = index + 1; });
  return { generatedAt: asOf, league, type, candidates, excluded,
    bookmakers: [...new Set(candidates.map(c => c.bookmaker))], methodology: 'Recent weighted scoring with a normal predictive distribution; uncalibrated, not a measured accuracy rate.' };
}
export function buildSlip(candidates, target, { maxLegs = 50, banned = new Set() } = {}) {
  if (!TARGETS.includes(target)) throw new Error('Choose target odds 5, 10, 50, 100, or 200');
  const eligible = candidates.filter(c => !banned.has(c.id));
  const solutions = [], partials = [];
  for (const book of new Set(eligible.map(c => c.bookmaker))) {
    const state = { picks: [], odds: 1, logP: 0, events: new Set() };
    const ranked = eligible.filter(c => c.bookmaker === book).sort((a, b) => b.probability - a.probability || b.expectedReturn - a.expectedReturn);
    for (const c of ranked) {
      if (state.picks.length >= maxLegs || state.odds >= target) break;
      if (state.events.has(c.eventId)) continue;
      state.picks.push(c); state.odds *= c.odds; state.logP += Math.log(c.probability); state.events.add(c.eventId);
    }
    if (state.picks.length) (state.odds >= target ? solutions : partials).push(state);
  }
  const rank = (a, b) => b.logP / b.picks.length - a.logP / a.picks.length || Math.abs(a.odds - target) - Math.abs(b.odds - target);
  solutions.sort(rank); partials.sort(rank);
  const selected = solutions[0] ?? partials[0];
  return { target, targetReached: Boolean(solutions.length), combinedOdds: selected?.odds ?? 1, picks: selected?.picks ?? [],
    estimatedAllWinProbability: selected ? Math.exp(selected.logP) : null,
    rankingRule: 'Individual statistical probability, highest first. One pick per game and one bookmaker per slip. Bookmakers are compared by the geometric mean of individual probabilities.',
    probabilityNote: 'Product assumes independent outcomes. Estimates are uncalibrated; a higher odds target does not mean a higher chance of winning.',
    reason: solutions.length ? null : 'No qualifying slip found within the search limits at one bookmaker. No extra picks were invented.' };
}
