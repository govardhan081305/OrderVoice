const express = require('express');
const { requireAuth } = require('../auth');

module.exports = function pushRoutes(ctx) {
  const r = express.Router();

  // VAPID public key the browser needs to subscribe.
  r.get('/public-key', (_req, res) => res.json({ publicKey: ctx.push.publicKey }));

  // "Decline" button on the incoming-call notification. The service worker has no
  // login token, so the push carried a short-lived signed token for this call.
  r.post('/call-action', async (req, res) => {
    const { callId, userId, action, token } = req.body || {};
    if (action !== 'decline' || !ctx.push.verifyActionToken(token, callId, Number(userId))) return res.status(403).json({ error: 'Invalid or expired action' });
    const done = await ctx.live.declineFromPush(callId, Number(userId));
    return res.json({ ok: done });
  });

  r.use(requireAuth);

  r.post('/subscribe', async (req, res) => {
    try {
      await ctx.push.subscribe(req.user.id, req.body?.subscription, req.get('User-Agent'));
      res.status(201).json({ ok: true, devices: await ctx.push.count(req.user.id) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.post('/unsubscribe', async (req, res) => {
    await ctx.push.unsubscribe(req.body?.endpoint, req.user.id);
    res.json({ ok: true });
  });

  r.get('/status', async (req, res) => res.json({ devices: await ctx.push.count(req.user.id) }));

  // "Send test notification" button on the Account page.
  r.post('/test', async (req, res) => {
    const n = await ctx.push.send(req.user.id, {
      type: 'info', title: 'OrderVoice call alerts are on', body: 'Incoming calls will ring this phone even when the app is closed.', url: '/account', tag: 'ov-test',
    }, { ttl: 60, urgency: 'high' });
    if (!n) return res.status(404).json({ error: 'No device is subscribed. Turn on call alerts first.' });
    return res.json({ ok: true, delivered: n });
  });

  return r;
};