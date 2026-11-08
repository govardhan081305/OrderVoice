// OrderVoice signaling server (Socket.IO).
//
// The server never touches audio. It only:
//   1. checks that a caller is allowed to call for an order (login + role + order state),
//   2. rings the other party,
//   3. relays WebRTC offer/answer/ICE messages between exactly those two sockets,
//   4. writes a call log (no audio is recorded),
//   5. closes the room (and ends any live call) when the order is delivered or cancelled,
//   6. tells the caller when the other side's internet is off, so the app can offer a normal (masked) call.
const crypto = require('crypto');
const config = require('./config');
const { verifyToken } = require('./auth');
const { getOrder } = require('./orders');
const { canCall, REASON_TEXT, OPEN_STATUSES } = require('./policy');

const MAX_SIGNAL_BYTES = 64 * 1024;
const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate']);

function attachSignaling(io, ctx) {
  const { db, events } = ctx;
  const sessions = new Map(); // callId -> session
  const lastLocation = new Map(); // orderId -> { lat, lng, at }
  const attempts = new Map(); // `${userId}:${orderId}` -> [timestamps]
  const grace = () => config.call.graceMinutes;

  const fail = (ack, reason) => typeof ack === 'function' && ack({ ok: false, reason, message: REASON_TEXT[reason] || reason });
  const ok = (ack, data = {}) => typeof ack === 'function' && ack({ ok: true, ...data });
  const isOnline = (userId) => (io.sockets.adapter.rooms.get(`user:${userId}`)?.size || 0) > 0;
  const sessionForOrder = (orderId) => [...sessions.values()].find((s) => s.orderId === orderId);
  const userBusy = (userId) => [...sessions.values()].some((s) => s.callerId === userId || s.calleeId === userId);
  const otherSocket = (s, socketId) => (socketId === s.callerSocketId ? s.calleeSocketId : s.callerSocketId);
  const notifyAdmins = () => io.to('admins').emit('admin:calls-changed');
  // Is any of the user's app windows actually on screen? (Backgrounded phones may keep a socket but won't ring.)
  const hasVisibleSocket = (userId) => [...(io.sockets.adapter.rooms.get(`user:${userId}`) || [])]
    .some((sid) => io.sockets.sockets.get(sid)?.data.visible !== false);
  const answerUrl = (s) => `${s.calleeRole === 'agent' ? '/agent/orders/' : '/orders/'}${s.orderId}?answer=${s.id}`;

  function rateLimited(userId, orderId) {
    const key = `${userId}:${orderId}`;
    const now = Date.now();
    const list = (attempts.get(key) || []).filter((t) => now - t < 10 * 60_000);
    if (list.length >= config.call.maxCallsPer10Min) { attempts.set(key, list); return true; }
    list.push(now); attempts.set(key, list);
    return false;
  }

  async function logMissedImmediately(order, callerId, calleeId, role, reason) {
    const now = Date.now();
    await db.run(
      `INSERT INTO call_logs (id, order_id, caller_id, callee_id, caller_role, status, end_reason, created_at, ended_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), order.id, callerId, calleeId, role, reason === 'busy' ? 'busy' : 'missed', reason, now, now]);
    notifyAdmins();
  }

  // Ends a session exactly once and writes the final call log.
  async function finalize(s, status, reason, { notify = [] } = {}) {
    if (!sessions.has(s.id)) return;
    sessions.delete(s.id);
    clearTimeout(s.ringTimer);
    const endedAt = Date.now();
    const duration = s.connectedAt ? Math.max(0, Math.round((endedAt - s.connectedAt) / 1000)) : 0;
    const avg = (k) => {
      const vals = s.samples.map((x) => x[k]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
    };
    const finalStatus = status === 'completed' && !s.connectedAt ? 'failed' : status;
    await db.run(
      `UPDATE call_logs SET status = ?, end_reason = ?, answered_at = ?, connected_at = ?, ended_at = ?, duration_sec = ?,
         connection_type = ?, avg_rtt_ms = ?, jitter_ms = ?, packet_loss_pct = ?, bitrate_kbps = ? WHERE id = ?`,
      [finalStatus, reason, s.answeredAt || null, s.connectedAt || null, endedAt, duration,
        s.connectionType || null, avg('rttMs'), avg('jitterMs'), avg('lossPct'), avg('bitrateKbps'), s.id]);
    for (const target of notify) if (target) io.to(target).emit('call:ended', { callId: s.id, reason, status: finalStatus, duration });
    notifyAdmins();
    // The callee's phone was rung by push: replace the ringing notification (missed call) or clear it.
    if (s.pushed && !s.answeredAt) {
      ctx.push.send(s.calleeId, {
        type: 'call-ended', callId: s.id, orderId: s.orderId, missed: finalStatus === 'missed',
        from: s.incoming.from, url: answerUrl(s).split('?')[0],
      }, { ttl: 3600, urgency: 'normal' }).catch(console.error);
    }
  }

  io.use((socket, next) => {
    try {
      socket.data.user = verifyToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.data.visible = socket.handshake.auth?.visible !== false;
    socket.join(`user:${user.id}`);
    if (user.role === 'agent') socket.join('agents');
    if (user.role === 'admin') socket.join('admins');

    // The app reports when it goes to the background / comes back.
    socket.on('presence', ({ visible } = {}) => { socket.data.visible = !!visible; });

    // App opened (e.g. from the "incoming call" notification) while a call is ringing for this user.
    for (const s of sessions.values()) {
      if (s.calleeId === user.id && s.state === 'ringing') socket.emit('call:incoming', s.incoming);
    }

    // ---- Calling -------------------------------------------------------
    socket.on('call:start', async ({ orderId } = {}, ack) => {
      try {
        const order = await getOrder(db, orderId);
        const check = canCall(order, user.id, { graceMinutes: grace() });
        if (!check.ok) return fail(ack, check.reason);
        if (sessionForOrder(order.id)) return fail(ack, 'call_in_progress');
        if (rateLimited(user.id, order.id)) return fail(ack, 'rate_limited');
        if (userBusy(user.id)) return fail(ack, 'call_in_progress');
        if (userBusy(check.calleeId)) { await logMissedImmediately(order, user.id, check.calleeId, check.role, 'busy'); return fail(ack, 'busy'); }
        const calleeOnline = isOnline(check.calleeId);
        const pushDevices = await ctx.push.count(check.calleeId);
        // App closed and no way to wake the phone -> offline (the app then offers a normal call).
        if (!calleeOnline && !pushDevices) {
          await logMissedImmediately(order, user.id, check.calleeId, check.role, 'offline');
          return fail(ack, 'offline');
        }

        const callee = await db.get('SELECT id, name FROM users WHERE id = ?', [check.calleeId]);
        const restaurant = await db.get('SELECT name FROM restaurants WHERE id = ?', [order.restaurant_id]);
        const s = {
          id: crypto.randomUUID(), orderId: order.id, callerId: user.id, calleeId: check.calleeId, callerRole: check.role,
          calleeRole: check.role === 'customer' ? 'agent' : 'customer',
          state: 'ringing', createdAt: Date.now(), callerSocketId: socket.id, calleeSocketId: null, samples: [],
        };
        s.incoming = { callId: s.id, orderId: order.id, restaurant: restaurant?.name, from: { name: user.name, role: check.role } };
        sessions.set(s.id, s);
        await db.run(
          `INSERT INTO call_logs (id, order_id, caller_id, callee_id, caller_role, status, created_at) VALUES (?,?,?,?,?,?,?)`,
          [s.id, order.id, s.callerId, s.calleeId, s.callerRole, 'ringing', s.createdAt]);

        io.to(`user:${s.calleeId}`).emit('call:incoming', s.incoming);
        // App closed or in the background: ring the phone through Web Push.
        if (pushDevices && (!calleeOnline || !hasVisibleSocket(s.calleeId))) {
          s.pushed = true;
          ctx.push.send(s.calleeId, {
            type: 'call', ...s.incoming, url: answerUrl(s), token: ctx.push.actionToken(s.id, s.calleeId), userId: s.calleeId,
          }, { ttl: config.call.ringTimeoutSec, urgency: 'high', topic: 'incoming-call' }).catch(console.error);
        }
        s.ringTimer = setTimeout(() => {
          if (sessions.get(s.id)?.state === 'ringing') {
            const reason = s.pushed && !isOnline(s.calleeId) ? 'push_no_answer' : 'no_answer';
            finalize(s, 'missed', reason, { notify: [s.callerSocketId, `user:${s.calleeId}`] }).catch(console.error);
          }
        }, config.call.ringTimeoutSec * 1000);
        notifyAdmins();
        ok(ack, { callId: s.id, callee: { name: callee.name, role: s.calleeRole }, notified: s.pushed ? 'push' : 'app' });
      } catch (e) { console.error(e); fail(ack, 'server_error'); }
    });

    socket.on('call:accept', async ({ callId } = {}, ack) => {
      const s = sessions.get(callId);
      if (!s || s.calleeId !== user.id || s.state !== 'ringing') return fail(ack, 'call_not_found');
      const order = await getOrder(db, s.orderId);
      const check = canCall(order, user.id, { graceMinutes: grace() });
      if (!check.ok) { await finalize(s, 'failed', check.reason, { notify: [s.callerSocketId, `user:${s.calleeId}`] }); return fail(ack, check.reason); }
      clearTimeout(s.ringTimer);
      s.state = 'connecting';
      s.answeredAt = Date.now();
      s.calleeSocketId = socket.id;
      await db.run("UPDATE call_logs SET status = 'answered', answered_at = ? WHERE id = ?", [s.answeredAt, s.id]);
      socket.to(`user:${user.id}`).emit('call:taken', { callId }); // stop ringing on the callee's other tabs/devices
      io.to(s.callerSocketId).emit('call:accepted', { callId });
      ok(ack, { callId });
    });

    socket.on('call:decline', async ({ callId } = {}, ack) => {
      const s = sessions.get(callId);
      if (!s || s.calleeId !== user.id || s.state !== 'ringing') return fail(ack, 'call_not_found');
      await finalize(s, 'declined', 'declined', { notify: [s.callerSocketId, `user:${s.calleeId}`] });
      ok(ack);
    });

    socket.on('call:end', async ({ callId, reason } = {}, ack) => {
      const s = sessions.get(callId);
      if (!s || (s.callerId !== user.id && s.calleeId !== user.id)) return fail(ack, 'call_not_found');
      const r = typeof reason === 'string' ? reason.slice(0, 40) : 'hangup';
      if (s.state === 'ringing') {
        // Caller gave up before an answer.
        await finalize(s, 'missed', 'caller_cancelled', { notify: [`user:${s.calleeId}`] });
      } else {
        await finalize(s, s.connectedAt ? 'completed' : 'failed', r, { notify: [otherSocket(s, socket.id)] });
      }
      ok(ack);
    });

    // WebRTC offer / answer / ICE candidates, relayed only between the two participants.
    socket.on('signal', ({ callId, data } = {}) => {
      const s = sessions.get(callId);
      if (!s || s.state === 'ringing') return;
      if (socket.id !== s.callerSocketId && socket.id !== s.calleeSocketId) return;
      if (!data || !SIGNAL_TYPES.has(data.type)) return;
      if (JSON.stringify(data).length > MAX_SIGNAL_BYTES) return;
      io.to(otherSocket(s, socket.id)).emit('signal', { callId, data });
    });

    socket.on('call:connected', async ({ callId, connectionType } = {}) => {
      const s = sessions.get(callId);
      if (!s || (socket.id !== s.callerSocketId && socket.id !== s.calleeSocketId)) return;
      if (!s.connectedAt) {
        s.connectedAt = Date.now();
        s.state = 'connected';
        await db.run("UPDATE call_logs SET status = 'connected', connected_at = ? WHERE id = ?", [s.connectedAt, s.id]);
        notifyAdmins();
      }
      if (connectionType === 'relay' || connectionType === 'direct') s.connectionType = connectionType;
    });

    // Quality samples from the browser's RTCPeerConnection.getStats().
    socket.on('call:stats', ({ callId, stats } = {}) => {
      const s = sessions.get(callId);
      if (!s || !stats || (socket.id !== s.callerSocketId && socket.id !== s.calleeSocketId)) return;
      const n = (v, max) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : null);
      s.samples.push({
        rttMs: n(stats.rttMs, 10_000), jitterMs: n(stats.jitterMs, 10_000),
        lossPct: n(stats.lossPct, 100), bitrateKbps: n(stats.bitrateKbps, 1000),
      });
      if (s.samples.length > 2000) s.samples.shift();
      if (stats.connectionType === 'relay' || stats.connectionType === 'direct') s.connectionType = stats.connectionType;
    });

    // ---- Live tracking -------------------------------------------------
    socket.on('agent:location', async ({ orderId, lat, lng } = {}) => {
      if (user.role !== 'agent' || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const order = await getOrder(db, orderId);
      if (!order || Number(order.agent_id) !== user.id || !OPEN_STATUSES.has(order.status)) return;
      const loc = { orderId: order.id, lat, lng, at: Date.now() };
      lastLocation.set(order.id, loc);
      io.to(`user:${order.customer_id}`).emit('agent:location', loc);
    });

    socket.on('order:last-location', async ({ orderId } = {}, ack) => {
      const order = await getOrder(db, orderId);
      if (!order || (Number(order.customer_id) !== user.id && Number(order.agent_id) !== user.id)) return fail(ack, 'order_not_found');
      ok(ack, { location: lastLocation.get(order.id) || null });
    });

    socket.on('disconnect', () => {
      for (const s of [...sessions.values()]) {
        if (s.callerSocketId === socket.id) {
          const notify = s.state === 'ringing' ? [`user:${s.calleeId}`] : [s.calleeSocketId];
          finalize(s, s.state === 'ringing' ? 'missed' : (s.connectedAt ? 'completed' : 'failed'), 'disconnected', { notify }).catch(console.error);
        } else if (s.calleeSocketId === socket.id) {
          finalize(s, s.connectedAt ? 'completed' : 'failed', 'disconnected', { notify: [s.callerSocketId] }).catch(console.error);
        } else if (s.state === 'ringing' && s.calleeId === user.id && !isOnline(user.id) && !s.pushed) {
          // The person being called lost internet while their phone was ringing.
          finalize(s, 'missed', 'callee_offline', { notify: [s.callerSocketId] }).catch(console.error);
        }
      }
    });
  });

  // Push order changes to the people involved, and close rooms when needed.
  events.on('order:changed', async (orderId, type) => {
    try {
      const order = await getOrder(db, orderId);
      if (!order) return;
      const payload = { orderId: order.id, status: order.status, type };
      io.to(`user:${order.customer_id}`).emit('order:update', payload);
      if (order.agent_id) io.to(`user:${order.agent_id}`).emit('order:update', payload);
      if (['placed', 'accepted', 'cancelled'].includes(type)) io.to('agents').emit('orders:available-changed');
      pushOrderUpdate(order, type).catch(console.error);
      io.to('admins').emit('order:update', payload);
      // Room closes on cancel, and on delivery (unless a grace period is configured).
      const closedNow = type === 'cancelled' || (type === 'delivered' && !canCall(order, order.customer_id, { graceMinutes: grace() }).ok);
      if (closedNow) {
        const s = sessionForOrder(order.id);
        if (s) await finalize(s, s.connectedAt ? 'completed' : 'missed', 'room_closed', { notify: [s.callerSocketId, s.calleeSocketId || `user:${s.calleeId}`] });
        lastLocation.delete(order.id);
      }
      if (type === 'delivered') lastLocation.delete(order.id);
    } catch (e) { console.error(e); }
  });

  // Order updates as phone notifications (only reach users whose app isn't open on screen).
  async function pushOrderUpdate(order, type) {
    const restaurant = await db.get('SELECT name FROM restaurants WHERE id = ?', [order.restaurant_id]);
    const agent = order.agent_id ? await db.get('SELECT name FROM users WHERE id = ?', [order.agent_id]) : null;
    const first = (n) => (n || '').split(' ')[0];
    const toCustomer = {
      accepted: ['Delivery partner assigned', `${first(agent?.name)} is picking up your order from ${restaurant?.name}.`],
      out_for_delivery: ['Your order is on the way', `${first(agent?.name)} is heading to you. Track live in the app.`],
      delivered: ['Order delivered', `Enjoy your food from ${restaurant?.name}!`],
    }[type];
    if (toCustomer && !hasVisibleSocket(order.customer_id)) {
      await ctx.push.send(order.customer_id, { type: 'order', title: toCustomer[0], body: toCustomer[1], url: `/orders/${order.id}`, tag: `order-${order.id}` }, { ttl: 1800 });
    }
    if (type === 'cancelled' && order.agent_id && !hasVisibleSocket(order.agent_id)) {
      await ctx.push.send(order.agent_id, { type: 'order', title: 'Order cancelled', body: `The customer cancelled order ${order.id}.`, url: '/agent', tag: `order-${order.id}` }, { ttl: 1800 });
    }
    if (type === 'placed') {
      // Free delivery partners with call alerts on, whose app isn't open.
      const agents = await db.all(`SELECT DISTINCT p.user_id AS id FROM push_subscriptions p JOIN users u ON u.id = p.user_id
        WHERE u.role = 'agent' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.agent_id = u.id AND o.status IN ('accepted','picked_up','out_for_delivery'))`);
      for (const a of agents) {
        if (hasVisibleSocket(a.id)) continue;
        await ctx.push.send(a.id, { type: 'order', title: 'New order near you', body: `${restaurant?.name} · ₹${order.total}. Open to accept.`, url: '/agent', tag: 'new-orders' }, { ttl: 300 });
      }
    }
  }

  // Close calls whose room has expired (grace period after delivery is over).
  const sweeper = setInterval(async () => {
    for (const s of [...sessions.values()]) {
      try {
        const order = await getOrder(db, s.orderId);
        const check = canCall(order, s.callerId, { graceMinutes: grace() });
        if (!check.ok) await finalize(s, s.connectedAt ? 'completed' : 'missed', 'room_closed', { notify: [s.callerSocketId, s.calleeSocketId || `user:${s.calleeId}`] });
      } catch (e) { console.error(e); }
    }
  }, 30_000);
  sweeper.unref();

  return {
    // "Decline" pressed on the incoming-call notification (app closed).
    declineFromPush: async (callId, userId) => {
      const s = sessions.get(callId);
      if (!s || s.calleeId !== userId || s.state !== 'ringing') return false;
      await finalize(s, 'declined', 'declined', { notify: [s.callerSocketId, `user:${s.calleeId}`] });
      return true;
    },
    activeCount: () => sessions.size,
    sessions,
    stop: () => clearInterval(sweeper),
  };
}

module.exports = { attachSignaling };