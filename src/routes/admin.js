'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const transcodeQueue = require('../transcode_queue');
const channelsRouter = require('./channels');
const authRouter = require('./auth');
const {
  getAllUsers, createUser, updateUser, deleteUser, getUserByUsername,
  getVideoById,
  createPerson, updatePerson, deletePerson, getAllPeople, getPersonById,
  setPersonImage, setPersonUserLink, syncAutoTaggedPeopleForPerson,
  getVideoPeople, setVideoPeople,
  getVideoAccess, setVideoAccess,
  createSeries, updateSeries, deleteSeries,
  getSeriesById, getAllSeries, getSeriesVideos,
  addVideosToSeries, removeVideoFromSeries, setSeriesVideoOrder,
  getSeriesAccess, setSeriesAccess,
  getAllDialogs, createDialog, deleteDialog,
  getChannelProfile, updateChannelProfile, getAllChannels,
  getSetting, setSetting,
  createAuditLog, getRecentAuditLogs,
  getAllVideoShares,
  deleteVideoShare,
} = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { scanVideos, getScanStatus } = require('../scanner');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PEOPLE_DIR = path.join(DATA_DIR, 'people');

const router = express.Router();

// All admin routes require authentication + admin role
router.use(authenticate, requireAdmin);

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  res.json(getAllUsers());
});

// ── GET /api/admin/channels ───────────────────────────────────────────────────
router.get('/channels', (req, res) => {
  const allChannels = [];
  
  // 1. Add Main Channel
  const globalProfile = getChannelProfile();
  const mainName = globalProfile.channel_name || 'Spool Main Channel';
  allChannels.push({
    id: 'main',
    name: mainName,
    username: mainName.replace(/\s+/g, '').toLowerCase(),
    avatar_path: globalProfile.channel_avatar || null,
    banner_path: globalProfile.channel_banner || null,
    is_main: true
  });
  
  // 2. Add User Channels
  const userChannels = getAllChannels().map(ch => ({
    id: ch.id,
    name: ch.name,
    username: ch.username || ch.name.replace(/\s+/g, '').toLowerCase(),
    avatar_path: ch.avatar_path || null,
    banner_path: ch.banner_path || null,
    user_id: ch.user_id,
    is_main: false
  }));
  
  res.json(allChannels.concat(userChannels));
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────
router.post('/users', async (req, res) => {
  const { username, password, display_name, role = 'viewer', can_upload } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }
  if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 2–32 characters.' });
  }
  if (!/^[a-z0-9_.-]+$/i.test(username)) {
    return res.status(400).json({ error: 'Username may only contain letters, numbers, _ . -' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be 8–128 characters.' });
  }
  if (!['admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or viewer.' });
  }

  const existing = getUserByUsername(username.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Username already taken.' });
  }

  const hash = await bcrypt.hash(password, 12);
  const info = createUser(username.toLowerCase(), hash, display_name || username, role);
  if (can_upload) {
    updateUser(info.lastInsertRowid, { can_upload: 1 });
  }

  res.status(201).json({ message: 'User created.' });
});

// ── PUT /api/admin/users/:id ──────────────────────────────────────────────────
router.put('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid user id.' });

  // Prevent removing yourself as admin
  if (id === req.user.id && req.body.role && req.body.role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role.' });
  }

  const fields = {};
  if (req.body.display_name !== undefined) {
    if (typeof req.body.display_name !== 'string' || req.body.display_name.length > 64) {
      return res.status(400).json({ error: 'display_name must be a string up to 64 chars.' });
    }
    fields.display_name = req.body.display_name;
  }
  if (req.body.role !== undefined) {
    if (!['admin', 'viewer'].includes(req.body.role)) {
      return res.status(400).json({ error: 'Role must be admin or viewer.' });
    }
    fields.role = req.body.role;
  }
  if (req.body.new_password !== undefined) {
    if (typeof req.body.new_password !== 'string' || req.body.new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    fields.password_hash = await bcrypt.hash(req.body.new_password, 12);
    fields.password_changed_at = new Date().toISOString();
  }
  if (req.body.can_upload !== undefined) {
    const canUploadVal = req.body.can_upload ? 1 : 0;
    
    // If revoking upload privileges, check for existing videos
    if (canUploadVal === 0) {
      const db = require('../database');
      const channel = db.getChannelByUserId(id);
      if (channel) {
        const videos = db.getAllVideos({ channelId: channel.id, isAdmin: true });
        if (videos.total > 0) {
          return res.status(400).json({ error: 'Cannot revoke upload privileges while user has uploaded videos.' });
        }
      }
    }
    fields.can_upload = canUploadVal;
  }

  updateUser(id, fields);

  if (fields.password_hash) {
    createAuditLog({
      userId: req.user.id,
      action: 'password_reset_admin',
      details: `Admin reset password for user ID ${id}.`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null,
    });
  }

  // L2: Audit role/upload permission changes
  if (fields.role !== undefined || fields.can_upload !== undefined) {
    createAuditLog({
      userId: req.user.id,
      action: 'user_permissions_updated',
      details: `Updated permissions for user ID ${id}. Role: ${fields.role || 'unchanged'}, Upload: ${fields.can_upload !== undefined ? fields.can_upload : 'unchanged'}.`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null,
    });
  }

  res.json({ message: 'User updated.' });
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
router.delete('/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid user id.' });
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  const db = require('../database');
  const channel = db.getChannelByUserId(id);
  if (channel) {
    const videos = db.getAllVideos({ channelId: channel.id, isAdmin: true });
    if (videos.total > 0) {
      return res.status(400).json({ error: 'Cannot delete user because they have uploaded videos.' });
    }
  }

  deleteUser(id);
  
  // L2: Audit user deletion
  createAuditLog({
    userId: req.user.id,
    action: 'user_deleted',
    details: `Deleted user ID ${id}.`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  res.json({ message: 'User deleted.' });
});

