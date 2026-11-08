const test = require('node:test');
const assert = require('node:assert');
const { canCall } = require('../src/policy');

const base = { id: 'OV-X', customer_id: 1, agent_id: 2, status: 'accepted', delivered_at: null };

test('customer and assigned agent can call while order is active', () => {
  for (const status of ['accepted', 'picked_up', 'out_for_delivery']) {
    assert.deepStrictEqual(canCall({ ...base, status }, 1).ok, true);
    assert.deepStrictEqual(canCall({ ...base, status }, 2).ok, true);
  }
  assert.strictEqual(canCall(base, 1).calleeId, 2);
  assert.strictEqual(canCall(base, 2).calleeId, 1);
});

test('anyone else is rejected even if they know the Order ID', () => {
  assert.deepStrictEqual(canCall(base, 99), { ok: false, reason: 'not_a_participant' });
});

test('room is closed before an agent is assigned', () => {
  assert.strictEqual(canCall({ ...base, status: 'placed', agent_id: null }, 1).reason, 'no_agent_assigned');
});

test('room is closed when the order is cancelled', () => {
  assert.strictEqual(canCall({ ...base, status: 'cancelled' }, 1).reason, 'order_cancelled');
});

test('room closes as soon as the order is delivered (default)', () => {
  const o = { ...base, status: 'delivered', delivered_at: 1_000_000 };
  assert.strictEqual(canCall(o, 1).reason, 'order_delivered');
  assert.strictEqual(canCall(o, 2).reason, 'order_delivered');
});

test('optional grace period after delivery, then closed', () => {
  const deliveredAt = 1_000_000;
  const o = { ...base, status: 'delivered', delivered_at: deliveredAt };
  assert.strictEqual(canCall(o, 1, { now: deliveredAt + 14 * 60_000, graceMinutes: 15 }).ok, true);
  assert.strictEqual(canCall(o, 1, { now: deliveredAt + 16 * 60_000, graceMinutes: 15 }).reason, 'room_closed');
});