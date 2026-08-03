'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const https = require('https');
require('dotenv').config();

const { initDatabase } = require('./src/database');
const authRoutes = require('./src/routes/auth');
const videoRoutes = require('./src/routes/videos');
const adminRoutes = require('./src/routes/admin');
const userRoutes  = require('./src/routes/user');
const peopleRoutes = require('./src/routes/people');
const gifRoutes = require('./src/routes/gifs');
const dialogRoutes = require('./src/routes/dialogs');
const seriesRoutes = require('./src/routes/series');
const shareRoutes = require('./src/routes/share');
const uploadRoutes = require('./src/routes/upload');
const channelRoutes = require('./src/routes/channels');
const friendsRoutes = require('./src/routes/friends');
const { initWebSocket } = require('./src/websocket');

const app = express();

const tp = process.env.TRUST_PROXY;
if (tp === 'true') app.set('trust proxy', 1);
else if (tp === 'false') app.set('trust proxy', false);
else if (!tp) app.set('trust proxy', 1);
else app.set('trust proxy', tp);
const PORT = process.env.PORT || 443;
const ENABLE_CSP = process.env.ENABLE_CSP !== 'false'; // CSP on by default

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    contentSecurityPolicy: ENABLE_CSP
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
              "'self'",
              "'unsafe-inline'",
              'cdn.jsdelivr.net',
              'vjs.zencdn.net',
              'unpkg.com',
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
              "'self'",
              "'unsafe-inline'",
              'fonts.googleapis.com',
              'vjs.zencdn.net',
              'unpkg.com',
            ],
            fontSrc: ["'self'", 'fonts.gstatic.com', 'data:'],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
            mediaSrc: ["'self'"],
            connectSrc: [
              "'self'",
              'fonts.googleapis.com',
              'fonts.gstatic.com',
              'vjs.zencdn.net',
              'cdn.jsdelivr.net',
              'unpkg.com',
              'wss:',
              'ws:'
            ],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: [],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
  })
);

