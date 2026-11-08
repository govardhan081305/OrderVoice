const config = require('./config');
const { createServer } = require('./app');

createServer().then(({ server, db }) => {
  server.listen(config.port, () => {
    console.log(`OrderVoice server on http://localhost:${config.port}  (db: ${db.engine}, env: ${config.env})`);
    if (!config.adminSignupCode) console.log('  Admin sign-up: disabled (set ADMIN_SIGNUP_CODE to enable)');
    else if (config.adminSignupCodeGenerated) console.log(`  Admin sign-up code (this run only): ${config.adminSignupCode}   (set ADMIN_SIGNUP_CODE in server/.env to fix it)`);
    else console.log('  Admin sign-up: enabled (code from ADMIN_SIGNUP_CODE)');
    if (!config.ice.turnUrls.length) console.log('  TURN not configured: calls use STUN only (fine on the same network; set TURN_URLS + TURN_SECRET for production)');
  });
}).catch((e) => { console.error(e); process.exit(1); });