import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from './server.mjs';

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
