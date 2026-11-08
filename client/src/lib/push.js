// Web Push on the client: register the service worker and subscribe this
// device, so incoming calls ring the phone even when the app is closed.
import { api } from './api';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export function pushSupport() {
  if (!window.isSecureContext) return { ok: false, reason: 'Needs a secure (https) page.' };
  if (!('serviceWorker' in navigator)) return { ok: false, reason: 'This browser does not support background notifications.' };
  if (!('PushManager' in window) || !('Notification' in window)) {
    if (isIOS() && !isStandalone()) return { ok: false, reason: 'On iPhone: tap Share → Add to Home Screen, then open OrderVoice from the Home Screen to turn this on.', ios: true };
    return { ok: false, reason: 'This browser does not support background notifications.' };
  }
  return { ok: true };
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(null);
  return navigator.serviceWorker.register('/sw.js').catch(() => null);
}

const ready = () => Promise.race([
  navigator.serviceWorker.ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error('Service worker not ready')), 8000)),
]);

function keyToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function pushStatus() {
  const sup = pushSupport();
  if (!sup.ok) return { supported: false, reason: sup.reason, ios: sup.ios };
  try {
    const reg = await ready();
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, permission: Notification.permission, subscribed: !!sub && Notification.permission === 'granted' };
  } catch { return { supported: true, permission: Notification.permission, subscribed: false }; }
}

// Ask permission (must be called from a button tap), subscribe, and register the device with our server.
export async function enablePush() {
  const sup = pushSupport();
  if (!sup.ok) throw new Error(sup.reason);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser\'s site settings.' : 'Permission was not given.');
  const reg = await ready();
  const { publicKey } = await api.get('/push/public-key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
  await api.post('/push/subscribe', { subscription: sub.toJSON() });
  return true;
}

// After login: if this device already has permission + a subscription, link it to the logged-in user.
export async function syncPush() {
  try {
    if (!pushSupport().ok || Notification.permission !== 'granted') return;
    const reg = await ready();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api.post('/push/subscribe', { subscription: sub.toJSON() });
  } catch { /* ignore */ }
}

// On logout: stop sending this account's calls to this device.
export async function unlinkPush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
  } catch { /* ignore */ }
}

export async function sendTestPush() { return api.post('/push/test'); }

// Close the ringing notification once the call is handled inside the app.
export async function closeCallNotification(callId) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const list = (await reg?.getNotifications({ tag: `call-${callId}` })) || [];
    list.forEach((n) => n.close());
  } catch { /* ignore */ }
}