import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Http {
  constructor(store, directory, { fetcher = fetch, sleep = wait, limits = {} } = {}) {
    this.store = store; this.directory = join(directory, 'raw'); this.fetcher = fetcher; this.sleep = sleep;
    mkdirSync(this.directory, { recursive: true });
    this.limits = {
      espn: { daily: 250, monthly: 7500 },
      sportsdataverse: { daily: 30, monthly: 100 },
      cbbd: { daily: 24, monthly: 900 },
      odds: { daily: 14, monthly: 450 }, ...limits
    };
    this.nextAt = new Map();
  }
  async file(provider, url, { ttl = 3600000, headers = {}, cost = 1 } = {}) {
    // URLs passed here must never contain API credentials. Credentials belong in headers.
    const key = createHash('sha256').update(`${provider}:${url}`).digest('hex');
    const cached = this.store.db.prepare('SELECT * FROM cache WHERE key=?').get(key);
    if (cached && Date.now() - Date.parse(cached.fetched_at) < ttl && existsSync(cached.file)) return cached.file;
    const target = join(this.directory, key), temporary = `${target}.part`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.sleep(Math.max(0, (this.nextAt.get(provider) ?? 0) - Date.now()));
      this.store.reserve(provider, cost, this.limits[provider]);
      this.nextAt.set(provider, Date.now() + (provider === 'espn' ? 350 : 1000));
      try {
        const response = await this.fetcher(url, { headers: { 'User-Agent': 'BasketballResearch/0.1', ...headers }, signal: AbortSignal.timeout(120000) });
        const remaining = response.headers.get('x-requests-remaining');
        if (remaining !== null) this.store.remoteRemaining(provider, Number(remaining));
        const actualCost = Number(response.headers.get('x-requests-last'));
        if (actualCost > cost) throw new Error(`${provider}: unexpected provider cost; stop and review budget`);
        if (!response.ok) {
          await response.body?.cancel();
          const error = new Error(`${provider}: HTTP ${response.status}`);
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            const value = response.headers.get('retry-after');
            const seconds = value === null ? 2 ** attempt : Number(value);
            if (!Number.isFinite(seconds) || seconds > 30) throw error;
            await this.sleep(Math.max(1, seconds) * 1000); continue;
          }
          throw error;
        }
        let bytes = 0;
        const cap = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 300 * 1024 * 1024 ? new Error('Response exceeds 300 MB limit') : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), cap, createWriteStream(temporary));
        renameSync(temporary, target);
        this.store.db.prepare(`INSERT INTO cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET file=excluded.file,fetched_at=excluded.fetched_at`).run(key, target, new Date().toISOString());
        return target;
      } catch (error) {
        rmSync(temporary, { force: true });
        // Never include URLs, headers, tokens, or provider bodies in error output.
        if (error.message.startsWith(`${provider}:`) || error.message.includes('300 MB')) throw error;
        if (attempt === 2) throw new Error(`${provider}: network/download failure after 3 attempts`);
        await this.sleep(1000 * 2 ** attempt);
      }
    }
  }
  async json(provider, url, options) {
    const file = await this.file(provider, url, options);
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error(`${provider}: invalid JSON response`); }
  }
}
