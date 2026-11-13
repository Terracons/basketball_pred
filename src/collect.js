import { csvRows } from './csv.js';
import { boxRow, scheduleRow, espnGames, espnBox, cbbdGame } from './normalize.js';
import { playerMarkets } from './markets.js';
import { canonical } from './analytics.js';

export const leagues = ['nba', 'ncaa'];
export function checkLeague(league) { if (!leagues.includes(league)) throw new Error('League must be nba or ncaa'); }
const espnPath = league => league === 'nba' ? 'nba' : 'mens-college-basketball';
export function dayString(date) { return date.toISOString().slice(0, 10); }
export async function scoreboard(http, store, league, day) {
  checkLeague(league);
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/${espnPath(league)}/scoreboard?dates=${day.replaceAll('-', '')}&limit=1000${league === 'ncaa' ? '&groups=50' : ''}`;
  const games = espnGames(await http.json('espn', url, { ttl: 3 * 3600000 }));
  if (games.length >= 1000) throw new Error('Scoreboard potentially truncated');
  store.transaction(() => { for (const g of games) store.put('game', league, 'espn', g.game_id, g); });
  return games;
}
export async function summaries(http, store, league, limit = 25) {
  const known = new Set(store.db.prepare("SELECT id FROM records WHERE kind='summary_complete' AND league=? AND source='espn' AND json_extract(payload,'$.schema_version')=1").all(league).map(x => x.id));
  // Recent incomplete summaries are retried. Completed historical files need no per-game calls.
  const pairedIds = new Set(store.db.prepare("SELECT game_id FROM records WHERE kind='team_box' AND league=? GROUP BY game_id HAVING COUNT(DISTINCT team_id)=2").all(league).map(r => r.game_id));
  const historyIds = new Set(store.db.prepare("SELECT DISTINCT game_id FROM records WHERE kind='player_box' AND league=? AND source IN ('sportsdataverse','snapshot')").all(league).map(r => r.game_id).filter(id => pairedIds.has(id)));
  const pending = canonical(store, 'game', league).filter(g => g.game_id && g.status === 'final' && !known.has(g.game_id) && !historyIds.has(g.game_id))
    .filter(g => store.db.prepare("SELECT 1 FROM records WHERE kind='game' AND league=? AND source='espn' AND id=?").get(league, g.game_id))
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, limit);
  let done = 0; const errors = [];
  for (const g of pending) {
    try {
      const body = await http.json('espn', `https://site.api.espn.com/apis/site/v2/sports/basketball/${espnPath(league)}/summary?event=${g.game_id}`, { ttl: 24 * 3600000 });
      const { players, teams } = espnBox(body, g);
      store.transaction(() => {
        for (const t of teams) store.put('team_box', league, 'espn', `${g.game_id}:${t.team_id}`, t);
        for (const p of players) store.put('player_box', league, 'espn', `${g.game_id}:${p.player_id}`, p);
        const complete = [g.home_id, g.away_id].every(teamId => {
          const played = players.filter(p => p.team_id === teamId && !p.did_not_play && p.points !== null);
          const expected = teamId === g.home_id ? g.home_score : g.away_score;
          return played.length > 0 && played.reduce((sum, p) => sum + p.points, 0) === expected;
        });
        if (teams.length === 2 && complete) {
          store.put('summary_complete', league, 'espn', g.game_id, { game_id: g.game_id, schema_version: 1 }); done++;
        } else errors.push({ game: g.game_id, error: 'Incomplete boxscore; will retry' });
      });
    } catch (e) { errors.push({ game: g.game_id, error: e.message }); }
  }
  return { done, errors };
}
export async function history(http, store, league, season, kinds = ['schedule', 'team_box', 'player_box'], { reprocess = false } = {}) {
  checkLeague(league);
  if (!Number.isInteger(season) || season < 2003 || season > 2100) throw new Error('Invalid season ending year');
  const prefix = league === 'nba' ? 'espn_nba' : 'espn_mens_college_basketball';
  const mapping = { schedule: ['schedules', league === 'nba' ? 'nba_schedule' : 'mbb_schedule'], team_box: ['team_boxscores', 'team_box'], player_box: ['player_boxscores', 'player_box'] };
  const result = {};
  for (const kind of kinds) {
    if (!mapping[kind]) throw new Error('Unknown historical dataset');
    const [tag, name] = mapping[kind];
    const url = `https://github.com/sportsdataverse/sportsdataverse-data/releases/download/${prefix}_${tag}/${name}_${season}.csv`;
    const currentSeason = new Date().getUTCFullYear() + (new Date().getUTCMonth() >= 6 ? 1 : 0);
    const path = await http.file('sportsdataverse', url, { ttl: season < currentSeason ? 365 * 86400000 : 86400000 });
    const fetched = store.db.prepare('SELECT fetched_at FROM cache WHERE file=?').get(path)?.fetched_at ?? null;
    const prior = store.db.prepare('SELECT * FROM imports WHERE league=? AND kind=? AND season=?').get(league, kind, season);
    const needsPeriods = kind === 'schedule' && store.db.prepare(`SELECT 1 FROM records WHERE kind='game' AND league=?
      AND source='sportsdataverse' AND json_extract(payload,'$.season')=? AND json_type(payload,'$.periods') IS NULL LIMIT 1`).get(league, season);
    if (!reprocess && !needsPeriods && fetched && prior?.fetched_at === fetched && prior.state === 'complete') {
      result[kind] = prior.accepted;
      if (prior.rejected) result[`${kind}_rejected`] = prior.rejected;
      continue;
    }
    store.transaction(() => {
      store.db.prepare('DELETE FROM rejections WHERE league=? AND kind=? AND season=?').run(league, kind, season);
      store.db.prepare('INSERT OR REPLACE INTO imports VALUES(?,?,?,?,?,?,?)').run(league, kind, season, fetched, 'in_progress', 0, 0);
    });
    let count = 0, rejected = 0, index = 0, batch = [];
    const quarantine = store.db.prepare('INSERT OR REPLACE INTO rejections VALUES(?,?,?,?,?,?)');
    const flush = () => store.transaction(() => {
      for (const { row, rowNumber } of batch) {
        let payload;
        try { payload = kind === 'schedule' ? scheduleRow(row) : boxRow(row, kind); }
        catch (error) {
          quarantine.run(league, kind, season, rowNumber, error.message, JSON.stringify(row)); rejected++; continue;
        }
        const id = kind === 'schedule' ? payload.game_id : `${payload.game_id}:${kind === 'player_box' ? payload.player_id : payload.team_id}`;
        store.put(kind === 'schedule' ? 'game' : kind, league, 'sportsdataverse', id, payload, fetched ?? undefined);
        count++;
      }
    });
    for await (const row of csvRows(path)) {
      batch.push({ row, rowNumber: ++index }); if (batch.length === 500) { flush(); batch = []; }
    }
    flush(); result[kind] = count;
    if (rejected) result[`${kind}_rejected`] = rejected;
    store.db.prepare("UPDATE imports SET state='complete',accepted=?,rejected=? WHERE league=? AND kind=? AND season=?").run(count, rejected, league, kind, season);
  }
  return result;
}
export async function cbbd(http, store, start, end, key) {
  if (!key) return { skipped: 'Set CBBD_API_KEY to enable NCAA supplement' };
  const query = new URLSearchParams({ startDateRange: `${start}T00:00:00Z`, endDateRange: `${end}T23:59:59Z` });
  const body = await http.json('cbbd', `https://api.collegebasketballdata.com/games?${query}`, { headers: { Authorization: `Bearer ${key}` }, ttl: 6 * 3600000 });
  if (!Array.isArray(body) || body.length >= 3000) throw new Error('CBBD schema changed or date range truncated; use smaller ranges');
  store.transaction(() => { for (const r of body) { const g = cbbdGame(r); store.put('game_supplement', 'ncaa', 'cbbd', g.game_id, g); } });
  // CBBD ids stay namespaced. Do not silently join unrelated source team/player ids.
  return { games: body.length };
}
export async function odds(http, store, league, key, eventId, { playerStat } = {}) {
  checkLeague(league);
  if (!key) return { skipped: 'Set ODDS_API_KEY to enable odds snapshots' };
  const sport = league === 'nba' ? 'basketball_nba' : 'basketball_ncaab';
  if (eventId && !/^[a-zA-Z0-9_-]+$/.test(eventId)) throw new Error('Invalid odds event id');
  if (playerStat !== undefined && !playerMarkets[playerStat]) throw new Error('Invalid player statistic');
  const markets = eventId ? playerStat ? playerMarkets[playerStat] : 'player_points,player_rebounds,player_assists' : 'h2h,totals';
  const suffix = eventId ? `/events/${eventId}/odds` : '/odds';
  const url = `https://api.the-odds-api.com/v4/sports/${sport}${suffix}?regions=us&markets=${markets}&oddsFormat=decimal`;
  const body = await http.json('odds', url, { headers: { 'x-api-key': key }, ttl: 3 * 3600000, cost: markets.split(',').length });
  const observed = new Date().toISOString();
  const events = eventId ? [body] : body;
  if (!Array.isArray(events)) throw new Error('Odds response schema changed');
  let count = 0;
  store.transaction(() => {
    for (const event of events) {
      if (!event.id || !event.commence_time || !Array.isArray(event.bookmakers)) throw new Error('Invalid odds event');
      if (eventId) for (const market of markets.split(',')) {
        const id = `${event.id}:${market}`;
        const prior = store.db.prepare("SELECT payload FROM records WHERE kind='market_check' AND league=? AND source='odds' AND id=?").get(league, id);
        const previous = prior && JSON.parse(prior.payload);
        store.put('market_check', league, 'odds', id, { event_id: event.id, starts_at: new Date(event.commence_time).toISOString(), market,
          checked_at: previous && Date.parse(observed) - Date.parse(previous.checked_at) < 3 * 3600000 ? previous.checked_at : observed,
          hasPrices: event.bookmakers.some(b => b.markets?.some(m => m.key === market && m.outcomes?.length)) }, observed);
      }
      for (const book of event.bookmakers) for (const market of book.markets ?? []) {
        // Provider timestamps identify immutable price snapshots, including cached reruns.
        const updated = market.last_update || book.last_update;
        if (!updated) throw new Error('Odds missing price timestamp');
        store.put('odds', league, 'odds', `${event.id}:${book.key}:${market.key}:${updated}`, {
          event_id: event.id, starts_at: new Date(event.commence_time).toISOString(), home_name: event.home_team,
          away_name: event.away_team, bookmaker: book.key, market: market.key, price_updated_at: updated,
          outcomes: market.outcomes, first_observed_at: observed
        }, observed); count++;
      }
    }
  });
  return { events: events.length, snapshots: count, markets: markets.split(','),
    ...(eventId && !count ? { warning: `No ${playerStat ?? 'player'} prices were returned for this event by the available bookmakers.` } : {}) };
}
