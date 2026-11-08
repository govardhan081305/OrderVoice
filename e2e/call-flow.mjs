// End-to-end test: two real Chrome browsers (customer + delivery agent) place an
// order, then make REAL WebRTC calls to each other through the OrderVoice server.
// Chrome's fake microphone generates a tone, so we can verify audio actually arrives.
//
// Usage:  node call-flow.mjs            (expects client/dist to be built)
//   CHROME=/path/to/chrome  to choose the browser binary
//   RELAY=1                 to force the call through TURN (needs TURN_URLS/TURN_SECRET on the server)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const shots = path.join(here, 'screenshots');
const dbFile = path.join(here, '.tmp', `e2e-${Date.now()}.db`);
mkdirSync(shots, { recursive: true });
mkdirSync(path.dirname(dbFile), { recursive: true });

const log = (...a) => console.log('  ✓', ...a);
const fail = (m) => { throw new Error(m); };

// ---- Stand-in for OpenStreetMap services (Nominatim + OSRM), so the test runs offline ----
import http from 'node:http';
let routeRequests = 0;
const pushSink = []; // what the server would send to the browser's push service
const geoServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/push-sink') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { pushSink.push(JSON.parse(body)); res.writeHead(201); res.end(); });
    return undefined;
  }
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/reverse') {
    return json({ display_name: 'x', address: { house_number: '21', road: '24th Main Road', suburb: 'HSR Layout', city: 'Bengaluru', postcode: '560102' } });
  }
  if (u.pathname === '/search') {
    return json([{ lat: '12.9352', lon: '77.6245', display_name: 'Koramangala 5th Block, Bengaluru', address: { suburb: 'Koramangala 5th Block', city: 'Bengaluru', postcode: '560095' } }]);
  }
  if (u.pathname.startsWith('/route/v1/driving/')) {
    routeRequests += 1;
    const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number)); // [lng, lat]
    const coords = [];
    for (let i = 1; i < pts.length; i++) { const [a, b] = [pts[i - 1], pts[i]]; coords.push(a, [b[0], a[1]]); } // L-shaped "roads"
    coords.push(pts[pts.length - 1]);
    let d = 0;
    for (let i = 1; i < coords.length; i++) d += Math.hypot((coords[i][0] - coords[i - 1][0]) * 108000, (coords[i][1] - coords[i - 1][1]) * 111000);
    // Turn-by-turn steps for the L-shaped legs: depart (east/west), turn at the corner, arrive.
    const legs = [];
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const corner = [b[0], a[1]];
      const eastward = b[0] > a[0];
      const north = b[1] > a[1];
      const turn = (eastward === north) ? 'left' : 'right';
      const leg1 = Math.abs(b[0] - a[0]) * 108000; const leg2 = Math.abs(b[1] - a[1]) * 111000;
      legs.push({ steps: [
        { name: 'Kanakapura Main Road', distance: leg1, duration: leg1 / 5.5, maneuver: { type: 'depart', bearing_after: eastward ? 90 : 270, location: a } },
        { name: 'Harohalli Bus Stand Road', distance: leg2, duration: leg2 / 5.5, maneuver: { type: 'turn', modifier: turn, location: corner } },
        { name: '', distance: 0, duration: 0, maneuver: { type: 'arrive', location: b } },
      ] });
    }
    return json({ routes: [{ distance: d, duration: d / 5.5, geometry: { coordinates: coords }, legs }] });
  }
  res.writeHead(404); return res.end();
});
await new Promise((r) => geoServer.listen(0, r));
const GEO = `http://localhost:${geoServer.address().port}`;

const server = spawn(process.execPath, ['src/index.js'], {
  cwd: path.join(root, 'server'),
  env: { ...process.env, PORT: String(PORT), SQLITE_PATH: dbFile, NODE_ENV: 'test', CALL_RING_TIMEOUT_SEC: '20', ADMIN_SIGNUP_CODE: 'E2E-ADMIN-CODE', NOMINATIM_URL: GEO, OSRM_URL: GEO, PUSH_SINK_URL: `${GEO}/push-sink` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 15000);
  server.stdout.on('data', (d) => { if (String(d).includes('OrderVoice server on')) { clearTimeout(t); resolve(); } });
});
log('server started on', BASE);

