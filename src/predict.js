import { canonical } from './analytics.js';
import { createEfficiencyContext, efficiencyProjection } from './efficiency.js';

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
export function baselineTeamProjection(game, past, asOf) {
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
  return { model: 'scoring-baseline', homeMean, awayMean, total: homeMean + awayMean, margin: homeMean - awayMean, sd, marginSd: sd,
    homeSamples: home.length, awaySamples: away.length,
    homeRecent: home.slice(0, 5), awayRecent: away.slice(0, 5),
    flags: ['Uncalibrated statistical baseline', 'Pregame injuries and lineups not verified',
      ...(home.some(g => cutoff - Date.parse(g.date) > 120 * 86400000) || away.some(g => cutoff - Date.parse(g.date) > 120 * 86400000) ? ['Sample includes an earlier roster period'] : [])] };
}
export function teamProjection(game, past, asOf, context) {
  const advanced = context && efficiencyProjection(game, context);
  if (advanced) return advanced;
  const baseline = baselineTeamProjection(game, past, asOf);
  if (baseline) baseline.flags.unshift('Scoring fallback: fewer than eight valid paired efficiency box scores for one or both teams');
  return baseline;
}
export function playerProjection(rows, playerName, teamIds, stat, asOf, context, game, teamForecast) {
  const cutoff = Date.parse(asOf);
  const found = rows.filter(p => normalizedName(p.player_name) === normalizedName(playerName)
    && teamIds.includes(p.team_id) && !p.did_not_play && Number.isFinite(p[stat]) && p.minutes > 0
    && Date.parse(p.starts_at) + 6 * 3600000 < cutoff && cutoff - Date.parse(p.starts_at) <= 365 * 86400000);
  const ids = new Set(found.map(p => p.player_id));
  if (ids.size !== 1) return null;
  const samples = found.sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 20);
  if (samples.length < 8) return null;
  const recent = weighted(samples.map(p => p[stat])), teamId = samples[0].team_id;
  const regulationMinutes = p => {
    const paired = context?.byGame.get(p.game_id)?.find(r => r.teamId === p.team_id);
    return paired ? p.minutes * context.regulation / paired.duration : p.minutes;
  };
  const recentRole = samples.filter(p => p.team_id === teamId).slice(0, 5);
  const minutes = Math.min(context?.regulation ?? 48, weighted(recentRole.map(regulationMinutes)).mean);
  const rate = weighted(samples.map(p => p[stat])).mean / weighted(samples.map(p => p.minutes)).mean;
  const paired = samples.map(p => context?.byGame.get(p.game_id)?.find(r => r.teamId === p.team_id)).filter(Boolean);
  const historicalPace = paired.length >= 8 ? weighted(paired.map(r => r.pace)).mean : null;
  const paceFactor = historicalPace && teamForecast?.expectedPossessions ? Math.max(.85, Math.min(1.15, teamForecast.expectedPossessions / historicalPace)) : 1;
  const opponentId = game && (teamId === game.home_id ? game.away_id : game.home_id);
  const opponent = context?.ratings.get(opponentId);
  const opponentFactor = stat === 'points' && opponent?.samples >= 8 ? Math.max(.9, Math.min(1.1, 1 + .5 * (opponent.adjustedDefense / context.leagueRating - 1))) : 1;
  const projected = rate * minutes * paceFactor * opponentFactor;
  return { model: 'minutes-rate-v1', mean: projected, sd: Math.sqrt(Math.max(recent.variance, 4)) * Math.max(1, projected / Math.max(recent.mean, 1)), samples: samples.length,
    playerId: samples[0].player_id, teamId, minutes, perMinuteRate: rate, paceFactor, opponentFactor,
    flags: ['Uncalibrated minutes and per-minute model', 'Availability and expected minutes not verified; minutes estimated from recent appearances',
      ...(historicalPace ? [] : ['Insufficient matched team pace history for player pace adjustment']),
      ...(recentRole.length < 5 ? ['Limited appearances with the latest team'] : [])] };
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
  const teamBoxes = canonical(store, 'team_box', league, { start: new Date(now - 365 * 86400000).toISOString(), end: asOf });
  const context = createEfficiencyContext(games, teamBoxes, league, asOf);
  const candidates = [], excluded = { unmatchedEvents: 0, insufficientHistory: 0, belowThreshold: 0, staleOrUnavailable: 0 };
  const projections = new Map();
  for (const r of relevant) {
    const game = matchEvent(r, upcoming);
    if (!game) { excluded.unmatchedEvents++; continue; }
    if (!projections.has(game.game_id)) projections.set(game.game_id, teamProjection(game, games, asOf, context));
    const projection = projections.get(game.game_id);
    for (const outcome of r.outcomes ?? []) {
      if (!Number.isFinite(outcome.price) || outcome.price <= 1) continue;
      const isPlayer = r.market.startsWith('player_'), isTotal = r.market === 'totals';
      let probability, push = 0, label, detail = projection;
      if (isPlayer) {
        detail = playerProjection(playerRows, outcome.description, [game.home_id, game.away_id], playerStat, asOf, context, game, projection);
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
          probability = home ? 1 - normalCdf(0, projection.margin, projection.marginSd) : normalCdf(0, projection.margin, projection.marginSd);
          label = type === 'lose' ? `${home ? game.away_name : game.home_name} to lose (${outcome.name} wins)` : `${outcome.name} to win`;
        }
      }
      probability = Math.max(0.02, Math.min(0.98, probability));
      if (probability < minProbability) { excluded.belowThreshold++; continue; }
      const expectedReturn = probability * outcome.price + push - 1;
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
    qualifyingGameCount: new Set(candidates.map(c => c.gameId)).size,
    bookmakers: [...new Set(candidates.map(c => c.bookmaker))], dataCoverage: context.coverage,
    methodology: 'Possession-based opponent-adjusted efficiency and pace when at least eight valid paired box scores exist per team; otherwise a labeled scoring fallback. Player props use estimated minutes and per-minute production. Supporting box-score factors are evidence, not extra arbitrary weights. Normal-distribution probabilities remain uncalibrated.' };
}
export function buildSlip(candidates, target, { maxLegs = 50, banned = new Set() } = {}) {
  if (!TARGETS.includes(target)) throw new Error('Choose target odds 5, 10, 50, 100, or 200');
  const eligible = candidates.filter(c => !banned.has(c.id) && Number.isFinite(c.odds) && c.odds > 1
    && Number.isFinite(c.probability) && c.probability > 0 && c.probability <= 1);
  const solutions = [], partials = [];
  const nearTarget = target * 1.05;
  const compareSolutions = (a, b) => {
    const aNear = a.odds <= nearTarget, bNear = b.odds <= nearTarget;
    if (aNear !== bNear) return aNear ? -1 : 1;
    return aNear ? b.logP - a.logP || a.odds - b.odds : a.odds - b.odds || b.logP - a.logP;
  };
  for (const book of new Set(eligible.map(c => c.bookmaker))) {
    const groups = new Map();
    for (const c of eligible.filter(c => c.bookmaker === book)) {
      const key = c.gameId ?? c.eventId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    let beam = [{ picks: [], odds: 1, logP: 0 }], bestSolution;
    for (const choices of groups.values()) {
      const buckets = new Map();
      const retain = state => {
        const key = `${state.picks.length}:${Math.round(Math.log(state.odds) / 0.01)}`;
        const values = buckets.get(key) ?? [];
        values.push(state); values.sort((a, b) => b.logP - a.logP || b.odds - a.odds);
        buckets.set(key, values.slice(0, 2));
      };
      for (const state of beam) {
        retain(state);
        if (state.picks.length >= maxLegs) continue;
        for (const c of choices) {
          const next = { picks: [...state.picks, c], odds: state.odds * c.odds, logP: state.logP + Math.log(c.probability) };
          if (next.odds >= target - 1e-12) {
            if (!bestSolution || compareSolutions(next, bestSolution) < 0) bestSolution = next;
          } else retain(next);
        }
      }
      beam = [...buckets.values()].flat();
      // Bound work for unusually large player-market feeds, retaining progress
      // across the complete odds range rather than only high-probability singles.
      if (beam.length > 8000) {
        const bins = new Map();
        for (const state of beam) {
          const key = Math.round(Math.log(state.odds) / .01);
          const old = bins.get(key);
          if (!old || state.logP > old.logP) bins.set(key, state);
        }
        beam = [...bins.values()];
      }
    }
    // A maximum-price path guarantees we do not report a partial simply because
    // the bounded search pruned a feasible path.
    const maximumPath = { picks: [], odds: 1, logP: 0 };
    for (const c of [...groups.values()].map(rows => rows.reduce((a, b) => b.odds > a.odds ? b : a)).sort((a, b) => b.odds - a.odds).slice(0, maxLegs)) {
      maximumPath.picks.push(c); maximumPath.odds *= c.odds; maximumPath.logP += Math.log(c.probability);
      if (maximumPath.odds >= target - 1e-12) break;
    }
    if (maximumPath.odds >= target - 1e-12 && (!bestSolution || compareSolutions(maximumPath, bestSolution) < 0)) bestSolution = maximumPath;
    if (bestSolution) solutions.push(bestSolution);
    const partial = [...beam, maximumPath].filter(s => s.picks.length && s.odds < target - 1e-12)
      .sort((a, b) => b.odds - a.odds || b.logP - a.logP)[0];
    if (partial) partials.push(partial);
  }
  solutions.sort(compareSolutions); partials.sort((a, b) => b.odds - a.odds || b.logP - a.logP);
  const selected = solutions[0] ?? partials[0];
  const picks = [...(selected?.picks ?? [])].sort((a, b) => b.probability - a.probability || b.expectedReturn - a.expectedReturn);
  return { target, targetReached: Boolean(solutions.length), closeToTarget: Boolean(solutions.length && selected.odds <= nearTarget), combinedOdds: selected?.odds ?? 1, picks,
    estimatedAllWinProbability: selected ? Math.exp(selected.logP) : null,
    oddsCalculation: picks.map(p => p.odds),
    rankingRule: 'Search game combinations at one bookmaker for the target odds. Prefer combinations within 5% above the target, choosing the highest estimated all-win chance in that range. Display individual picks in descending estimated probability.',
    probabilityNote: 'Product assumes independent outcomes. Estimates are uncalibrated; a higher odds target does not mean a higher chance of winning.',
    reason: solutions.length ? null : picks.length ? `Available qualifying games reach ${selected.odds.toFixed(2)} combined odds, below your ${target} target. This partial slip can still be exported.` : 'No qualifying priced games are available for these filters. Refresh prices or change the date, market, or minimum chance.' };
}
