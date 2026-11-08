// Ringing a phone whose app is closed, via Web Push.
process.env.ADMIN_SIGNUP_CODE = 'TEST-ADMIN-CODE';
process.env.CALL_RING_TIMEOUT_SEC = '2';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const webpush = require('web-push');
const { io: ioc } = require('socket.io-client');
const { createServer } = require('../src/app');

const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const once = (s, ev, ms = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
  s.once(ev, (d) => { clearTimeout(t); resolve(d); });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A realistic browser subscription (valid P-256 key + auth secret).
function fakeSubscription(id) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://push.example.test/send/${id}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

let srv; let api; let base;
const pushes = [];
let failNext = null;
const sockets = [];
const connect = (token, auth = {}) => new Promise((resolve, reject) => {
  const s = ioc(base, { auth: { token, ...auth }, transports: ['websocket'], forceNew: true });
  sockets.push(s); s.on('connect', () => resolve(s)); s.on('connect_error', reject);
});
const reg = async (who, role) => {
  const r = await api.post('/api/auth/register').send({ name: `T ${who}`, email: `${who}@t.dev`, password: 'secret123', role });
  return { token: r.body.token, user: r.body.user, auth: { Authorization: `Bearer ${r.body.token}` } };
};
const activeOrder = async (cust, agent) => {
  const o = await api.post('/api/orders').set(cust.auth).send({ restaurantId: 1, items: [{ menuItemId: 1, qty: 1 }], address: '1 Test St, Harohalli', lat: 12.683, lng: 77.472 });
  await api.post(`/api/orders/${o.body.order.id}/accept`).set(agent.auth);
  return o.body.order.id;
};
const pushesFor = (endpoint) => pushes.filter((p) => p.sub.endpoint === endpoint).map((p) => p.payload);

test.before(async () => {
  srv = await createServer({
    dbOptions: { sqlitePath: ':memory:', databaseUrl: '' }, quiet: true, clientDist: '/nonexistent',
    push: { sendImpl: async (sub, payload, opts) => { if (failNext) { const e = failNext; failNext = null; throw e; } pushes.push({ sub, payload: JSON.parse(payload), opts }); } },
  });
  await new Promise((r) => srv.server.listen(0, r));
  base = `http://localhost:${srv.server.address().port}`;
  api = request(base);
});
test.after(async () => { sockets.forEach((s) => s.close()); await srv.close(); });

test('real Web Push requests are encrypted (aes128gcm) and VAPID-signed', () => {
  const keys = webpush.generateVAPIDKeys();
  const d = webpush.generateRequestDetails(fakeSubscription('x'), JSON.stringify({ type: 'call' }), {
    vapidDetails: { subject: 'mailto:admin@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 30, urgency: 'high',
  });
  assert.strictEqual(d.headers['Content-Encoding'], 'aes128gcm');
  assert.match(d.headers.Authorization, /^vapid t=.+, k=/);
  assert.strictEqual(d.headers.Urgency, 'high');
  assert.ok(d.body.length > 16 && !d.body.toString().includes('call'), 'payload must be encrypted');
});

test('subscribe / status / unsubscribe', async () => {
  const u = await reg('s1', 'customer');
  assert.ok((await api.get('/api/push/public-key')).body.publicKey.length > 40);
  assert.strictEqual((await api.post('/api/push/subscribe').set(u.auth).send({ subscription: { endpoint: 'nope' } })).status, 400);
  const sub = fakeSubscription('s1');
  assert.strictEqual((await api.post('/api/push/subscribe').set(u.auth).send({ subscription: sub })).status, 201);
  assert.strictEqual((await api.post('/api/push/subscribe').set(u.auth).send({ subscription: sub })).body.devices, 1); // same device once
  assert.strictEqual((await api.post('/api/push/test').set(u.auth)).status, 200);
  assert.strictEqual(pushesFor(sub.endpoint).at(-1).type, 'info');
  await api.post('/api/push/unsubscribe').set(u.auth).send({ endpoint: sub.endpoint });
  assert.strictEqual((await api.get('/api/push/status').set(u.auth)).body.devices, 0);
  assert.strictEqual((await api.post('/api/push/test').set(u.auth)).status, 404);
});

test('app closed: the call rings the phone by push, and opening the app answers it', async () => {
  const cust = await reg('c1', 'customer');
  const agent = await reg('a1', 'agent');
  const orderId = await activeOrder(cust, agent);
  const sub = fakeSubscription('a1');
  await api.post('/api/push/subscribe').set(agent.auth).send({ subscription: sub });
  const cs = await connect(cust.token);

  const r = await emit(cs, 'call:start', { orderId }); // agent's app is closed (no socket)
  assert.deepStrictEqual([r.ok, r.notified], [true, 'push']);
  await wait(50);
  const p = pushesFor(sub.endpoint).find((x) => x.type === 'call');
  assert.ok(p, 'push sent');
  assert.strictEqual(p.callId, r.callId);
  assert.strictEqual(p.from.name, 'T c1');
  assert.strictEqual(p.url, `/agent/orders/${orderId}?answer=${r.callId}`);
  assert.ok(p.token);
  assert.strictEqual(pushes.find((x) => x.payload === p).opts.urgency, 'high');

  // Agent taps the notification -> app opens -> the waiting call is delivered -> answer.
  const incoming = new Promise((res) => {
    const s = ioc(base, { auth: { token: agent.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s); s.once('call:incoming', (d) => res({ s, d }));
  });
  const { s: as, d } = await incoming;
  assert.strictEqual(d.callId, r.callId);
  const accepted = once(cs, 'call:accepted');
  assert.ok((await emit(as, 'call:accept', { callId: r.callId })).ok);
  await accepted;
  await emit(cs, 'call:end', { callId: r.callId });
  as.close();
});

test('decline from the notification; missed call when nobody answers', async () => {
  const cust = await reg('c2', 'customer');
  const agent = await reg('a2', 'agent');
  const orderId = await activeOrder(cust, agent);
  const sub = fakeSubscription('a2');
  await api.post('/api/push/subscribe').set(agent.auth).send({ subscription: sub });
  const cs = await connect(cust.token);

  const r = await emit(cs, 'call:start', { orderId });
  await wait(50);
  const p = pushesFor(sub.endpoint).find((x) => x.type === 'call' && x.callId === r.callId);
  assert.strictEqual((await api.post('/api/push/call-action').send({ callId: r.callId, userId: p.userId, action: 'decline', token: 'bad.token' })).status, 403);
  const ended = once(cs, 'call:ended');
  assert.deepStrictEqual((await api.post('/api/push/call-action').send({ callId: r.callId, userId: p.userId, action: 'decline', token: p.token })).body, { ok: true });
  assert.strictEqual((await ended).reason, 'declined');

  // Nobody answers -> caller told, phone shows "Missed call".
  const r2 = await emit(cs, 'call:start', { orderId });
  const e2 = await once(cs, 'call:ended', 5000);
  assert.strictEqual(e2.reason, 'push_no_answer');
  await wait(50);
  const missed = pushesFor(sub.endpoint).find((x) => x.type === 'call-ended' && x.callId === r2.callId);
  assert.ok(missed && missed.missed === true);
});

test('app open but in the background also rings by push; dead subscriptions are removed', async () => {
  const cust = await reg('c3', 'customer');
  const agent = await reg('a3', 'agent');
  const orderId = await activeOrder(cust, agent);
  const sub = fakeSubscription('a3');
  await api.post('/api/push/subscribe').set(agent.auth).send({ subscription: sub });
  const cs = await connect(cust.token);
  const as = await connect(agent.token, { visible: false }); // app open, screen off / other app in front
  const inc = once(as, 'call:incoming');
  const r = await emit(cs, 'call:start', { orderId });
  assert.strictEqual(r.notified, 'push');
  await inc;
  await emit(cs, 'call:end', { callId: r.callId });

  as.emit('presence', { visible: true });
  await wait(50);
  const r2 = await emit(cs, 'call:start', { orderId });
  assert.strictEqual(r2.notified, 'app'); // on screen -> in-app ringing only
  await emit(cs, 'call:end', { callId: r2.callId });

  failNext = Object.assign(new Error('gone'), { statusCode: 410 });
  await api.post('/api/push/test').set(agent.auth);
  assert.strictEqual((await api.get('/api/push/status').set(agent.auth)).body.devices, 0);
});

test('order updates reach the customer as notifications when the app is closed', async () => {
  const cust = await reg('c4', 'customer');
  const agent = await reg('a4', 'agent');
  const sub = fakeSubscription('c4');
  await api.post('/api/push/subscribe').set(cust.auth).send({ subscription: sub });
  const orderId = await activeOrder(cust, agent);
  await wait(100);
  assert.ok(pushesFor(sub.endpoint).some((x) => x.type === 'order' && x.title === 'Delivery partner assigned' && x.url === `/orders/${orderId}`));
  for (const st of ['picked_up', 'out_for_delivery', 'delivered']) await api.post(`/api/orders/${orderId}/status`).set(agent.auth).send({ status: st });
  await wait(100);
  const titles = pushesFor(sub.endpoint).filter((x) => x.type === 'order').map((x) => x.title);
  assert.ok(titles.includes('Your order is on the way') && titles.includes('Order delivered'), titles.join(','));
});