const CHROME_PATHS = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = CHROME_PATHS.find((p) => existsSync(p));
if (!executablePath) { console.error('Chrome not found. Set CHROME=/path/to/chrome'); server.kill(); process.exit(1); }
const browser = await chromium.launch({
  executablePath,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
// Emulated GPS: customer at home in HSR Layout, agent ~1 km from the restaurant.
// Emulated GPS in Harohalli: customer at home, agent ~1.5 km south-west of the town centre.
const HOME = { latitude: 12.6845, longitude: 77.4745 };
const AGENT_START = { latitude: 12.6700, longitude: 77.4620 };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone', 'geolocation', 'notifications'], geolocation: HOME };
const agentPhone = { ...phone, geolocation: AGENT_START };

async function newUser(name, opts = phone) {
  const ctx = await browser.newContext(opts);
  // External tiles/fonts are not needed for the test; fail them fast.
  await ctx.route(/(tile\.openstreetmap|fonts\.(googleapis|gstatic))/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name} pageerror]`, e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) console.error(`[${name} console]`, m.text()); });
  await page.goto(`${BASE}/login${process.env.RELAY === '1' ? '?relay=1' : ''}`);
  return page;
}

// Sign up through the real Create-account page.
// Wait until the call screen's status text actually starts with `prefix` (checked inside the page).
const waitStatus = (page, prefix, timeout = 15000) => page.waitForFunction(
  (p) => (document.querySelector('[data-testid=call-status]')?.textContent || '').trim().startsWith(p), prefix, { timeout });

async function signUp(page, role, name, email, adminCode) {
  await page.getByTestId('go-register').click();
  await page.getByTestId(`role-${role}`).click();
  await page.getByTestId('name').fill(name);
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('secret123');
  await page.getByTestId('confirm').fill('secret123');
  if (adminCode) await page.getByTestId('admin-code').fill(adminCode);
  await page.getByTestId('submit').click();
}

let exitCode = 0;
try {
  const customer = await newUser('customer');
  const agent = await newUser('agent', agentPhone);

  await customer.screenshot({ path: path.join(shots, '01-login.png') });

  // Customer: sign up, log out, then log in again with the Customer tab.
  await signUp(customer, 'customer', 'Priya Sharma', 'priya@example.com');
  await customer.getByTestId('restaurant-card').first().waitFor();
  await customer.locator('.tabbar').getByText('Account').click();
  await customer.getByTestId('logout').click();
  await customer.getByTestId('role-agent').click();
  await customer.getByTestId('email').fill('priya@example.com');
  await customer.getByTestId('password').fill('secret123');
  await customer.getByTestId('submit').click();
  await customer.getByTestId('auth-error').filter({ hasText: 'registered as Customer' }).waitFor();
  await customer.getByTestId('role-customer').click();
  await customer.getByTestId('submit').click();
  await customer.getByTestId('restaurant-card').first().waitFor();
  await customer.screenshot({ path: path.join(shots, '02-restaurants.png') });
  log('customer signed up, logged out, wrong role tab refused, logged in as Customer');

  await agent.getByTestId('go-register').click();
  await agent.getByTestId('role-agent').click();
  await agent.screenshot({ path: path.join(shots, '00-signup.png') });
  await agent.goto(`${BASE}/login`);
  await signUp(agent, 'agent', 'Ravi Kumar', 'ravi@example.com');
  await agent.getByRole('heading', { name: 'Deliveries' }).waitFor();
  log('delivery partner signed up');

  // Customer orders.
  await customer.getByTestId('restaurant-card').first().click();
  const adds = customer.getByTestId('add-item');
  await adds.first().click();
  await adds.nth(1).click();
  await customer.screenshot({ path: path.join(shots, '03-menu.png') });
  await customer.getByTestId('view-cart').click();
  if (!(await customer.getByTestId('place-order').isDisabled())) fail('cannot order before a delivery location is set');
  // "Use my current location" -> GPS -> address filled in automatically.
  await customer.getByTestId('use-location').click();
  await customer.waitForFunction(() => document.querySelector('[data-testid=address]').value.includes('24th Main Road'));
  await customer.getByTestId('loc-msg').filter({ hasText: 'filled from your current location' }).waitFor();
  await customer.getByTestId('distance').filter({ hasText: /km from|m from/ }).waitFor();
  await customer.getByTestId('flat').fill('Flat 302, 3rd floor');
  await customer.getByTestId('deliver-to').filter({ hasText: 'Flat 302, 3rd floor, 21, 24th Main Road, HSR Layout, Bengaluru 560102' }).waitFor();
  await customer.waitForTimeout(300);
  await customer.screenshot({ path: path.join(shots, '03b-checkout-location.png'), fullPage: true });
  log('checkout: "Use my current location" filled the address from GPS; pin on map; distance shown');
  // Address search also works (and moves the pin).
  await customer.getByTestId('address-search').fill('Koramangala');
  await customer.getByTestId('address-search').press('Enter');
  await customer.getByTestId('search-results').getByText('Koramangala 5th Block').first().waitFor();
  await customer.getByTestId('use-location').click(); // back to GPS location for this order
  await customer.waitForFunction(() => document.querySelector('[data-testid=address]').value.includes('24th Main Road'));
  log('checkout: address search returns places to pick from');
  await customer.getByTestId('place-order').click();
  await customer.waitForURL(/\/orders\/OV-/);
  const orderId = customer.url().split('/').pop();
  await customer.getByTestId('order-status').filter({ hasText: 'Finding a delivery partner' }).waitFor();
  if (!(await customer.getByTestId('start-call').isDisabled())) fail('call should be disabled before an agent accepts');
  log('order placed', orderId, '(call button disabled until an agent accepts)');

  // Agent gets it in real time and accepts.
  await agent.getByTestId('available-order').first().waitFor({ timeout: 5000 });
  await agent.screenshot({ path: path.join(shots, '04-agent-new-order.png') });
  await agent.getByTestId('accept-order').first().click();
  await agent.waitForURL(new RegExp(`/agent/orders/${orderId}`));
  await customer.getByTestId('order-status').filter({ hasText: 'Partner assigned' }).waitFor({ timeout: 5000 });
  await customer.waitForFunction(() => !document.querySelector('[data-testid=start-call]').disabled);
  log('agent accepted; customer screen updated live and call button enabled');

  // Agent's GPS is shared automatically (permission already granted) -> customer sees live route + ETA.
  await agent.getByTestId('sharing-status').filter({ hasText: 'GPS' }).waitFor({ timeout: 8000 });
  await agent.getByTestId('agent-route').filter({ hasText: 'Next: Pickup at' }).waitFor({ timeout: 8000 });
  const navHref = await agent.getByTestId('navigate').getAttribute('href');
  if (!navHref.includes('google.com/maps/dir') || navHref.includes('12.6845')) fail(`navigate link should go to the restaurant first: ${navHref}`);
  await customer.getByTestId('route-info').filter({ hasText: 'heading to the restaurant' }).waitFor({ timeout: 10000 });
  await customer.waitForTimeout(800);
  await customer.screenshot({ path: path.join(shots, '05-customer-tracking.png'), fullPage: true });
  // Maps must zoom to show restaurant, delivery pin and the partner (all markers inside the map box).
  for (const [nm, pg] of [['customer', customer], ['agent', agent]]) {
    const m = await pg.evaluate(() => {
      const c = document.querySelector('[data-testid=track-map]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid=track-map] .map-pin')].map((p) => { const r = p.getBoundingClientRect(); return [r.x - c.x, r.y - c.y, c.width, c.height]; });
    });
    if (m.length !== 3 || m.some(([x, y, w, h]) => x < -5 || y < -5 || x > w - 20 || y > h - 20)) fail(`${nm} map does not show all 3 markers: ${JSON.stringify(m)}`);
  }
  log('both maps fit restaurant, delivery pin and partner in view');
  await customer.getByTestId('track-map').scrollIntoViewIfNeeded();
  await customer.screenshot({ path: path.join(shots, '05c-customer-map-view.png') });
  await agent.getByTestId('track-map').scrollIntoViewIfNeeded();
  await agent.screenshot({ path: path.join(shots, '05d-agent-map-view.png') });
  await agent.screenshot({ path: path.join(shots, '05b-agent-route.png'), fullPage: true });
  log('agent GPS auto-shared; agent sees route + Navigate; customer sees "Ravi is heading to the restaurant" with distance + ETA');
  // ---- In-app turn-by-turn navigation following the agent's moving GPS -----
  const token = await customer.evaluate(() => localStorage.getItem('ov.token'));
  const ord = await (await fetch(`${BASE}/api/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const R = ord.order.restaurant;
  const moveAgent = async (lat, lng) => { await agent.context().setGeolocation({ latitude: lat, longitude: lng }); await agent.waitForTimeout(700); };
  const navDist = async () => { const t = await agent.getByTestId('nav-distance').textContent(); return t.includes('km') ? parseFloat(t) * 1000 : parseFloat(t); };

  await agent.getByTestId('start-nav').click();
  await agent.getByTestId('nav-screen').waitFor();
  await agent.getByTestId('nav-instruction').filter({ hasText: 'Turn' }).waitFor({ timeout: 8000 }); // next maneuver = the corner turn
  const d0 = await navDist();
  await agent.screenshot({ path: path.join(shots, '06a-nav-start.png') });
  // Drive along the first road towards the corner (route is L-shaped: east/west first, then north/south).
  const corner = { lat: AGENT_START.latitude, lng: R.lng };
  await moveAgent(AGENT_START.latitude, AGENT_START.longitude + (corner.lng - AGENT_START.longitude) * 0.5);
  await moveAgent(AGENT_START.latitude, AGENT_START.longitude + (corner.lng - AGENT_START.longitude) * 0.8);
  const d1 = await navDist();
  if (!(d1 < d0 * 0.4)) fail(`distance to the turn should shrink as the agent moves: ${d0} -> ${d1}`);
  log(`navigation follows GPS: "${await agent.getByTestId('nav-instruction').textContent()}" ${Math.round(d0)} m -> ${Math.round(d1)} m`);
  // Past the corner: next instruction is the arrival.
  await moveAgent(corner.lat + (R.lat - corner.lat) * 0.3, corner.lng);
  await agent.getByTestId('nav-instruction').filter({ hasText: 'Arrive' }).waitFor({ timeout: 5000 });
  await agent.screenshot({ path: path.join(shots, '06b-nav-after-turn.png') });
  log('after the turn, the next instruction switches to "Arrive at your destination"');
  // Go off the route -> rerouting from the new position.
  const before = routeRequests;
  await moveAgent(corner.lat + (R.lat - corner.lat) * 0.3, corner.lng + 0.006);
  await moveAgent(corner.lat + (R.lat - corner.lat) * 0.3, corner.lng + 0.0065);
  await agent.waitForFunction(() => !document.querySelector('[data-testid=nav-rerouting]'), null, { timeout: 8000 });
  if (!(routeRequests > before)) fail('leaving the route should trigger a re-route');
  await agent.getByTestId('nav-instruction').waitFor({ timeout: 8000 });
  log('agent left the route -> navigation re-routed from the new position');
  // Arrive at the restaurant -> pick up -> navigation continues to the customer.
  await moveAgent(R.lat, R.lng);
  await agent.getByTestId('nav-arrived').waitFor({ timeout: 8000 });
  await agent.screenshot({ path: path.join(shots, '06c-nav-arrived.png') });
  await agent.getByTestId('nav-arrived-action').filter({ hasText: 'Picked up' }).click();
  await agent.getByTestId('nav-instruction').filter({ hasText: /Turn|Head|Arrive/ }).waitFor({ timeout: 8000 });
  await agent.waitForFunction(() => !document.querySelector('[data-testid=nav-arrived]'), null, { timeout: 8000 });
  await customer.getByTestId('order-status').filter({ hasText: 'On the way' }).waitFor({ timeout: 8000 });
  await customer.getByTestId('route-info').filter({ hasText: /Ravi is .* away/ }).waitFor({ timeout: 10000 });
  log('arrived at restaurant -> "Picked up · start delivery" -> navigation now guides to the customer; customer sees "On the way"');
  await agent.getByTestId('nav-exit').click();
  await agent.getByTestId('nav-screen').waitFor({ state: 'detached' });
  const navHref2 = await agent.getByTestId('navigate').getAttribute('href');
  if (!navHref2.includes('destination=12.6845')) fail(`after pickup, Google Maps link should go to the customer's pin: ${navHref2}`);

  // ---- Call 1: customer -> agent, accepted, real audio --------------------
  await customer.getByTestId('start-call').click();
  await agent.getByTestId('accept-call').waitFor({ timeout: 8000 });
  await customer.getByTestId('call-status').filter({ hasText: 'Ringing' }).waitFor();
  await agent.waitForTimeout(500);
  await agent.screenshot({ path: path.join(shots, '06-agent-incoming-call.png') });
  log('agent phone is ringing (incoming call screen)');
  await agent.getByTestId('accept-call').click();
  await waitStatus(customer, 'Connected');
  await waitStatus(agent, 'Connected');
  log('WebRTC connected on both sides');

  // Wait for stats and check that audio bytes are flowing both ways.
  const audioKbps = async (page) => {
    await page.getByTestId('bitrate').waitFor({ timeout: 15000 });
    await page.waitForTimeout(4500);
    return Number((await page.getByTestId('bitrate').textContent()).replace(/\D/g, ''));
  };
  const [kA, kC] = await Promise.all([audioKbps(agent), audioKbps(customer)]);
  if (!(kA > 5 && kC > 5)) fail(`audio not flowing: agent receives ${kA} kbps, customer receives ${kC} kbps`);
  const connType = await customer.getByTestId('conn-type').textContent();
  if (process.env.RELAY === '1' && !/relay/i.test(connType)) fail(`expected relay, got ${connType}`);
  log(`audio flowing both ways: agent hears ${kA} kbps, customer hears ${kC} kbps · path: ${connType}`);
  await customer.screenshot({ path: path.join(shots, '07-customer-in-call.png') });
  await agent.screenshot({ path: path.join(shots, '08-agent-in-call.png') });

  // Mute works (track disabled -> still connected).
  await customer.getByTestId('mute-call').click();
  await customer.getByRole('button', { name: 'Unmute' }).waitFor();
  await customer.getByTestId('mute-call').click();

  await customer.getByTestId('end-call').click();
  await agent.getByTestId('call-status').filter({ hasText: 'Call ended' }).waitFor({ timeout: 5000 });
  await agent.getByTestId('call-screen').waitFor({ state: 'detached', timeout: 6000 });
  await customer.getByTestId('call-screen').waitFor({ state: 'detached', timeout: 6000 });
  log('customer hung up; agent saw "Call ended"');

  // ---- Call 2: agent -> customer, declined -------------------------------
  await agent.getByTestId('start-call').click();
  await customer.getByTestId('decline-call').waitFor({ timeout: 8000 });
  await customer.waitForTimeout(500);
  await customer.screenshot({ path: path.join(shots, '09-customer-incoming-call.png') });
  await customer.getByTestId('decline-call').click();
  await agent.getByTestId('call-status').filter({ hasText: 'Call declined' }).waitFor({ timeout: 5000 });
  log('agent called customer (two-way calling); customer declined');
  await agent.getByTestId('call-screen').waitFor({ state: 'detached', timeout: 6000 });

  // ---- Agent's app is CLOSED: the call rings his phone via Web Push -----------
  // (This sandbox can't reach Google's push servers, so the server's push goes to a local
  //  sink and we hand it to the agent's real service worker with Chrome's DevTools protocol.)
  const agentToken = await agent.evaluate(() => localStorage.getItem('ov.token'));
  await fetch(`${BASE}/api/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-agent', keys: { p256dh: 'BOr-test-key', auth: 'test-auth' } } }) });
  await agent.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const cdp = await agent.context().newCDPSession(agent);
  const regId = new Promise((res) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { const r = e.registrations.find((x) => x.scopeURL.startsWith(BASE)); if (r) res(r.registrationId); }));
  await cdp.send('ServiceWorker.enable');
  const registrationId = await regId;
  const agentOrderPath = new URL(agent.url()).pathname;
  await agent.goto('about:blank'); // app closed
  await customer.waitForTimeout(600);
  await customer.getByTestId('start-call').click();
  await waitStatus(customer, 'Ringing their phone', 8000);
  const deadline = Date.now() + 5000;
  while (!pushSink.some((p) => p.payload.type === 'call') && Date.now() < deadline) await customer.waitForTimeout(100);
  const callPush = pushSink.find((p) => p.payload.type === 'call');
  if (!callPush) fail('server did not send an incoming-call push');
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId, data: JSON.stringify(callPush.payload) });
  // Check the ringing notification (from a static same-origin page, so the app itself doesn't start).
  await agent.goto(`${BASE}/manifest.webmanifest`);
  const notes = await agent.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications())
    .map((n) => ({ title: n.title, tag: n.tag, actions: n.actions.map((a) => a.title), req: n.requireInteraction, vib: (n.vibrate || []).length })));
  const ring = notes.find((n) => n.tag === `call-${callPush.payload.callId}`);
  if (!ring || ring.title !== 'Priya Sharma is calling' || ring.actions.join() !== 'Answer,Decline' || !ring.req) fail(`ringing notification wrong: ${JSON.stringify(notes)}`);
  log(`app closed -> phone rings by Web Push: "${ring.title}" [${ring.actions.join(' | ')}], stays until answered, vibrates`);
  // Tap "Answer" -> app opens at the call and answers it.
  await agent.goto(`${BASE}${callPush.payload.url}`);
  await waitStatus(agent, 'Connected', 15000);
  await waitStatus(customer, 'Connected', 15000);
  const left = await agent.evaluate(async (tag) => (await (await navigator.serviceWorker.ready).getNotifications({ tag })).length, `call-${callPush.payload.callId}`);
  if (left) fail('ringing notification should close once answered');
  log('tapped "Answer" -> app opened, call auto-answered and connected; notification cleared');
  await customer.getByTestId('end-call').click();
  await agent.getByTestId('call-screen').waitFor({ state: 'detached', timeout: 8000 });
  if (new URL(agent.url()).pathname !== agentOrderPath) fail(`agent should land on the order page, got ${agent.url()}`);

  // ---- Delivery closes calling for BOTH sides ----------------------------
  for (const label of ['Mark as delivered']) {
    await agent.getByTestId('advance-status').filter({ hasText: new RegExp(label, 'i') }).click();
  }
  await agent.getByTestId('order-status').filter({ hasText: 'Delivered' }).waitFor();
  await customer.getByTestId('order-status').filter({ hasText: 'Delivered' }).waitFor({ timeout: 5000 });
  for (const [who, page] of [['customer', customer], ['agent', agent]]) {
    await page.getByText('Order delivered: calling closed.').waitFor({ timeout: 5000 });
    if (!(await page.getByTestId('start-call').isDisabled())) fail(`${who} can still call after delivery`);
  }
  log('order delivered; call button disabled for both customer and agent');
  await customer.getByTestId('call-log').waitFor();
  await customer.screenshot({ path: path.join(shots, '10-customer-call-history.png'), fullPage: true });

  // ---- Internet off on the other side -> call ends, "Normal call" option ----
  await customer.goto(`${BASE}/`);
  await customer.getByTestId('restaurant-card').nth(1).click();
  await customer.getByTestId('add-item').first().click();
  await customer.getByTestId('view-cart').click();
  await customer.getByTestId('place-order').click(); // address remembered from the first order
  await customer.waitForURL(/\/orders\/OV-/);
  const order2 = customer.url().split('/').pop();
  await agent.goto(`${BASE}/agent`);
  await agent.getByTestId('accept-order').first().click();
  await agent.waitForURL(new RegExp(`/agent/orders/${order2}`));
  await customer.getByTestId('order-status').filter({ hasText: 'Partner assigned' }).waitFor({ timeout: 5000 });

  // (a) Agent's internet drops in the middle of a call.
  await customer.getByTestId('start-call').click();
  await agent.getByTestId('accept-call').click({ timeout: 8000 });
  await waitStatus(customer, 'Connected');
  await agent.close(); // agent's phone loses internet
  await customer.getByTestId('internet-off').waitFor({ timeout: 15000 });
  await waitStatus(customer, 'Internet connection lost on Ravi');
  await customer.waitForTimeout(400);
  await customer.screenshot({ path: path.join(shots, '12-internet-lost-mid-call.png') });
  log('agent lost internet mid-call: call terminated, customer told "Internet connection lost on Ravi\'s side"');
  await customer.getByTestId('normal-call').click();
  await customer.getByTestId('masked-explainer').waitFor();
  await customer.waitForTimeout(300);
  await customer.screenshot({ path: path.join(shots, '13-normal-call-explainer.png') });
  if (await customer.getByTestId('call-timer').count()) fail('normal call must not start a demo call');
  await customer.getByTestId('masked-close').click();
  await customer.getByTestId('call-screen').waitFor({ state: 'detached' });
  log('"Normal call" shows how the masking provider connects the call (no demo call placed)');

  // (b) Agent's app is closed and his phone doesn't answer the push (no internet / ignored):
  //     the phone is rung first, then the caller is offered a normal call.
  const pushesBefore = pushSink.length;
  await customer.getByTestId('start-call').click();
  await waitStatus(customer, 'Ringing their phone', 8000);
  await waitStatus(customer, "Ravi didn't pick up", 30000);
  if (!pushSink.slice(pushesBefore).some((p) => p.payload.type === 'call-ended' && p.payload.missed)) fail('a "missed call" push should be sent');
  await customer.waitForTimeout(400);
  await customer.screenshot({ path: path.join(shots, '14-internet-off.png') });
  await customer.getByTestId('normal-call').click();
  await customer.getByTestId('masked-explainer').waitFor();
  await customer.getByTestId('masked-close').click();
  await customer.getByTestId('call-log').getByText('Normal call requested').first().waitFor({ timeout: 5000 });
  log('agent\'s app closed + no answer: phone rung by push, then "Ravi didn\'t pick up" + normal call option; "missed call" push sent');

  // (b2) Without call alerts (no push subscription) the call can't ring at all -> "internet is off" at once.
  await fetch(`${BASE}/api/push/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-agent' }) });
  await customer.getByTestId('start-call').click();
  await waitStatus(customer, "Ravi's internet is off", 8000);
  await customer.getByTestId('normal-call').click();
  await customer.getByTestId('masked-close').click();
  log('agent offline without call alerts: "Ravi\'s internet is off" immediately');

  // (c) Customer's own internet is off.
  await customer.context().setOffline(true);
  await customer.getByTestId('call-sub').filter({ hasText: "You're offline" }).waitFor({ timeout: 25000 });
  await customer.getByTestId('start-call').click();
  await customer.getByTestId('masked-explainer').filter({ hasText: 'helpline' }).waitFor();
  await customer.waitForTimeout(500);
  await customer.screenshot({ path: path.join(shots, '15-self-offline-helpline.png') });
  await customer.getByTestId('masked-close').click();
  await customer.context().setOffline(false);
  await customer.getByTestId('call-sub').filter({ hasText: 'free internet call' }).waitFor({ timeout: 25000 });
  log('customer offline: tapping Call shows the helpline (normal call) option; back online afterwards');

  // ---- Admin dashboard ----------------------------------------------------
  const admin = await newUser('admin', { viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1.5 });
  await signUp(admin, 'admin', 'Ops Admin', 'admin@example.com', 'WRONG-CODE');
  await admin.getByTestId('auth-error').filter({ hasText: 'Invalid admin code' }).waitFor();
  await admin.getByTestId('admin-code').fill('E2E-ADMIN-CODE');
  await admin.getByTestId('submit').click();
  await admin.getByTestId('admin-calls').waitFor();
  await admin.getByTestId('kpi-internet-off').filter({ hasText: /^[2-9]/ }).waitFor({ timeout: 5000 });
  await admin.getByTestId('kpi-masked').filter({ hasText: /^[2-9]/ }).waitFor({ timeout: 5000 });
  log('admin: internet-off events and normal-call requests counted');
  const rows = await admin.locator('[data-testid=admin-calls] tbody tr').count();
  if (rows < 2) fail(`admin should list 2 calls, saw ${rows}`);
  await admin.screenshot({ path: path.join(shots, '11-admin-dashboard.png'), fullPage: true });
  log(`wrong admin code refused; admin signed up; dashboard shows ${rows} calls with quality metrics`);

  console.log('\nALL E2E CHECKS PASSED');
} catch (e) {
  exitCode = 1;
  console.error('\nE2E FAILED:', e.message);
} finally {
  await browser.close();
  server.kill();
  geoServer.close();
  rmSync(path.dirname(dbFile), { recursive: true, force: true });
  process.exit(exitCode);
}