// ── POST /api/admin/users/:id/reset-lockouts ────────────────────────────────
router.post('/users/:id/reset-lockouts', (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing user ID.' });
  
  if (typeof channelsRouter.resetUserVhsAttempts === 'function') {
    channelsRouter.resetUserVhsAttempts(id);
  }
  
  const { createAuditLog } = require('../database');
  createAuditLog({
    userId: req.user.id,
    action: 'reset_lockouts',
    details: `Reset VHS lockouts for user ID ${id}.`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  res.json({ message: 'Lockouts reset successfully.' });
});

// ── POST /api/admin/users/:id/reset-2fa-attempts ────────────────────────────
router.post('/users/:id/reset-2fa-attempts', (req, res) => {
  const { id } = req.params;
  const user = getAllUsers().find((u) => u.id === Number(id));
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (typeof authRouter.resetUser2FAAttempts === 'function') {
    authRouter.resetUser2FAAttempts(user.username);
  }
  
  const { createAuditLog } = require('../database');
  createAuditLog({
    userId: req.user.id,
    action: 'reset_2fa_attempts',
    details: `Reset 2FA attempts for user ID ${id}.`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  res.json({ message: '2FA attempts reset successfully.' });
});

// ── POST /api/admin/users/:id/disable-2fa ───────────────────────────────────
router.post('/users/:id/disable-2fa', (req, res) => {
  const { id } = req.params;
  const user = getAllUsers().find((u) => u.id === Number(id));
  if (!user) return res.status(404).json({ error: 'User not found.' });

  updateUser(Number(id), { twofa_enabled: 0, twofa_secret: null });
  
  if (typeof authRouter.resetUser2FAAttempts === 'function') {
    authRouter.resetUser2FAAttempts(user.username);
  }
  
  const { createAuditLog } = require('../database');
  createAuditLog({
    userId: req.user.id,
    action: 'disable_2fa',
    details: `Disabled 2FA for user ID ${id}.`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  res.json({ message: '2FA disabled successfully.' });
});

// ── POST /api/admin/scan ──────────────────────────────────────────────────────
router.post('/scan', (req, res) => {
  const status = getScanStatus();
  if (status.running) {
    return res.status(409).json({ error: 'A scan is already in progress.', status });
  }
  scanVideos();
  
  // L2: Audit library scan
  createAuditLog({
    userId: req.user.id,
    action: 'library_scan_started',
    details: `Started full library scan.`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  res.json({ message: 'Video scan started.' });
});

// ── POST /api/admin/scan/regenerate-thumbnails ─────────────────────────────
router.post('/scan/regenerate-thumbnails', (req, res) => {
  const status = getScanStatus();
  if (status.running) {
    return res.status(409).json({ error: 'A scan is already in progress.', status });
  }
  scanVideos({ regenerateThumbnails: true });
  res.json({ message: 'Thumbnail regeneration scan started.' });
});

// ── GET /api/admin/scan-status ────────────────────────────────────────────────
router.get('/scan-status', (req, res) => {
  res.json(getScanStatus());
});

// ── People CRUD ───────────────────────────────────────────────────────────────
router.get('/people', (req, res) => {
  res.json(getAllPeople());
});

router.post('/people', (req, res) => {
  const { name, bio = '', title_tags = '' } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  const result = createPerson(name.trim().slice(0, 100), String(bio).slice(0, 1000), String(title_tags).slice(0, 500));
  const personId = Number(result.lastInsertRowid);
  syncAutoTaggedPeopleForPerson(personId);
  res.status(201).json({ id: personId, name: name.trim() });
});

router.put('/people/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid person id.' });
  const person = getPersonById(id);
  if (!person) return res.status(404).json({ error: 'Person not found.' });

  const { name, bio, title_tags, user_id } = req.body;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'Name must be a non-empty string.' });
  }

  const updates = {};
  if (name !== undefined) updates.name = name.trim().slice(0, 100);
  if (bio !== undefined) updates.bio = String(bio).slice(0, 1000);
  if (title_tags !== undefined) updates.title_tags = String(title_tags).slice(0, 500);
  if (Object.keys(updates).length) updatePerson(id, updates);
  if (title_tags !== undefined) syncAutoTaggedPeopleForPerson(id);

  if ('user_id' in req.body) {
    const uid = user_id ? parseInt(user_id, 10) : null;
    setPersonUserLink(id, uid);
  }

  res.json({ message: 'Person updated.', person: getPersonById(id) });
});

router.delete('/people/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid person id.' });
  const person = getPersonById(id);
  if (!person) return res.status(404).json({ error: 'Person not found.' });

  if (person.image_path) {
    try {
      const imgFile = path.join(PEOPLE_DIR, path.basename(person.image_path));
      if (fs.existsSync(imgFile)) fs.unlinkSync(imgFile);
    } catch {}
  }

  deletePerson(id);
  res.json({ message: 'Person deleted.' });
});

