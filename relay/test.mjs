import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from './server.mjs';
import { createWebPush, validSubscription } from './web-push.mjs';
import webpush from 'web-push';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const key = 'a-long-test-pairing-secret';
async function fixture(t, options = {}) {
  const relay = createRelay({ pairingKey: key, push: { configured: false, send: async () => 'unconfigured' }, ...options });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => { await new Promise(resolve => relay.server.close(resolve)); relay.db.close(); });
  async function request(path, method = 'GET', data, token) {
    const response = await fetch(base + path, { method, headers: {
      ...(data ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, data: await response.json() };
  }
  const pair = async role => (await request('/v1/pair', 'POST', { key, role })).data;
  return { ...relay, request, pair };
}

test('two coaches send, receive and acknowledge in both directions', async t => {
  const { request, pair } = await fixture(t);
  const first = await pair('First base'), third = await pair('Third base');
  for (const [sender, recipient, text] of [[third, first, 'Steal'], [first, third, 'Hold']]) {
    const id = randomUUID();
    assert.equal((await request('/v1/messages', 'POST', { id, text }, sender.token)).status, 201);
    assert.equal((await request(`/v1/messages/${id}/received`, 'POST', {}, sender.token)).status, 404);
    assert.equal((await request(`/v1/messages/${id}/received`, 'POST', {}, recipient.token)).status, 200);
    assert.equal((await request(`/v1/messages/${id}/ack`, 'POST', {}, recipient.token)).status, 200);
    const feed = (await request('/v1/messages', 'GET', undefined, sender.token)).data;
    const call = feed.messages.find(message => message.id === id);
    assert.equal(call.text, text);
    assert.ok(call.receivedAt && call.acknowledgedAt);
  }
});

test('pairing and access are protected, roles cannot be overwritten', async t => {
  const { request, pair } = await fixture(t);
  assert.equal((await request('/v1/pair', 'POST', { key: 'wrong', role: 'First base' })).status, 403);
  assert.equal((await request('/v1/pair', 'POST', { key, role: 'Other' })).status, 400);
  const first = await pair('First base');
  assert.equal((await request('/v1/pair', 'POST', { key, role: 'First base' })).status, 409);
  assert.equal((await request('/v1/messages')).status, 401);
  assert.equal((await request('/v1/messages', 'POST', { id: randomUUID(), text: 'Steal' }, first.token)).status, 409);
  assert.equal((await request('/v1/device', 'DELETE', undefined, first.token)).status, 200);
  assert.equal((await request('/v1/messages', 'GET', undefined, first.token)).status, 401);
  assert.ok((await pair('First base')).token);
});

test('retrying a message is idempotent and cannot duplicate calls', async t => {
  const { request, pair } = await fixture(t);
  const first = await pair('First base'), third = await pair('Third base');
  const id = randomUUID(), call = { id, text: 'Bunt' };
  assert.equal((await request('/v1/messages', 'POST', call, first.token)).status, 201);
  assert.equal((await request('/v1/messages', 'POST', call, first.token)).status, 200);
  assert.equal((await request('/v1/messages', 'POST', call, third.token)).status, 409);
  assert.equal((await request('/v1/messages', 'GET', undefined, third.token)).data.messages.length, 1);
});

test('expired instructions cannot be acknowledged', async t => {
  const { request, pair, db } = await fixture(t);
  const first = await pair('First base'), third = await pair('Third base');
  const id = randomUUID();
  await request('/v1/messages', 'POST', { id, text: 'Send him' }, first.token);
  db.prepare('UPDATE messages SET expires_at=? WHERE id=?').run(new Date(0).toISOString(), id);
  assert.equal((await request(`/v1/messages/${id}/ack`, 'POST', {}, third.token)).status, 410);
  assert.equal((await request(`/v1/messages/${id}/received`, 'POST', {}, third.token)).status, 410);
});

test('push failure preserves calls and reports failure', async t => {
  const { request, pair } = await fixture(t, { push: { configured: true, send: async () => { throw Error('APNs unavailable'); } } });
  const first = await pair('First base'), third = await pair('Third base');
  await request('/v1/push-token', 'POST', { token: 'a'.repeat(64) }, third.token);
  const sent = await request('/v1/messages', 'POST', { id: randomUUID(), text: 'Hold' }, first.token);
  assert.equal(sent.status, 201);
  const feed = (await request('/v1/messages', 'GET', undefined, third.token)).data;
  assert.equal(feed.messages[0].pushStatus, 'failed');
  assert.equal(feed.messages[0].text, 'Hold');
});

test('invalid text and oversized bodies are rejected', async t => {
  const { request, pair } = await fixture(t);
  const first = await pair('First base');
  await pair('Third base');
  for (const text of ['', ' '.repeat(3), 'a'.repeat(121)]) {
    assert.equal((await request('/v1/messages', 'POST', { id: randomUUID(), text }, first.token)).status, 400);
  }
  assert.equal((await request('/v1/messages', 'POST', { id: randomUUID(), text: 'a'.repeat(5000) }, first.token)).status, 413);
  assert.equal((await request('/v1/push-token', 'POST', { token: 'bad-token' }, first.token)).status, 400);
});

test('SQLite preserves pairing and messages across relay restarts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-comms-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'relay.sqlite');
  const one = createRelay({ databasePath, pairingKey: key });
  one.db.prepare('INSERT INTO devices(id,token_hash,role,seen_at) VALUES(?,?,?,?)')
    .run('test-device', 'hash', 'First base', new Date().toISOString());
  one.db.close();
  const two = createRelay({ databasePath, pairingKey: key });
  assert.equal(two.db.prepare('SELECT role FROM devices WHERE id=?').get('test-device').role, 'First base');
  two.db.close();
});

test('rapid pairing attempts are rate-limited', async t => {
  const { request } = await fixture(t);
  for (let i = 0; i < 10; i++) await request('/v1/pair', 'POST', { key: 'wrong' });
  assert.equal((await request('/v1/pair', 'POST', { key: 'wrong' })).status, 429);
});

function subscription() {
  return { endpoint: 'https://web.push.apple.com/fake-test-endpoint',
    keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: Buffer.alloc(16, 7).toString('base64url') } };
}

