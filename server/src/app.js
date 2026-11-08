const path = require('path');
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');
const config = require('./config');
const { createDb } = require('./db');
const { seed } = require('./seed');
const { attachSignaling } = require('./signaling');
const { createGeo } = require('./geo');
const { createPush } = require('./push');

async function createServer(opts = {}) {
  const db = opts.db || createDb(opts.dbOptions);
  await db.migrate();
  if (opts.seed !== false) await seed(db, { log: !opts.quiet });

  const ctx = { db, events: new EventEmitter(), live: null, io: null, geo: opts.geo || createGeo() };
  ctx.push = createPush(ctx, opts.push || {});
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, db: db.engine, liveCalls: ctx.live?.activeCount() ?? 0 }));
  app.use('/api/auth', require('./routes/auth')(ctx));
  app.use('/api/restaurants', require('./routes/restaurants')(ctx));
  app.use('/api/orders', require('./routes/orders')(ctx));
  app.use('/api/calls', require('./routes/calls')(ctx));
  app.use('/api/admin', require('./routes/admin')(ctx));
  app.use('/api/geo', require('./routes/geo')(ctx));
  app.use('/api/push', require('./routes/push')(ctx));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // In production the built React app is served by this same server.
  const dist = opts.clientDist || path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    // The service worker must not be cached, or phones keep running an old version.
    app.get('/sw.js', (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'sw.js')); });
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  const server = http.createServer(app);
  // Short heartbeat so a phone that loses internet is detected as offline within ~15 s.
  const io = new Server(server, { cors: { origin: config.corsOrigin }, pingInterval: 8000, pingTimeout: 7000 });
  ctx.io = io;
  ctx.live = attachSignaling(io, ctx);

  const close = async () => {
    ctx.live.stop();
    io.close();
    await new Promise((r) => server.close(() => r()));
    await db.close();
  };
  return { app, server, io, ctx, db, close };
}

module.exports = { createServer };