router.post('/people/:id/image', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid person id.' });
  const person = getPersonById(id);
  if (!person) return res.status(404).json({ error: 'Person not found.' });

  const { imageBase64 } = req.body;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 is required.' });
  }

  const matches = imageBase64.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!matches) return res.status(400).json({ error: 'Invalid image format.' });

  const imgData = Buffer.from(matches[2], 'base64');
  if (imgData.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large (max 2MB).' });
  }

  fs.mkdirSync(PEOPLE_DIR, { recursive: true });

  if (person.image_path) {
    try {
      const oldFile = path.join(PEOPLE_DIR, path.basename(person.image_path));
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    } catch {}
  }

  const filename = `person_${id}_${Date.now()}.jpg`;
  const filePath = path.join(PEOPLE_DIR, filename);
  fs.writeFileSync(filePath, imgData);

  setPersonImage(id, filename);
  res.json({ message: 'Image saved.', path: `/api/people/${id}/image` });
});

// ── Video access management ───────────────────────────────────────────────────
router.get('/videos/:id/access', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  res.json(getVideoAccess(id));
});

router.put('/videos/:id/access', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  const { all_users, user_ids = [] } = req.body;
  setVideoAccess(id, {
    all_users: Boolean(all_users),
    user_ids: Array.isArray(user_ids) ? user_ids.map(Number).filter((n) => !isNaN(n)) : [],
  });

  res.json({ message: 'Access updated.', access: getVideoAccess(id) });
});

