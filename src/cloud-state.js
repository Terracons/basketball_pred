import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class CloudState {
  constructor(store, directory, { env = process.env, fetcher = fetch } = {}) {
    this.store = store; this.directory = directory; this.fetcher = fetcher;
    this.url = env.UPSTASH_REDIS_REST_URL; this.token = env.UPSTASH_REDIS_REST_TOKEN;
    this.prefix = 'courtside:v1'; this.owner = null;
    if (!this.url || !this.token || new URL(this.url).protocol !== 'https:') throw new Error('Connect Upstash Redis in Vercel and set its REST URL and token');
  }
  async redis(command) {
    let response;
    try { response = await this.fetcher(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Shared storage is unavailable; external API requests have been stopped'); }
    if (!response.ok) throw new Error('Shared storage request failed');
    const value = await response.json(); if (value.error) throw new Error('Shared storage command failed');
    return value.result;
  }
  capture() {
    const db = this.store.db;
    const old = new Date(Date.now() - 45 * 86400000).toISOString();
    db.prepare("DELETE FROM records WHERE source<>'snapshot' AND observed_at<?").run(old);
    db.exec("DELETE FROM records WHERE kind='prediction' AND rowid NOT IN (SELECT rowid FROM records WHERE kind='prediction' ORDER BY observed_at DESC LIMIT 50)");
    db.prepare('DELETE FROM intelligence_cache WHERE saved_at<?').run(new Date(Date.now() - 2 * 86400000).toISOString());
    const cache = db.prepare('SELECT * FROM cache WHERE fetched_at>=? ORDER BY fetched_at DESC LIMIT 80').all(new Date(Date.now() - 12 * 3600000).toISOString())
      .filter(r => /^[a-f0-9]{64}$/.test(r.key) && existsSync(r.file))
      .map(r => ({ key: r.key, fetched_at: r.fetched_at, content: readFileSync(r.file, 'utf8') }));
    return { version: 1,
      records: db.prepare("SELECT kind,league,source,id,game_id,team_id,player_id,starts_at,status,observed_at,payload FROM records WHERE source<>'snapshot'").all().map(Object.values),
      usage: db.prepare('SELECT * FROM usage').all().map(Object.values), remote_limits: db.prepare('SELECT * FROM remote_limits').all().map(Object.values),
      intelligence_cache: db.prepare('SELECT * FROM intelligence_cache').all().map(Object.values),
      slip_requests: db.prepare('SELECT * FROM slip_requests').all().map(Object.values), ai_spend: db.prepare('SELECT * FROM ai_spend').all().map(Object.values), cache };
  }
  restore(state) {
    if (!state || state.version !== 1) throw new Error('Unsupported shared state version');
    const tables = { usage: 3, remote_limits: 3, intelligence_cache: 3, slip_requests: 2, ai_spend: 2 };
    this.store.transaction(() => {
      this.store.db.exec("DELETE FROM records WHERE source<>'snapshot'; DELETE FROM cache;");
      for (const [table, count] of Object.entries(tables)) {
        this.store.db.exec(`DELETE FROM ${table}`);
        const insert = this.store.db.prepare(`INSERT INTO ${table} VALUES(${Array(count).fill('?').join(',')})`);
        for (const row of state[table] ?? []) insert.run(...row);
      }
      for (const row of state.records ?? []) {
        if (row[2] === 'snapshot') throw new Error('Invalid mutable source');
        this.store.insert.run(...row);
      }
      mkdirSync(join(this.directory, 'raw'), { recursive: true });
      for (const r of state.cache ?? []) {
        if (!/^[a-f0-9]{64}$/.test(r.key)) throw new Error('Invalid shared cache key');
        const file = join(this.directory, 'raw', r.key); writeFileSync(file, r.content);
        this.store.db.prepare('INSERT INTO cache VALUES(?,?,?)').run(r.key, file, r.fetched_at);
      }
    });
  }
  async persist() {
    if (!this.owner) throw new Error('Shared quota lock is not held');
    const encoded = gzipSync(JSON.stringify(this.capture())).toString('base64');
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error('Shared state reached its safety size limit; rebuild the snapshot before more API calls');
    const result = await this.redis(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[2],ARGV[2]); return 1 else return 0 end", '2', `${this.prefix}:lock`, `${this.prefix}:state`, this.owner, encoded]);
    if (result !== 1) throw new Error('Shared quota lock expired; request stopped');
  }
  async beforeExternal() {
    if (Date.now() - this.startedAt > 180000) throw new Error('Request time budget reached; remaining selections stay statistically ranked without more network calls');
    await this.persist();
  }
  async run(fn) {
    if (this.owner && Date.now() - this.startedAt > 330000) this.owner = null;
    if (this.owner) throw new Error('Another request is already running in this instance');
    const owner = randomUUID();
    if (await this.redis(['SET', `${this.prefix}:lock`, owner, 'NX', 'EX', '330']) !== 'OK') throw new Error('Another prediction or update is running; try again shortly');
    this.owner = owner; this.startedAt = Date.now();
    try {
      const encoded = await this.redis(['GET', `${this.prefix}:state`]);
      const state = encoded ? JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8')) : { version: 1 };
      this.restore(state);
      try { return await fn(); } finally { await this.persist(); }
    } finally {
      try { await this.redis(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", '1', `${this.prefix}:lock`, owner]); }
      finally { this.owner = null; }
    }
  }
  async loginAllowed(request) {
    const address = String(request.headers['x-forwarded-for'] ?? request.socket?.remoteAddress ?? 'unknown').split(',')[0];
    const key = `${this.prefix}:login:${createHash('sha256').update(address).digest('hex')}`;
    const attempts = await this.redis(['EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n", '1', key]);
    return attempts <= 10;
  }
}
