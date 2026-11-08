// Location services: address lookup, search, road routes, and order location rules.
process.env.ADMIN_SIGNUP_CODE = 'TEST-ADMIN-CODE';
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createGeo, haversine, formatAddress } = require('../src/geo');
const { createServer } = require('../src/app');

const NOMINATIM_REVERSE = {
  display_name: '14, 27th Main Road, HSR Layout, Bengaluru, Karnataka, 560102, India',
  address: { house_number: '14', road: '27th Main Road', suburb: 'HSR Layout', city: 'Bengaluru', postcode: '560102', state: 'Karnataka' },
};
const OSRM = { routes: [{ distance: 3210.4, duration: 612.7, geometry: { coordinates: [[77.6474, 12.9116], [77.65, 12.915], [77.6574, 12.9216]] } }] };

function fakeFetch(log, { failOsrm = false } = {}) {
  return async (url, opts) => {
    log.push({ url: String(url), at: Date.now(), ua: opts?.headers?.['User-Agent'] });
    const u = String(url);
    if (u.includes('/route/v1/')) {
      if (failOsrm) throw new Error('offline');
      return { ok: true, json: async () => OSRM };
    }
    if (u.includes('/reverse')) return { ok: true, json: async () => NOMINATIM_REVERSE };
    if (u.includes('/search')) return { ok: true, json: async () => [{ lat: '12.9352', lon: '77.6245', display_name: 'Koramangala 5th Block, Bengaluru', address: { suburb: 'Koramangala 5th Block', city: 'Bengaluru' } }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('address formatting and distance', () => {
  assert.strictEqual(formatAddress(NOMINATIM_REVERSE.address), '14, 27th Main Road, HSR Layout, Bengaluru 560102');
  assert.strictEqual(formatAddress({}, 'A, B, C, D, E, F'), 'A, B, C, D');
  const d = haversine({ lat: 12.9116, lng: 77.6474 }, { lat: 12.9352, lng: 77.6245 });
  assert.ok(d > 3500 && d < 3700, String(d));
});

test('reverse geocoding: User-Agent, 1 request/second, cache', async () => {
  const log = [];
  const geo = createGeo({ fetchImpl: fakeFetch(log), nominatimUrl: 'https://nom.test', osrmUrl: 'https://osrm.test', userAgent: 'OV-test', minIntervalMs: 300 });
  const a = await geo.reverse(12.9216, 77.6574);
  assert.strictEqual(a.address, '14, 27th Main Road, HSR Layout, Bengaluru 560102');
  assert.strictEqual(log[0].ua, 'OV-test');
  await geo.reverse(12.9216, 77.6574); // cached
  assert.strictEqual(log.length, 1);
  await Promise.all([geo.reverse(12.93, 77.66), geo.reverse(12.94, 77.67)]);
  assert.strictEqual(log.length, 3);
  assert.ok(log[2].at - log[1].at >= 290, 'Nominatim requests must be spaced out');
});

test('address search is limited to India and biased to the restaurant', async () => {
  const log = [];
  const geo = createGeo({ fetchImpl: fakeFetch(log), nominatimUrl: 'https://nom.test', country: 'in', minIntervalMs: 0 });
  const rows = await geo.search('koramangala', { lat: 12.9116, lng: 77.6474 });
  assert.deepStrictEqual(rows[0], { label: 'Koramangala 5th Block, Bengaluru', full: 'Koramangala 5th Block, Bengaluru', lat: 12.9352, lng: 77.6245 });
  const u = new URL(log[0].url);
  assert.strictEqual(u.searchParams.get('countrycodes'), 'in');
  assert.ok(u.searchParams.get('viewbox'));
});

test('road route from OSRM, and straight-line fallback when it is unreachable', async () => {
  const geo = createGeo({ fetchImpl: fakeFetch([]), osrmUrl: 'https://osrm.test' });
  const r = await geo.route([{ lat: 12.9116, lng: 77.6474 }, { lat: 12.9216, lng: 77.6574 }]);
  assert.deepStrictEqual([r.distanceM, r.durationS, r.approximate, r.coordinates.length], [3210, 613, false, 3]);
  assert.deepStrictEqual(r.coordinates[0], [12.9116, 77.6474]); // converted to [lat, lng]

  const off = createGeo({ fetchImpl: fakeFetch([], { failOsrm: true }), osrmUrl: 'https://osrm.test' });
  const s = await off.route([{ lat: 12.9116, lng: 77.6474 }, { lat: 12.9216, lng: 77.6574 }, { lat: 12.93, lng: 77.66 }]);
  assert.strictEqual(s.approximate, true);
  assert.strictEqual(s.coordinates.length, 3);
  assert.ok(s.distanceM > 0 && s.durationS > 0);
});

test('geo API endpoints and order location rules', async () => {
  const log = [];
  const geo = createGeo({ fetchImpl: fakeFetch(log), nominatimUrl: 'https://nom.test', osrmUrl: 'https://osrm.test', minIntervalMs: 0 });
  const srv = await createServer({ dbOptions: { sqlitePath: ':memory:', databaseUrl: '' }, quiet: true, clientDist: '/nonexistent', geo });
  await new Promise((r) => srv.server.listen(0, r));
  const api = request(`http://localhost:${srv.server.address().port}`);
  try {
    const reg = await api.post('/api/auth/register').send({ name: 'G', email: 'g@t.dev', password: 'secret1', role: 'customer' });
    const auth = { Authorization: `Bearer ${reg.body.token}` };

    assert.strictEqual((await api.get('/api/geo/reverse?lat=12.92&lng=77.65')).status, 401);
    assert.strictEqual((await api.get('/api/geo/reverse?lat=abc&lng=77.65').set(auth)).status, 400);
    const rev = await api.get('/api/geo/reverse?lat=12.9216&lng=77.6574').set(auth);
    assert.deepStrictEqual([rev.status, rev.body.address], [200, '14, 27th Main Road, HSR Layout, Bengaluru 560102']);
    assert.strictEqual((await api.get('/api/geo/search?q=ko').set(auth)).status, 400);
    assert.strictEqual((await api.get('/api/geo/search?q=koramangala&near=12.91,77.64').set(auth)).body.results.length, 1);
    const route = await api.get('/api/geo/route?from=12.9116,77.6474&via=12.915,77.65&to=12.9216,77.6574').set(auth);
    assert.deepStrictEqual([route.status, route.body.distanceM], [200, 3210]);
    assert.ok(log.some((l) => l.url.includes('77.6474,12.9116;77.65,12.915;77.6574,12.9216')), 'via point included in OSRM request');
    assert.strictEqual((await api.get('/api/geo/route?from=1,2&to=bad').set(auth)).status, 400);

    const base = { restaurantId: 1, items: [{ menuItemId: 1, qty: 1 }], address: '14, 27th Main Road, HSR Layout' };
    const noPin = await api.post('/api/orders').set(auth).send(base);
    assert.deepStrictEqual([noPin.status, noPin.body.error], [400, 'Set your delivery location on the map']);
    const far = await api.post('/api/orders').set(auth).send({ ...base, lat: 13.0827, lng: 80.2707 }); // Chennai
    assert.strictEqual(far.status, 400);
    assert.match(far.body.error, /km from the restaurant/);
    const ok = await api.post('/api/orders').set(auth).send({ ...base, lat: 12.6845, lng: 77.4745 });
    assert.strictEqual(ok.status, 201);
    assert.deepStrictEqual([ok.body.order.deliveryLat, ok.body.order.deliveryLng], [12.6845, 77.4745]);
  } finally { await srv.close(); }
});