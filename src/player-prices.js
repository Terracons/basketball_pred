import { odds } from './collect.js';
import { canonical } from './analytics.js';
import { matchEvent } from './predict.js';
import { playerMarkets, lagosDay, isFreshQuote } from './markets.js';

// One selected prop market per event, up to five events per explicit batch action.
export async function loadPlayerPrices(store, transport, { league, date, playerStat, limit = 5 }, key, { getOdds = odds, now = Date.now() } = {}) {
  if (!['nba', 'ncaa'].includes(league) || !playerMarkets[playerStat] || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('Invalid player price batch');
  if (!key) return { skipped: 'Add ODDS_API_KEY to fetch player prices', events: 0, snapshots: 0, errors: [] };
  const rows = store.rows('odds', league), games = canonical(store, 'game', league).filter(g => g.status === 'scheduled' && Date.parse(g.starts_at) > now);
  const events = [...new Map(rows.filter(r => Date.parse(r.starts_at) > now && lagosDay(r.starts_at) === date).map(r => [r.event_id, r])).values()]
    .filter(r => matchEvent(r, games)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const loaded = new Set(rows.filter(r => r.market === playerMarkets[playerStat] && isFreshQuote(r, now)).map(r => r.event_id));
  const unavailable = new Set(store.rows('market_check', league).filter(r => r.market === playerMarkets[playerStat] && r.hasPrices === false
    && Date.parse(r.checked_at) <= now && now - Date.parse(r.checked_at) < 3 * 3600000).map(r => r.event_id));
  const pending = events.filter(event => !loaded.has(event.event_id) && !unavailable.has(event.event_id));
  const result = { events: 0, snapshots: 0, alreadyLoaded: events.filter(e => loaded.has(e.event_id)).length,
    recentlyUnavailable: events.filter(e => unavailable.has(e.event_id)).length, remainingEvents: pending.length, errors: [] };
  if (!events.length) result.errors.push('No matched upcoming games on this Lagos date. Refresh fixtures and prices first.');
  for (const event of pending.slice(0, limit)) {
    try {
      const fetched = await getOdds(transport, store, league, key, event.event_id, { playerStat });
      result.events++; result.snapshots += fetched.snapshots ?? 0;
      if (fetched.warning || fetched.skipped) result.errors.push(fetched.warning ?? fetched.skipped);
    } catch (error) { result.errors.push(error.message); break; }
  }
  result.remainingEvents = pending.length - result.events;
  return result;
}
