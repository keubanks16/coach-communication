import webpush from 'web-push';
import { Buffer } from 'node:buffer';

export function validSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2048) return false;
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { return false; }
  const approved = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com'].includes(endpoint.hostname);
  if (!approved || endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password) return false;
  const { p256dh, auth } = subscription.keys ?? {};
  return typeof p256dh === 'string' && /^[A-Za-z0-9_-]{86,88}={0,2}$/.test(p256dh)
    && typeof auth === 'string' && /^[A-Za-z0-9_-]{22,24}={0,2}$/.test(auth)
    && Buffer.from(p256dh, 'base64url').length === 65 && Buffer.from(p256dh, 'base64url')[0] === 4
    && Buffer.from(auth, 'base64url').length === 16;
}

export async function getPushKeys(db) {
  let row = await db.prepare("SELECT value FROM app_settings WHERE key='vapid'").first();
  if (!row) {
    const keys = webpush.generateVAPIDKeys();
    // Concurrent first launches share whichever key pair is committed first.
    await db.prepare("INSERT INTO app_settings(key,value) VALUES('vapid',?) ON CONFLICT(key) DO NOTHING")
      .bind(JSON.stringify(keys)).run();
    row = await db.prepare("SELECT value FROM app_settings WHERE key='vapid'").first();
  }
  return JSON.parse(row.value);
}

export async function sendPush(db, subscription, message, subject, fetcher = fetch) {
  if (!validSubscription(subscription)) return 'unconfigured';
  const ttl = Math.max(0, Math.min(60, Math.floor((Date.parse(message.expiresAt) - Date.now()) / 1000)));
  if (!ttl) return 'expired';
  let stage = 'keys';
  try {
    const keys = await getPushKeys(db);
    // Build RFC8291-encrypted Web Push using the maintained library, then use
    // Workers fetch instead of Node's socket-based sendNotification transport.
    stage = 'encryption';
    const details = webpush.generateRequestDetails(subscription, JSON.stringify({
      title: message.senderRole, body: message.text, messageID: message.id,
      expiresAt: message.expiresAt, url: '/'
    }), { vapidDetails: { subject, ...keys }, TTL: ttl, urgency: 'high' });
    stage = 'transport';
    const response = await fetcher(details.endpoint, {
      method: details.method, headers: details.headers, body: new Uint8Array(details.body),
      // Workers supports manual/follow, not redirect:error. A 3xx response is
      // treated as failure below; no subscription can redirect to another host.
      redirect: 'manual', signal: AbortSignal.timeout(8000)
    });
    if (response.status === 404 || response.status === 410) return 'expired-subscription';
    return response.ok ? 'accepted' : 'failed';
  } catch (error) {
    console.error('Web Push failed:', stage, error.name);
    return 'failed';
  }
}
