import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getPushKeys, validSubscription, sendPush } from './push.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const roles = ['First base', 'Third base'];
class APIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(condition, status, message) {
  if (!condition) throw new APIError(status, message);
}
function json(data, status = 200) {
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  } });
}
async function body(request) {
  requireValue(Number(request.headers.get('Content-Length') ?? 0) <= 4096, 413, 'Request too large.');
  const reader = request.body?.getReader();
  requireValue(reader, 400, 'JSON body is required.');
  const chunks = []; let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > 4096) { await reader.cancel(); throw new APIError(413, 'Request too large.'); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const result = JSON.parse(new TextDecoder().decode(bytes));
    requireValue(result && typeof result === 'object' && !Array.isArray(result), 400, 'JSON object required.');
    return result;
  } catch { throw new APIError(400, 'Invalid JSON.'); }
}
async function rate(db, key, max) {
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO rate_limits(key,count,window_start) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,
      window_start=CASE WHEN window_start<=? THEN ? ELSE window_start END RETURNING count`)
    .bind(key, now, now - 60000, now - 60000, now).first();
  requireValue(row.count <= max, 429, 'Too many requests. Try again shortly.');
}
function model(row) {
  return { id: row.id, senderID: row.sender_id, recipientID: row.recipient_id,
    senderRole: row.sender_role, text: row.text, createdAt: row.created_at,
    expiresAt: row.expires_at, receivedAt: row.received_at,
    acknowledgedAt: row.acknowledged_at, pushStatus: row.push_status };
}

export function createWorker({ fetchPush = fetch, pushTestDelayMs = 8000 } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url), path = url.pathname;
      try {
        if (request.method === 'GET' && path === '/health') {
          return json({ ok: true, ready: Boolean(env.DB && env.PAIRING_KEY?.length >= 16) });
        }
        if (!path.startsWith('/v1/')) return env.ASSETS.fetch(request);
        requireValue(env.DB, 503, 'Bind the D1 database as DB in Cloudflare.');
        requireValue(typeof env.PAIRING_KEY === 'string' && env.PAIRING_KEY.length >= 16, 503,
          'Set PAIRING_KEY in Cloudflare Variables & Secrets using at least 16 characters.');
        const db = env.DB;
        const subject = env.VAPID_SUBJECT || url.origin;
        if (request.method === 'GET' && path === '/v1/config') {
          const keys = await getPushKeys(db);
          return json({ publicKey: keys.publicKey });
        }
        if (request.method === 'POST' && path === '/v1/pair') {
          await rate(db, 'pair:' + (request.headers.get('CF-Connecting-IP') ?? 'local'), 10);
          const data = await body(request);
          requireValue(typeof data.key === 'string' && timingSafeEqual(
            createHash('sha256').update(data.key).digest(), createHash('sha256').update(env.PAIRING_KEY).digest()),
            403, 'Incorrect pairing key.');
          requireValue(roles.includes(data.role), 400, 'Choose First base or Third base.');
          const token = randomBytes(32).toString('hex'), id = randomUUID();
          try {
            await db.prepare('INSERT INTO devices(id,token_hash,role,seen_at) VALUES(?,?,?,?)')
              .bind(id, digest(token), data.role, new Date().toISOString()).run();
          } catch (error) {
            const occupied = await db.prepare('SELECT id FROM devices WHERE role=?').bind(data.role).first();
            if (occupied) throw new APIError(409, 'That coach position is already paired. Unpair the old device first.');
            throw error;
          }
          return json({ id, token, role: data.role }, 201);
        }
        const bearer = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        const device = bearer ? await db.prepare('SELECT * FROM devices WHERE token_hash=?').bind(digest(bearer)).first() : null;
        if (!device) await rate(db, 'auth:' + (request.headers.get('CF-Connecting-IP') ?? 'local'), 60);
        requireValue(device, 401, 'Pair this device again.');
        // Avoid a D1 write for every two-second poll; only update presence every ten seconds.
        if (Date.now() - Date.parse(device.seen_at) >= 10000) {
          await db.prepare('UPDATE devices SET seen_at=? WHERE id=? AND seen_at<?')
            .bind(new Date().toISOString(), device.id, new Date(Date.now() - 10000).toISOString()).run();
        }
        if (request.method === 'DELETE' && path === '/v1/device') {
          await db.prepare('DELETE FROM devices WHERE id=?').bind(device.id).run();
          return json({ ok: true });
        }
        if (request.method === 'POST' && path === '/v1/web-subscription') {
          const data = await body(request);
          requireValue(validSubscription(data.subscription), 400, 'Invalid browser push subscription.');
          await db.prepare('UPDATE devices SET web_subscription=? WHERE id=?')
            .bind(JSON.stringify(data.subscription), device.id).run();
          return json({ ok: true });
        }
        if (request.method === 'DELETE' && path === '/v1/web-subscription') {
          await db.prepare('UPDATE devices SET web_subscription=NULL WHERE id=?').bind(device.id).run();
          return json({ ok: true });
        }
        if (request.method === 'POST' && path === '/v1/push-test') {
          await rate(db, 'push-test:' + device.id, 5);
          requireValue(device.web_subscription, 409, 'Enable notifications on this device first.');
          ctx.waitUntil((async () => {
            await new Promise(resolve => setTimeout(resolve, pushTestDelayMs));
            const current = await db.prepare('SELECT web_subscription FROM devices WHERE id=?').bind(device.id).first();
            if (current?.web_subscription !== device.web_subscription) return;
            const status = await sendPush(db, JSON.parse(device.web_subscription), {
              id: randomUUID(), senderRole: 'Coach Comms · Test', text: 'Wrist alert test. No game call was sent.',
              expiresAt: new Date(Date.now() + 60000).toISOString()
            }, subject, fetchPush);
            if (status === 'expired-subscription') {
              await db.prepare('UPDATE devices SET web_subscription=NULL WHERE id=? AND web_subscription=?')
                .bind(device.id, device.web_subscription).run();
            }
            if (status !== 'accepted') console.error('Wrist-alert test failed:', status);
          })().catch(() => console.error('Wrist-alert test failed.')));
          return json({ status: 'scheduled', delaySeconds: pushTestDelayMs / 1000 });
        }
        if (request.method === 'GET' && path === '/v1/messages') {
          const peer = await db.prepare('SELECT role,seen_at,web_subscription FROM devices WHERE id<>?').bind(device.id).first();
          const rows = await db.prepare(`SELECT * FROM messages WHERE sender_id=? OR recipient_id=?
            ORDER BY created_at DESC,rowid DESC LIMIT 50`).bind(device.id, device.id).all();
          return json({ messages: rows.results.reverse().map(model), peerRole: peer?.role ?? null,
            peerLastSeen: peer?.seen_at ?? null, notificationsReady: Boolean(device.web_subscription),
            pushReady: Boolean(peer?.web_subscription) });
        }
        if (request.method === 'POST' && path === '/v1/messages') {
          await rate(db, 'send:' + device.id, 30);
          const data = await body(request);
          requireValue(typeof data.id === 'string' && /^[a-f0-9-]{36}$/i.test(data.id), 400, 'Invalid message ID.');
          requireValue(typeof data.text === 'string' && data.text.trim() && data.text.length <= 120,
            400, 'Messages must contain 1–120 characters.');
          const existing = await db.prepare('SELECT * FROM messages WHERE id=?').bind(data.id).first();
          if (existing) {
            requireValue(existing.sender_id === device.id, 409, 'Message ID already used.');
            return json(model(existing));
          }
          const peer = await db.prepare('SELECT * FROM devices WHERE id<>?').bind(device.id).first();
          requireValue(peer, 409, 'The other coach has not paired yet.');
          const now = new Date(), expires = new Date(now.getTime() + 60000);
          const result = await db.prepare(`INSERT INTO messages(id,sender_id,recipient_id,sender_role,text,created_at,expires_at,push_status)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
            .bind(data.id, device.id, peer.id, device.role, data.text.trim(), now.toISOString(), expires.toISOString(), 'pending').run();
          const row = await db.prepare('SELECT * FROM messages WHERE id=?').bind(data.id).first();
          requireValue(row.sender_id === device.id, 409, 'Message ID already used.');
          if (result.meta.changes === 1) {
            ctx.waitUntil((async () => {
              const current = await db.prepare('SELECT web_subscription FROM devices WHERE id=?').bind(peer.id).first();
              let status = 'unconfigured';
              if (peer.web_subscription && current?.web_subscription === peer.web_subscription) {
                status = await sendPush(db, JSON.parse(peer.web_subscription), model(row), subject, fetchPush);
                if (status === 'expired-subscription') {
                  await db.prepare('UPDATE devices SET web_subscription=NULL WHERE id=? AND web_subscription=?')
                    .bind(peer.id, peer.web_subscription).run();
                }
              }
              await db.prepare('UPDATE messages SET push_status=? WHERE id=?')
                .bind(status === 'expired-subscription' ? 'failed' : status, data.id).run();
              await db.batch([
                db.prepare('DELETE FROM messages WHERE created_at<?').bind(new Date(Date.now() - 86400000).toISOString()),
                db.prepare('DELETE FROM rate_limits WHERE window_start<?').bind(Date.now() - 86400000)
              ]);
            })().catch(() => console.error('Call push processing failed.')));
          }
          return json(model(row), result.meta.changes === 1 ? 201 : 200);
        }
        const action = path.match(/^\/v1\/messages\/([a-f0-9-]{36})\/(received|ack)$/i);
        if (request.method === 'POST' && action) {
          const row = await db.prepare('SELECT * FROM messages WHERE id=? AND recipient_id=?').bind(action[1], device.id).first();
          requireValue(row, 404, 'Message not found.');
          requireValue(Date.parse(row.expires_at) > Date.now(), 410, 'This call has expired.');
          const now = new Date().toISOString();
          const sql = action[2] === 'ack'
            ? 'UPDATE messages SET received_at=COALESCE(received_at,?),acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=? AND expires_at>?'
            : 'UPDATE messages SET received_at=COALESCE(received_at,?) WHERE id=? AND expires_at>?';
          const result = await db.prepare(sql).bind(...(action[2] === 'ack' ? [now, now, row.id, now] : [now, row.id, now])).run();
          requireValue(result.meta.changes > 0, 410, 'This call has expired.');
          return json({ ok: true });
        }
        if (path === '/v1/push-token') throw new APIError(409, 'This Cloudflare backend supports Home Screen Web Push. Use the Node relay for native watch APNs.');
        throw new APIError(404, 'Route not found.');
      } catch (error) {
        if (!error.status) console.error('Coach API failed:', error.message);
        return json({ error: error.status ? error.message : 'Relay error. Check the D1 binding and migrations.' }, error.status ?? 500);
      }
    }
  };
}
export default createWorker();
