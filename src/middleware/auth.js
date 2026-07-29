'use strict';

const jwt = require('jsonwebtoken');
const { getUserById, getVideoByShareToken } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[Auth] FATAL: JWT_SECRET environment variable is not set!');
  process.exit(1);
}

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Browser media tags (<video>, <img>) cannot attach Authorization headers.
  // Allow token via query string ONLY for media endpoints to minimize log exposure.
  if (typeof req.query.token === 'string' && req.query.token.length > 0) {
    const p = req.path.toLowerCase();
    const isMediaPath =
      p.endsWith('/stream') ||
      p.endsWith('/thumbnail') ||
      p.includes('/hls/') ||
      p.includes('/avatar') ||
      p.includes('/image');
    if (isMediaPath) {
      return req.query.token;
    }
  }

  return null;
}

/**
 * Middleware: verifies JWT from Authorization header or query token.
 * Attaches req.user = { id, username, role } on success.
 */
function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  const user = getUserById(payload.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  // M2: Invalidate tokens issued before the last password change
  if (user.password_changed_at && payload.iat) {
    const changedAtSec = Math.floor(new Date(user.password_changed_at).getTime() / 1000);
    if (payload.iat < changedAtSec) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

/**
 * Middleware: requires JWT OR a valid share_token in query for the requested video.
 */
function authOrShareToken(req, res, next) {
  // If standard token exists and is valid, authenticate normally
  const token = extractToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = getUserById(payload.userId);
      if (user) {
        req.user = user;
        return next();
      }
    } catch (err) {
      // Ignore JWT error and fallback to share token check
    }
  }

  // Fallback: check share token
  const shareToken = req.query.share_token;
  if (!shareToken) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const video = getVideoByShareToken(shareToken);
  if (!video) {
    return res.status(401).json({ error: 'Invalid share token.' });
  }

  // Ensure the route's :id matches the video the token is for (only applies to /api/videos routes)
  if (req.params.id && req.originalUrl.includes('/api/videos/') && String(video.id) !== String(req.params.id)) {
    return res.status(403).json({ error: 'Share token is not valid for this video.' });
  }

  // Allow access anonymously
  req.user = null;
  req.sharedVideo = video;
  next();
}

module.exports = { authenticate, requireAdmin, authOrShareToken };
