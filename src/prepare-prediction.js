import { canonical } from './analytics.js';
import { scoreboard, odds, dayString } from './collect.js';
import { TYPES, playerMarkets } from './predict.js';

// Preparing a slip should not depend on a separate manual refresh action.
export async function preparePredictionData(store, transport, options, key, { getScoreboard = scoreboard, getOdds = odds, now = new Date() } = {}) {
  const { league = 'nba', type = 'over', playerStat = 'points', bookmaker = '', date } = options;
  if (!['nba', 'ncaa'].includes(league) || !TYPES.includes(type) || !playerMarkets[playerStat]) throw new Error('Invalid prediction filters');
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || dayString(new Date(date)) !== date)) throw new Error('Invalid prediction date');
  const wantedMarkets = type === 'player' ? [playerMarkets[playerStat]] : type === 'win' || type === 'lose' ? ['h2h'] : type === 'mixed' ? ['totals', 'h2h'] : ['totals'];
  const fresh = store.rows('odds', league).some(r => wantedMarkets.includes(r.market) && (!bookmaker || r.bookmaker === bookmaker)
    && Date.parse(r.starts_at) > now.getTime() && Date.parse(r.price_updated_at) <= now.getTime()
    && now.getTime() - Date.parse(r.price_updated_at) <= 6 * 3600000);
  const hasFixture = canonical(store, 'game', league).some(g => g.status === 'scheduled' && Date.parse(g.starts_at) > now.getTime()
    && (!date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(g.starts_at)) === date));
  const result = { oddsRefreshed: false, fixturesRefreshed: false, warnings: [] };
  if (fresh && hasFixture) return result;
  if (!fresh && type === 'player') {
    result.warnings.push('No fresh player prices are stored. Select an event and fetch its player prices first.');
    return result;
  }
  if (!fresh && !key) {
    result.warnings.push('Add ODDS_API_KEY to load bookmaker prices and build a priced slip.');
    return result;
  }
  const day = date || dayString(now);
  try {
    for (const offset of [-1, 0, 1]) {
      const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset);
      await getScoreboard(transport, store, league, dayString(d));
    }
    result.fixturesRefreshed = true;
  } catch (error) { result.warnings.push(`Fixture update: ${error.message}`); }
  if (!fresh) {
    try {
      const response = await getOdds(transport, store, league, key);
      result.oddsRefreshed = !response.skipped;
      if (response.skipped) result.warnings.push(response.skipped);
    } catch (error) { result.warnings.push(`Price update: ${error.message}`); }
  }
  return result;
}
