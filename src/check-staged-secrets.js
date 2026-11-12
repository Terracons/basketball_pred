import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
const secrets = Object.entries(process.env).filter(([name, value]) => /(API_KEY|TOKEN|PASSWORD)$/.test(name) && value.length >= 8).map(([, value]) => value);
const files = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let failed = false;
for (const file of files) {
  if (/(^|\/)\.env$|\.sqlite(?:-|$)|(^|\/)(data|runtime|\.build-data)\//.test(file)) { console.error(`Private/runtime file staged: ${file}`); failed = true; continue; }
  const content = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (secrets.some(value => content.includes(value))) { console.error(`Configured secret detected in staged file: ${file}`); failed = true; }
}
if (failed) process.exitCode = 1; else console.log(`Staged-secret check passed for ${files.length} files. No keys or private databases are staged.`);