// ── Series management ───────────────────────────────────────────────────────
router.get('/series', (req, res) => {
  const series = getAllSeries({ isAdmin: true, userId: req.user.id });
  res.json(series);
});

router.post('/series', (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';

  if (!name) {
    return res.status(400).json({ error: 'Series name is required.' });
  }

  const result = createSeries({
    name: name.slice(0, 120),
    description: description.slice(0, 2000),
    createdBy: req.user.id,
  });
  const id = Number(result.lastInsertRowid);

  // Default to admin-only visibility until explicitly shared.
  setSeriesAccess(id, { all_users: false, user_ids: [] });

  res.status(201).json({ message: 'Series created.', series: getSeriesById(id) });
});

router.put('/series/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const existing = getSeriesById(id);
  if (!existing) return res.status(404).json({ error: 'Series not found.' });

  const updates = {};
  if (req.body.name !== undefined) {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
      return res.status(400).json({ error: 'Series name must be a non-empty string.' });
    }
    updates.name = req.body.name.trim().slice(0, 120);
  }
  if (req.body.description !== undefined) {
    updates.description = String(req.body.description || '').trim().slice(0, 2000);
  }

  updateSeries(id, updates);
  res.json({ message: 'Series updated.', series: getSeriesById(id) });
});

router.delete('/series/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const existing = getSeriesById(id);
  if (!existing) return res.status(404).json({ error: 'Series not found.' });

  deleteSeries(id);
  res.json({ message: 'Series deleted.' });
});

router.get('/series/:id/videos', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const existing = getSeriesById(id);
  if (!existing) return res.status(404).json({ error: 'Series not found.' });

  const videos = getSeriesVideos({ seriesId: id, isAdmin: true, userId: req.user.id });
  res.json({ series: existing, videos });
});

router.post('/series/:id/videos', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const existing = getSeriesById(id);
  if (!existing) return res.status(404).json({ error: 'Series not found.' });

  const rawIds = Array.isArray(req.body.video_ids) ? req.body.video_ids : [];
  const videoIds = rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!videoIds.length) {
    return res.status(400).json({ error: 'video_ids must include at least one valid id.' });
  }

  addVideosToSeries(id, Array.from(new Set(videoIds)));
  const videos = getSeriesVideos({ seriesId: id, isAdmin: true, userId: req.user.id });
  res.json({ message: 'Videos added to series.', videos });
});

router.delete('/series/:id/videos/:videoId', (req, res) => {
  const id = Number(req.params.id);
  const videoId = Number(req.params.videoId);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(videoId) || videoId < 1) {
    return res.status(400).json({ error: 'Invalid id.' });
  }

  const existing = getSeriesById(id);
  if (!existing) return res.status(404).json({ error: 'Series not found.' });

  removeVideoFromSeries(id, videoId);
  res.json({ message: 'Video removed from series.' });
});

router.put('/series/:id/videos/order', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const existing = getSeriesById(id);
  if (!existing) return res.status(404).json({ error: 'Series not found.' });

  const rawIds = Array.isArray(req.body.video_ids) ? req.body.video_ids : [];
  const orderedIds = rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);

  setSeriesVideoOrder(id, orderedIds);
  const videos = getSeriesVideos({ seriesId: id, isAdmin: true, userId: req.user.id });
  res.json({ message: 'Series order updated.', videos });
});

router.get('/series/:id/access', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const existing = getSeriesById(id);
  if (!existing) return res.status(404).json({ error: 'Series not found.' });

  res.json(getSeriesAccess(id));
});

router.put('/series/:id/access', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const existing = getSeriesById(id);
  if (!existing) return res.status(404).json({ error: 'Series not found.' });

  const { all_users, user_ids = [] } = req.body;
  setSeriesAccess(id, {
    all_users: Boolean(all_users),
    user_ids: Array.isArray(user_ids) ? user_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [],
  });

  res.json({ message: 'Series access updated.', access: getSeriesAccess(id) });
});

// ── Video people tags ─────────────────────────────────────────────────────────
router.get('/videos/:id/people', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  res.json(getVideoPeople(id));
});

