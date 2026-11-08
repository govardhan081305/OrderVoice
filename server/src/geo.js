// Location services, all free and keyless:
//   - Reverse geocoding (GPS -> address) and address search: Nominatim (OpenStreetMap)
//   - Road routes with distance + travel time: OSRM
// Requests go through our server so we can send an identifying User-Agent,
// respect Nominatim's 1-request-per-second policy, and cache results.
// If a service is unreachable, routes fall back to a straight line with an
// estimated time, so maps still work.
const config = require('./config');
const { toSteps } = require('./nav');

const R = 6371e3;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

function lru(max) {
  const m = new Map();
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
    set(k, v) { m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); },
  };
}

// Turn Nominatim's address parts into "12, 5th Main Road, HSR Layout, Bengaluru 560102".
function formatAddress(a = {}, fallback = '') {
  const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(', ');
  const area = a.neighbourhood || a.suburb || a.quarter || a.residential || a.hamlet || a.village;
  const city = a.city || a.town || a.city_district || a.county || a.state_district;
  const parts = [street, area, city && a.postcode ? `${city} ${a.postcode}` : city || a.postcode].filter(Boolean);
  const out = [...new Set(parts)].join(', ');
  return out || fallback.split(',').slice(0, 4).join(',').trim();
}

function createGeo({ fetchImpl = globalThis.fetch, nominatimUrl = config.geo.nominatimUrl, osrmUrl = config.geo.osrmUrl, userAgent = config.geo.userAgent, country = config.geo.country, minIntervalMs = 1100 } = {}) {
  const cache = lru(1000);
  let queue = Promise.resolve();
  let last = 0;

  // Nominatim allows max 1 request/second: run its requests one after another.
  function throttled(fn) {
    const run = queue.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(7000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function reverse(lat, lng) {
    const key = `r:${lat.toFixed(5)},${lng.toFixed(5)}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const url = `${nominatimUrl}/reverse?${new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: '18', addressdetails: '1' })}`;
    const d = await throttled(() => getJson(url));
    if (!d || d.error) throw new Error(d?.error || 'No address found');
    const out = { address: formatAddress(d.address, d.display_name), area: d.address?.suburb || d.address?.neighbourhood || d.address?.city || '', lat, lng };
    cache.set(key, out);
    return out;
  }

  async function search(q, near) {
    const query = String(q).trim().slice(0, 200);
    const key = `s:${query.toLowerCase()}:${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const params = { format: 'jsonv2', q: query, addressdetails: '1', limit: '5' };
    if (country) params.countrycodes = country;
    if (near) { // prefer results within ~25 km of the restaurant
      const d = 0.25;
      params.viewbox = `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`;
    }
    const rows = await throttled(() => getJson(`${nominatimUrl}/search?${new URLSearchParams(params)}`));
    const out = (rows || []).map((r) => ({ label: formatAddress(r.address, r.display_name), full: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }))
      .filter(validPoint);
    cache.set(key, out);
    return out;
  }

  // Road route through the given points (2 or 3). Falls back to straight lines.
  // With { steps: true } it also returns turn-by-turn instructions.
  async function route(points, { steps = false } = {}) {
    const key = `t:${steps ? 's' : ''}:${points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';')}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const straight = () => {
      let dist = 0;
      for (let i = 1; i < points.length; i++) dist += haversine(points[i - 1], points[i]);
      const road = dist * 1.3; // roads are longer than a straight line
      const out = { coordinates: points.map((p) => [p.lat, p.lng]), distanceM: Math.round(road), durationS: Math.round(road / (20_000 / 3600)), approximate: true };
      if (steps) {
        out.steps = [
          { type: 'depart', modifier: null, exit: null, name: '', instruction: 'Head towards your destination', distanceM: out.distanceM, durationS: out.durationS, location: [points[0].lat, points[0].lng] },
          { type: 'arrive', modifier: null, exit: null, name: '', instruction: 'Arrive at your destination', distanceM: 0, durationS: 0, location: [points[points.length - 1].lat, points[points.length - 1].lng] },
        ];
      }
      return out;
    };
    try {
      const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
      const d = await getJson(`${osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson${steps ? '&steps=true' : ''}`);
      const r = d?.routes?.[0];
      if (!r) throw new Error('no route');
      const out = { coordinates: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distanceM: Math.round(r.distance), durationS: Math.round(r.duration), approximate: false };
      if (steps) out.steps = toSteps(r.legs);
      cache.set(key, out);
      return out;
    } catch {
      return straight(); // not cached, so we retry the real route next time
    }
  }

  return { reverse, search, route };
}

module.exports = { createGeo, haversine, formatAddress, validPoint };