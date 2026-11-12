import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { Intelligence } from '../src/intelligence.js';
import { CloudState } from '../src/cloud-state.js';
import { createAuth } from '../src/auth.js';
import { createApplication } from '../src/application.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'courtside-hosting-')), store = new Store(join(dir, 'test.sqlite'));
  new Intelligence(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}
function fakeRedis() {
  const values = new Map();
  return { values, fetcher: async (url, options) => {
    const c = JSON.parse(options.body); let result;
    if (c[0] === 'GET') result = values.get(c[1]) ?? null;
    else if (c[0] === 'SET') { result = values.has(c[1]) ? null : 'OK'; if (result) values.set(c[1], c[2]); }
    else if (c[0] === 'EVAL' && c[1].includes('local n=')) { result = (values.get(c[3]) ?? 0) + 1; values.set(c[3], result); }
    else if (c[0] === 'EVAL' && c[2] === '2') { result = values.get(c[3]) === c[5] ? 1 : 0; if (result) values.set(c[4], c[6]); }
    else if (c[0] === 'EVAL') { result = values.get(c[3]) === c[4] ? 1 : 0; if (result) values.delete(c[3]); }
    else assert.fail('Unexpected Redis command');
    return new Response(JSON.stringify({ result }));
  } };
}
const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example.invalid', UPSTASH_REDIS_REST_TOKEN: 'test-only' };
test('password sessions are signed, HttpOnly, secure in production, and work across instances', () => {
  const first = createAuth('a-long-test-password', true), second = createAuth('a-long-test-password', true);
  assert.equal(first.login('wrong'), null);
  const cookie = first.login('a-long-test-password');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/);
  assert.equal(second.valid({ headers: { cookie } }), true);
  assert.equal(second.valid({ headers: { cookie: cookie.replace('courtside_session=', 'courtside_session=9') } }), false);
  assert.equal(first.actionToken, second.actionToken);
});
test('shared quotas survive new function instances and are persisted before provider calls', async t => {
  const a = setup(t), b = setup(t), redis = fakeRedis();
  const first = new CloudState(a.store, a.dir, { env, fetcher: redis.fetcher }), second = new CloudState(b.store, b.dir, { env, fetcher: redis.fetcher });
  b.store.put('game', 'nba', 'snapshot', 'base', { game_id: 'base' });
  await first.run(async () => {
    a.store.reserve('odds', 2, { daily: 4, monthly: 10 }); await first.beforeExternal();
    const saved = JSON.parse(gunzipSync(Buffer.from(redis.values.get('courtside:v1:state'), 'base64')));
    assert.equal(saved.usage[0][2], 2);
    a.store.put('odds', 'nba', 'odds', 'quote', { game_id: 'game' });
  });
  await second.run(async () => {
    assert.equal(b.store.rows('odds', 'nba').length, 1); assert.equal(b.store.rows('game', 'nba').length, 1);
    b.store.reserve('odds', 2, { daily: 4, monthly: 10 });
    assert.throws(() => b.store.reserve('odds', 1, { daily: 4, monthly: 10 }), /quota guard/);
  });
  assert.equal(redis.values.has('courtside:v1:lock'), false);
});
test('distributed lock stops concurrent collectors and releases even on errors', async t => {
  const a = setup(t), b = setup(t), redis = fakeRedis();
  const first = new CloudState(a.store, a.dir, { env, fetcher: redis.fetcher }), second = new CloudState(b.store, b.dir, { env, fetcher: redis.fetcher });
  await first.run(async () => { await assert.rejects(second.run(async () => {}), /Another prediction/); });
  await assert.rejects(first.run(async () => { throw new Error('test failure'); }), /test failure/);
  assert.equal(redis.values.has('courtside:v1:lock'), false);
});
test('login limiter caps attempts and storage failure stops calls rather than resetting counters', async t => {
  const { store, dir } = setup(t), redis = fakeRedis(), cloud = new CloudState(store, dir, { env, fetcher: redis.fetcher });
  for (let i = 0; i < 10; i++) assert.equal(await cloud.loginAllowed({ headers: { 'x-forwarded-for': '127.0.0.1' } }), true);
  assert.equal(await cloud.loginAllowed({ headers: { 'x-forwarded-for': '127.0.0.1' } }), false);
  const broken = new CloudState(store, dir, { env, fetcher: async () => { throw new Error('private provider details'); } });
  await assert.rejects(broken.run(() => assert.fail('Must not call APIs')), /Shared storage is unavailable/);
});
async function call(app, method, path, value, extraHeaders = {}) {
  const req = Readable.from(value === undefined ? [] : [JSON.stringify(value)]);
  Object.assign(req, { method, url: path, headers: { host: 'desk.vercel.app', ...extraHeaders } });
  const res = { headers: {}, status: 200, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = JSON.parse(body); } };
  await app.handler(req, res); return res;
}
test('hosted app rejects anonymous access, requires a password, and never returns keys', async t => {
  const { store, dir } = setup(t);
  const app = createApplication({ store, directory: dir, env: { VERCEL: '1', VERCEL_URL: 'desk.vercel.app', APP_PASSWORD: 'a-long-test-password', OPENROUTER_API_KEY: 'private-test-key' } });
  assert.equal((await call(app, 'GET', '/api/config')).status, 401);
  assert.equal((await call(app, 'POST', '/api/login', { password: 'wrong' })).status, 401);
  const login = await call(app, 'POST', '/api/login', { password: 'a-long-test-password' });
  const config = await call(app, 'GET', '/api/config', undefined, { cookie: login.headers['Set-Cookie'] });
  assert.equal(config.status, 200); assert.equal(config.body.openrouterConfigured, true);
  assert.ok(!JSON.stringify(config.body).includes('private-test-key'));
  assert.equal((await call(app, 'POST', '/api/models', {}, { cookie: login.headers['Set-Cookie'] })).status, 403);
  const unset = createApplication({ store, directory: dir, env: { VERCEL: '1', VERCEL_URL: 'desk.vercel.app' } });
  assert.equal((await call(unset, 'GET', '/api/config')).status, 503);
});