router.put('/videos/:id/people', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid video id.' });
  const video = getVideoById(id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  const { person_ids = [] } = req.body;
  setVideoPeople(id, Array.isArray(person_ids) ? person_ids.map(Number).filter((n) => !isNaN(n)) : []);
  res.json({ message: 'People tags updated.', people: getVideoPeople(id) });
});

// ── GET /api/admin/dialogs ────────────────────────────────────────────────────
router.get('/dialogs', (req, res) => {
  res.json(getAllDialogs());
});

// ── General Settings ───────────────────────────────────────────────────────
router.get('/settings/transcoder', (req, res) => {
  try {
    const enabled = getSetting('auto_transcode_enabled', '0');
    const confirm4k = getSetting('auto_transcode_confirm_4k', '0');
    const confirmSizeMb = getSetting('auto_transcode_confirm_size_mb', '0');
    const threads = getSetting('auto_transcode_threads', '0');
    res.json({
      auto_transcode_enabled: enabled === '1',
      auto_transcode_confirm_4k: confirm4k === '1',
      auto_transcode_confirm_size_mb: parseInt(confirmSizeMb, 10) || 0,
      auto_transcode_threads: parseInt(threads, 10) || 0
    });
  } catch (err) {
    console.error('[Admin] Error getting transcoder setting:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings/transcoder', (req, res) => {
  try {
    const { auto_transcode_enabled, auto_transcode_confirm_4k, auto_transcode_confirm_size_mb, auto_transcode_threads } = req.body;
    if (typeof auto_transcode_enabled === 'boolean') {
      setSetting('auto_transcode_enabled', auto_transcode_enabled ? '1' : '0');
    }
    if (typeof auto_transcode_confirm_4k === 'boolean') {
      setSetting('auto_transcode_confirm_4k', auto_transcode_confirm_4k ? '1' : '0');
    }
    if (auto_transcode_confirm_size_mb !== undefined) {
      const val = Math.max(0, parseInt(auto_transcode_confirm_size_mb, 10) || 0);
      setSetting('auto_transcode_confirm_size_mb', String(val));
    }
    if (auto_transcode_threads !== undefined) {
      const val = Math.max(0, parseInt(auto_transcode_threads, 10) || 0);
      setSetting('auto_transcode_threads', String(val));
    }
    res.json({
      auto_transcode_enabled: getSetting('auto_transcode_enabled', '0') === '1',
      auto_transcode_confirm_4k: getSetting('auto_transcode_confirm_4k', '0') === '1',
      auto_transcode_confirm_size_mb: parseInt(getSetting('auto_transcode_confirm_size_mb', '0'), 10) || 0,
      auto_transcode_threads: parseInt(getSetting('auto_transcode_threads', '0'), 10) || 0
    });
  } catch (err) {
    console.error('[Admin] Error setting transcoder setting:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/transcode/status', (req, res) => {
  res.json(transcodeQueue.getStatus());
});

router.post('/transcode/approve/:videoId', (req, res) => {
  const { videoId } = req.params;
  const ok = transcodeQueue.approveJob(videoId);
  if (ok) {
    res.json({ message: 'Job approved and queued for processing.' });
  } else {
    res.status(404).json({ error: 'Job not found in queue.' });
  }
});

router.delete('/transcode/queue/:videoId', (req, res) => {
  const { videoId } = req.params;
  const ok = transcodeQueue.removeJob(videoId);
  if (ok) {
    res.json({ message: 'Job removed from queue.' });
  } else {
    res.status(404).json({ error: 'Job not found in queue.' });
  }
});

// ── Channel Profile ───────────────────────────────────────────────────────
router.get('/settings/channel', (req, res) => {
  res.json(getChannelProfile());
});

router.put('/settings/channel', (req, res) => {
  const { channel_name } = req.body;
  if (channel_name !== undefined) {
    if (typeof channel_name !== 'string' || !channel_name.trim()) {
      return res.status(400).json({ error: 'Channel name cannot be empty.' });
    }
    updateChannelProfile({ channel_name: channel_name.trim().slice(0, 64) });
  }
  res.json(getChannelProfile());
});

router.post('/settings/channel/avatar', (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64 || typeof imageBase64 !== 'string') return res.status(400).json({ error: 'imageBase64 required.' });
  
  const match = imageBase64.match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/i);
  if (!match) return res.status(400).json({ error: 'Invalid image format.' });
  
  const buffer = Buffer.from(match[3].replace(/\s/g, ''), 'base64');
  if (buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large.' });
  
  const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  
  sharp(buffer)
    .rotate()
    .resize(1024, 1024, { fit: 'cover' })
    .jpeg({ quality: 92 })
    .toBuffer()
    .then((compressedBuffer) => {
      fs.writeFileSync(path.join(AVATAR_DIR, 'channel.jpg'), compressedBuffer);
      updateChannelProfile({ channel_avatar: '/api/videos/channel/avatar' });
      res.json({ message: 'Avatar updated.', path: '/api/videos/channel/avatar' });
    })
    .catch((err) => {
      console.error('[Admin] Failed to compress avatar:', err);
      res.status(500).json({ error: 'Failed to process avatar.' });
    });
});

router.delete('/settings/channel/avatar', (req, res) => {
  const absPath = path.join(DATA_DIR, 'avatars', 'channel.jpg');
  if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  updateChannelProfile({ channel_avatar: '' });
  res.json({ message: 'Avatar removed.' });
});

// ── GET /api/admin/audit-logs ────────────────────────────────────────────────
router.get('/audit-logs', (req, res) => {
  const limit = Number(req.query.limit || 200);
  res.json(getRecentAuditLogs(limit));
});

// ── POST /api/admin/dialogs ───────────────────────────────────────────────────
router.post('/dialogs', (req, res) => {
  const { title, body, title_pl, body_pl } = req.body;
  if (!title || typeof title !== 'string' || title.trim().length < 1) {
    return res.status(400).json({ error: 'title is required.' });
  }
  if (!body || typeof body !== 'string' || body.trim().length < 1) {
    return res.status(400).json({ error: 'body is required.' });
  }
  if (title.length > 200) {
    return res.status(400).json({ error: 'title must be 200 characters or fewer.' });
  }
  if (body.length > 10000) {
    return res.status(400).json({ error: 'body must be 10 000 characters or fewer.' });
  }
  if (title_pl && (typeof title_pl !== 'string' || title_pl.length > 200)) {
    return res.status(400).json({ error: 'title_pl must be 200 characters or fewer.' });
  }
  if (body_pl && (typeof body_pl !== 'string' || body_pl.length > 10000)) {
    return res.status(400).json({ error: 'body_pl must be 10 000 characters or fewer.' });
  }
  const result = createDialog(
    title.trim(),
    body.trim(),
    title_pl ? title_pl.trim() : null,
    body_pl ? body_pl.trim() : null,
    req.user.id
  );
  res.status(201).json({ id: result.lastInsertRowid, message: 'Dialog created.' });
});

// ── DELETE /api/admin/dialogs/:id ─────────────────────────────────────────────
router.delete('/dialogs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid dialog id.' });
  }
  deleteDialog(id);
  res.json({ message: 'Dialog deleted.' });
});

// ── Share Admin ───────────────────────────────────────────────────────────────
router.get('/shares', (req, res) => {
  res.json(getAllVideoShares());
});

router.delete('/shares/:videoId', (req, res) => {
  deleteVideoShare(req.params.videoId);

  createAuditLog({
    userId: req.user.id,
    action: 'share_link_revoked',
    details: `Revoked share link for video ID ${req.params.videoId}.`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  res.json({ success: true });
});

// ── System Settings / API Keys ────────────────────────────────────────────────
router.get('/settings/api-keys', (req, res) => {
  const klipy = require('../database').getSetting('klipy_api_key', '');
  res.json({ klipy_api_key: klipy });
});

router.post('/settings/api-keys', (req, res) => {
  const { klipy_api_key } = req.body;
  if (klipy_api_key !== undefined) {
    require('../database').setSetting('klipy_api_key', String(klipy_api_key).trim());
  }
  
  createAuditLog({
    userId: req.user.id,
    action: 'api_keys_updated',
    details: 'Updated system API keys.',
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  res.json({ success: true, message: 'API keys updated.' });
});

module.exports = router;
