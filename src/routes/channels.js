'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticate } = require('../middleware/auth');

const failedVhsAttempts = new Map(); // Tracks failed VHS password attempts: `${userId}_${channelId}` -> { count, lockUntil }
const {
  getAllChannels,
  getChannelProfile,
  updateChannelProfile,
  getChannelById,
  updateChannel,
  getSubscriptionStatus,
  getSubscriberCount,
  getVideoCount,
  toggleSubscription,
  createCommunityPost,
  updateCommunityPost,
  deleteCommunityPost,
  getCommunityPosts,
} = require('../database');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

fs.mkdirSync(AVATAR_DIR, { recursive: true });

// ── GET /api/channels ────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  let channels = getAllChannels().map(ch => ({
    ...ch,
    video_count: getVideoCount(ch.id),
    subscriber_count: getSubscriberCount(ch.id)
  }));
  const globalProfile = getChannelProfile ? getChannelProfile() : {};
  const adminChannel = {
    id: 'main',
    name: globalProfile.channel_name || 'Mysticle Archive',
    avatar_path: globalProfile.channel_avatar || null,
    banner_path: globalProfile.channel_banner || null,
    video_count: getVideoCount(null), // Assuming null/main is admin
    subscriber_count: getSubscriberCount(null)
  };
  // Prepend admin channel
  channels.unshift(adminChannel);
  res.json({ channels });
});

// ── GET /api/channels/:id ────────────────────────────────────────────────────
router.get('/:id', authenticate, (req, res) => {
  const channelId = req.params.id;
  let channelData = null;
  let numericId = null;

  if (channelId === 'main') {
    const globalProfile = getChannelProfile();
    channelData = {
      id: 'main',
      user_id: 1, // Admin user ID is typically 1
      name: globalProfile.channel_name || 'Mysticle Archive',
      avatar_path: globalProfile.channel_avatar || null,
      banner_path: globalProfile.channel_banner || null,
      vhs_password: globalProfile.channel_vhs_password || null
    };
    numericId = 0; // For DB queries
  } else {
    numericId = parseInt(channelId, 10);
    if (isNaN(numericId)) return res.status(400).json({ error: 'Invalid channel ID' });
    channelData = getChannelById(numericId);
    if (!channelData) return res.status(404).json({ error: 'Channel not found' });
  }

  // Hide the actual password hash/text from frontend
  const hasVhsPassword = !!channelData.vhs_password;
  delete channelData.vhs_password;

  channelData.has_vhs_password = hasVhsPassword;
  channelData.is_subscribed = getSubscriptionStatus(req.user.id, numericId);
  channelData.subscriber_count = getSubscriberCount(numericId);
  channelData.video_count = getVideoCount(numericId);
  
  res.json({ channel: channelData });
});

// ── POST /api/channels/:id/subscribe ──────────────────────────────────────────
router.post('/:id/subscribe', authenticate, (req, res) => {
  const channelId = req.params.id;
  let numericId = null;

  if (channelId === 'main') {
    numericId = 0;
  } else {
    numericId = parseInt(channelId, 10);
    if (isNaN(numericId) || !getChannelById(numericId)) return res.status(404).json({ error: 'Channel not found' });
  }

  const isSubscribed = toggleSubscription(req.user.id, numericId);
  res.json({ subscribed: isSubscribed });
});

