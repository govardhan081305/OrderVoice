const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { signToken, requireAuth } = require('../auth');

const ROLES = ['customer', 'agent', 'admin'];
const ROLE_LABEL = { customer: 'Customer', agent: 'Delivery partner', admin: 'Admin' };

// Constant-time comparison so the admin code can't be guessed by timing.
function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = function authRoutes({ db }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 50, standardHeaders: true, legacyHeaders: false });

  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

  // Sign up as customer, delivery partner, or admin (admin needs ADMIN_SIGNUP_CODE).
  r.post('/register', limiter, async (req, res) => {
    const { name, email, password, role, adminCode } = req.body || {};
    if (!name || !String(name).trim() || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose Customer, Delivery partner or Admin' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const e = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: 'Enter a valid email' });
    if (role === 'admin') {
      if (!config.adminSignupCode) return res.status(403).json({ error: 'Admin sign-up is disabled on this server' });
      if (!adminCode || !sameSecret(adminCode, config.adminSignupCode)) return res.status(403).json({ error: 'Invalid admin code' });
    }
    if (await db.get('SELECT id FROM users WHERE email = ?', [e])) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    const { lastId } = await db.run(
      'INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,?)',
      [String(name).trim().slice(0, 60), e, await bcrypt.hash(String(password), 10), role, Date.now()],
    );
    const user = await db.get('SELECT * FROM users WHERE id = ?', [lastId]);
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  });

  // Log in. If `role` is sent (the tab chosen on the login page), it must match the account.
  r.post('/login', limiter, async (req, res) => {
    const { email, password, role } = req.body || {};
    const user = email && (await db.get('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]));
    if (!user || !(await bcrypt.compare(String(password || ''), user.password_hash))) {
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    if (role && ROLES.includes(role) && role !== user.role) {
      return res.status(403).json({ error: `This account is registered as ${ROLE_LABEL[user.role]}. Select "${ROLE_LABEL[user.role]}" to log in.` });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  r.get('/me', requireAuth, async (req, res) => {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    res.json({ user: publicUser(user) });
  });

  return r;
};