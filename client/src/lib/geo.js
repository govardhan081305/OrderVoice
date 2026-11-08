// Location helpers shared by checkout, tracking and the agent screen.
import { useEffect, useRef, useState } from 'react';
import { api, storage } from './api';

const rad = (d) => (d * Math.PI) / 180;
export function distanceM(a, b) {
  if (!a || !b) return null;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

export const fmtDistance = (m) => (m == null ? '' : m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
export const fmtEta = (s) => (s == null ? '' : s < 90 ? '1 min' : `${Math.round(s / 60)} min`);
export const DELIVERY_RADIUS_KM = 30;

// Opens turn-by-turn navigation in Google Maps (app on phones, website on laptops).
export const navigateUrl = (to) => `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}&travelmode=driving`;

// Saved delivery address: { flat, area, lat, lng }
export function loadSavedAddress() {
  const raw = storage.get('ov.address');
  if (!raw) return { flat: '', landmark: '', area: '', lat: null, lng: null };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return { flat: v.flat || '', landmark: v.landmark || '', area: v.area || '', lat: v.lat ?? null, lng: v.lng ?? null };
  } catch { /* older versions stored a plain string */ }
  return { flat: '', landmark: '', area: raw, lat: null, lng: null };
}
export const saveAddress = (a) => storage.set('ov.address', JSON.stringify(a));

const GEO_ERRORS = {
  1: 'Location permission is blocked. Allow it in your browser\'s site settings, or drop the pin on the map.',
  2: 'Your location is unavailable right now. Turn on GPS / location services, or drop the pin on the map.',
  3: 'Getting your location took too long. Try again, or drop the pin on the map.',
};

// One-shot GPS reading with a friendly error message.
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) return reject(new Error('Location needs a secure (https) page. Open the app over https, or drop the pin on the map.'));
    if (!navigator.geolocation) return reject(new Error('This browser does not support location. Drop the pin on the map instead.'));
    return navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(GEO_ERRORS[e.code] || 'Could not get your location.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 },
    );
  });
}

export async function geolocationGranted() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch { return false; }
}

const key = (p) => (p ? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}` : '');

// Road route through `points` ([from, via?, to]). Re-fetches when the first
// point (the moving delivery partner) moves more than ~60 m, at most every 10 s.
export function useRoute(points) {
  const [route, setRoute] = useState(null);
  const last = useRef({ from: null, rest: '', at: 0 });
  const valid = points.filter(Boolean);
  const from = valid[0];
  const rest = valid.slice(1).map(key).join('|');
  const ok = valid.length >= 2;

  useEffect(() => {
    if (!ok) { setRoute(null); return undefined; }
    const L = last.current;
    const moved = !L.from || distanceM(L.from, from) > 60;
    const changed = L.rest !== rest;
    if (!changed && (!moved || Date.now() - L.at < 10_000)) return undefined;
    last.current = { from, rest, at: Date.now() };
    let cancelled = false;
    const q = new URLSearchParams({ from: key(from), to: key(valid[valid.length - 1]) });
    if (valid.length === 3) q.set('via', key(valid[1]));
    api.get(`/geo/route?${q}`).then((r) => { if (!cancelled) setRoute(r); }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, key(from), rest]);

  return ok ? route : null;
}

export function useNow(intervalMs = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)} min ago`;
}