// ── Rate limiters ─────────────────────────────────────────────────────────────
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX || 1200);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many API requests, please retry shortly.' },
  // Video playback can trigger many range/thumbnail requests, especially on
  // flaky mobile networks. Do not count these against the general API quota.
  skip: (req) => {
    if (!req.path.startsWith('/videos/')) return false;
    return req.path.endsWith('/stream') || req.path.endsWith('/thumbnail');
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // max 10 login attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

app.use('/api/', globalLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/2fa/verify', loginLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));

// ── Static files ──────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
app.use('/avatars', express.static(path.join(DATA_DIR, 'avatars')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check (no auth required) ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api/users', userRoutes);
app.use('/api/people', peopleRoutes);
app.use('/api/gifs', gifRoutes);
app.use('/api/dialogs', dialogRoutes);
app.use('/api/series', seriesRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/friends', friendsRoutes);

const { getVideoByShareToken } = require('./src/database');

// ── SPA fallback: redirect share links to watch.html ─────────────────────────
app.get('/share/:token', (req, res) => {
  const video = getVideoByShareToken(req.params.token);
  if (!video) {
    return res.redirect('/login.html');
  }
  res.redirect(`/watch.html?id=${video.id}&share_token=${req.params.token}`);
});

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_NAME = ${JSON.stringify(process.env.APP_NAME || 'Spool')};`);
});

app.get('/manifest.json', (req, res) => {
  const manifestPath = path.join(__dirname, 'public', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    let content = fs.readFileSync(manifestPath, 'utf8');
    content = content.replace(/"name": "Spool"/, `"name": "${process.env.APP_NAME || 'Spool'}"`);
    res.type('application/json');
    return res.send(content);
  }
  res.status(404).send('Not found');
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Do not return HTML for asset-like requests (e.g. /css/*.css, /js/*.js)
  // because that causes browsers to treat missing assets as broken CSS/JS.
  if (path.extname(req.path)) {
    return res.status(404).send('Not found');
  }

  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[Error]', err.message);
  const isProduction = process.env.NODE_ENV === 'production';
  res.status(err.status || 500).json({
    error: isProduction ? 'Internal server error' : (err.message || 'Internal server error'),
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
initDatabase();

const certPath = process.env.SSL_CERT_PATH || path.join(__dirname, 'cert.pem');
const keyPath = process.env.SSL_KEY_PATH || path.join(__dirname, 'key.pem');
const hasTlsFiles = fs.existsSync(certPath) && fs.existsSync(keyPath);

function tlsKeyLooksEncrypted(keyBuf) {
  const head = keyBuf.slice(0, Math.min(keyBuf.length, 512)).toString('utf8');
  return (
    head.includes('BEGIN ENCRYPTED PRIVATE KEY') ||
    /Proc-Type:\s*4,\s*ENCRYPTED/i.test(head) ||
    /DEK-Info:/i.test(head)
  );
}

function buildTlsOptions() {
  const cert = fs.readFileSync(certPath);
  const key = fs.readFileSync(keyPath);
  const passphrase = process.env.SSL_KEY_PASSPHRASE;
  if (tlsKeyLooksEncrypted(key) && !passphrase) {
    const err = new Error(
      'Private key is password-protected. Set SSL_KEY_PASSPHRASE in the environment, ' +
        'or recreate key.pem without a password (openssl … -nodes).'
    );
    err.code = 'TLS_KEY_NEEDS_PASSPHRASE';
    throw err;
  }
  const opts = { cert, key };
  if (passphrase) opts.passphrase = passphrase;
  return opts;
}

function logTlsOpenSslHint(err) {
  if (err.code === 'ERR_OSSL_UNSUPPORTED' || err.code === 'ERR_OSSL_EVP_UNSUPPORTED') {
    console.warn('[TLS] OpenSSL could not load key.pem (unsupported or legacy format).');
    console.warn('[TLS] Recreate an unencrypted RSA PEM pair on the host, then restart:');
    console.warn(
      '[TLS]   openssl req -x509 -newkey rsa:4096 -sha256 -days 825 -nodes ' +
        '-keyout key.pem -out cert.pem -subj "/CN=YOUR_LAN_HOSTNAME_OR_IP"'
    );
  }
}

function startHttpServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║       Spool — v1.0.0          ║`);
    console.log(`║   Running on http://0.0.0.0:${PORT}       ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
  });
  initWebSocket(server);
}

if (hasTlsFiles) {
  try {
    console.info(`[TLS] Using cert=${certPath} key=${keyPath}`);
    const tlsOptions = buildTlsOptions();
    const server = https.createServer(tlsOptions, app);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n╔══════════════════════════════════════════╗`);
      console.log(`║       Spool — v1.0.0          ║`);
      console.log(`║  Running on https://0.0.0.0:${PORT}      ║`);
      console.log(`╚══════════════════════════════════════════╝\n`);
    });
    initWebSocket(server);
  } catch (err) {
    console.warn(`[TLS] Failed to start HTTPS: ${err.code || err.message}`);
    logTlsOpenSslHint(err);
    console.warn(`[TLS] Falling back to HTTP. Fix key.pem/cert.pem or set paths via SSL_CERT_PATH / SSL_KEY_PATH.`);
    startHttpServer();
  }
} else {
  console.warn(`[TLS] Missing cert or key file. Falling back to HTTP.`);
  console.warn(`[TLS] Expected cert: ${certPath}`);
  console.warn(`[TLS] Expected key : ${keyPath}`);
  startHttpServer();
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}. Closing gracefully…`);
  try {
    const { closeDatabase } = require('./src/database');
    if (typeof closeDatabase === 'function') closeDatabase();
  } catch (e) {
    console.warn('[Shutdown] Could not close database:', e.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
