import http from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { createApplication } from './application.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const directory = resolve(process.env.DATA_DIR || './data'); mkdirSync(directory, { recursive: true });
const port = Number(process.env.PORT || 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
const store = new Store(join(directory, 'basketball.sqlite')), app = createApplication({ store, directory });
const server = http.createServer(app.handler);
server.listen(port, '127.0.0.1', () => console.log(`Basketball app: http://127.0.0.1:${port}`));
function shutdown() { server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
