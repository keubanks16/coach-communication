import webpush from 'web-push';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function validSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2048) return false;
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { return false; }
  // Browser-supplied URLs are never allowed to target arbitrary hosts or internal services.
  const approved = endpoint.hostname === 'web.push.apple.com' || endpoint.hostname === 'fcm.googleapis.com'
    || endpoint.hostname === 'updates.push.services.mozilla.com' || endpoint.hostname === 'push.services.mozilla.com';
  if (!approved || endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password) return false;
  const { p256dh, auth } = subscription.keys ?? {};
  return typeof p256dh === 'string' && /^[A-Za-z0-9_-]{86,88}={0,2}$/.test(p256dh)
    && typeof auth === 'string' && /^[A-Za-z0-9_-]{22,24}={0,2}$/.test(auth)
    && Buffer.from(p256dh, 'base64url').length === 65 && Buffer.from(auth, 'base64url').length === 16;
}

export function createWebPush(env = process.env) {
  let keys;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } else {
    const path = env.VAPID_KEY_PATH ?? 'data/vapid.json';
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) keys = JSON.parse(readFileSync(path, 'utf8'));
    else {
      keys = webpush.generateVAPIDKeys();
      writeFileSync(path, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
    }
  }
  const subject = env.VAPID_SUBJECT ?? env.PUBLIC_ORIGIN ?? 'https://example.com/coach-communication';
  async function send(subscription, message) {
    if (!validSubscription(subscription)) return 'unconfigured';
    const ttl = Math.max(0, Math.min(60, Math.floor((Date.parse(message.expiresAt) - Date.now()) / 1000)));
    if (!ttl) return 'expired';
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: message.senderRole, body: message.text, messageID: message.id,
        expiresAt: message.expiresAt, url: '/'
      }), {
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: ttl, urgency: 'high', timeout: 8000
      });
      return 'accepted';
    } catch (error) {
      return error.statusCode === 404 || error.statusCode === 410 ? 'expired-subscription' : 'failed';
    }
  }
  return { publicKey: keys.publicKey, configured: true, send };
}
