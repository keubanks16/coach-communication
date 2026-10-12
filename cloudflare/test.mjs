import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createECDH } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createWorker } from './worker.mjs';
import { getPushKeys, sendPush, validSubscription } from './push.mjs';
import { selectDatabase } from './deploy.mjs';

const pairingKey = 'local-only-test-pairing-secret';
const schema = readFileSync(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8');

// Async D1-shaped adapter for fast edge-case tests; the integration test below
// also executes the bundled Worker in workerd against Miniflare's real local D1.
function localDB() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(schema);
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      const result = {
        bind(...args) { values = args; return result; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { const r = statement.run(...values); return { meta: { changes: Number(r.changes) } }; }
      };
      return result;
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
  };
}
function fixture(t, options = {}) {
  const db = localDB(), pending = [];
  const worker = createWorker({ pushTestDelayMs: 0, ...options });
  const env = { DB: db, PAIRING_KEY: pairingKey, ASSETS: { fetch: async () => new Response('asset') } };
  t.after(() => db.sqlite.close());
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  async function request(path, method = 'GET', data, token, extra = {}) {
    const response = await worker.fetch(new Request('https://coach.example.com' + path, {
      method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
      body: data ? JSON.stringify(data) : undefined
    }), env, ctx);
    await Promise.all(pending.splice(0));
    return { status: response.status, data: await response.json() };
  }
  const pair = async role => (await request('/v1/pair', 'POST', { key: pairingKey, role })).data;
  return { db, env, worker, request, pair };
}
function subscription() {
  const client = createECDH('prime256v1'); client.generateKeys();
  return { endpoint: 'https://web.push.apple.com/fake-test-endpoint',
    keys: { p256dh: client.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 8).toString('base64url') } };
}

test('bundled Worker runs in Cloudflare runtime with local D1 and persistent VAPID keys', async t => {
  const outgoing = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: '.wrangler/test-build/worker.js',
    compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { PAIRING_KEY: pairingKey }, d1Databases: { DB: 'local-test-database' },
    outboundService: async request => {
      outgoing.push({ url: request.url, encoding: request.headers.get('Content-Encoding'), body: new Uint8Array(await request.arrayBuffer()) });
      return new Response('', { status: 201 });
    }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  await db.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  async function request(path, method = 'GET', data, token) {
    const response = await mf.dispatchFetch('https://coach.example.com' + path, {
      method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: data ? JSON.stringify(data) : undefined
    });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await request('/health')).data.ready, true);
  const first = (await request('/v1/pair', 'POST', { key: pairingKey, role: 'First base' })).data;
  const third = (await request('/v1/pair', 'POST', { key: pairingKey, role: 'Third base' })).data;
  assert.ok(first.token && third.token);
  for (const [sender, recipient, text] of [[first, third, 'Steal'], [third, first, 'Hold']]) {
    const id = randomUUID();
    assert.equal((await request('/v1/messages', 'POST', { id, text }, sender.token)).status, 201);
    assert.equal((await request('/v1/messages/' + id + '/ack', 'POST', {}, recipient.token)).status, 200);
    const feed = (await request('/v1/messages', 'GET', undefined, sender.token)).data;
    assert.ok(feed.messages.find(message => message.id === id).acknowledgedAt);
  }
  const key = (await request('/v1/config')).data.publicKey;
  assert.match(key, /^[A-Za-z0-9_-]{87}$/);
  assert.equal((await request('/v1/config')).data.publicKey, key);
  const stored = await db.prepare("SELECT value FROM app_settings WHERE key='vapid'").first();
  assert.equal(JSON.parse(stored.value).publicKey, key);
  await request('/v1/web-subscription', 'POST', { subscription: subscription() }, third.token);
  const pushID = randomUUID();
  await request('/v1/messages', 'POST', { id: pushID, text: 'Bunt now' }, first.token);
  let pushStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    pushStatus = (await db.prepare('SELECT push_status FROM messages WHERE id=?').bind(pushID).first()).push_status;
    if (pushStatus !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(pushStatus, 'accepted');
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].encoding, 'aes128gcm');
  assert.equal(Buffer.from(outgoing[0].body).includes(Buffer.from('Bunt now')), false);
});

