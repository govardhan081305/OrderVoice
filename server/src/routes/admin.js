const express = require('express');
const config = require('../config');
const { requireAuth, requireRole } = require('../auth');

// Bytes per minute of one direction of an Opus audio stream at `kbps`.
const gbPerMin = (kbps) => (kbps * 1000 * 60) / 8 / 1e9;

module.exports = function adminRoutes(ctx) {
  const { db } = ctx;
  const r = express.Router();
  r.use(requireAuth, requireRole('admin'));

  r.get('/stats', async (req, res) => {
    const pstnRate = Number(req.query.pstnRate ?? config.cost.pstnRatePerMin);
    const egressPerGb = Number(req.query.egressPerGb ?? config.cost.egressPerGb);

    const orders = await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
    const users = await db.all('SELECT role, COUNT(*) AS n FROM users GROUP BY role');
    const callsByStatus = await db.all("SELECT status, COUNT(*) AS n FROM call_logs WHERE channel = 'internet' GROUP BY status");
    const byRole = await db.all("SELECT caller_role, COUNT(*) AS n FROM call_logs WHERE channel = 'internet' GROUP BY caller_role");
    const q = await db.get(`
      SELECT COUNT(*) AS connected,
             COALESCE(SUM(duration_sec), 0) AS total_sec,
             COALESCE(SUM(CASE WHEN connection_type = 'relay' THEN duration_sec ELSE 0 END), 0) AS relay_sec,
             COALESCE(SUM(CASE WHEN connection_type = 'relay' THEN 1 ELSE 0 END), 0) AS relay_calls,
             AVG(avg_rtt_ms) AS avg_rtt, AVG(jitter_ms) AS avg_jitter,
             AVG(packet_loss_pct) AS avg_loss, AVG(bitrate_kbps) AS avg_bitrate
      FROM call_logs WHERE status = 'completed' AND duration_sec > 0 AND channel = 'internet'`);
    // Internet-off handling: internet calls that couldn't connect because the other side was offline,
    // and how often users then chose the normal (masked) call option.
    const off = await db.get(`SELECT COUNT(*) AS n FROM call_logs WHERE channel = 'internet'
      AND end_reason IN ('offline','callee_offline','disconnected','connection_failed','peer_offline','push_no_answer')`);
    const masked = await db.get("SELECT COUNT(*) AS n FROM call_logs WHERE channel = 'masked'");

    const totalMin = Number(q.total_sec) / 60;
    const relayMin = Number(q.relay_sec) / 60;
    // If no bitrate has been measured yet, assume 40 kbps (Opus voice + RTP/UDP/IP overhead).
    const bitrate = q.avg_bitrate ? Number(q.avg_bitrate) : 40;
    // A relayed call: TURN server sends each direction once to the far peer => 2 streams of egress.
    const relayGb = relayMin * gbPerMin(bitrate) * 2;
    const internetCost = relayGb * egressPerGb;
    const pstnCost = totalMin * pstnRate;

    res.json({
      users: Object.fromEntries(users.map((u) => [u.role, Number(u.n)])),
      orders: Object.fromEntries(orders.map((o) => [o.status, Number(o.n)])),
      calls: {
        byStatus: Object.fromEntries(callsByStatus.map((c) => [c.status, Number(c.n)])),
        byCallerRole: Object.fromEntries(byRole.map((c) => [c.caller_role, Number(c.n)])),
        connected: Number(q.connected),
        totalMinutes: +totalMin.toFixed(2),
        relayMinutes: +relayMin.toFixed(2),
        relayCallPct: q.connected ? +((Number(q.relay_calls) / Number(q.connected)) * 100).toFixed(1) : 0,
        avgRttMs: q.avg_rtt != null ? +Number(q.avg_rtt).toFixed(1) : null,
        avgJitterMs: q.avg_jitter != null ? +Number(q.avg_jitter).toFixed(1) : null,
        avgPacketLossPct: q.avg_loss != null ? +Number(q.avg_loss).toFixed(2) : null,
        avgBitrateKbps: q.avg_bitrate != null ? +Number(q.avg_bitrate).toFixed(1) : null,
        live: ctx.live ? ctx.live.activeCount() : 0,
        internetOff: Number(off.n),
        maskedRequests: Number(masked.n),
      },
      cost: {
        assumptions: { pstnRatePerMin: pstnRate, egressPerGb, bitrateKbpsUsed: +bitrate.toFixed(1), bitrateMeasured: !!q.avg_bitrate },
        pstnCost: +pstnCost.toFixed(2), // same minutes as masked phone calls
        internetCost: +internetCost.toFixed(4), // TURN relay bandwidth
        relayGb: +relayGb.toFixed(5),
        savingPct: pstnCost > 0 ? +(((pstnCost - internetCost) / pstnCost) * 100).toFixed(1) : null,
        note: 'Variable cost only. Excludes fixed server cost (signaling + TURN VM). Normal (masked) calls would be billed per minute by the provider. Rates are assumptions until replaced with real quotes.',
      },
    });
  });

  r.get('/calls', async (_req, res) => {
    const calls = await db.all(`
      SELECT c.*, cu.name AS caller_name, ce.name AS callee_name
      FROM call_logs c JOIN users cu ON cu.id = c.caller_id JOIN users ce ON ce.id = c.callee_id
      ORDER BY c.created_at DESC LIMIT 100`);
    res.json({ calls });
  });

  return r;
};