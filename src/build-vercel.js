import { existsSync, mkdirSync, copyFileSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { Http } from './http.js';
import { history } from './collect.js';
import { populateSnapshot } from './snapshot.js';

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
      await history(http, source, league, year, ['schedule', 'team_box', 'player_box']);
    }
  } finally { source.close(); }
}
const source = new Store(join(sourceDir, 'basketball.sqlite')), targetFile = join(runtimeDir, 'seed.sqlite');
if (existsSync(targetFile)) unlinkSync(targetFile);
const target = new Store(targetFile);
let counts;
try { counts = populateSnapshot(source, target); }
finally { source.close(); target.close(); }
const bytes = statSync(targetFile).size;
if (bytes > 180 * 1024 * 1024) throw new Error('Deployment snapshot exceeds the 180 MB safety limit');
writeFileSync(join(runtimeDir, 'manifest.json'), JSON.stringify({ builtAt: new Date().toISOString(), bytes, counts,
  attribution: 'Historical basketball data: SportsDataverse / hoopR, derived from ESPN. https://sportsdataverse.org/ . Source provenance is retained on each snapshot record.' }, null, 2));
console.log(JSON.stringify({ snapshotBytes: bytes, counts }, null, 2));