test('pairing protects coach roles and rejects unauthenticated access', async t => {
  const { request, pair } = fixture(t);
  assert.equal((await request('/v1/pair', 'POST', { key: 'wrong', role: 'First base' })).status, 403);
  const first = await pair('First base');
  assert.equal((await request('/v1/pair', 'POST', { key: pairingKey, role: 'First base' })).status, 409);
  assert.equal((await request('/v1/messages')).status, 401);
  assert.equal((await request('/v1/device', 'DELETE', undefined, first.token)).status, 200);
  assert.equal((await request('/v1/messages', 'GET', undefined, first.token)).status, 401);
  assert.ok((await pair('First base')).token);
});

test('retries are idempotent and only recipients can acknowledge calls', async t => {
  const { request, pair } = fixture(t);
  const first = await pair('First base'), third = await pair('Third base');
  const call = { id: randomUUID(), text: 'Bunt' };
  assert.equal((await request('/v1/messages', 'POST', call, first.token)).status, 201);
  assert.equal((await request('/v1/messages', 'POST', call, first.token)).status, 200);
  assert.equal((await request('/v1/messages', 'POST', call, third.token)).status, 409);
  assert.equal((await request('/v1/messages/' + call.id + '/ack', 'POST', {}, first.token)).status, 404);
  assert.equal((await request('/v1/messages/' + call.id + '/received', 'POST', {}, third.token)).status, 200);
  assert.equal((await request('/v1/messages/' + call.id + '/ack', 'POST', {}, third.token)).status, 200);
  const feed = (await request('/v1/messages', 'GET', undefined, first.token)).data;
  assert.equal(feed.messages.length, 1);
  assert.ok(feed.messages[0].receivedAt && feed.messages[0].acknowledgedAt);
});

