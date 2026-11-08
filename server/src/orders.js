// Order data access + the shape sent to clients.
const crypto = require('crypto');
const config = require('./config');
const { roomWindow, canCall } = require('./policy');

// Non-sequential, hard-to-guess order IDs (defence in depth: the call room is
// protected by login + role checks, not by the ID being secret).
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newOrderId() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `OV-${s}`;
}

async function getOrder(db, id) {
  return db.get('SELECT * FROM orders WHERE id = ?', [String(id)]);
}

// Returns what a given viewer may see. Never includes phone numbers or emails
// of the other party: names only.
async function serializeOrder(db, order, viewer) {
  const [restaurant, items, customer, agent] = await Promise.all([
    db.get('SELECT id, name, emoji, address, lat, lng FROM restaurants WHERE id = ?', [order.restaurant_id]),
    db.all('SELECT name, price, qty FROM order_items WHERE order_id = ? ORDER BY id', [order.id]),
    db.get('SELECT id, name FROM users WHERE id = ?', [order.customer_id]),
    order.agent_id ? db.get('SELECT id, name FROM users WHERE id = ?', [order.agent_id]) : null,
  ]);
  const window = roomWindow(order, config.call.graceMinutes);
  const check = viewer ? canCall(order, viewer.id, { graceMinutes: config.call.graceMinutes }) : { ok: false };
  return {
    id: order.id,
    status: order.status,
    total: order.total,
    address: order.address,
    deliveryLat: order.delivery_lat,
    deliveryLng: order.delivery_lng,
    createdAt: order.created_at,
    acceptedAt: order.accepted_at,
    deliveredAt: order.delivered_at,
    cancelledAt: order.cancelled_at,
    restaurant,
    items,
    customer: customer ? { id: customer.id, name: customer.name } : null,
    agent: agent ? { id: agent.id, name: agent.name } : null,
    call: {
      allowed: check.ok,
      reason: check.ok ? null : check.reason,
      closesAt: window.open ? window.closesAt : null,
    },
  };
}

module.exports = { newOrderId, getOrder, serializeOrder };