// ── POST /api/channels/:id/banner ─────────────────────────────────────────────
router.post('/:id/banner', authenticate, (req, res) => {
  const channelId = req.params.id;
  let numericId = null;
  let channelData = null;

  if (channelId === 'main') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  } else {
    numericId = parseInt(channelId, 10);
    if (isNaN(numericId)) return res.status(400).json({ error: 'Invalid channel ID' });
    channelData = getChannelById(numericId);
    if (!channelData) return res.status(404).json({ error: 'Channel not found' });
    if (channelData.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const { imageBase64 } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 is required.' });
  }

  const match = imageBase64.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return res.status(400).json({ error: 'Invalid image format.' });

  const mimeType = match[1].toLowerCase();
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const base64Payload = match[3].replace(/\s/g, '');
  
  let buffer;
  try {
    buffer = Buffer.from(base64Payload, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 payload.' });
  }

  const filename = `banner_${channelId === 'main' ? 'main' : numericId}_${Date.now()}.${ext}`;
  const absPath = path.join(AVATAR_DIR, filename);
  const relPath = `/avatars/${filename}`;

  try {
    fs.writeFileSync(absPath, buffer);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save banner.' });
  }

  if (channelId === 'main') {
    updateChannelProfile({ channel_banner: relPath });
  } else {
    updateChannel(numericId, { banner_path: relPath });
  }

  res.json({ message: 'Banner updated.', path: relPath });
});

// ── POST /api/channels/:id/vhs_password ───────────────────────────────────────
router.post('/:id/vhs_password', authenticate, (req, res) => {
  try {
    const channelId = req.params.id;
    let numericId = null;

    if (channelId === 'main') {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    } else {
      numericId = parseInt(channelId, 10);
      if (isNaN(numericId)) return res.status(400).json({ error: 'Invalid channel ID' });
      const channelData = getChannelById(numericId);
      if (!channelData) return res.status(404).json({ error: 'Channel not found' });
      if (channelData.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const { password } = req.body || {};
    const rawPassword = password || null; // allow unsetting

    if (channelId === 'main') {
      if (rawPassword) {
        const hashed = bcrypt.hashSync(rawPassword, 12);
        updateChannelProfile({ channel_vhs_password: hashed });
      } else {
        updateChannelProfile({ channel_vhs_password: null });
      }
    } else {
      if (rawPassword) {
        const hashed = bcrypt.hashSync(rawPassword, 12);
        updateChannel(numericId, { vhs_password: hashed });
      } else {
        updateChannel(numericId, { vhs_password: null });
      }
    }

    res.json({ message: 'VHS password updated.' });
  } catch (err) {
    console.error('[VHS Password Error]', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ── POST /api/channels/:id/vhs_verify ─────────────────────────────────────────
router.post('/:id/vhs_verify', authenticate, async (req, res) => {
  const channelId = req.params.id;
  const { password } = req.body || {};
  let storedHash = null;

  if (channelId === 'main') {
    storedHash = getChannelProfile().channel_vhs_password;
  } else {
    const numericId = parseInt(channelId, 10);
    const channelData = getChannelById(numericId);
    if (!channelData) return res.status(404).json({ error: 'Channel not found' });
    storedHash = channelData.vhs_password;
  }

  if (!storedHash) {
    return res.status(400).json({ error: 'This channel has no VHS password set.' });
  }

  const userChannelKey = `${req.user.id}_${channelId}`;
  const attempt = failedVhsAttempts.get(userChannelKey) || { count: 0, lockUntil: 0 };

  if (attempt.lockUntil > Date.now()) {
    const mins = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minutes.` });
  }

  // Support both legacy plaintext and new bcrypt hashes
  let isValid = false;
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
    isValid = await bcrypt.compare(password || '', storedHash);
  } else {
    // Legacy plaintext comparison — constant-time to avoid timing attacks
    const a = Buffer.from(String(password || ''));
    const b = Buffer.from(String(storedHash));
    isValid = a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  if (!isValid) {
    attempt.count++;
    if (attempt.count >= 3) {
      attempt.lockUntil = Date.now() + 30 * 60000;
      attempt.count = 0; // reset for next time they can try
      failedVhsAttempts.set(userChannelKey, attempt);
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 30 minutes.' });
    } else {
      failedVhsAttempts.set(userChannelKey, attempt);
      return res.status(403).json({ error: `Incorrect password. ${3 - attempt.count} attempts remaining.` });
    }
  }

  failedVhsAttempts.delete(userChannelKey);

  // Issue a proper JWT with expiry instead of a static hash
  const JWT_SECRET = process.env.JWT_SECRET;
  const token = jwt.sign(
    { type: 'vhs_access', channelId, userId: req.user.id },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({ token, message: 'Password correct' });
});

// ── GET /api/channels/:id/community ───────────────────────────────────────────
router.get('/:id/community', authenticate, (req, res) => {
  const channelId = req.params.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const numericId = channelId === 'main' ? null : parseInt(channelId, 10);
  
  if (channelId !== 'main' && isNaN(numericId)) {
    return res.status(400).json({ error: 'Invalid channel ID' });
  }

  const posts = getCommunityPosts(numericId, limit);
  res.json({ posts });
});

// ── POST /api/channels/:id/community ──────────────────────────────────────────
router.post('/:id/community', authenticate, async (req, res) => {
  const channelId = req.params.id;
  const { content, imageBase64 } = req.body || {};

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required.' });
  }

  let numericId = null;
  if (channelId === 'main') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  } else {
    numericId = parseInt(channelId, 10);
    if (isNaN(numericId)) return res.status(400).json({ error: 'Invalid channel ID' });
    const channelData = getChannelById(numericId);
    if (!channelData) return res.status(404).json({ error: 'Channel not found' });
    if (channelData.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  let relPath = null;
  if (imageBase64) {
    const match = imageBase64.match(/^data:(image\/(jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (match) {
      const base64Payload = match[3].replace(/\s/g, '');
      try {
        const rawBuffer = Buffer.from(base64Payload, 'base64');
        if (rawBuffer.length > 5 * 1024 * 1024) {
          return res.status(400).json({ error: 'Image too large (max 5MB).' });
        }
        // Compress to JPEG, strip metadata, cap width at 1920px
        const processed = await sharp(rawBuffer)
          .rotate() // auto-orient based on EXIF before stripping
          .resize({ width: 1920, withoutEnlargement: true })
          .jpeg({ quality: 92 })
          .toBuffer();
        const filename = `community_${channelId === 'main' ? 'main' : numericId}_${Date.now()}.jpg`;
        const absPath = path.join(AVATAR_DIR, filename);
        fs.writeFileSync(absPath, processed);
        relPath = `/avatars/${filename}`;
      } catch (err) {
        console.error('Failed to process community post image:', err);
      }
    }
  }

  createCommunityPost(numericId, content.trim(), relPath);
  res.json({ message: 'Post created successfully.' });
});

// ── PUT /api/channels/:id/community/:postId ───────────────────────────────────
router.put('/:id/community/:postId', authenticate, async (req, res) => {
  const channelId = req.params.id;
  const postId = parseInt(req.params.postId, 10);
  const { content, imageBase64 } = req.body || {};

  if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required.' });
  }

  let numericId = null;
  if (channelId === 'main') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  } else {
    numericId = parseInt(channelId, 10);
    if (isNaN(numericId)) return res.status(400).json({ error: 'Invalid channel ID' });
    const channelData = getChannelById(numericId);
    if (!channelData) return res.status(404).json({ error: 'Channel not found' });
    if (channelData.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  let relPath = null;
  if (imageBase64) {
    const match = imageBase64.match(/^data:(image\/(jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (match) {
      const base64Payload = match[3].replace(/\s/g, '');
      try {
        const rawBuffer = Buffer.from(base64Payload, 'base64');
        if (rawBuffer.length > 5 * 1024 * 1024) {
          return res.status(400).json({ error: 'Image too large (max 5MB).' });
        }
        // Compress to JPEG, strip metadata, cap width at 1920px
        const processed = await sharp(rawBuffer)
          .rotate() // auto-orient based on EXIF before stripping
          .resize({ width: 1920, withoutEnlargement: true })
          .jpeg({ quality: 92 })
          .toBuffer();
        const filename = `community_${channelId === 'main' ? 'main' : numericId}_${Date.now()}.jpg`;
        const absPath = path.join(AVATAR_DIR, filename);
        fs.writeFileSync(absPath, processed);
        relPath = `/avatars/${filename}`;
      } catch (err) {
        console.error('Failed to process community post image:', err);
      }
    }
  }

  updateCommunityPost(postId, numericId, content.trim(), relPath);
  res.json({ message: 'Post updated successfully.' });
});

// ── DELETE /api/channels/:id/community/:postId ────────────────────────────────
router.delete('/:id/community/:postId', authenticate, (req, res) => {
  const channelId = req.params.id;
  const postId = parseInt(req.params.postId, 10);

  if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });

  let numericId = null;
  if (channelId === 'main') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  } else {
    numericId = parseInt(channelId, 10);
    if (isNaN(numericId)) return res.status(400).json({ error: 'Invalid channel ID' });
    const channelData = getChannelById(numericId);
    if (!channelData) return res.status(404).json({ error: 'Channel not found' });
    if (channelData.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  deleteCommunityPost(postId, numericId);
  res.json({ message: 'Post deleted successfully.' });
});

module.exports = router;
