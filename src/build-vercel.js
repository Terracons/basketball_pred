import { existsSync, mkdirSync, copyFileSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { Http } from './http.js';
import { history } from './collect.js';
import { canonicalIterator } from './analytics.js';

// Build-time data is public. API keys and private local state are never bundled.
const root = process.cwd(), publicDir = resolve(root, 'public'), runtimeDir = resolve(root, 'runtime');
mkdirSync(publicDir, { recursive: true }); mkdirSync(runtimeDir, { recursive: true });
for (const name of ['index.html', 'style.css', 'app.js']) copyFileSync(join(root, 'web', name), join(publicDir, name));
let sourceDir = resolve(process.env.DATA_DIR || './data');
if (!existsSync(join(sourceDir, 'basketball.sqlite'))) {
  sourceDir = resolve(root, '.build-data'); mkdirSync(sourceDir, { recursive: true });
  const source = new Store(join(sourceDir, 'basketball.sqlite')), http = new Http(source, sourceDir);
  try {
    const today = new Date(), season = today.getUTCFullYear() + (today.getUTCMonth() >= 6 ? 1 : 0);
    for (const league of ['nba', 'ncaa']) for (const year of [season - 1, season]) {
      console.log(`Preparing public ${league} history, season ${year}...`);
      await history(http, source, league, year, ['schedule', 'player_box']);
    }
  } finally { source.close(); }
}
const source = new Store(join(sourceDir, 'basketball.sqlite')), targetFile = join(runtimeDir, 'seed.sqlite');
if (existsSync(targetFile)) unlinkSync(targetFile);
const target = new Store(targetFile), now = Date.now(), start = new Date(now - 365 * 86400000).toISOString(), end = new Date(now + 8 * 86400000).toISOString();
const counts = {};
try {
  for (const league of ['nba', 'ncaa']) {
    let games = 0, players = 0, batch = [];
    const save = () => { target.transaction(() => { for (const [kind, id, p, observed] of batch) target.put(kind, league, 'snapshot', id, p, observed); }); batch = []; };
    for (const g of canonicalIterator(source, 'game', league)) if (g.starts_at >= start && g.starts_at <= end) {
      const p = { game_id: g.game_id, starts_at: g.starts_at, status: g.status, home_id: g.home_id, away_id: g.away_id,
        home_name: g.home_name, away_name: g.away_name, home_score: g.home_score, away_score: g.away_score, neutral: g.neutral,
        upstream_source: g.upstream_source ?? g.source };
      batch.push(['game', g.game_id, p, g.observed_at]); games++; if (batch.length >= 500) save();
    }
    save();
    const seen = new Map();
    // Current players' latest 20 appearances suffice for this statistical baseline.
    const rows = source.db.prepare(`SELECT payload,observed_at,source FROM records WHERE kind='player_box' AND league=? AND starts_at>=?
      ORDER BY starts_at DESC,observed_at DESC,CASE source WHEN 'espn' THEN 1 ELSE 0 END DESC`).iterate(league, start);
    const duplicates = new Set();
    for (const row of rows) {
      const p = JSON.parse(row.payload), key = `${p.game_id}:${p.player_id}`;
      if (duplicates.has(key)) continue; duplicates.add(key);
      const count = seen.get(p.player_id) ?? 0; if (count >= 20 || p.did_not_play || !(p.minutes > 0)) continue;
      seen.set(p.player_id, count + 1);
      batch.push(['player_box', key, { game_id: p.game_id, team_id: p.team_id, player_id: p.player_id, player_name: p.player_name,
        starts_at: p.starts_at, minutes: p.minutes, points: p.points, rebounds: p.rebounds, assists: p.assists, pra: p.pra,
        did_not_play: p.did_not_play, upstream_source: row.source }, row.observed_at]); players++;
      if (batch.length >= 500) save();
    }
    save(); counts[league] = { games, players };
  }
} finally { source.close(); target.close(); }
const bytes = statSync(targetFile).size;
if (bytes > 180 * 1024 * 1024) throw new Error('Deployment snapshot exceeds the 180 MB safety limit');
writeFileSync(join(runtimeDir, 'manifest.json'), JSON.stringify({ builtAt: new Date().toISOString(), bytes, counts,
  attribution: 'Historical basketball data: SportsDataverse / hoopR, derived from ESPN. https://sportsdataverse.org/ . Source provenance is retained on each snapshot record.' }, null, 2));
console.log(JSON.stringify({ snapshotBytes: bytes, counts }, null, 2));
