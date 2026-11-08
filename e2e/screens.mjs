// UI audit: fills the app with realistic data, then screenshots every page for
// customer, agent and admin at phone (390px) and laptop (1440px) widths.
//   node screens.mjs            -> e2e/screens/<size>-<page>.png
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const require = createRequire(path.join(root, 'server', 'package.json'));
const { io: ioc } = require('socket.io-client');

const PORT = 4700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const out = path.join(here, 'screens');
const dbFile = path.join(here, '.tmp', `screens-${Date.now()}.db`);
mkdirSync(out, { recursive: true });
mkdirSync(path.dirname(dbFile), { recursive: true });

process.on('unhandledRejection', (e) => { console.error('FAILED', e.message); server.kill(); process.exit(1); });
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: path.join(root, 'server'),
  env: { ...process.env, PORT: String(PORT), SQLITE_PATH: dbFile, NODE_ENV: 'test', ADMIN_SIGNUP_CODE: 'X', CALL_RING_TIMEOUT_SEC: '2' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('OrderVoice server on') && res()));

const post = async (p, body, token) => {
  const r = await fetch(`${BASE}/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
};
const sock = (token) => new Promise((res) => { const s = ioc(BASE, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => res(s)); });
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Data -------------------------------------------------------------------
const reg = (name, email, role) => post('/auth/register', { name, email, password: 'secret123', role, ...(role === 'admin' ? { adminCode: 'X' } : {}) });
const priya = await reg('Priya Sharma', 'priya@example.com', 'customer');
const arjun = await reg('Arjun Rao', 'arjun@example.com', 'customer');
const ravi = await reg('Ravi Kumar', 'ravi@example.com', 'agent');
const meena = await reg('Meena Iyer', 'meena@example.com', 'agent');
const admin = await reg('Ops Admin', 'admin@example.com', 'admin');
const order = (u, restaurantId, items, address) => post('/orders', { restaurantId, items, address, lat: 12.6845, lng: 77.4745 }, u.token).then((r) => r.order);

const old = await order(priya, 2, [{ menuItemId: 5, qty: 2 }, { menuItemId: 7, qty: 2 }], 'Flat 302, 2nd Cross, Harohalli');
await post(`/orders/${old.id}/accept`, {}, meena.token);
for (const s of ['picked_up', 'out_for_delivery', 'delivered']) await post(`/orders/${old.id}/status`, { status: s }, meena.token);

const live = await order(priya, 1, [{ menuItemId: 1, qty: 1 }, { menuItemId: 2, qty: 3 }, { menuItemId: 4, qty: 1 }], 'Flat 302, 2nd Cross, Harohalli');
await post(`/orders/${live.id}/accept`, {}, ravi.token);
await post(`/orders/${live.id}/status`, { status: 'picked_up' }, ravi.token);
await post(`/orders/${live.id}/status`, { status: 'out_for_delivery' }, ravi.token);
await order(arjun, 4, [{ menuItemId: 13, qty: 1 }, { menuItemId: 16, qty: 2 }], '22, Bus Stand Road, Harohalli');
await order(arjun, 5, [{ menuItemId: 17, qty: 2 }], '9, Kanakapura Main Road, Harohalli');

// Calls (signaling only, no audio) so history + admin have data.
const sp = await sock(priya.token); const sr = await sock(ravi.token);
async function call(from, to, orderId, { accept = true, secs = 2, stats } = {}) {
  const r = await emit(from, 'call:start', { orderId });
  await wait(150);
  if (accept === 'decline') { await emit(to, 'call:decline', { callId: r.callId }); return; }
  if (!accept) { await wait(2600); return; }
  await emit(to, 'call:accept', { callId: r.callId });
  from.emit('call:connected', { callId: r.callId, connectionType: stats.connectionType });
  from.emit('call:stats', { callId: r.callId, stats });
  to.emit('call:stats', { callId: r.callId, stats: { ...stats, rttMs: stats.rttMs + 8 } });
  await wait(secs * 1000);
  await emit(from, 'call:end', { callId: r.callId });
}
await call(sr, sp, live.id, { secs: 3, stats: { rttMs: 42, jitterMs: 3.1, lossPct: 0.2, bitrateKbps: 26, connectionType: 'direct' } });
await call(sp, sr, live.id, { accept: 'decline' });
await call(sp, sr, live.id, { secs: 2, stats: { rttMs: 118, jitterMs: 8.4, lossPct: 1.4, bitrateKbps: 24, connectionType: 'relay' } });
sr.emit('agent:location', { orderId: live.id, lat: 12.6790, lng: 77.4680 });
await wait(300);

// ---- Screenshots --------------------------------------------------------------
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const SIZES = { tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1 }, mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, laptop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } };
const only = process.argv[2];

async function shoot(size, name, token, url, prep) {
  if (only && !name.includes(only)) return;
  const ctx = await browser.newContext(SIZES[size]);
  await ctx.route(/(tile\.openstreetmap|fonts\.(googleapis|gstatic))/, (r) => r.abort());
  if (token) await ctx.addInitScript((t) => localStorage.setItem('ov.token', t), token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${size}/${name}]`, e.message));
  await page.goto(BASE + url);
  await page.waitForLoadState('networkidle');
  if (prep) await prep(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${size}-${name}.png`), fullPage: true });
  if (size === 'mobile') await page.screenshot({ path: path.join(out, `view-${name}.png`) });
  await ctx.close();
}

for (const size of Object.keys(SIZES)) {
  await shoot(size, 'c0-login', null, '/login');
  await shoot(size, 'c0-register', null, '/register?role=admin');
  await shoot(size, 'c1-restaurants', priya.token, '/');
  await shoot(size, 'c2-menu', priya.token, '/r/1', async (p) => { const a = p.getByTestId('add-item'); await a.first().click(); await a.first().click(); });
  await shoot(size, 'c3-cart', priya.token, '/r/3', async (p) => { const a = p.getByTestId('add-item'); await a.first().click(); await a.first().click(); await p.goto(`${BASE}/cart`); await p.waitForLoadState('networkidle'); });
  await shoot(size, 'c4-orders', priya.token, '/orders');
  await shoot(size, 'c5-track', priya.token, `/orders/${live.id}`);
  await shoot(size, 'c6-delivered', priya.token, `/orders/${old.id}`);
  await shoot(size, 'a1-home', meena.token, '/agent');
  await shoot(size, 'a2-order', ravi.token, `/agent/orders/${live.id}`);
  await shoot(size, 'd1-admin', admin.token, '/admin');
  await shoot(size, 'e1-account', ravi.token, '/account');
}
console.log('screens saved to', out);
sp.close(); sr.close();
await browser.close();
server.kill();
rmSync(path.dirname(dbFile), { recursive: true, force: true });
process.exit(0);
