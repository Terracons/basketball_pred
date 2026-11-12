import { existsSync, readFileSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { Http } from './http.js';
import { history, scoreboard, summaries, cbbd, odds, leagues, checkLeague, dayString } from './collect.js';
import { quality, headToHead, exportLabels } from './analytics.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2), command = args.shift() ?? 'help';
const options = {};
while (args.length) {
  const key = args.shift();
  if (!key.startsWith('--') || !args.length || args[0].startsWith('--')) throw new Error('Options require --name value');
  options[key.slice(2)] = args.shift();
}
function positive(value, fallback) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Budget or limit must be a nonnegative integer');
  return n;
}
function validDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || dayString(new Date(s)) !== s) throw new Error('Date must be YYYY-MM-DD');
  return s;
}
if (command === 'help') {
  console.log(`Basketball data collection (Node 22.18+)
  node src/cli.js collect [--date YYYY-MM-DD] [--summary-limit 25]
  node src/cli.js history --seasons 2024,2025,2026 [--league nba|ncaa] [--kinds schedule,team_box,player_box]
  node src/cli.js odds [--league nba|ncaa] [--event EVENT_ID]
  node src/cli.js h2h --league nba --teams ID,ID --before ISO_TIMESTAMP
  node src/cli.js export
  node src/cli.js status
Copy .env.example to .env to configure optional API keys and budgets.`);
  process.exit(0);
}
const directory = resolve(process.env.DATA_DIR || './data');
mkdirSync(directory, { recursive: true });
const lock = join(directory, 'collector.lock');
try {
  const fd = openSync(lock, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd);
} catch {
  const pid = Number(readFileSync(lock, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
  if (alive || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Another collector is running, or lock needs manual inspection');
  unlinkSync(lock);
  const fd = openSync(lock, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd);
}
let store;
try {
  store = new Store(join(directory, 'basketball.sqlite'));
  const http = new Http(store, directory, { limits: {
    cbbd: { daily: positive(process.env.CBBD_DAILY_BUDGET, 24), monthly: positive(process.env.CBBD_MONTHLY_BUDGET, 900) },
    odds: { daily: positive(process.env.ODDS_DAILY_BUDGET, 14), monthly: positive(process.env.ODDS_MONTHLY_BUDGET, 450) },
    espn: { daily: positive(process.env.ESPN_DAILY_BUDGET, 250), monthly: 7500 }
  } });
  const result = {}, errors = [];
  const run = store.db.prepare('INSERT INTO runs(started_at,command) VALUES(?,?)').run(new Date().toISOString(), command).lastInsertRowid;
  async function step(name, fn) {
    console.log(`Collecting ${name}...`);
    try { result[name] = await fn(); }
    catch (e) { errors.push({ step: name, error: e.message }); }
  }
  const selected = options.league ? [options.league] : leagues;
  selected.forEach(checkLeague);
  if (command === 'collect') {
    const day = validDay(options.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
    const limit = positive(options['summary-limit'], 25);
    if (limit > 100) throw new Error('Summary limit must be at most 100 per league');
    for (const league of selected) {
      for (const offset of [-1, 0, 1]) {
        const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset);
        await step(`${league}:fixtures:${dayString(d)}`, async () => ({ games: (await scoreboard(http, store, league, dayString(d))).length }));
      }
      await step(`${league}:boxscores`, () => summaries(http, store, league, limit));
      await step(`${league}:odds`, () => odds(http, store, league, process.env.ODDS_API_KEY));
    }
    if (selected.includes('ncaa')) await step('ncaa:cbbd', () => cbbd(http, store, day, day, process.env.CBBD_API_KEY));
  } else if (command === 'history') {
    if (!options.seasons) throw new Error('Provide explicit season ending years with --seasons');
    for (const league of selected) for (const season of options.seasons.split(',').map(Number)) {
      await step(`${league}:${season}`, () => history(http, store, league, season, options.kinds?.split(',')));
    }
  } else if (command === 'odds') {
    if (options.event && !options.league) throw new Error('Player prop collection needs --league and --event');
    for (const league of selected) await step(`${league}:odds`, () => odds(http, store, league, process.env.ODDS_API_KEY, options.event));
  } else if (command === 'h2h') {
    if (!options.teams || !options.before || !options.league) throw new Error('h2h needs --league, --teams and --before');
    const teams = options.teams.split(',');
    if (teams.length !== 2) throw new Error('Supply two ESPN team ids');
    result.games = headToHead(store, options.league, teams[0], teams[1], options.before);
  } else if (command === 'export') result.exports = exportLabels(store, join(directory, 'exports'));
  else if (command !== 'status') throw new Error(`Unknown command: ${command}`);
  for (const [stepName, value] of Object.entries(result)) if (value?.errors?.length) errors.push(...value.errors.map(e => ({ step: stepName, ...e })));
  result.errors = errors; result.quality = quality(store);
  store.db.prepare('UPDATE runs SET finished_at=?,result=? WHERE id=?').run(new Date().toISOString(), JSON.stringify(result), run);
  if (command === 'status') result.status = store.status();
  writeFileSync(join(directory, 'latest-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (e) {
  console.error(e.message); process.exitCode = 1;
} finally {
  store?.close(); unlinkSync(lock);
}
