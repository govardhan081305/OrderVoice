const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth');
const { getOrder } = require('../orders');
const { canCall, roleInOrder, REASON_TEXT } = require('../policy');
const { iceServersFor, turnMode } = require('../turn');

module.exports = function callRoutes(ctx) {
  const { db } = ctx;
  const r = express.Router();
  r.use(requireAuth);

  // ICE config (STUN + short-lived TURN credentials). Only handed out to someone
  // who is allowed to call for this order right now, so random accounts can't
  // use our TURN relay as free bandwidth.
  r.get('/ice-config', async (req, res) => {
    const order = await getOrder(db, req.query.orderId);
    const check = canCall(order, req.user.id, { graceMinutes: config.call.graceMinutes });
    if (!check.ok) return res.status(403).json({ error: REASON_TEXT[check.reason], reason: check.reason });
    res.json({
      iceServers: iceServersFor(req.user.id),
      turnConfigured: !!turnMode(),
    });
  });

  // ---- Normal (masked) call option ----------------------------------------
  // When the other side's internet is off, the app offers a normal phone call
  // through a number-masking provider (like Swiggy/Zomato use). The provider is
  // not connected in this prototype; we record the request so the admin can
  // see how often internet calling wasn't possible (= minutes that would be paid).
  const REASONS = new Set(['offline', 'callee_offline', 'peer_offline', 'disconnected', 'connection_failed', 'self_offline']);
  r.post('/masked-request', async (req, res) => {
    const order = await getOrder(db, req.body?.orderId);
    if (!order || !roleInOrder(order, req.user.id)) return res.status(404).json({ error: 'Order not found' });
    const check = canCall(order, req.user.id, { graceMinutes: config.call.graceMinutes });
    if (!check.ok) return res.status(403).json({ error: REASON_TEXT[check.reason], reason: check.reason });
    const reason = REASONS.has(req.body?.reason) ? req.body.reason : 'offline';
    const now = Date.now();
    await db.run(
      `INSERT INTO call_logs (id, order_id, caller_id, callee_id, caller_role, status, end_reason, created_at, ended_at, channel)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), order.id, req.user.id, check.calleeId, check.role, 'requested', reason, now, now, 'masked']);
    ctx.io?.to('admins').emit('admin:calls-changed');
    return res.status(201).json({ ok: true, providerConnected: false });
  });

  return r;
};