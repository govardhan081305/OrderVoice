const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const { newOrderId, getOrder, serializeOrder } = require('../orders');
const { NEXT_STATUS, roleInOrder } = require('../policy');
const { haversine, validPoint } = require('../geo');
const config = require('../config');

module.exports = function orderRoutes({ db, events }) {
  const r = express.Router();
  r.use(requireAuth);

  const canView = (order, user) => user.role === 'admin' || !!roleInOrder(order, user.id);

  // Customer places an order.
  r.post('/', requireRole('customer'), async (req, res) => {
    const { restaurantId, items, address, lat, lng } = req.body || {};
    if (!restaurantId || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Add at least one item' });
    if (!address || String(address).trim().length < 5) return res.status(400).json({ error: 'Enter a delivery address' });
    const restaurant = await db.get('SELECT id, lat, lng FROM restaurants WHERE id = ?', [Number(restaurantId)]);
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    // The delivery pin is required (tracking and routes use it) and must be within the delivery radius.
    const pin = { lat: Number(lat), lng: Number(lng) };
    if (lat == null || lng == null || lat === '' || lng === '' || !validPoint(pin)) return res.status(400).json({ error: 'Set your delivery location on the map' });
    const km = haversine(pin, restaurant) / 1000;
    if (km > config.deliveryRadiusKm) return res.status(400).json({ error: `This address is ${km.toFixed(1)} km from the restaurant. We deliver within ${config.deliveryRadiusKm} km.` });

    const lines = [];
    for (const it of items) {
      const qty = Math.floor(Number(it.qty));
      if (!(qty >= 1 && qty <= 20)) return res.status(400).json({ error: 'Quantity must be 1-20' });
      const m = await db.get('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?', [Number(it.menuItemId), restaurant.id]);
      if (!m) return res.status(400).json({ error: 'An item is not on this restaurant\'s menu' });
      lines.push({ m, qty });
    }
    const subtotal = lines.reduce((s, l) => s + l.m.price * l.qty, 0);
    const total = subtotal + 30; // flat delivery fee
    const id = newOrderId();

    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO orders (id, customer_id, restaurant_id, status, total, address, delivery_lat, delivery_lng, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, req.user.id, restaurant.id, 'placed', total, String(address).trim().slice(0, 300), pin.lat, pin.lng, Date.now()],
      );
      for (const { m, qty } of lines) {
        await tx.run('INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES (?,?,?,?,?)', [id, m.id, m.name, m.price, qty]);
      }
    });
    events.emit('order:changed', id, 'placed');
    res.status(201).json({ order: await serializeOrder(db, await getOrder(db, id), req.user) });
  });

  // My orders (customer: placed by me; agent: assigned to me; admin: all).
  r.get('/', async (req, res) => {
    let rows;
    if (req.user.role === 'customer') rows = await db.all('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    else if (req.user.role === 'agent') rows = await db.all('SELECT * FROM orders WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    else rows = await db.all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');
    res.json({ orders: await Promise.all(rows.map((o) => serializeOrder(db, o, req.user))) });
  });

  // Orders waiting for a delivery partner.
  r.get('/available', requireRole('agent'), async (req, res) => {
    const rows = await db.all("SELECT * FROM orders WHERE status = 'placed' AND agent_id IS NULL ORDER BY created_at ASC LIMIT 30");
    // Agents see only the area, not the full address, before accepting.
    const out = await Promise.all(rows.map(async (o) => {
      const s = await serializeOrder(db, o, req.user);
      return { ...s, address: s.address.split(',').slice(-2).join(',').trim() || 'Nearby', customer: null };
    }));
    res.json({ orders: out });
  });

  r.get('/:id', async (req, res) => {
    const order = await getOrder(db, req.params.id);
    if (!order || !canView(order, req.user)) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: await serializeOrder(db, order, req.user) });
  });

  // Agent accepts. The WHERE clause makes this atomic: two agents can't both win.
  r.post('/:id/accept', requireRole('agent'), async (req, res) => {
    const active = await db.get(
      "SELECT id FROM orders WHERE agent_id = ? AND status IN ('accepted','picked_up','out_for_delivery')", [req.user.id]);
    if (active) return res.status(409).json({ error: 'Finish your current delivery first' });
    const { changes } = await db.run(
      "UPDATE orders SET agent_id = ?, status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'placed' AND agent_id IS NULL",
      [req.user.id, Date.now(), String(req.params.id)],
    );
    if (!changes) return res.status(409).json({ error: 'This order was already taken or cancelled' });
    events.emit('order:changed', req.params.id, 'accepted');
    res.json({ order: await serializeOrder(db, await getOrder(db, req.params.id), req.user) });
  });

  // Agent moves the order forward one step.
  r.post('/:id/status', requireRole('agent'), async (req, res) => {
    const order = await getOrder(db, req.params.id);
    if (!order || Number(order.agent_id) !== req.user.id) return res.status(404).json({ error: 'Order not found' });
    const next = NEXT_STATUS[order.status];
    if (!next || req.body?.status !== next) return res.status(400).json({ error: `Next status must be ${next || 'none'}` });
    const now = Date.now();
    const { changes } = await db.run(
      `UPDATE orders SET status = ?${next === 'delivered' ? ', delivered_at = ?' : ''} WHERE id = ? AND status = ?`,
      next === 'delivered' ? [next, now, order.id, order.status] : [next, order.id, order.status],
    );
    if (!changes) return res.status(409).json({ error: 'Order changed, refresh and try again' });
    events.emit('order:changed', order.id, next);
    res.json({ order: await serializeOrder(db, await getOrder(db, order.id), req.user) });
  });

  // Customer cancels (only before pickup).
  r.post('/:id/cancel', requireRole('customer'), async (req, res) => {
    const order = await getOrder(db, req.params.id);
    if (!order || Number(order.customer_id) !== req.user.id) return res.status(404).json({ error: 'Order not found' });
    const { changes } = await db.run(
      "UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status IN ('placed','accepted')",
      [Date.now(), order.id],
    );
    if (!changes) return res.status(409).json({ error: 'Orders can only be cancelled before pickup' });
    events.emit('order:changed', order.id, 'cancelled');
    res.json({ order: await serializeOrder(db, await getOrder(db, order.id), req.user) });
  });

  // Call history for this order (participants and admin).
  r.get('/:id/calls', async (req, res) => {
    const order = await getOrder(db, req.params.id);
    if (!order || !canView(order, req.user)) return res.status(404).json({ error: 'Order not found' });
    const calls = await db.all(
      `SELECT id, caller_role, status, end_reason, created_at, connected_at, ended_at, duration_sec, connection_type, channel
       FROM call_logs WHERE order_id = ? ORDER BY created_at DESC`, [order.id]);
    res.json({ calls });
  });

  return r;
};