test('concurrent retries do not insert duplicate calls', async t => {
  const { request, pair } = fixture(t);
  const first = await pair('First base'); await pair('Third base');
  const call = { id: randomUUID(), text: 'Hold' };
  const responses = await Promise.all([request('/v1/messages', 'POST', call, first.token), request('/v1/messages', 'POST', call, first.token)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  assert.equal((await request('/v1/messages', 'GET', undefined, first.token)).data.messages.length, 1);
});

test('expired instructions cannot be received or acknowledged', async t => {
  const { request, pair, db } = fixture(t);
  const first = await pair('First base'), third = await pair('Third base');
  const id = randomUUID();
  await request('/v1/messages', 'POST', { id, text: 'Send him' }, first.token);
  await db.prepare('UPDATE messages SET expires_at=? WHERE id=?').bind(new Date(0).toISOString(), id).run();
  assert.equal((await request('/v1/messages/' + id + '/ack', 'POST', {}, third.token)).status, 410);
  assert.equal((await request('/v1/messages/' + id + '/received', 'POST', {}, third.token)).status, 410);
});

test('subscriptions reject untrusted destinations and store only under authenticated devices', async t => {
  const { request, pair } = fixture(t);
  const first = await pair('First base');
  const sub = subscription();
  assert.equal((await request('/v1/web-subscription', 'POST', { subscription: sub })).status, 401);
  for (const endpoint of ['https://localhost/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.evil.example/a', 'http://web.push.apple.com/a', 'https://user:pass@web.push.apple.com/a']) {
    assert.equal(validSubscription({ ...sub, endpoint }), false);
  }
  assert.equal((await request('/v1/web-subscription', 'POST', { subscription: sub }, first.token)).status, 200);
  assert.equal((await request('/v1/messages', 'GET', undefined, first.token)).data.notificationsReady, true);
  assert.equal((await request('/v1/web-subscription', 'DELETE', undefined, first.token)).status, 200);
  assert.equal((await request('/v1/messages', 'GET', undefined, first.token)).data.notificationsReady, false);
});

test('Web Push is encrypted, uses Workers fetch, and has a short TTL', async t => {
  const { db } = fixture(t);
  const sub = subscription();
  let delivery;
  const message = { id: randomUUID(), senderRole: 'Third base', text: 'Steal', expiresAt: new Date(Date.now() + 60000).toISOString() };
  const result = await sendPush(db, sub, message, 'https://coach.example.com', async (url, options) => {
    delivery = { url, options }; return new Response('', { status: 201 });
  });
  assert.equal(result, 'accepted');
  assert.equal(delivery.url, sub.endpoint);
  assert.equal(delivery.options.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(delivery.options.headers.Urgency, 'high');
  assert.ok(Number(delivery.options.headers.TTL) <= 60);
  assert.equal(delivery.options.redirect, 'manual');
  assert.equal(Buffer.from(delivery.options.body).includes(Buffer.from('Steal')), false);
  assert.match(delivery.options.headers.Authorization, /^vapid t=/);
});

test('expired subscriptions are removed but their messages are preserved', async t => {
  const { request, pair, db } = fixture(t, { fetchPush: async () => new Response('', { status: 410 }) });
  const first = await pair('First base'), third = await pair('Third base');
  await request('/v1/web-subscription', 'POST', { subscription: subscription() }, third.token);
  const call = { id: randomUUID(), text: 'Hold' };
  assert.equal((await request('/v1/messages', 'POST', call, first.token)).status, 201);
  assert.equal((await db.prepare('SELECT web_subscription FROM devices WHERE id=?').bind(third.id).first()).web_subscription, null);
  const feed = (await request('/v1/messages', 'GET', undefined, first.token)).data;
  assert.equal(feed.messages[0].text, 'Hold');
  assert.equal(feed.messages[0].pushStatus, 'failed');
});

test('test notification targets the requesting coach and actual calls target the other coach', async t => {
  const destinations = [];
  const { request, pair } = fixture(t, { fetchPush: async url => { destinations.push(url); return new Response('', { status: 201 }); } });
  const first = await pair('First base'), third = await pair('Third base');
  const firstSub = subscription(), thirdSub = { ...subscription(), endpoint: 'https://web.push.apple.com/other-test-endpoint' };
  await request('/v1/web-subscription', 'POST', { subscription: firstSub }, first.token);
  await request('/v1/web-subscription', 'POST', { subscription: thirdSub }, third.token);
  assert.equal((await request('/v1/push-test', 'POST', {}, first.token)).data.status, 'scheduled');
  await request('/v1/messages', 'POST', { id: randomUUID(), text: 'Bunt' }, first.token);
  assert.deepEqual(destinations, [firstSub.endpoint, thirdSub.endpoint]);
});

test('bad payloads, body sizes and repeated pairing attempts are rejected', async t => {
  const { request, pair } = fixture(t);
  const first = await pair('First base'); await pair('Third base');
  assert.equal((await request('/v1/messages', 'POST', { id: randomUUID(), text: 'a'.repeat(121) }, first.token)).status, 400);
  assert.equal((await request('/v1/messages', 'POST', { id: randomUUID(), text: 'a'.repeat(5000) }, first.token)).status, 413);
  for (let i = 0; i < 8; i++) await request('/v1/pair', 'POST', { key: 'wrong' });
  assert.equal((await request('/v1/pair', 'POST', { key: 'wrong' })).status, 429);
});

test('VAPID keys survive new requests and are never exposed with their private key', async t => {
  const { db, request } = fixture(t);
  const keys = await getPushKeys(db);
  const publicConfig = (await request('/v1/config')).data;
  assert.deepEqual(publicConfig, { publicKey: keys.publicKey });
  assert.equal((await getPushKeys(db)).privateKey, keys.privateKey);
  assert.equal(JSON.stringify(publicConfig).includes(keys.privateKey), false);
});

test('missing setup returns actionable errors; database selection never invents IDs', async t => {
  const { worker, env } = fixture(t);
  const response = await worker.fetch(new Request('https://coach.example.com/v1/config'), { ...env, PAIRING_KEY: undefined }, { waitUntil() {} });
  assert.equal(response.status, 503);
  const uuid = randomUUID();
  assert.equal(selectDatabase([{ name: 'coach-communication', uuid }], 'coach-communication').uuid, uuid);
  assert.equal(selectDatabase([], 'coach-communication'), undefined);
  assert.throws(() => selectDatabase([{ name: 'coach-communication', uuid: 'bad-id' }], 'coach-communication'));
  assert.throws(() => selectDatabase([{ name: 'coach-communication', uuid }, { name: 'coach-communication', uuid }], 'coach-communication'));
});
