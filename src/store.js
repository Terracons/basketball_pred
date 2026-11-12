import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, league TEXT NOT NULL, source TEXT NOT NULL,
        id TEXT NOT NULL, game_id TEXT, team_id TEXT, player_id TEXT,
        starts_at TEXT, status TEXT, observed_at TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(kind,league,source,id));
      CREATE INDEX IF NOT EXISTS records_games ON records(kind,league,game_id);
      CREATE INDEX IF NOT EXISTS records_dates ON records(kind,league,starts_at);
      CREATE TABLE IF NOT EXISTS usage (
        provider TEXT NOT NULL, day TEXT NOT NULL, units INTEGER NOT NULL,
        PRIMARY KEY(provider,day));
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY, file TEXT NOT NULL, fetched_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, command TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS remote_limits (
        provider TEXT PRIMARY KEY, month TEXT NOT NULL, remaining INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imports (
        league TEXT, kind TEXT, season INTEGER, fetched_at TEXT, state TEXT,
        accepted INTEGER, rejected INTEGER, PRIMARY KEY(league,kind,season));
      CREATE TABLE IF NOT EXISTS rejections (
        league TEXT, kind TEXT, season INTEGER, row_number INTEGER,
        reason TEXT, payload TEXT, PRIMARY KEY(league,kind,season,row_number));
    `);
    this.insert = this.db.prepare(`INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(kind,league,source,id) DO UPDATE SET
      game_id=excluded.game_id,team_id=excluded.team_id,player_id=excluded.player_id,
      starts_at=excluded.starts_at,status=excluded.status,observed_at=excluded.observed_at,payload=excluded.payload
      WHERE records.payload <> excluded.payload`);
  }
  put(kind, league, source, id, payload, observed = new Date().toISOString()) {
    if (!id || !league || !source) throw new Error('Missing record identity');
    if (kind === 'odds' && this.db.prepare('SELECT 1 FROM records WHERE kind=? AND league=? AND source=? AND id=?').get(kind, league, source, String(id))) return;
    this.insert.run(kind, league, source, String(id), payload.game_id ?? null,
      payload.team_id ?? null, payload.player_id ?? null, payload.starts_at ?? null,
      payload.status ?? null, observed, JSON.stringify(payload));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reserve(provider, units, limits, now = new Date()) {
    if (!Number.isSafeInteger(units) || units < 1) throw new Error('Invalid quota cost');
    const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
    this.transaction(() => {
      const daily = this.db.prepare('SELECT units FROM usage WHERE provider=? AND day=?').get(provider, day)?.units ?? 0;
      const monthly = this.db.prepare('SELECT COALESCE(SUM(units),0) n FROM usage WHERE provider=? AND day LIKE ?').get(provider, `${month}%`).n;
      const remote = this.db.prepare('SELECT * FROM remote_limits WHERE provider=? AND month=?').get(provider, month);
      if (daily + units > limits.daily || monthly + units > limits.monthly || (remote && remote.remaining < units)) {
        throw new Error(`${provider}: quota guard blocked request; daily=${daily}/${limits.daily}, monthly=${monthly}/${limits.monthly}`);
      }
      this.db.prepare(`INSERT INTO usage VALUES(?,?,?) ON CONFLICT(provider,day) DO UPDATE SET units=units+excluded.units`).run(provider, day, units);
      if (remote) this.db.prepare('UPDATE remote_limits SET remaining=remaining-? WHERE provider=?').run(units, provider);
    });
  }
  remoteRemaining(provider, remaining) {
    if (Number.isFinite(remaining) && remaining >= 0) this.db.prepare(`INSERT INTO remote_limits VALUES(?,?,?)
      ON CONFLICT(provider) DO UPDATE SET month=excluded.month,remaining=excluded.remaining`).run(provider, new Date().toISOString().slice(0, 7), remaining);
  }
  rows(kind, league) {
    return this.db.prepare('SELECT payload,observed_at FROM records WHERE kind=? AND league=?').all(kind, league)
      .map(r => ({ ...JSON.parse(r.payload), observed_at: r.observed_at }));
  }
  status() {
    return {
      counts: this.db.prepare('SELECT kind,league,source,COUNT(*) count,MAX(observed_at) last_observed FROM records GROUP BY kind,league,source').all(),
      usage: this.db.prepare('SELECT * FROM usage ORDER BY day DESC,provider').all(),
      remoteLimits: this.db.prepare('SELECT * FROM remote_limits').all(),
      imports: this.db.prepare('SELECT * FROM imports ORDER BY league,season,kind').all(),
      rejections: this.db.prepare('SELECT league,kind,season,reason,COUNT(*) count FROM rejections GROUP BY league,kind,season,reason').all(),
      recentRuns: this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 5').all()
    };
  }
  close() { this.db.close(); }
}
