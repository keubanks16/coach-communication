import http from 'node:http';
import http2 from 'node:http2';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, timingSafeEqual, sign } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const secretEqual = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const validRoles = ['First base', 'Third base'];
class APIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(condition, status, message) {
  if (!condition) throw new APIError(status, message);
}

// No third-party packages. APNs authentication is ES256 with an Apple .p8 key.
export function createPush(env = process.env) {
  const configured = Boolean(env.APNS_KEY_PATH && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);
  let cachedToken, issuedAt = 0;
  async function send(deviceToken, message) {
    if (!configured || !deviceToken) return 'unconfigured';
    const now = Math.floor(Date.now() / 1000);
    if (!cachedToken || now - issuedAt > 3000) {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })).toString('base64url');
      const input = `${header}.${payload}`;
      const signature = sign('sha256', Buffer.from(input), {
        key: readFileSync(env.APNS_KEY_PATH), dsaEncoding: 'ieee-p1363'
      }).toString('base64url');
      cachedToken = `${input}.${signature}`;
      issuedAt = now;
    }
    return await new Promise((resolve, reject) => {
      const host = env.APNS_ENVIRONMENT === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
      const client = http2.connect(`https://${host}`);
      const timer = setTimeout(() => { client.destroy(); reject(new Error('APNs timeout')); }, 8000);
      const finish = (error, value) => {
        clearTimeout(timer); client.close(); error ? reject(error) : resolve(value);
      };
      client.on('error', error => finish(error));
      const request = client.request({
        ':method': 'POST', ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${cachedToken}`, 'apns-topic': env.APNS_TOPIC,
        'apns-push-type': 'alert', 'apns-priority': '10',
        // Never deliver an old coaching instruction minutes later.
        'apns-expiration': String(Math.floor(Date.parse(message.expiresAt) / 1000))
      });
      let status, body = '';
      request.on('response', headers => { status = headers[':status']; });
      request.on('data', chunk => { body += chunk; });
      request.on('error', error => finish(error));
      request.on('end', () => finish(null, status === 200 ? 'accepted' : `rejected:${status}:${body}`));
      request.end(JSON.stringify({
        aps: { alert: { title: message.senderRole, body: message.text },
          sound: 'default', category: 'COACH_CALL', 'thread-id': 'coach-calls' },
        messageID: message.id, expiresAt: message.expiresAt
      }));
    });
  }
  return { configured, send };
}

export function createRelay({ databasePath = ':memory:', pairingKey, push = createPush() } = {}) {
  requireValue(typeof pairingKey === 'string' && pairingKey.length >= 16, 500, 'PAIRING_KEY must contain at least 16 characters.');
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, role TEXT UNIQUE NOT NULL,
      push_token TEXT, seen_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
      sender_role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, received_at TEXT, acknowledged_at TEXT, push_status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient_id, created_at);`);
  const rates = new Map();
  function rate(key, max, window = 60000) {
    const now = Date.now();
    // Bounded time-based cleanup, including failed authentication attempts.
    if (rates.size > 2000) for (const [k, v] of rates) if (now - v.start > window) rates.delete(k);
    const value = rates.get(key);
    if (!value || now - value.start > window) { rates.set(key, { start: now, count: 1 }); return; }
    requireValue(++value.count <= max, 429, 'Too many requests. Try again shortly.');
  }
  function model(row) {
    return { id: row.id, senderID: row.sender_id, recipientID: row.recipient_id,
      senderRole: row.sender_role, text: row.text, createdAt: row.created_at,
      expiresAt: row.expires_at, receivedAt: row.received_at,
      acknowledgedAt: row.acknowledged_at, pushStatus: row.push_status };
  }
  async function body(req) {
    let bytes = 0, chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      requireValue(bytes <= 4096, 413, 'Request too large.'); chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw new APIError(400, 'Invalid JSON.'); }
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return reply(200, { ok: true });
      if (req.method === 'POST' && path === '/v1/pair') {
        rate(`pair:${req.socket.remoteAddress}`, 10);
        const data = await body(req);
        requireValue(typeof data.key === 'string' && secretEqual(data.key, pairingKey), 403, 'Incorrect pairing key.');
        requireValue(validRoles.includes(data.role), 400, 'Choose First base or Third base.');
        requireValue(!db.prepare('SELECT id FROM devices WHERE role=?').get(data.role), 409,
          'That coach position is already paired. Unpair the old watch first.');
        const token = randomBytes(32).toString('hex'), id = randomUUID();
        db.prepare('INSERT INTO devices(id,token_hash,role,seen_at) VALUES(?,?,?,?)')
          .run(id, digest(token), data.role, new Date().toISOString());
        return reply(201, { id, token, role: data.role });
      }
      const bearer = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const device = bearer && db.prepare('SELECT * FROM devices WHERE token_hash=?').get(digest(bearer));
      if (!device) rate(`auth:${req.socket.remoteAddress}`, 60);
      requireValue(device, 401, 'Pair this watch again.');
      rate(`device:${device.id}`, 180);
      db.prepare('UPDATE devices SET seen_at=? WHERE id=?').run(new Date().toISOString(), device.id);
      if (req.method === 'DELETE' && path === '/v1/device') {
        db.prepare('DELETE FROM devices WHERE id=?').run(device.id);
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/v1/push-token') {
        const data = await body(req);
        requireValue(typeof data.token === 'string' && /^[a-f0-9]{32,256}$/.test(data.token), 400, 'Invalid push token.');
        db.prepare('UPDATE devices SET push_token=? WHERE id=?').run(data.token, device.id);
        return reply(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/v1/messages') {
        const peer = db.prepare('SELECT role,seen_at,push_token FROM devices WHERE id<>?').get(device.id);
        const rows = db.prepare('SELECT * FROM messages WHERE sender_id=? OR recipient_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50')
          .all(device.id, device.id);
        return reply(200, { messages: rows.reverse().map(model), peerRole: peer?.role ?? null,
          peerLastSeen: peer?.seen_at ?? null, pushReady: Boolean(push.configured && peer?.push_token) });
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        rate(`send:${device.id}`, 30);
        const data = await body(req);
        requireValue(typeof data.id === 'string' && /^[a-f0-9-]{36}$/i.test(data.id), 400, 'Invalid message ID.');
        requireValue(typeof data.text === 'string' && data.text.trim().length > 0 && data.text.length <= 120,
          400, 'Messages must contain 1–120 characters.');
        const existing = db.prepare('SELECT * FROM messages WHERE id=?').get(data.id);
        if (existing) {
          requireValue(existing.sender_id === device.id, 409, 'Message ID already used.');
          return reply(200, model(existing));
        }
        const peer = db.prepare('SELECT * FROM devices WHERE id<>?').get(device.id);
        requireValue(peer, 409, 'The other coach has not paired yet.');
        const now = new Date(), expires = new Date(now.getTime() + 60000);
        db.prepare(`INSERT INTO messages(id,sender_id,recipient_id,sender_role,text,created_at,expires_at,push_status)
          VALUES(?,?,?,?,?,?,?,?)`).run(data.id, device.id, peer.id, device.role, data.text.trim(),
            now.toISOString(), expires.toISOString(), 'pending');
        const row = db.prepare('SELECT * FROM messages WHERE id=?').get(data.id);
        // Persist before notifying; a push failure never loses the message.
        Promise.resolve().then(() => push.send(peer.push_token, model(row))).then(status => {
          db.prepare('UPDATE messages SET push_status=? WHERE id=?').run(status, data.id);
        }).catch(() => {
          db.prepare('UPDATE messages SET push_status=? WHERE id=?').run('failed', data.id);
        });
        // Remove old calls, retaining a rolling 24-hour history.
        db.prepare('DELETE FROM messages WHERE created_at<?').run(new Date(Date.now() - 86400000).toISOString());
        return reply(201, model(row));
      }
      const action = path.match(/^\/v1\/messages\/([a-f0-9-]{36})\/(received|ack)$/i);
      if (req.method === 'POST' && action) {
        const row = db.prepare('SELECT * FROM messages WHERE id=? AND recipient_id=?').get(action[1], device.id);
        requireValue(row, 404, 'Message not found.');
        requireValue(Date.parse(row.expires_at) > Date.now(), 410, 'This call has expired.');
        const column = action[2] === 'ack' ? 'acknowledged_at' : 'received_at';
        db.prepare(`UPDATE messages SET ${column}=COALESCE(${column},?) WHERE id=?`).run(new Date().toISOString(), row.id);
        return reply(200, { ok: true });
      }
      throw new APIError(404, 'Route not found.');
    } catch (error) {
      reply(error.status ?? 500, { error: error.status ? error.message : 'Relay error.' });
      if (!error.status) console.error('Relay request failed:', error.message);
    }
  });
  server.requestTimeout = 15000;
  return { server, db };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createRelay({ databasePath: process.env.DATABASE_PATH ?? 'data/coach.sqlite',
    pairingKey: process.env.PAIRING_KEY });
  server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Coach relay listening on ${server.address().port}; use an HTTPS reverse proxy.`);
  });
}
