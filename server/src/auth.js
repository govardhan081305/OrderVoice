const jwt = require('jsonwebtoken');
const config = require('./config');

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, name: user.name }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

function verifyToken(token) {
  const p = jwt.verify(token, config.jwtSecret);
  return { id: Number(p.sub), role: p.role, name: p.name };
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try { req.user = verifyToken(token); return next(); }
  catch { return res.status(401).json({ error: 'Session expired, please log in again' }); }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed for your role' });

module.exports = { signToken, verifyToken, requireAuth, requireRole };
