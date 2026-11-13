import { readFileSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { Http } from './http.js';
import { Intelligence } from './intelligence.js';
import { createPrediction } from './slips.js';
import { canonical } from './analytics.js';
import { odds, scoreboard, summaries, dayString } from './collect.js';
import { createAuth } from './auth.js';
import { preparePredictionData } from './prepare-prediction.js';
import { playerMarkets, lagosDay, isFreshQuote } from './markets.js';
import { loadPlayerPrices } from './player-prices.js';

export function createApplication({ store, directory, env = process.env, beforeExternalFetch = async () => {}, loginLimiter = async () => true, fetcher = fetch } = {}) {
  const production = env.VERCEL === '1', port = Number(env.PORT || 3100);
  const auth = createAuth(env.APP_PASSWORD, production);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`,
    ...[env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean).map(host => `https://${host}`), ...(env.APP_ORIGIN ? [env.APP_ORIGIN] : [])]);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  const network = async (url, init = {}) => {
    await beforeExternalFetch();
    return fetcher(url, { ...init, ...(production ? { signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) } : {}) });
  };
  const intelligence = new Intelligence(store, { env, fetcher: network });
  let busy = false;
  async function locked(fn) {
    if (production) return fn(); // CloudState already holds the cross-instance lock.
    if (busy) throw new Error('Another app request is running');
    const lock = join(directory, 'collector.lock'); let fd;
    try { fd = openSync(lock, 'wx'); } catch { throw new Error('Collector is running or its lock needs inspection'); }
    writeFileSync(fd, String(process.pid)); closeSync(fd); busy = true;
    try { return await fn(); } finally { busy = false; unlinkSync(lock); }
  }
  function send(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  }
  async function body(request) {
    let data = '';
    for await (const chunk of request) { data += chunk; if (data.length > 20000) throw new Error('Request too large'); }
    try { return JSON.parse(data); } catch { throw new Error('Invalid JSON request'); }
  }
  function predictionOptions(value) {
    const filtered = Object.fromEntries(['league', 'type', 'playerStat', 'playerDirection', 'playerEventId', 'bookmaker', 'date', 'model'].filter(k => typeof value[k] === 'string').map(k => [k, value[k]]));
    return { ...filtered, target: Number(value.target), minProbability: Number(value.minProbability ?? 0.5),
      aiEnabled: value.aiEnabled === true, researchEnabled: value.researchEnabled === true };
  }
  function transport() {
    const limits = { daily: Number(env.ODDS_DAILY_BUDGET ?? 14), monthly: Number(env.ODDS_MONTHLY_BUDGET ?? 450) };
    if (![limits.daily, limits.monthly].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid odds budgets');
    return new Http(store, directory, { limits: { odds: limits }, fetcher: network });
  }
  const fileMap = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
  const handler = async (request, response) => {
    if (!hosts.has(request.headers.host)) { send(response, 403, { error: 'Invalid host' }); return; }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    try {
      if (request.method === 'GET' && fileMap[url.pathname]) {
        const file = fileMap[url.pathname];
        response.writeHead(200, { 'Content-Type': `${{ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'X-Content-Type-Options': 'nosniff' });
        response.end(readFileSync(resolve('web', file))); return;
      }
      if (production && (!env.APP_PASSWORD || env.APP_PASSWORD.length < 16)) { send(response, 503, { error: 'Set APP_PASSWORD to at least 16 characters in Vercel environment variables' }); return; }
      if (request.headers.origin && !origins.has(request.headers.origin)) { send(response, 403, { error: 'Invalid origin' }); return; }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        if (!await loginLimiter(request)) { send(response, 429, { error: 'Too many login attempts; try again in ten minutes' }); return; }
        const cookie = auth.login((await body(request)).password);
        if (!cookie) { send(response, 401, { error: 'Incorrect app password' }); return; }
        response.setHeader('Set-Cookie', cookie); send(response, 200, { ok: true }); return;
      }
      if (!auth.valid(request)) { send(response, 401, { error: 'Sign in with your app password', loginRequired: true }); return; }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        send(response, 200, { actionToken: auth.actionToken, openrouterConfigured: Boolean(env.OPENROUTER_API_KEY), tavilyConfigured: Boolean(env.TAVILY_API_KEY),
          oddsConfigured: Boolean(env.ODDS_API_KEY), defaultModel: env.OPENROUTER_MODEL || '', hosted: production,
          policy: { skipAiAt: 0.7, maxRequestsPerSlip: 5 }, today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date()) }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/fixtures') {
        const league = url.searchParams.get('league') ?? 'nba'; if (!['nba', 'ncaa'].includes(league)) throw new Error('Invalid league');
        const now = new Date().toISOString(), games = canonical(store, 'game', league);
        const fixtures = games.filter(g => g.status === 'scheduled' && g.starts_at > now).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 200);
        const snapshots = store.rows('odds', league).filter(r => r.starts_at > now);
        const fresh = snapshots.filter(r => isFreshQuote(r, Date.parse(now)));
        const events = [...new Map(snapshots.map(r => [r.event_id, { id: r.event_id, home: r.home_name, away: r.away_name, startsAt: r.starts_at,
          freshMarkets: [...new Set(fresh.filter(p => p.event_id === r.event_id).map(p => p.market))] }])).values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        send(response, 200, { fixtures, events, bookmakers: [...new Set(fresh.map(r => r.bookmaker))].sort(),
          freshPriceEvents: new Set(fresh.map(r => r.event_id)).size,
          coverageNote: league === 'ncaa' ? 'NCAA men: primarily Division I and their opponents. Division II/III, women and live games are not fully covered.' : 'NBA pregame markets. Started games are excluded.',
          latestCompletedAt: games.filter(g => g.status === 'final').map(g => g.starts_at).sort().at(-1) ?? null,
          priceUpdatedAt: snapshots.map(r => r.price_updated_at).sort().at(-1) ?? null }); return;
      }
      if (request.method !== 'POST' || request.headers['x-app-token'] !== auth.actionToken) { send(response, 403, { error: 'Invalid app action' }); return; }
      const value = await body(request);
      if (url.pathname === '/api/predict') {
        send(response, 200, await locked(async () => {
          const selected = predictionOptions(value);
          if (![5, 10, 50, 100, 200].includes(selected.target) || !Number.isFinite(selected.minProbability) || selected.minProbability < .5 || selected.minProbability > .95) throw new Error('Invalid target or minimum chance');
          const preparation = await preparePredictionData(store, transport(), selected, env.ODDS_API_KEY);
          return createPrediction(store, intelligence, selected, { exportDirectory: join(directory, 'predictions'), preparation });
        })); return;
      }
      if (url.pathname === '/api/models') { send(response, 200, await locked(() => intelligence.models())); return; }
      if (url.pathname === '/api/player-odds-batch') {
        send(response, 200, await locked(() => loadPlayerPrices(store, transport(), value, env.ODDS_API_KEY))); return;
      }
      if (['/api/refresh-odds', '/api/player-odds'].includes(url.pathname)) {
        if (!['nba', 'ncaa'].includes(value.league)) throw new Error('Invalid league');
        if (url.pathname === '/api/player-odds' && (!playerMarkets[value.playerStat] || !store.rows('odds', value.league).some(r => r.event_id === value.eventId && Date.parse(r.starts_at) > Date.now()))) throw new Error('Select an upcoming event and a valid player statistic');
        send(response, 200, await locked(async () => {
          const client = transport();
          if (url.pathname === '/api/refresh-odds') {
            const day = value.date || lagosDay(Date.now());
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || dayString(new Date(day)) !== day) throw new Error('Invalid refresh date');
            for (const offset of [-1, 0, 1]) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); await scoreboard(client, store, value.league, dayString(d)); }
            const boxes = await summaries(client, store, value.league, 5);
            if (boxes.errors.length) console.warn(`${value.league}: some recent summaries are incomplete`);
          }
          return odds(client, store, value.league, env.ODDS_API_KEY, url.pathname === '/api/player-odds' ? value.eventId : undefined,
            url.pathname === '/api/player-odds' ? { playerStat: value.playerStat } : {});
        })); return;
      }
      send(response, 404, { error: 'Unknown endpoint' });
    } catch (error) { send(response, 400, { error: error.message }); }
  };
  return { handler, auth };
}
