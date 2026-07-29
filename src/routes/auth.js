'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
let authenticator = null;
try {
  ({ authenticator } = require('otplib'));
  // window:2 = accept codes ±2 time-steps (±1 minute) from server clock.
  // Must be set on the instance — passing it inside verify() is ignored in v12.
  authenticator.options = { window: 2 };
} catch {
  console.warn('[Auth] otplib not installed. 2FA is temporarily disabled until dependency is installed.');
}
let qrcode = null;
try {
  qrcode = require('qrcode');
} catch {
  console.warn('[Auth] qrcode not installed. QR codes will not be generated.');
}
const { getUserByUsername, touchLastLogin, updateUser, createAuditLog } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '7d';
const TOTP_ISSUER = process.env.TOTP_ISSUER || 'TheMysticle Archive';
const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

const loginChallenges = new Map();

function pruneExpiredChallenges() {
  const now = Date.now();
  for (const [id, challenge] of loginChallenges.entries()) {
    if (challenge.expiresAt <= now) loginChallenges.delete(id);
  }
}

function createLoginChallenge(payload) {
  pruneExpiredChallenges();
  const id = crypto.randomBytes(24).toString('hex');
  loginChallenges.set(id, {
    ...payload,
    attempts: 0,
    expiresAt: Date.now() + LOGIN_CHALLENGE_TTL_MS,
  });
  return id;
}

// Periodic cleanup of expired challenges (every 5 minutes)
setInterval(pruneExpiredChallenges, 5 * 60 * 1000);

function issueAuthResponse(user) {
  touchLastLogin(user.id);
  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_path: user.avatar_path || null,
      role: user.role,
    },
  };
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (username.length > 64 || password.length > 128) {
    return res.status(400).json({ error: 'Invalid credentials.' });
  }

  const user = getUserByUsername(username.trim().toLowerCase());

  // Constant-time comparison even on missing user (prevent timing attacks)
  const fakeHash = '$2a$12$KrTQU9riLWE6z1JWEV2e8.A9k0Cz3m0Gzn5HH8X4JvO1G5vH3bYi';
  const hash = user ? user.password_hash : fakeHash;

  const valid = await bcrypt.compare(password, hash);
  if (!user || !valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Temporary compatibility mode if otplib is not available in runtime yet.
  if (!authenticator) {
    const channel = require('../database').getChannelByUserId(user.id);
    const authRes = issueAuthResponse(user);
    authRes.user.can_upload = user.can_upload;
    authRes.user.channel_id = channel ? channel.id : null;
    return res.json(authRes);
  }

  // Mandatory 2FA: enforce TOTP on every successful password check.
  if (!user.twofa_enabled || !user.twofa_secret) {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.username, TOTP_ISSUER, secret);
    const challengeId = createLoginChallenge({ userId: user.id, loginUsername: user.username, mode: 'setup', secret });
    let qr_data_url = null;
    if (qrcode) {
      try {
        qr_data_url = await qrcode.toDataURL(otpauthUrl, { width: 200, margin: 2 });
      } catch { /* non-fatal, client falls back to text */ }
    }
    return res.json({
      requires_2fa_setup: true,
      challenge_id: challengeId,
      otpauth_url: otpauthUrl,
      qr_data_url,
    });
  }

  const challengeId = createLoginChallenge({ userId: user.id, loginUsername: user.username, mode: 'verify' });
  return res.json({ requires_2fa: true, challenge_id: challengeId });
});

// ── POST /api/auth/2fa/verify ─────────────────────────────────────────────────
router.post('/2fa/verify', (req, res) => {
  if (!authenticator) {
    return res.status(503).json({ error: '2FA service unavailable. Install otplib and restart.' });
  }

  const { challenge_id, code } = req.body;

  if (!challenge_id || !code || typeof challenge_id !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ error: 'challenge_id and code are required.' });
  }

  pruneExpiredChallenges();
  const challenge = loginChallenges.get(challenge_id);
  if (!challenge) {
    return res.status(401).json({ error: '2FA challenge expired. Please sign in again.' });
  }

  // Rate-limit: max 5 attempts per challenge
  challenge.attempts = (challenge.attempts || 0) + 1;
  if (challenge.attempts > 5) {
    loginChallenges.delete(challenge_id);
    return res.status(429).json({ error: 'Too many 2FA attempts. Please sign in again.' });
  }

  const currentUser = challenge.loginUsername ? getUserByUsername(challenge.loginUsername) : null;

  // If we still cannot resolve, fail safely.
  if (!currentUser) {
    loginChallenges.delete(challenge_id);
    return res.status(401).json({ error: 'User not found for 2FA verification.' });
  }

  const normalizedCode = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalizedCode)) {
    return res.status(400).json({ error: '2FA code must be 6 digits.' });
  }

  const secret = challenge.mode === 'setup' ? challenge.secret : currentUser.twofa_secret;
  if (!secret) {
    loginChallenges.delete(challenge_id);
    return res.status(401).json({ error: '2FA secret missing. Please sign in again.' });
  }

  const valid = authenticator.verify({ token: normalizedCode, secret });
  if (!valid) {
    // Generate expected codes for the current window so we can see the mismatch
    let expectedNow = '?';
    try { expectedNow = authenticator.generate(secret); } catch {}
    console.warn(
      `[Auth] 2FA verify failed for "${challenge.loginUsername}" ` +
      `| received: ${normalizedCode} | expected now: ${expectedNow} ` +
      `| secret length: ${secret.length} | server time: ${new Date().toISOString()}`
    );
    return res.status(401).json({ error: 'Invalid 2FA code. Make sure your phone clock is accurate and try again.' });
  }

  if (challenge.mode === 'setup') {
    updateUser(currentUser.id, { twofa_secret: secret, twofa_enabled: 1 });
    currentUser.twofa_secret = secret;
    currentUser.twofa_enabled = 1;
  }

  loginChallenges.delete(challenge_id);
  
  const channel = require('../database').getChannelByUserId(currentUser.id);
  const authRes = issueAuthResponse(currentUser);
  authRes.user.can_upload = currentUser.can_upload;
  authRes.user.channel_id = channel ? channel.id : null;

  res.json(authRes);
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  const { id, username, display_name, avatar_path, role, can_upload } = req.user;
  const channel = require('../database').getChannelByUserId(id);
  res.json({ id, username, display_name, avatar_path, role, can_upload, channel_id: channel ? channel.id : null });
});

// ── POST /api/auth/change-password ────────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required.' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  if (new_password.length > 128) {
    return res.status(400).json({ error: 'Password too long.' });
  }

  const user = getUserByUsername(req.user.username);
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const newHash = await bcrypt.hash(new_password, 12);
  updateUser(req.user.id, {
    password_hash: newHash,
    password_changed_at: new Date().toISOString(),
  });

  createAuditLog({
    userId: req.user.id,
    action: 'password_change_self',
    details: 'User changed own password.',
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  res.json({ message: 'Password changed successfully.' });
});

module.exports = router;
