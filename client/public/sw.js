/* OrderVoice service worker.
 * Runs in the background even when the app is closed. When the server sends a
 * Web Push for an incoming call, it shows a ringing notification (sound +
 * vibration, Answer / Decline). Tapping Answer opens the app and connects.
 */
const ICON = '/icon-192.png';
const BADGE = '/badge-96.png';
// Long vibration pattern ~ a phone ringing (Android).
const RING = [700, 300, 700, 300, 700, 300, 700, 300, 700, 300, 700];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { type: 'info', title: 'OrderVoice', body: event.data && event.data.text() }; }
  event.waitUntil(handlePush(d));
});

async function closeTag(tag) {
  const list = await self.registration.getNotifications({ tag });
  list.forEach((n) => n.close());
}

async function handlePush(d) {
  if (d.type === 'call') {
    const who = (d.from && d.from.name) || 'Someone';
    const role = d.from && d.from.role === 'agent' ? 'Your delivery partner' : 'Your customer';
    return self.registration.showNotification(`${who} is calling`, {
      body: `${role} · OrderVoice call · Order ${d.orderId}${d.restaurant ? ` (${d.restaurant})` : ''}`,
      tag: `call-${d.callId}`,
      renotify: true,
      requireInteraction: true, // stays until answered / declined / call ends
      vibrate: RING,
      icon: ICON,
      badge: BADGE,
      timestamp: Date.now(),
      actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
      data: d,
    });
  }
  if (d.type === 'call-ended') {
    await closeTag(`call-${d.callId}`);
    if (!d.missed) return undefined;
    return self.registration.showNotification(`Missed call from ${(d.from && d.from.name) || 'OrderVoice'}`, {
      body: `Order ${d.orderId} · tap to open and call back`,
      tag: `missed-${d.callId}`, icon: ICON, badge: BADGE, data: { url: d.url || '/' },
    });
  }
  return self.registration.showNotification(d.title || 'OrderVoice', {
    body: d.body || '', tag: d.tag || undefined, icon: ICON, badge: BADGE, data: { url: d.url || '/' },
  });
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();
  if (d.type === 'call' && event.action === 'decline') {
    event.waitUntil(fetch('/api/push/call-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: d.callId, userId: d.userId, action: 'decline', token: d.token }),
    }).catch(() => {}));
    return;
  }
  // Answer button -> open and answer. Tapping the notification itself -> open the ringing screen.
  const url = d.type === 'call' ? (event.action === 'answer' ? d.url : d.url.replace(/answer=/, 'ring=')) : (d.url || '/');
  event.waitUntil(openApp(url, d.type === 'call' && event.action === 'answer' ? d.callId : null));
});

async function openApp(url, answerCallId) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
  if (win) {
    await win.focus();
    win.postMessage({ type: 'ov-open', url, answer: answerCallId });
    return win;
  }
  return self.clients.openWindow(url);
}