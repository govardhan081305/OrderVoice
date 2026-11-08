// End-to-end tests of the REST API and the OrderVoice signaling rules.
process.env.CALL_RING_TIMEOUT_SEC = '2';
process.env.ADMIN_SIGNUP_CODE = 'TEST-ADMIN-CODE';
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { io: ioc } = require('socket.io-client');
const config = require('../src/config');
const { createServer } = require('../src/app');

let srv; let base; let api;
const tokens = {};
const sockets = [];

const connect = (token) => new Promise((resolve, reject) => {
  const s = ioc(base, { auth: { token }, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const once = (s, ev, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
  s.once(ev, (d) => { clearTimeout(t); resolve(d); });
});
const notReceived = (s, ev, ms = 300) => new Promise((resolve, reject) => {
  const h = () => reject(new Error(`unexpected ${ev}`));
  s.once(ev, h);
  setTimeout(() => { s.off(ev, h); resolve(); }, ms);
});
const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function placeOrder(who = 'customer') {
  const r = await api.post('/api/orders').set(auth(who)).send({
    restaurantId: 1, items: [{ menuItemId: 1, qty: 2 }], address: '12, 2nd Cross, Harohalli', lat: 12.6845, lng: 77.4745,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.order;
}

test.before(async () => {
  srv = await createServer({ dbOptions: { sqlitePath: ':memory:', databaseUrl: '' }, quiet: true, clientDist: '/nonexistent' });
  await new Promise((r) => srv.server.listen(0, r));
  base = `http://localhost:${srv.server.address().port}`;
  api = request(base);
  // No accounts are seeded: everyone signs up.
  for (const [who, role] of [['admin', 'admin'], ['customer', 'customer'], ['customer2', 'customer'], ['agent', 'agent'], ['agent2', 'agent']]) {
    const body = { name: `Test ${who}`, email: `${who}@test.dev`, password: 'secret123', role };
    if (role === 'admin') body.adminCode = 'TEST-ADMIN-CODE';
    const r = await api.post('/api/auth/register').send(body);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    tokens[who] = r.body.token;
  }
});

test.after(async () => { sockets.forEach((s) => s.close()); await srv.close(); });

test('auth: register, wrong password, me', async () => {
  const r = await api.post('/api/auth/register').send({ name: 'New Agent', email: 'new@x.dev', password: 'secret1', role: 'agent' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await api.post('/api/auth/register').send({ name: 'X', email: 'new@x.dev', password: 'secret1', role: 'agent'})).status, 409);
  assert.strictEqual((await api.post('/api/auth/register').send({ name: 'X', email: 'y@x.dev', password: 'secret1', role: 'superuser' })).status, 400);

  // Admin sign-up needs the right code.
  assert.strictEqual((await api.post('/api/auth/register').send({ name: 'X', email: 'a1@x.dev', password: 'secret1', role: 'admin' })).status, 403);
  assert.strictEqual((await api.post('/api/auth/register').send({ name: 'X', email: 'a1@x.dev', password: 'secret1', role: 'admin', adminCode: 'wrong' })).status, 403);
  const adm = await api.post('/api/auth/register').send({ name: 'Second Admin', email: 'a1@x.dev', password: 'secret1', role: 'admin', adminCode: 'TEST-ADMIN-CODE' });
  assert.deepStrictEqual([adm.status, adm.body.user.role], [201, 'admin']);

  // Login: correct role works, wrong role tab is refused with a helpful message, wrong password is 401.
  assert.strictEqual((await api.post('/api/auth/login').send({ email: 'customer@test.dev', password: 'secret123', role: 'customer' })).status, 200);
  const wrongRole = await api.post('/api/auth/login').send({ email: 'customer@test.dev', password: 'secret123', role: 'agent' });
  assert.strictEqual(wrongRole.status, 403);
  assert.match(wrongRole.body.error, /registered as Customer/);
  assert.strictEqual((await api.post('/api/auth/login').send({ email: 'new@x.dev', password: 'secret1', role: 'agent' })).status, 200);
  assert.strictEqual((await api.post('/api/auth/login').send({ email: 'customer@test.dev', password: 'nope' })).status, 401);
  const me = await api.get('/api/auth/me').set(auth('customer'));
  assert.strictEqual(me.body.user.role, 'customer');
  assert.strictEqual((await api.get('/api/orders')).status, 401);
});

test('socket rejects connections without a valid token', async () => {
  await assert.rejects(connect('garbage'));
});

test('full OrderVoice flow: room rules, ringing, signaling, logs', async () => {
  const cSock = await connect(tokens.customer);
  const aSock = await connect(tokens.agent);
  const outsider = await connect(tokens.agent2);

  const order = await placeOrder();
  assert.match(order.id, /^OV-[2-9A-Z]{8}$/);
  assert.strictEqual(order.call.allowed, false);

  // Before an agent accepts, the room is closed.
  let r = await emit(cSock, 'call:start', { orderId: order.id });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'no_agent_assigned']);

  // Agent sees it as available, without the full address.
  const avail = await api.get('/api/orders/available').set(auth('agent'));
  const listed = avail.body.orders.find((o) => o.id === order.id);
  assert.ok(listed && !listed.address.includes('12, 3rd Cross') && listed.customer === null);

  const updateP = once(cSock, 'order:update');
  assert.strictEqual((await api.post(`/api/orders/${order.id}/accept`).set(auth('agent'))).status, 200);
  assert.strictEqual((await updateP).status, 'accepted');
  assert.strictEqual((await api.post(`/api/orders/${order.id}/accept`).set(auth('agent2'))).status, 409);

  // Knowing the Order ID is not enough.
  r = await emit(outsider, 'call:start', { orderId: order.id });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'not_a_participant']);
  assert.strictEqual((await api.get(`/api/calls/ice-config?orderId=${order.id}`).set(auth('agent2'))).status, 403);
  assert.strictEqual((await api.get(`/api/orders/${order.id}`).set(auth('agent2'))).status, 404);
  const ice = await api.get(`/api/calls/ice-config?orderId=${order.id}`).set(auth('customer'));
  assert.strictEqual(ice.status, 200);
  assert.ok(ice.body.iceServers.length >= 1);

  // Customer sees agent's name only: no email/phone.
  const view = await api.get(`/api/orders/${order.id}`).set(auth('customer'));
  assert.deepStrictEqual(Object.keys(view.body.order.agent).sort(), ['id', 'name']);
  assert.strictEqual(view.body.order.call.allowed, true);

  // Customer -> agent call.
  const incomingP = once(aSock, 'call:incoming');
  r = await emit(cSock, 'call:start', { orderId: order.id });
  assert.ok(r.ok, JSON.stringify(r));
  const incoming = await incomingP;
  assert.strictEqual(incoming.callId, r.callId);
  assert.strictEqual(incoming.from.role, 'customer');

  // A second call on the same order while ringing is refused.
  assert.strictEqual((await emit(aSock, 'call:start', { orderId: order.id })).reason, 'call_in_progress');

  // Outsider can't accept or inject signals.
  assert.strictEqual((await emit(outsider, 'call:accept', { callId: r.callId })).ok, false);

  const acceptedP = once(cSock, 'call:accepted');
  assert.ok((await emit(aSock, 'call:accept', { callId: r.callId })).ok);
  await acceptedP;

  const offerP = once(aSock, 'signal');
  cSock.emit('signal', { callId: r.callId, data: { type: 'offer', sdp: 'v=0 fake' } });
  assert.strictEqual((await offerP).data.type, 'offer');
  const injectedP = notReceived(cSock, 'signal');
  outsider.emit('signal', { callId: r.callId, data: { type: 'answer', sdp: 'evil' } });
  await injectedP;
  const answerP = once(cSock, 'signal');
  aSock.emit('signal', { callId: r.callId, data: { type: 'answer', sdp: 'v=0 fake' } });
  assert.strictEqual((await answerP).data.type, 'answer');

  cSock.emit('call:connected', { callId: r.callId, connectionType: 'direct' });
  cSock.emit('call:stats', { callId: r.callId, stats: { rttMs: 40, jitterMs: 3, lossPct: 0, bitrateKbps: 32, connectionType: 'direct' } });
  aSock.emit('call:stats', { callId: r.callId, stats: { rttMs: 60, jitterMs: 5, lossPct: 1, bitrateKbps: 30 } });
  await new Promise((res) => setTimeout(res, 1100));
  const endedP = once(aSock, 'call:ended');
  assert.ok((await emit(cSock, 'call:end', { callId: r.callId })).ok);
  const ended = await endedP;
  assert.strictEqual(ended.status, 'completed');
  assert.ok(ended.duration >= 1);

  // Agent -> customer (either side can start), customer declines.
  const inc2P = once(cSock, 'call:incoming');
  const r2 = await emit(aSock, 'call:start', { orderId: order.id });
  assert.ok(r2.ok);
  assert.strictEqual((await inc2P).from.role, 'agent');
  const declinedP = once(aSock, 'call:ended');
  await emit(cSock, 'call:decline', { callId: r2.callId });
  assert.strictEqual((await declinedP).reason, 'declined');

  // Unanswered call times out as missed.
  const r3 = await emit(aSock, 'call:start', { orderId: order.id });
  assert.ok(r3.ok);
  assert.strictEqual((await once(aSock, 'call:ended', 4000)).reason, 'no_answer');

  // Callee offline.
  cSock.close();
  await new Promise((res) => setTimeout(res, 100));
  assert.strictEqual((await emit(aSock, 'call:start', { orderId: order.id })).reason, 'offline');

  const logs = await api.get(`/api/orders/${order.id}/calls`).set(auth('customer'));
  const statuses = logs.body.calls.map((c) => c.status).sort();
  assert.deepStrictEqual(statuses, ['completed', 'declined', 'missed', 'missed']);
  const done = logs.body.calls.find((c) => c.status === 'completed');
  assert.strictEqual(done.connection_type, 'direct');

  const admin = await api.get('/api/admin/stats').set(auth('admin'));
  assert.strictEqual(admin.status, 200);
  assert.strictEqual(admin.body.calls.avgRttMs, 50);
  assert.strictEqual(admin.body.calls.avgPacketLossPct, 0.5);
  assert.ok(admin.body.cost.savingPct > 99); // direct calls have no relay cost
  assert.strictEqual((await api.get('/api/admin/stats').set(auth('customer'))).status, 403);
});

test('cancelling an order closes its room and ends a live call', async () => {
  const cSock = await connect(tokens.customer2);
  const aSock = await connect(tokens.agent2);
  const order = await placeOrder('customer2');
  assert.strictEqual((await api.post(`/api/orders/${order.id}/accept`).set(auth('agent2'))).status, 200);
  const incP = once(aSock, 'call:incoming');
  const r = await emit(cSock, 'call:start', { orderId: order.id });
  await incP;
  await emit(aSock, 'call:accept', { callId: r.callId });
  const aEnded = once(aSock, 'call:ended');
  const cEnded = once(cSock, 'call:ended');
  assert.strictEqual((await api.post(`/api/orders/${order.id}/cancel`).set(auth('customer2'))).status, 200);
  assert.strictEqual((await aEnded).reason, 'room_closed');
  assert.strictEqual((await cEnded).reason, 'room_closed');
  assert.strictEqual((await emit(cSock, 'call:start', { orderId: order.id })).reason, 'order_cancelled');
});

test('delivery closes calling for both sides and ends a live call', async () => {
  const cSock = await connect(tokens.customer2);
  const aSock = await connect(tokens.agent2);
  const order = await placeOrder('customer2');
  await api.post(`/api/orders/${order.id}/accept`).set(auth('agent2'));
  assert.strictEqual((await api.post(`/api/orders/${order.id}/status`).set(auth('agent2')).send({ status: 'delivered' })).status, 400);
  for (const s of ['picked_up', 'out_for_delivery']) {
    assert.strictEqual((await api.post(`/api/orders/${order.id}/status`).set(auth('agent2')).send({ status: s })).status, 200, s);
  }

  // A call is in progress when the agent marks the order delivered.
  const incP = once(aSock, 'call:incoming');
  const r = await emit(cSock, 'call:start', { orderId: order.id });
  assert.ok(r.ok);
  await incP;
  await emit(aSock, 'call:accept', { callId: r.callId });
  const aEnded = once(aSock, 'call:ended');
  const cEnded = once(cSock, 'call:ended');
  assert.strictEqual((await api.post(`/api/orders/${order.id}/status`).set(auth('agent2')).send({ status: 'delivered' })).status, 200);
  assert.strictEqual((await aEnded).reason, 'room_closed');
  assert.strictEqual((await cEnded).reason, 'room_closed');
  assert.strictEqual((await api.post(`/api/orders/${order.id}/cancel`).set(auth('customer2'))).status, 409);

  // After delivery: no call option for either side, and the server refuses calls.
  for (const who of ['customer2', 'agent2']) {
    const v = await api.get(`/api/orders/${order.id}`).set(auth(who));
    assert.deepStrictEqual([v.body.order.call.allowed, v.body.order.call.reason], [false, 'order_delivered'], who);
    assert.strictEqual((await api.get(`/api/calls/ice-config?orderId=${order.id}`).set(auth(who))).status, 403);
  }
  assert.strictEqual((await emit(cSock, 'call:start', { orderId: order.id })).reason, 'order_delivered');
  assert.strictEqual((await emit(aSock, 'call:start', { orderId: order.id })).reason, 'order_delivered');

  // Optional: a grace period can be switched on with CALL_GRACE_MINUTES.
  config.call.graceMinutes = 15;
  const g = await api.get(`/api/orders/${order.id}`).set(auth('customer2'));
  assert.strictEqual(g.body.order.call.allowed, true);
  config.call.graceMinutes = 0;
});

test('TURN credentials follow the coturn REST scheme', () => {
  const crypto = require('crypto');
  const { turnCredentials } = require('../src/turn');
  const c = turnCredentials(7, { secret: 's3cret', ttlSec: 60, now: 1_700_000_000_000 });
  assert.strictEqual(c.username, '1700000060:ov-7');
  assert.strictEqual(c.credential, crypto.createHmac('sha1', 's3cret').update('1700000060:ov-7').digest('base64'));
});

test('ICE servers: hosted TURN with a fixed login, own coturn wins when both are set', () => {
  const { iceServersFor, turnMode } = require('../src/turn');
  const base = { stunUrls: ['stun:s:3478'], turnUrls: ['turn:t:80'], turnSecret: '', turnTtlSec: 60, turnUsername: 'u', turnPassword: 'p' };
  assert.equal(turnMode(base), 'static');
  assert.deepEqual(iceServersFor(1, base)[1], { urls: ['turn:t:80'], username: 'u', credential: 'p' });
  assert.equal(turnMode({ ...base, turnSecret: 'x' }), 'rest');
  assert.notEqual(iceServersFor(1, { ...base, turnSecret: 'x' })[1].username, 'u');
  assert.equal(turnMode({ ...base, turnPassword: '' }), null);
  assert.equal(iceServersFor(1, { ...base, turnPassword: '' }).length, 1);
});