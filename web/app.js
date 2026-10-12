'use strict';
const $ = id => document.getElementById(id);
const defaults = ['Steal', 'Hold', 'Send him', 'Bunt', 'Hit & run', 'Time out'];
function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
let credentials = stored('coachCredentials', null);
if (!credentials?.token || !credentials?.id || !credentials?.role) credentials = null;
let presets = stored('coachPresets', defaults);
if (!Array.isArray(presets) || !presets.length || presets.some(call => typeof call !== 'string')) presets = defaults;
let messages = [], incomingID, busy = false, failed, pollTimer, refreshing = false, feed;
let initialFeed = true;
const acknowledgedReceipts = new Set();
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isiOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const supportsPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const serviceWorker = 'serviceWorker' in navigator && window.isSecureContext
  ? navigator.serviceWorker.register('/sw.js').catch(() => null) : Promise.resolve(null);

function notice(text = '', error = false) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
  $('notice').classList.toggle('error', error);
}
function persist(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('.call, #custom-form button, #ack, #retry, #unpair, #pair-submit').forEach(button => { button.disabled = value; });
}
async function api(path, method = 'GET', body, authenticated = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      method, cache: 'no-store', signal: controller.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(authenticated && credentials ? { Authorization: `Bearer ${credentials.token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || 'Request failed.'); error.status = response.status; throw error;
    }
    return data;
  } finally { clearTimeout(timeout); }
}
function switchTab(tab) {
  for (const name of ['calls', 'history', 'setup']) $(name + '-tab').hidden = name !== tab;
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('selected', button.dataset.tab === tab));
  if (tab === 'setup') notificationStatus();
}
function renderCalls() {
  $('call-grid').replaceChildren();
  presets.slice(0, 12).forEach((text, index) => {
    const button = document.createElement('button'); button.className = 'call'; button.type = 'button';
    const number = document.createElement('span'); number.className = 'call-num'; number.textContent = String(index + 1).padStart(2, '0') + ' / SEND';
    const label = document.createElement('span'); label.textContent = text;
    button.append(number, label); button.disabled = busy;
    button.addEventListener('click', () => send(text)); $('call-grid').append(button);
  });
  $('preset-editor').value = presets.join('\n');
}
function showScreens() {
  $('pair-screen').hidden = Boolean(credentials);
  $('game-screen').hidden = !credentials;
  if (credentials) $('your-role').textContent = credentials.role;
  renderCalls(); renderMessages();
  if (credentials) schedulePoll(0);
}
function status(message) {
  if (message.acknowledgedAt) return 'Got it ✓';
  if (Date.parse(message.expiresAt) <= Date.now()) return 'Expired';
  if (message.receivedAt) return 'Received · waiting for Got it';
  if (message.pushStatus === 'failed') return 'Sent · push failed; waiting for receipt';
  if (message.pushStatus === 'unconfigured') return 'Sent · recipient needs the app open';
  return 'Sent · waiting for receipt';
}
function renderMessages() {
  // A newer acknowledged instruction must not reveal an older unacknowledged one.
  const latest = messages.filter(message => message.recipientID === credentials?.id).at(-1);
  const incoming = latest && !latest.acknowledgedAt && Date.parse(latest.expiresAt) > Date.now() ? latest : null;
  incomingID = incoming?.id;
  $('incoming').hidden = !incoming;
  if (incoming) {
    $('incoming-from').textContent = incoming.senderRole.toUpperCase() + ' SAYS';
    $('incoming-text').textContent = incoming.text;
    $('incoming-time').textContent = Math.ceil((Date.parse(incoming.expiresAt) - Date.now()) / 1000) + 's remaining';
  }
  const sent = messages.filter(message => message.senderID === credentials?.id).at(-1);
  $('last-sent').hidden = !sent;
  if (sent) { $('sent-text').textContent = sent.text; $('sent-status').textContent = status(sent); }
  const history = $('history-list'); history.replaceChildren();
  if (!messages.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Your calls will appear here.'; history.append(empty); }
  [...messages].reverse().forEach(message => {
    const card = document.createElement('div'); card.className = 'history-item';
    const meta = document.createElement('div'); meta.className = 'meta';
    const sender = document.createElement('span'); sender.textContent = message.senderID === credentials?.id ? 'You · ' + message.senderRole : message.senderRole;
    const time = document.createElement('time'); time.dateTime = message.createdAt;
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    meta.append(sender, time);
    const text = document.createElement('strong'); text.textContent = message.text;
    const state = document.createElement('span'); state.className = 'state'; state.textContent = status(message);
    card.append(meta, text, state); history.append(card);
  });
}
function schedulePoll(delay = 2000) {
  clearTimeout(pollTimer);
  if (credentials && !document.hidden) pollTimer = setTimeout(refresh, delay);
}
async function refresh() {
  if (!credentials || document.hidden || refreshing) { schedulePoll(); return; }
  refreshing = true;
  const deviceID = credentials.id;
  try {
    const result = await api('/v1/messages');
    if (credentials?.id !== deviceID) return;
    feed = result; messages = result.messages;
    const online = result.peerLastSeen && Date.now() - Date.parse(result.peerLastSeen) < 20000;
    $('connection').textContent = !result.peerRole ? 'Waiting for other coach' : online ? 'Both coaches online' : 'Other coach inactive';
    $('connection-dot').classList.toggle('online', Boolean(online));
    renderMessages();
    for (const message of messages) {
      if (message.recipientID === deviceID && !message.receivedAt && Date.parse(message.expiresAt) > Date.now() && !acknowledgedReceipts.has(message.id)) {
        try {
          await api('/v1/messages/' + message.id + '/received', 'POST', {});
          acknowledgedReceipts.add(message.id);
        } catch (error) { if (error.status !== 410) throw error; }
      }
    }
    if (initialFeed) { initialFeed = false; await syncSubscription(); }
    notificationStatus();
  } catch (error) {
    $('connection').textContent = navigator.onLine ? 'Connection lost · retrying' : 'Offline · calls paused';
    $('connection-dot').classList.remove('online');
    if (error.status === 401) notice('This pairing is no longer valid. Use Setup → Unpair, then pair again.', true);
  } finally { refreshing = false; schedulePoll(); }
}
async function send(text, retry = false) {
  if (busy || !credentials) return;
  if (!navigator.onLine) { notice('You are offline. Reconnect before sending a call.', true); return; }
  if (!text.trim() || text.length > 120) { notice('Use 1–120 characters.', true); return; }
  setBusy(true); notice();
  const call = retry && failed ? failed : { id: crypto.randomUUID(), text: text.trim() };
  try {
    const message = await api('/v1/messages', 'POST', call);
    if (!messages.some(item => item.id === message.id)) messages.push(message);
    failed = null; $('retry').hidden = true; $('custom-text').value = '';
    renderMessages(); await refresh();
  } catch (error) {
    failed = call; $('retry').hidden = false;
    notice('Send not confirmed. ' + error.message + ' Use Retry to avoid a duplicate.', true);
  } finally { setBusy(false); }
}
async function syncSubscription() {
  try {
    const registration = await serviceWorker;
    if (!registration || !credentials) return;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription && Notification.permission === 'granted') {
      await api('/v1/web-subscription', 'POST', { subscription: subscription.toJSON() });
    }
  } catch { /* Enable notifications provides an explicit recoverable setup flow. */ }
}
function notificationStatus() {
  let text;
  if (isiOS() && !standalone()) text = 'First add this page to your Home Screen, then open it from that icon.';
  else if (!supportsPush()) text = 'Push notifications need a supported browser and HTTPS.';
  else if (Notification.permission === 'denied') text = 'Notifications are blocked. Enable them in your iPhone notification settings.';
  else text = feed?.notificationsReady ? 'Push alerts registered on this phone. Run a wrist-alert test.' : 'Tap Enable notifications to set up this phone.';
  if (feed?.peerRole && !feed.pushReady) text += ' The other coach has not set up background alerts yet.';
  $('notification-status').textContent = text;
}
function bytes(base64) {
  const value = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(value, character => character.charCodeAt(0));
}
async function enableNotifications() {
  if (isiOS() && !standalone()) { notice('In Safari, tap Share → Add to Home Screen. Open the new icon, then enable notifications.', true); return; }
  if (!supportsPush()) { notice('Use the installed Home Screen app over HTTPS to enable notifications.', true); return; }
  // Request immediately in the click gesture, before network or registration awaits.
  const permissionPromise = Notification.requestPermission();
  $('enable-notifications').disabled = true;
  try {
    if (await permissionPromise !== 'granted') throw new Error('Notification permission was not granted.');
    const registration = await serviceWorker;
    if (!registration) throw new Error('The notification service could not start. Reload and try again.');
    await navigator.serviceWorker.ready;
    const config = await api('/v1/config', 'GET', undefined, false);
    if (!config.publicKey) throw new Error('The server has not configured Web Push.');
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && subscription.options.applicationServerKey &&
      btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== config.publicKey) {
      await subscription.unsubscribe(); subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(config.publicKey) });
    await api('/v1/web-subscription', 'POST', { subscription: subscription.toJSON() });
    await refresh();
    notice('Notifications enabled. Lock your iPhone and use the wrist-alert test to check your watch.');
  } catch (error) { notice(error.message, true); }
  finally { $('enable-notifications').disabled = false; notificationStatus(); }
}

$('pair-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; setBusy(true); notice();
  let paired;
  try {
    const role = document.querySelector('input[name="role"]:checked').value;
    paired = await api('/v1/pair', 'POST', { key: $('pair-key').value, role }, false);
    credentials = paired;
    try { persist('coachCredentials', paired); }
    catch {
      await api('/v1/device', 'DELETE'); credentials = null;
      throw new Error('Storage is unavailable. Allow site storage, then pair again.');
    }
    $('pair-key').value = ''; initialFeed = true; showScreens(); switchTab('setup');
    notice('Phone paired. Enable notifications to receive calls on your watch.');
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});
$('custom-form').addEventListener('submit', event => { event.preventDefault(); send($('custom-text').value); });
$('retry').addEventListener('click', () => { if (failed) send(failed.text, true); });
$('ack').addEventListener('click', async () => {
  if (!incomingID || busy) return;
  setBusy(true); notice();
  try {
    const id = incomingID;
    await api('/v1/messages/' + id + '/ack', 'POST', {});
    const registration = await serviceWorker;
    if (registration?.getNotifications) {
      const notifications = await registration.getNotifications();
      notifications.filter(item => item.data?.messageID === id).forEach(item => item.close());
    }
    await refresh();
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('enable-notifications').addEventListener('click', enableNotifications);
$('test-notification').addEventListener('click', async () => {
  $('test-notification').disabled = true; notice();
  try {
    const result = await api('/v1/push-test', 'POST', {});
    notice(result.status === 'scheduled'
      ? 'Lock your iPhone now. A wrist-alert test is scheduled in ' + result.delaySeconds + ' seconds. Delivery is not yet confirmed.'
      : 'Test could not be scheduled. Enable notifications again and check server setup.', result.status !== 'scheduled');
  } catch (error) { notice(error.message, true); }
  finally { $('test-notification').disabled = false; }
});
$('disable-notifications').addEventListener('click', async () => {
  try {
    await api('/v1/web-subscription', 'DELETE');
    const registration = await serviceWorker;
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    notice('Push alerts turned off on this phone.'); await refresh();
  } catch (error) { notice(error.message, true); }
});
$('save-presets').addEventListener('click', () => {
  const calls = $('preset-editor').value.split('\n').map(text => text.trim()).filter(Boolean);
  if (!calls.length || calls.length > 12 || calls.some(call => call.length > 120)) {
    notice('Use 1–12 calls, up to 120 characters each.', true); return;
  }
  try { persist('coachPresets', calls); presets = calls; renderCalls(); notice('Quick calls saved on this phone.'); }
  catch { notice('Could not save. Check your browser storage settings.', true); }
});
$('unpair').addEventListener('click', async () => {
  if (busy || !confirm('Unpair this phone and free this coach position?')) return;
  setBusy(true);
  try {
    try { await api('/v1/device', 'DELETE'); } catch (error) { if (error.status !== 401) throw error; }
    const registration = await serviceWorker;
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe().catch(() => {});
    credentials = null; localStorage.removeItem('coachCredentials'); clearTimeout(pollTimer);
    messages = []; feed = null; failed = null; $('retry').hidden = true; acknowledgedReceipts.clear();
    showScreens(); notice('Phone unpaired.');
  } catch (error) { notice('Could not unpair. ' + error.message, true); }
  finally { setBusy(false); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(pollTimer);
  else { renderMessages(); schedulePoll(0); }
});
window.addEventListener('online', () => schedulePoll(0));
window.addEventListener('offline', () => { $('connection').textContent = 'Offline · calls paused'; $('connection-dot').classList.remove('online'); });
setInterval(() => { if (!document.hidden) renderMessages(); }, 1000);
showScreens(); notificationStatus();