test('Home Screen assets have proper types, CSP and service-worker scope', async t => {
  const { server } = await fixture(t);
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, type] of [['/', 'text/html'], ['/sw.js', 'text/javascript'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon-192.png', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
    if (path === '/sw.js') assert.equal(response.headers.get('service-worker-allowed'), '/');
  }
  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
});

test('web subscriptions require authentication and cannot target arbitrary servers', async t => {
  const { request, pair } = await fixture(t);
  const coach = await pair('First base');
  const good = subscription();
  assert.equal((await request('/v1/web-subscription', 'POST', { subscription: good })).status, 401);
  for (const endpoint of ['http://web.push.apple.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.evil.example/a', 'https://user:password@web.push.apple.com/a', 'https://web.push.apple.com:444/a']) {
    assert.equal(validSubscription({ ...good, endpoint }), false);
    assert.equal((await request('/v1/web-subscription', 'POST', { subscription: { ...good, endpoint } }, coach.token)).status, 400);
  }
  assert.equal((await request('/v1/web-subscription', 'POST', { subscription: good }, coach.token)).status, 200);
  assert.equal((await request('/v1/web-subscription', 'DELETE', undefined, coach.token)).status, 200);
});

test('messages push only to the other coach and expired subscriptions are removed', async t => {
  const sent = [];
  const { request, pair, db } = await fixture(t, { webPush: { publicKey: 'test-key', configured: true,
    send: async (sub, message) => { sent.push({ sub, message }); return 'expired-subscription'; } } });
  const first = await pair('First base'), third = await pair('Third base');
  const sub = subscription();
  await request('/v1/web-subscription', 'POST', { subscription: sub }, third.token);
  assert.equal((await request('/v1/messages', 'GET', undefined, first.token)).data.pushReady, true);
  const id = randomUUID();
  await request('/v1/messages', 'POST', { id, text: 'Bunt' }, first.token);
  await request('/v1/messages', 'POST', { id, text: 'Bunt' }, first.token);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].sub, sub);
  assert.equal(sent[0].message.senderRole, 'First base');
  assert.equal(sent[0].message.text, 'Bunt');
  assert.equal(db.prepare('SELECT web_subscription FROM devices WHERE id=?').get(third.id).web_subscription, null);
  assert.equal((await request('/v1/messages', 'GET', undefined, first.token)).data.messages[0].pushStatus, 'failed');
});

