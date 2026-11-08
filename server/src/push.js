// Web Push: notifications that reach a phone even when the OrderVoice app is
// closed (the browser's push service wakes our service worker). Used to ring
// the callee for incoming calls and for order updates.
//
// VAPID keys identify this server to the push services. Set VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY in .env, or they are generated once and saved next to the
// database (data/vapid.json) so existing subscriptions keep working.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const config = require('./config');

function loadVapidKeys() {
  if (config.push.publicKey && config.push.privateKey) return { publicKey: config.push.publicKey, privateKey: config.push.privateKey };
  const file = config.sqlitePath && config.sqlitePath !== ':memory:' ? path.join(path.dirname(config.sqlitePath), 'vapid.json') : null;
  if (file && fs.existsSync(file)) {
    try { const k = JSON.parse(fs.readFileSync(file, 'utf8')); if (k.publicKey && k.privateKey) return k; } catch { /* regenerate */ }
  }
  const keys = webpush.generateVAPIDKeys();
  if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(keys, null, 2)); }
  return keys;
}

function createPush(ctx, { sendImpl, keys } = {}) {
  const { db } = ctx;
  const vapid = keys || loadVapidKeys();
  webpush.setVapidDetails(config.push.subject, vapid.publicKey, vapid.privateKey);

  // How a single push is delivered. Default: real Web Push (encrypted, VAPID-signed).
  // PUSH_SINK_URL (tests only) posts the payload to a local URL instead.
  const deliver = sendImpl || (config.push.sinkUrl
    ? async (sub, payload) => {
      const r = await fetch(config.push.sinkUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, payload: JSON.parse(payload) }) });
      return { statusCode: r.status };
    }
    : (sub, payload, opts) => webpush.sendNotification(sub, payload, opts));

  // Short-lived signed token so the service worker (which has no login token)
  // can decline a call from the notification's "Decline" button.
  const sign = (data) => crypto.createHmac('sha256', config.jwtSecret).update(`push:${data}`).digest('base64url').slice(0, 32);
  function actionToken(callId, userId, ttlSec = 120) {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `${exp}.${sign(`${callId}:${userId}:${exp}`)}`;
  }
  function verifyActionToken(token, callId, userId) {
    const [exp, sig] = String(token || '').split('.');
    if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
    const a = Buffer.from(sign(`${callId}:${userId}:${exp}`));
    const b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function subscribe(userId, sub, userAgent = '') {
    if (!sub?.endpoint || !/^https?:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid subscription');
    const now = Date.now();
    const existing = await db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
    if (existing) {
      await db.run('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?, last_seen_at = ? WHERE id = ?',
        [userId, sub.keys.p256dh, sub.keys.auth, String(userAgent).slice(0, 200), now, existing.id]);
    } else {
      await db.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
        [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(userAgent).slice(0, 200), now, now]);
    }
  }

  async function unsubscribe(endpoint, userId) {
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [String(endpoint || ''), userId]);
  }

  async function count(userId) {
    return Number((await db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [userId])).n);
  }

  // Send to every device of a user. Dead subscriptions (404/410) are removed.
  async function send(userId, payload, { ttl = 60, urgency = 'normal', topic } = {}) {
    const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
    const body = JSON.stringify(payload);
    let delivered = 0;
    await Promise.all(subs.map(async (s) => {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await deliver(sub, body, { TTL: ttl, urgency, ...(topic ? { topic } : {}) });
        delivered += 1;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await db.run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
        else console.error('[push] send failed:', e.statusCode || '', e.message);
      }
    }));
    return delivered;
  }

  return { publicKey: vapid.publicKey, subscribe, unsubscribe, count, send, actionToken, verifyActionToken };
}

module.exports = { createPush, loadVapidKeys };