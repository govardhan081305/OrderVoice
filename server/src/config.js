// Central configuration. Every value can be overridden with an environment variable
// (see ../.env.example). Defaults are chosen so `npm run dev` works with zero setup.
require('dotenv').config();
const crypto = require('crypto');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  port: num(process.env.PORT, 4000),

  // Auth
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // Admin accounts can only be created with this secret code, so a random
  // visitor can't sign up as admin. Set ADMIN_SIGNUP_CODE in .env.
  // Not set: in development a random code is generated and printed at startup;
  // in production admin sign-up is disabled.
  adminSignupCode: process.env.ADMIN_SIGNUP_CODE
    || (env === 'production' ? '' : crypto.randomBytes(4).toString('hex').toUpperCase()),
  adminSignupCodeGenerated: !process.env.ADMIN_SIGNUP_CODE && env !== 'production',

  // Database: SQLite file by default. Set DATABASE_URL=postgres://... to use PostgreSQL.
  sqlitePath: process.env.SQLITE_PATH || require('path').join(__dirname, '..', 'data', 'ordervoice.db'),
  databaseUrl: process.env.DATABASE_URL || '',

  // OrderVoice call rules
  call: {
    // Minutes after "delivered" that calling stays open. 0 = closes immediately on delivery.
    graceMinutes: num(process.env.CALL_GRACE_MINUTES, 0),
    // How long the callee's phone rings before the call is marked "missed".
    ringTimeoutSec: num(process.env.CALL_RING_TIMEOUT_SEC, 30),
    // Max calls one user may start per order per 10 minutes (anti-spam).
    maxCallsPer10Min: num(process.env.CALL_MAX_PER_10_MIN, 6),
  },

  // ICE servers. STUN is free (public); TURN should be YOUR OWN coturn server.
  ice: {
    stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').filter(Boolean),
    // e.g. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp"
    turnUrls: (process.env.TURN_URLS || '').split(',').filter(Boolean),
    // Shared secret configured in coturn as `static-auth-secret` (use-auth-secret mode).
    turnSecret: process.env.TURN_SECRET || '',
    turnTtlSec: num(process.env.TURN_TTL_SEC, 3600),
    // OR a hosted TURN service with a fixed username/password (e.g. Metered Open Relay, free 20 GB/month).
    // Used only when TURN_SECRET is empty.
    turnUsername: process.env.TURN_USERNAME || '',
    turnPassword: process.env.TURN_PASSWORD || '',
  },

  // Cost model defaults for the admin dashboard. These are ASSUMPTIONS:
  // replace them with your vendor quote / cloud price list before presenting numbers.
  cost: {
    pstnRatePerMin: num(process.env.COST_PSTN_RATE_PER_MIN, 0.6), // INR per masked-call minute (assumption)
    egressPerGb: num(process.env.COST_EGRESS_PER_GB, 7.5), // INR per GB of TURN egress (assumption)
  },

  deliveryRadiusKm: num(process.env.DELIVERY_RADIUS_KM, 30),

  // Web Push (rings the phone when the app is closed). Keys are auto-generated if unset.
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    // Contact for the push services: mailto: or https URL you control.
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    sinkUrl: process.env.PUSH_SINK_URL || '', // tests only
  },

  // Maps: free OpenStreetMap services (no API key). Change the URLs to self-host.
  geo: {
    nominatimUrl: (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    osrmUrl: (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, ''),
    // Nominatim's usage policy requires an identifying User-Agent.
    userAgent: process.env.GEO_USER_AGENT || 'OrderVoice/1.0 (college project; food delivery demo)',
    country: process.env.GEO_COUNTRY || 'in', // limit address search to India
  },

  corsOrigin: process.env.CORS_ORIGIN || '*',
};

if (config.env === 'production' && config.jwtSecret === 'dev-only-change-me') {
  throw new Error('Set JWT_SECRET in production.');
}

module.exports = config;