test('wrist-alert test is scheduled for the requesting coach, not the other coach', async t => {
  const sent = [];
  const { request, pair } = await fixture(t, { pushTestDelayMs: 0, webPush: { publicKey: 'test', configured: true,
    send: async (sub, message) => { sent.push({ sub, message }); return 'accepted'; } } });
  const first = await pair('First base');
  await pair('Third base');
  assert.equal((await request('/v1/push-test', 'POST', {}, first.token)).status, 409);
  const sub = subscription();
  await request('/v1/web-subscription', 'POST', { subscription: sub }, first.token);
  assert.equal((await request('/v1/push-test', 'POST', {}, first.token)).data.status, 'scheduled');
  // A subsequent round trip also allows the zero-delay test timer to fire.
  await request('/v1/messages', 'GET', undefined, first.token);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].sub, sub);
  assert.ok(sent[0].message.text.includes('No game call'));
});

test('VAPID keys persist and Web Push uses encrypted payload, short TTL and high urgency', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-vapid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { VAPID_KEY_PATH: join(dir, 'vapid.json'), PUBLIC_ORIGIN: 'https://coach.example.com' };
  const one = createWebPush(env), two = createWebPush(env);
  assert.equal(one.publicKey, two.publicKey);
  let options, payload;
  t.mock.method(webpush, 'sendNotification', async (_sub, body, config) => { payload = JSON.parse(body); options = config; });
  const message = { id: randomUUID(), senderRole: 'Third base', text: 'Steal', expiresAt: new Date(Date.now() + 60000).toISOString() };
  assert.equal(await one.send(subscription(), message), 'accepted');
  assert.equal(payload.body, 'Steal');
  assert.equal(options.urgency, 'high');
  assert.ok(options.TTL > 0 && options.TTL <= 60);
  assert.equal(options.vapidDetails.subject, env.PUBLIC_ORIGIN);
  assert.equal(await one.send(subscription(), { ...message, expiresAt: new Date(0).toISOString() }), 'expired');
});

test('service worker displays calls, visibly labels stale pushes, and opens the app', async () => {
  const handlers = {}, notifications = [], opened = [];
  const self = { location: { origin: 'https://coach.example.com' },
    addEventListener: (name, callback) => { handlers[name] = callback; },
    registration: { showNotification: async (title, options) => { notifications.push({ title, options }); } },
    clients: { matchAll: async () => [], openWindow: async url => { opened.push(url); } } };
  vm.runInNewContext(readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8'), { self, URL, Date });
  let work;
  const run = async payload => {
    handlers.push({ data: { json: () => payload }, waitUntil: promise => { work = promise; } }); await work;
  };
  await run({ title: 'Third base', body: 'Hold', expiresAt: new Date(Date.now() + 60000).toISOString(), messageID: 'test' });
  assert.equal(notifications[0].options.body, 'Hold');
  await run({ title: 'Third base', body: 'Steal', expiresAt: new Date(0).toISOString() });
  assert.equal(notifications[1].title, 'Expired call · Coach Comms');
  assert.ok(!notifications[1].options.body.includes('Steal'));
  handlers.notificationclick({ notification: { close() {} }, waitUntil: promise => { work = promise; } });
  await work; assert.deepEqual(opened, ['/']);
});
