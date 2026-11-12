import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { Http } from './http.js';
import { cbbd, odds } from './collect.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const directory = resolve(process.env.DATA_DIR || './data');
mkdirSync(directory, { recursive: true });
const lock = join(directory, 'collector.lock');
let lockFd;
try { lockFd = openSync(lock, 'wx'); }
catch { throw new Error('A collector lock exists; finish the running collector before testing'); }
writeFileSync(lockFd, String(process.pid)); closeSync(lockFd);
let store;
try {
  store = new Store(join(directory, 'basketball.sqlite'));
  const budget = (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid budget setting: ${name}`);
    return value;
  };
  const http = new Http(store, directory, { limits: {
    cbbd: { daily: budget('CBBD_DAILY_BUDGET', 24), monthly: budget('CBBD_MONTHLY_BUDGET', 900) },
    odds: { daily: budget('ODDS_DAILY_BUDGET', 14), monthly: budget('ODDS_MONTHLY_BUDGET', 450) }
  } });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const usage = () => store.db.prepare("SELECT provider,day,units FROM usage WHERE provider IN ('cbbd','odds') ORDER BY provider,day").all();
  const count = () => store.db.prepare("SELECT kind,league,COUNT(*) records FROM records WHERE source IN ('cbbd','odds') GROUP BY kind,league ORDER BY kind,league").all();
  const report = { tested_at: new Date().toISOString(), day, usage_before: usage(), tests: {}, errors: [] };
  const run = store.db.prepare('INSERT INTO runs(started_at,command) VALUES(?,?)').run(report.tested_at, 'api-smoke').lastInsertRowid;
  const cases = [
    ['cbbd:ncaa', () => cbbd(http, store, day, day, process.env.CBBD_API_KEY)],
    ['odds:nba', () => odds(http, store, 'nba', process.env.ODDS_API_KEY)],
    ['odds:ncaa', () => odds(http, store, 'ncaa', process.env.ODDS_API_KEY)]
  ];
  for (const [name, collect] of cases) {
    console.log(`Testing ${name}...`);
    try {
      const result = await collect();
      if (result.skipped) { report.tests[name] = result; continue; }
      const beforeUsage = JSON.stringify(usage()), beforeCount = JSON.stringify(count());
      await collect();
      const cachePassed = JSON.stringify(usage()) === beforeUsage && JSON.stringify(count()) === beforeCount;
      report.tests[name] = { ...result, cache_no_extra_quota_or_duplicates: cachePassed };
      if (!cachePassed) report.errors.push({ test: name, error: 'Cached rerun changed quota or row count' });
    } catch (error) { report.errors.push({ test: name, error: error.message }); }
  }
  report.stored = count();
  report.usage_after = usage();
  report.provider_remaining = store.db.prepare("SELECT * FROM remote_limits WHERE provider IN ('cbbd','odds')").all();
  report.odds_markets = store.db.prepare("SELECT league,json_extract(payload,'$.market') market,COUNT(*) snapshots FROM records WHERE kind='odds' GROUP BY league,market").all();
  store.db.prepare('UPDATE runs SET finished_at=?,result=? WHERE id=?').run(new Date().toISOString(), JSON.stringify(report), run);
  writeFileSync(join(directory, 'api-smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { store?.close(); unlinkSync(lock); }
