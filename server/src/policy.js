// OrderVoice call-room rules, as pure functions so they are easy to unit test.
//
// A "call room" exists per order. It OPENS when an agent is assigned and CLOSES
// as soon as the order is delivered or cancelled. (Optional: set
// CALL_GRACE_MINUTES > 0 to keep it open for a few minutes after delivery.)
// Only the order's customer and its assigned agent may use it. Knowing the
// Order ID alone is never enough.

const OPEN_STATUSES = new Set(['accepted', 'picked_up', 'out_for_delivery']);

function roomWindow(order, graceMinutes) {
  if (!order) return { open: false, reason: 'order_not_found' };
  if (order.status === 'cancelled') return { open: false, reason: 'order_cancelled' };
  if (!order.agent_id || order.status === 'placed') return { open: false, reason: 'no_agent_assigned' };
  if (OPEN_STATUSES.has(order.status)) return { open: true, closesAt: null };
  if (order.status === 'delivered') {
    if (!(graceMinutes > 0)) return { open: false, reason: 'order_delivered' };
    const closesAt = Number(order.delivered_at) + graceMinutes * 60_000;
    return { open: true, closesAt };
  }
  return { open: false, reason: 'invalid_status' };
}

function roleInOrder(order, userId) {
  if (!order) return null;
  if (Number(order.customer_id) === Number(userId)) return 'customer';
  if (order.agent_id != null && Number(order.agent_id) === Number(userId)) return 'agent';
  return null;
}

/**
 * Can `userId` start (or join) a call for `order` at time `now`?
 * Returns { ok: true, role, calleeId } or { ok: false, reason }.
 */
function canCall(order, userId, { now = Date.now(), graceMinutes = 0 } = {}) {
  if (!order) return { ok: false, reason: 'order_not_found' };
  const role = roleInOrder(order, userId);
  if (!role) return { ok: false, reason: 'not_a_participant' };
  const w = roomWindow(order, graceMinutes);
  if (!w.open) return { ok: false, reason: w.reason };
  if (w.closesAt != null && now > w.closesAt) return { ok: false, reason: 'room_closed' };
  const calleeId = role === 'customer' ? Number(order.agent_id) : Number(order.customer_id);
  return { ok: true, role, calleeId, closesAt: w.closesAt };
}

// Valid status transitions for the agent.
const NEXT_STATUS = { accepted: 'picked_up', picked_up: 'out_for_delivery', out_for_delivery: 'delivered' };

const REASON_TEXT = {
  order_not_found: 'Order not found.',
  not_a_participant: 'Only the customer and the assigned delivery partner can call for this order.',
  order_cancelled: 'This order was cancelled, so calling is closed.',
  order_delivered: 'This order has been delivered, so calling is closed.',
  no_agent_assigned: 'Calling opens once a delivery partner accepts the order.',
  room_closed: 'The call window for this order has closed.',
  invalid_status: 'Calling is not available for this order.',
  offline: 'The other person is offline right now. Try again in a moment.',
  busy: 'The other person is on another call.',
  call_in_progress: 'A call for this order is already in progress.',
  rate_limited: 'Too many call attempts. Please wait a few minutes.',
};

module.exports = { canCall, roomWindow, roleInOrder, NEXT_STATUS, REASON_TEXT, OPEN_STATUSES };