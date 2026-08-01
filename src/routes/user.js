'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { authenticate, authOrShareToken } = require('../middleware/auth');
const {
  getAllProgressForUser,
  getWatchHistory,
  getFavoriteVideoIds,
  getFavoriteVideos,
  addFavorite,
  removeFavorite,
  getVideoById,
  updateUser,
  getUserAvatarPathById,
  getNotifications,
  markNotificationRead,
  getChannelByUserId,
  createChannel,
  updateChannel,
} = require('../database');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

fs.mkdirSync(AVATAR_DIR, { recursive: true });

// ── GET /api/user/progress ────────────────────────────────────────────────────
// Returns [{ video_id, last_position, duration }, ...]
router.get('/progress', authenticate, (req, res) => {
  const progress = getAllProgressForUser(req.user.id);
  res.json(progress);
});

// ── GET /api/user/history ─────────────────────────────────────────────────────
// Returns { videos: [...] } ordered by most recently watched
router.get('/history', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
  const videos = getWatchHistory(req.user.id, limit);
  res.json({ videos });
});

// ── GET /api/user/favorites/ids ──────────────────────────────────────────────
// Returns { ids: [videoId, ...] }
router.get('/favorites/ids', authenticate, (req, res) => {
  const ids = getFavoriteVideoIds(req.user.id);
  res.json({ ids });
});

// ── GET /api/user/favorites ─────────────────────────────────────────────────
// Returns { videos: [...] } ordered by newest favorite first
router.get('/favorites', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
  const videos = getFavoriteVideos(req.user.id, limit);
  res.json({ videos });
});

// ── POST /api/user/favorites/:videoId ───────────────────────────────────────
router.post('/favorites/:videoId', authenticate, (req, res) => {
  const videoId = parseInt(req.params.videoId, 10);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return res.status(400).json({ error: 'Invalid video id.' });
  }

  const video = getVideoById(videoId);
  if (!video) {
    return res.status(404).json({ error: 'Video not found.' });
  }

  addFavorite(req.user.id, videoId);
  return res.json({ message: 'Added to favorites.' });
});

// ── DELETE /api/user/favorites/:videoId ─────────────────────────────────────
router.delete('/favorites/:videoId', authenticate, (req, res) => {
  const videoId = parseInt(req.params.videoId, 10);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return res.status(400).json({ error: 'Invalid video id.' });
  }

  removeFavorite(req.user.id, videoId);
  return res.json({ message: 'Removed from favorites.' });
});

// ── POST /api/user/avatar ───────────────────────────────────────────────────
// Expects JSON body: { imageBase64: "data:image/jpeg;base64,..." }
router.post('/avatar', authenticate, (req, res) => {
  const { imageBase64 } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 is required.' });
  }

  const match = imageBase64.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return res.status(400).json({ error: 'Invalid image format.' });
  }

  const mimeType = match[1].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    return res.status(400).json({ error: 'Only jpg, png, and webp are allowed.' });
  }

  const base64Payload = match[3].replace(/\s/g, '');
  let buffer;
  try {
    buffer = Buffer.from(base64Payload, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 image payload.' });
  }

  const MAX_SIZE = 2 * 1024 * 1024;
  if (buffer.length > MAX_SIZE) {
    return res.status(400).json({ error: 'Image is too large (Max 2MB).' });
  }

  const filename = `user-${req.user.id}.jpg`;
  const absPath = path.join(AVATAR_DIR, filename);
  const relPath = path.join('avatars', filename).replace(/\\/g, '/');

  sharp(buffer)
    .resize(512, 512, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer()
    .then((compressedBuffer) => {
      fs.writeFileSync(absPath, compressedBuffer);
      updateUser(req.user.id, { avatar_path: relPath });
      return res.json({ message: 'Avatar updated.', path: relPath });
    })
    .catch((err) => {
      console.error('[Avatar] Failed to compress avatar:', err);
      return res.status(500).json({ error: 'Failed to process avatar image.' });
    });
});

// ── DELETE /api/user/avatar ────────────────────────────────────────────────
router.delete('/avatar', authenticate, (req, res) => {
  const avatarPath = getUserAvatarPathById(req.user.id);
  if (avatarPath) {
    const absPath = path.join(DATA_DIR, avatarPath);
    if (fs.existsSync(absPath)) {
      try {
        fs.unlinkSync(absPath);
      } catch (err) {
        console.warn('[Avatar] Failed to delete avatar file:', err.message);
      }
    }
  }

  updateUser(req.user.id, { avatar_path: null });
  return res.json({ message: 'Avatar removed.' });
});

// ── GET /api/user/notifications ──────────────────────────────────────────────
router.get('/notifications', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  res.json(getNotifications(req.user.id, limit));
});

// ── POST /api/user/notifications/:commentId/read ─────────────────────────────
router.post('/notifications/:commentId/read', authenticate, (req, res) => {
  const commentId = parseInt(req.params.commentId, 10);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return res.status(400).json({ error: 'Invalid comment id.' });
  }
  markNotificationRead(req.user.id, commentId);
  res.json({ ok: true });
});

// ── GET /api/users/avatar/:id ───────────────────────────────────────────────
router.get('/avatar/:id', authOrShareToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const avatarPath = getUserAvatarPathById(id);
  if (!avatarPath) {
    return res.status(404).json({ error: 'Avatar not found.' });
  }

  const absPath = path.join(DATA_DIR, avatarPath);
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'Avatar not found.' });
  }

  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.sendFile(absPath);
});

// ── GET /api/user/channel ────────────────────────────────────────────────────
router.get('/channel', authenticate, (req, res) => {
  const channel = getChannelByUserId(req.user.id);
  res.json({ channel: channel || null });
});

// ── POST /api/user/channel ───────────────────────────────────────────────────
router.post('/channel', authenticate, async (req, res) => {
  const { name, imageBase64 } = req.body || {};
  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Channel name is required.' });
  }

  let avatarPath = null;
  if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.startsWith('data:image')) {
    const match = imageBase64.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (match) {
      const mimeType = match[1].toLowerCase();
      if (['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
        const base64Payload = match[3].replace(/\s/g, '');
        try {
          const buffer = Buffer.from(base64Payload, 'base64');
          const ext = 'jpg';
          const filename = `channel_${req.user.id}_${Date.now()}.${ext}`;
          const relPath = `/avatars/${filename}`;
          const absPath = path.join(DATA_DIR, 'avatars', filename);
          
          const compressedBuffer = await sharp(buffer)
            .resize(512, 512, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toBuffer();
            
          fs.writeFileSync(absPath, compressedBuffer);
          avatarPath = relPath;
        } catch (err) {
          console.error('[Channel] Failed to process avatar:', err);
        }
      }
    }
  }

  const existing = getChannelByUserId(req.user.id);
  let channel;
  if (existing) {
    const fields = { name: name.trim() };
    if (avatarPath) {
      fields.avatar_path = avatarPath;
      // Optionally delete old avatar here
    }
    channel = updateChannel(existing.id, fields);
  } else {
    channel = createChannel(req.user.id, name.trim(), avatarPath);
  }

  res.json({ message: 'Channel profile saved.', channel });
});

module.exports = router;
