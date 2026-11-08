// The other side's internet is off: detect it, end the internet call, and log
// when the user picks the normal (masked) call option.
process.env.ADMIN_SIGNUP_CODE = 'TEST-ADMIN-CODE';
process.env.CALL_RING_TIMEOUT_SEC = '20';
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { io: ioc } = require('socket.io-client');
const { createServer } = require('../src/app');

const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const once = (s, ev, ms = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
  s.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

let srv; let api; let base;
const sockets = [];
const connect = (token) => new Promise((resolve, reject) => {
  const s = ioc(base, { auth: { token }, transports: ['websocket'], forceNew: true });
  sockets.push(s); s.on('connect', () => resolve(s)); s.on('connect_error', reject);
});
const reg = async (who, role) => {
  const body = { name: `T ${who}`, email: `${who}@t.dev`, password: 'secret123', role };
  if (role === 'admin') body.adminCode = 'TEST-ADMIN-CODE';
  const r = await api.post('/api/auth/register').send(body);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, user: r.body.user, auth: { Authorization: `Bearer ${r.body.token}` } };
};
const activeOrder = async (cust, agent) => {
  const o = await api.post('/api/orders').set(cust.auth).send({ restaurantId: 1, items: [{ menuItemId: 1, qty: 1 }], address: '1 Test Street, Harohalli', lat: 12.683, lng: 77.472 });
  assert.strictEqual((await api.post(`/api/orders/${o.body.order.id}/accept`).set(agent.auth)).status, 200);
  return o.body.order.id;
};

test.before(async () => {
  srv = await createServer({ dbOptions: { sqlitePath: ':memory:', databaseUrl: '' }, quiet: true, clientDist: '/nonexistent' });
  await new Promise((r) => srv.server.listen(0, r));
  base = `http://localhost:${srv.server.address().port}`;
  api = request(base);
});
test.after(async () => { sockets.forEach((s) => s.close()); await srv.close(); });

test('callee loses internet while ringing: caller is told immediately (not after the ring timeout)', async () => {
  const cust = await reg('c1', 'customer');
  const agent = await reg('a1', 'agent');
  const orderId = await activeOrder(cust, agent);
  const cs = await connect(cust.token);
  const as = await connect(agent.token);
  const inc = once(as, 'call:incoming');
  const r = await emit(cs, 'call:start', { orderId });
  assert.ok(r.ok);
  await inc;
  const ended = once(cs, 'call:ended');
  as.disconnect(); // agent's internet goes off
  const e = await ended;
  assert.strictEqual(e.reason, 'callee_offline');
});

test('internet off at call time, and dropping mid-call, are both reported to the caller', async () => {
  const cust = await reg('c2', 'customer');
  const agent = await reg('a2', 'agent');
  const orderId = await activeOrder(cust, agent);
  const cs = await connect(cust.token);
  assert.strictEqual((await emit(cs, 'call:start', { orderId })).reason, 'offline');

  const as = await connect(agent.token);
  const inc = once(as, 'call:incoming');
  const r = await emit(cs, 'call:start', { orderId });
  await inc;
  await emit(as, 'call:accept', { callId: r.callId });
  cs.emit('call:connected', { callId: r.callId, connectionType: 'direct' });
  await new Promise((res) => setTimeout(res, 100));
  const ended = once(cs, 'call:ended');
  as.disconnect();
  assert.strictEqual((await ended).reason, 'disconnected');
});

test('normal (masked) call option is logged, only for participants and only while the order is active', async () => {
  const admin = await reg('adm', 'admin');
  const cust = await reg('c3', 'customer');
  const agent = await reg('a3', 'agent');
  const outsider = await reg('o3', 'agent');
  const orderId = await activeOrder(cust, agent);

  const ok = await api.post('/api/calls/masked-request').set(cust.auth).send({ orderId, reason: 'offline' });
  assert.deepStrictEqual([ok.status, ok.body.providerConnected], [201, false]);
  assert.strictEqual((await api.post('/api/calls/masked-request').set(outsider.auth).send({ orderId })).status, 404);

  const hist = (await api.get(`/api/orders/${orderId}/calls`).set(agent.auth)).body.calls;
  assert.ok(hist.some((c) => c.channel === 'masked' && c.status === 'requested' && c.caller_role === 'customer'));

  const stats = (await api.get('/api/admin/stats').set(admin.auth)).body;
  assert.ok(stats.calls.maskedRequests >= 1);
  assert.ok(stats.calls.internetOff >= 2); // offline + callee_offline from the earlier tests
  assert.ok(!('masked' in stats.calls.byStatus) && !('requested' in stats.calls.byStatus), 'masked requests are not counted as internet calls');

  for (const s of ['picked_up', 'out_for_delivery', 'delivered']) await api.post(`/api/orders/${orderId}/status`).set(agent.auth).send({ status: s });
  const closed = await api.post('/api/calls/masked-request').set(cust.auth).send({ orderId });
  assert.deepStrictEqual([closed.status, closed.body.reason], [403, 'order_delivered']);
});

test('phone numbers are no longer collected', async () => {
  const r = await api.post('/api/auth/register').send({ name: 'P', email: 'p@t.dev', password: 'secret1', role: 'customer', phone: '9876543210' });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(Object.keys(r.body.user).sort(), ['email', 'id', 'name', 'role']);
});