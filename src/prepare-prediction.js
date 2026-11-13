import { canonical } from './analytics.js';
import { scoreboard, odds, summaries, dayString } from './collect.js';
import { TYPES, matchEvent } from './predict.js';
import { playerMarkets, playerDirections, lagosDay, isFreshQuote } from './markets.js';

// Preparing a slip should not depend on a separate manual refresh action.
export async function preparePredictionData(store, transport, options, key, { getScoreboard = scoreboard, getOdds = odds, getSummaries = summaries, now = new Date() } = {}) {
  const { league = 'nba', type = 'over', playerStat = 'points', playerDirection = 'both', playerEventId, bookmaker = '', date } = options;
  if (!['nba', 'ncaa'].includes(league) || !TYPES.includes(type) || !playerMarkets[playerStat] || !playerDirections.includes(playerDirection)) throw new Error('Invalid prediction filters');
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || dayString(new Date(date)) !== date)) throw new Error('Invalid prediction date');
  const wantedMarkets = type === 'player' ? [playerMarkets[playerStat]] : type === 'win' || type === 'lose' ? ['h2h'] : type === 'mixed' ? ['totals', 'h2h'] : ['totals'];
  const stored = store.rows('odds', league);
  const selectedEvent = playerEventId && stored.find(r => r.event_id === playerEventId && Date.parse(r.starts_at) > now.getTime()
    && (!date || lagosDay(r.starts_at) === date));
  if (playerEventId && (!/^[a-zA-Z0-9_-]+$/.test(playerEventId) || !selectedEvent)) throw new Error('Select an upcoming player event on the chosen date');
  const prices = stored.filter(r => wantedMarkets.includes(r.market) && (!bookmaker || r.bookmaker === bookmaker)
    && (!date || lagosDay(r.starts_at) === date)
    && Date.parse(r.starts_at) > now.getTime() && isFreshQuote(r, now.getTime()));
  const fresh = wantedMarkets.every(market => prices.some(r => r.market === market && (!selectedEvent || r.event_id === playerEventId)));
  const upcoming = canonical(store, 'game', league).filter(g => g.status === 'scheduled' && Date.parse(g.starts_at) > now.getTime()
    && (!date || lagosDay(g.starts_at) === date));
  const matched = [...new Map(prices.map(r => [r.event_id, r])).values()].every(r => matchEvent(r, upcoming));
  const result = { oddsRefreshed: false, fixturesRefreshed: false, summariesUpdated: 0, warnings: [] };
  if (fresh && upcoming.length && matched) return result;
  const day = date || lagosDay(now); let sawFinal = false;
  try {
    for (const offset of [-1, 0, 1]) {
      const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset);
      const games = await getScoreboard(transport, store, league, dayString(d));
      sawFinal ||= games?.some(g => g.status === 'final');
    }
    result.fixturesRefreshed = true;
  } catch (error) { result.warnings.push(`Fixture update: ${error.message}`); }
  if (sawFinal) try {
    const boxes = await getSummaries(transport, store, league, 5); result.summariesUpdated = boxes.done;
    if (boxes.errors.length) result.warnings.push('Some recent box scores remain incomplete and will be retried.');
  } catch (error) { result.warnings.push(`Statistics update: ${error.message}`); }
  if (!fresh) {
    if (!key) result.warnings.push('Add ODDS_API_KEY to load bookmaker prices and build a priced slip.');
    else if (type === 'player' && !selectedEvent) result.warnings.push(`No fresh ${playerStat} prices for this date. Refresh fixtures and prices, choose a game, then fetch its player prices.`);
    else try {
      const response = await getOdds(transport, store, league, key, type === 'player' ? playerEventId : undefined, type === 'player' ? { playerStat } : {});
      result.oddsRefreshed = !response.skipped;
      if (response.skipped) result.warnings.push(response.skipped);
      if (response.warning) result.warnings.push(response.warning);
    } catch (error) { result.warnings.push(`Price update: ${error.message}`); }
  }
  return result;
}
