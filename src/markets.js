export const playerMarkets = { points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists', pra: 'player_points_rebounds_assists' };
export const playerDirections = ['both', 'over', 'under'];
export const lagosDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(value));
// Accept at most five minutes of provider clock skew, never future observations.
export function isFreshQuote(row, now = Date.now(), maxAgeHours = 6) {
  const updated = Date.parse(row.price_updated_at), observed = Date.parse(row.observed_at);
  return [updated, observed, now].every(Number.isFinite) && observed <= now && updated <= observed + 5 * 60000
    && now - Math.min(updated, observed) <= maxAgeHours * 3600000;
}
