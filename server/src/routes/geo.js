const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../auth');
const { validPoint } = require('../geo');

const point = (s) => {
  const [lat, lng] = String(s || '').split(',').map(Number);
  const p = { lat, lng };
  return validPoint(p) ? p : null;
};

module.exports = function geoRoutes(ctx) {
  const r = express.Router();
  r.use(requireAuth);
  // Per-user limit (the geocoder itself is also throttled to 1 req/s server-wide).
  r.use(rateLimit({ windowMs: 60_000, limit: 60, keyGenerator: (req) => `geo:${req.user.id}`, standardHeaders: true, legacyHeaders: false }));

  // GPS coordinates -> street address
  r.get('/reverse', async (req, res) => {
    const p = point(`${req.query.lat},${req.query.lng}`);
    if (!p) return res.status(400).json({ error: 'Invalid location' });
    try { return res.json(await ctx.geo.reverse(p.lat, p.lng)); } catch { return res.status(502).json({ error: 'Could not look up this address right now. Type it in instead.' }); }
  });

  // Typed address -> matching places with coordinates
  r.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.status(400).json({ error: 'Type at least 3 characters' });
    try { return res.json({ results: await ctx.geo.search(q, point(req.query.near)) }); } catch { return res.status(502).json({ error: 'Address search is unavailable right now' }); }
  });

  // Road route: from -> [via ->] to, with distance and travel time
  r.get('/route', async (req, res) => {
    const pts = [point(req.query.from), req.query.via ? point(req.query.via) : undefined, point(req.query.to)].filter((x) => x !== undefined);
    if (pts.some((x) => !x)) return res.status(400).json({ error: 'Invalid points' });
    return res.json(await ctx.geo.route(pts, { steps: req.query.steps === '1' }));
  });

  return r;
};