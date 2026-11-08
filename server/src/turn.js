// Builds the ICE server list sent to the browser.
// TURN uses coturn's "TURN REST API" scheme (use-auth-secret): short-lived
// credentials derived from a shared secret, so no permanent TURN password ever
// reaches the client.
const crypto = require('crypto');
const config = require('./config');

function turnCredentials(userId, { secret = config.ice.turnSecret, ttlSec = config.ice.turnTtlSec, now = Date.now() } = {}) {
  const expiry = Math.floor(now / 1000) + ttlSec;
  const username = `${expiry}:ov-${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry * 1000 };
}

// 'rest' = own coturn with a shared secret, 'static' = hosted TURN with a fixed login.
function turnMode(ice = config.ice) {
  if (!ice.turnUrls.length) return null;
  if (ice.turnSecret) return 'rest';
  if (ice.turnUsername && ice.turnPassword) return 'static';
  return null;
}

function iceServersFor(userId, ice = config.ice) {
  const servers = [];
  if (ice.stunUrls.length) servers.push({ urls: ice.stunUrls });
  const mode = turnMode(ice);
  if (mode === 'rest') {
    const { username, credential } = turnCredentials(userId, { secret: ice.turnSecret, ttlSec: ice.turnTtlSec });
    servers.push({ urls: ice.turnUrls, username, credential });
  } else if (mode === 'static') {
    servers.push({ urls: ice.turnUrls, username: ice.turnUsername, credential: ice.turnPassword });
  }
  return servers;
}

module.exports = { iceServersFor, turnCredentials, turnMode };