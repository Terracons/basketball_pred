import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { createApplication } from '../src/application.js';
import { CloudState } from '../src/cloud-state.js';

let runtime;
function initialize() {
  const directory = join(tmpdir(), `courtside-${process.pid}`); mkdirSync(directory, { recursive: true });
  const file = join(directory, 'basketball.sqlite');
  if (!existsSync(file)) copyFileSync(resolve('runtime/seed.sqlite'), file);
  const store = new Store(file);
  // Application creates the intelligence tables before shared state is restored.
  let cloud;
  const app = createApplication({ store, directory, beforeExternalFetch: () => cloud.beforeExternal(), loginLimiter: request => cloud.loginAllowed(request) });
  cloud = new CloudState(store, directory);
  return { app, cloud };
}
export default async function handler(request, response) {
  try {
    const incoming = new URL(request.url, 'http://local');
    const route = incoming.searchParams.get('__route') ?? request.query?.__route;
    if (typeof route === 'string') {
      if (!/^[a-z-]+$/.test(route)) throw new Error('Invalid API route');
      incoming.searchParams.delete('__route');
      request.url = `/api/${route}${incoming.searchParams.size ? `?${incoming.searchParams}` : ''}`;
    }
    runtime ??= initialize();
    const { app, cloud } = runtime;
    const path = new URL(request.url, 'http://local').pathname;
    if (path === '/api/login' || !app.auth.valid(request) || path === '/api/config') {
      await app.handler(request, response); return;
    }
    const buffered = { status: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(value) { this.body = value ?? ''; } };
    await cloud.run(() => app.handler(request, buffered));
    response.writeHead(buffered.status, buffered.headers); response.end(buffered.body);
  } catch (error) {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: error.message }));
  }
}
