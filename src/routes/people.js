'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { authenticate, authOrShareToken } = require('../middleware/auth');
const { getPersonById, getAllPeople } = require('../database');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PEOPLE_DIR = path.join(DATA_DIR, 'people');

// ── GET /api/people ─────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  res.json(getAllPeople({ userId: req.user.id, isAdmin: req.user.role === 'admin' }));
});

// ── GET /api/people/:id/image ─────────────────────────────────────────────────
router.get('/:id/image', authOrShareToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid person id.' });

  const person = getPersonById(id);
  if (!person || !person.image_path) {
    return res.status(404).json({ error: 'No image for this person.' });
  }

  const imgFile = path.join(PEOPLE_DIR, path.basename(person.image_path));
  const resolved = path.resolve(imgFile);
  const resolvedDir = path.resolve(PEOPLE_DIR);

  if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Image not found.' });
  }

  // Filename changes on replace; short cache + filename ETag avoids sticky old PFPs
  try {
    const stat = fs.statSync(resolved);
    res.setHeader('ETag', `"${path.basename(person.image_path)}-${stat.mtimeMs}"`);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
  } catch {}
  res.setHeader('Cache-Control', 'private, max-age=60, must-revalidate');
  res.sendFile(resolved);
});

// ── Middleware for Channel Ownership ──────────────────────────────────────────
const checkPeoplePermission = (req, res, next) => {
  if (req.user.role === 'admin') {
    req.userChannel = null;
    return next();
  }
  const { getChannelByUserId, getPersonById } = require('../database');
  const userChannel = getChannelByUserId(req.user.id);
  if (!userChannel) {
    return res.status(403).json({ error: 'You must have a channel to manage people.' });
  }
  req.userChannel = userChannel;

  if (req.params.id) {
    const id = parseInt(req.params.id, 10);
    const person = getPersonById(id);
    if (!person) return res.status(404).json({ error: 'Person not found.' });

    const ownsAsChannel = person.channel_id != null && Number(person.channel_id) === Number(userChannel.id);
    const isLinkedSelf = person.user_id != null && Number(person.user_id) === Number(req.user.id);
    // Channel-owned people, or the profile linked to this user (e.g. admin-created)
    if (!ownsAsChannel && !isLinkedSelf) {
      return res.status(403).json({ error: 'You do not have permission to modify this person.' });
    }
    req.personRecord = person;
    req.personOwnsAsChannel = ownsAsChannel;
    req.personIsLinkedSelf = isLinkedSelf;
  }
  next();
};

// ── POST /api/people ────────────────────────────────────────────────────────
router.post('/', authenticate, checkPeoplePermission, (req, res) => {
  const { createPerson, syncAutoTaggedPeopleForPerson } = require('../database');
  const { name, second_name = '', surname = '', bio = '', title_tags = '' } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  
  const channelId = req.userChannel ? req.userChannel.id : null;
  const result = createPerson(name.trim().slice(0, 100), String(bio).slice(0, 1000), String(title_tags).slice(0, 500), channelId, String(second_name).trim().slice(0, 100), String(surname).trim().slice(0, 100));
  const personId = Number(result.lastInsertRowid);
  syncAutoTaggedPeopleForPerson(personId);
  res.status(201).json({ id: personId, name: name.trim() });
});

// ── PUT /api/people/:id ─────────────────────────────────────────────────────
router.put('/:id', authenticate, checkPeoplePermission, (req, res) => {
  const { getPersonById, updatePerson, syncAutoTaggedPeopleForPerson, setPersonUserLink } = require('../database');
  const id = parseInt(req.params.id, 10);
  
  const { name, second_name, surname, bio, title_tags, user_id } = req.body;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'Name must be a non-empty string.' });
  }

  const updates = {};
  if (name !== undefined) updates.name = name.trim().slice(0, 100);
  if (second_name !== undefined) updates.second_name = String(second_name).trim().slice(0, 100);
  if (surname !== undefined) updates.surname = String(surname).trim().slice(0, 100);
  if (bio !== undefined) updates.bio = String(bio).slice(0, 1000);
  if (title_tags !== undefined) updates.title_tags = String(title_tags).slice(0, 500);
  
  if (Object.keys(updates).length) updatePerson(id, updates);
  if (title_tags !== undefined) syncAutoTaggedPeopleForPerson(id);

  if ('user_id' in req.body) {
    // Admins can always link; channel owners can link on their own people only.
    // Linked-self profiles created by admin must not be unlinked by the user.
    if (req.user.role === 'admin') {
      const uid = user_id ? parseInt(user_id, 10) : null;
      setPersonUserLink(id, uid);
    } else if (req.personOwnsAsChannel) {
      const uid = user_id ? parseInt(user_id, 10) : null;
      setPersonUserLink(id, uid);
    }
  }

  res.json({ message: 'Person updated.', person: getPersonById(id) });
});

// ── DELETE /api/people/:id ──────────────────────────────────────────────────
router.delete('/:id', authenticate, checkPeoplePermission, (req, res) => {
  const { getPersonById, deletePerson, getPersonVhsPhotos } = require('../database');
  const id = parseInt(req.params.id, 10);
  const person = getPersonById(id);

  // Non-admins may only delete people owned by their channel.
  // Linked self profiles created by an admin (no channel_id) cannot be deleted by the user.
  if (req.user.role !== 'admin') {
    const channelId = req.userChannel ? Number(req.userChannel.id) : null;
    const ownedByChannel = person.channel_id != null && Number(person.channel_id) === channelId;
    if (!ownedByChannel) {
      return res.status(403).json({
        error: 'You cannot delete this person profile. Contact an admin if it needs to be removed.',
      });
    }
  }

  if (person.image_path) {
    try {
      const imgFile = path.join(PEOPLE_DIR, path.basename(person.image_path));
      if (fs.existsSync(imgFile)) fs.unlinkSync(imgFile);
    } catch {}
  }

  try {
    const vhsPhotos = getPersonVhsPhotos(id);
    for (const ph of vhsPhotos) {
      try {
        const imgFile = path.join(PEOPLE_DIR, path.basename(ph.image_path));
        if (fs.existsSync(imgFile)) fs.unlinkSync(imgFile);
      } catch {}
    }
  } catch {}

  deletePerson(id);
  res.json({ message: 'Person deleted.' });
});

// ── POST /api/people/:id/image ──────────────────────────────────────────────
router.post('/:id/image', authenticate, checkPeoplePermission, (req, res) => {
  const { getPersonById, setPersonImage } = require('../database');
  const id = parseInt(req.params.id, 10);
  const person = getPersonById(id);

  const { imageBase64 } = req.body;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 is required.' });
  }

  const matches = imageBase64.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/i);
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

// ── DELETE /api/people/:id/image ────────────────────────────────────────────
router.delete('/:id/image', authenticate, checkPeoplePermission, (req, res) => {
  const { getPersonById, setPersonImage } = require('../database');
  const id = parseInt(req.params.id, 10);
  const person = getPersonById(id);
  if (!person) return res.status(404).json({ error: 'Person not found.' });

  if (person.image_path) {
    try {
      const imgFile = path.join(PEOPLE_DIR, path.basename(person.image_path));
      if (fs.existsSync(imgFile)) fs.unlinkSync(imgFile);
    } catch {}
  }
  setPersonImage(id, null);
  res.json({ message: 'Image removed.' });
});

// ── GET /api/people/:id/vhs-channels ──────────────────────────────────────────
router.get('/:id/vhs-channels', authenticate, (req, res) => {
  const { getPersonById, getPersonVhsChannels } = require('../database');
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid person id.' });
  const person = getPersonById(id);
  if (!person) return res.status(404).json({ error: 'Person not found.' });
  res.json({ channels: getPersonVhsChannels({ personId: id, userId: req.user.id, isAdmin: req.user.role === 'admin' }) });
});

// ── GET /api/people/:id/vhs-photos ──────────────────────────────────────────
router.get('/:id/vhs-photos', authenticate, (req, res) => {
  const { getPersonById, getPersonVhsPhotos } = require('../database');
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid person id.' });
  const person = getPersonById(id);
  if (!person) return res.status(404).json({ error: 'Person not found.' });
  res.json(getPersonVhsPhotos(id));
});

// ── GET /api/people/:id/vhs-photos/:photoId/image ────────────────────────────
router.get('/:id/vhs-photos/:photoId/image', authOrShareToken, (req, res) => {
  const { getPersonVhsPhotoById } = require('../database');
  const personId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (isNaN(personId) || isNaN(photoId)) {
    return res.status(400).json({ error: 'Invalid ids.' });
  }

  const photo = getPersonVhsPhotoById(photoId);
  if (!photo || photo.person_id !== personId) {
    return res.status(404).json({ error: 'Photo not found.' });
  }

  const imgFile = path.join(PEOPLE_DIR, path.basename(photo.image_path));
  const resolved = path.resolve(imgFile);
  const resolvedDir = path.resolve(PEOPLE_DIR);
  if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Image file not found.' });
  }

  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(resolved);
});

// ── POST /api/people/:id/vhs-photos ─────────────────────────────────────────
router.post('/:id/vhs-photos', authenticate, checkPeoplePermission, (req, res) => {
  const { getPersonById, addPersonVhsPhoto } = require('../database');
  const id = parseInt(req.params.id, 10);
  const person = getPersonById(id);
  if (!person) return res.status(404).json({ error: 'Person not found.' });

  const { imageBase64, effective_date, label } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 is required.' });
  }

  const matches = imageBase64.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/i);
  if (!matches) return res.status(400).json({ error: 'Invalid image format.' });

  const imgData = Buffer.from(matches[2], 'base64');
  if (imgData.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large (max 2MB).' });
  }

  let eff = null;
  if (effective_date != null && String(effective_date).trim()) {
    const v = String(effective_date).trim();
    if (!/^\d{4}$/.test(v) && !/^\d{4}-\d{2}$/.test(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return res.status(400).json({ error: 'effective_date must be YYYY, YYYY-MM, or YYYY-MM-DD.' });
    }
    eff = v;
  }

  fs.mkdirSync(PEOPLE_DIR, { recursive: true });
  const filename = `person_${id}_vhs_${Date.now()}.jpg`;
  fs.writeFileSync(path.join(PEOPLE_DIR, filename), imgData);

  const photo = addPersonVhsPhoto(id, filename, eff, typeof label === 'string' ? label.trim().slice(0, 120) : '');
  res.status(201).json(photo);
});

// ── PUT /api/people/:id/vhs-photos/:photoId ─────────────────────────────────
router.put('/:id/vhs-photos/:photoId', authenticate, checkPeoplePermission, (req, res) => {
  const { getPersonVhsPhotoById, updatePersonVhsPhoto } = require('../database');
  const personId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  const photo = getPersonVhsPhotoById(photoId);
  if (!photo || photo.person_id !== personId) {
    return res.status(404).json({ error: 'Photo not found.' });
  }

  const fields = {};
  if ('effective_date' in (req.body || {})) {
    const v = req.body.effective_date;
    if (v == null || String(v).trim() === '') {
      fields.effective_date = null;
    } else {
      const s = String(v).trim();
      if (!/^\d{4}$/.test(s) && !/^\d{4}-\d{2}$/.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return res.status(400).json({ error: 'effective_date must be YYYY, YYYY-MM, or YYYY-MM-DD.' });
      }
      fields.effective_date = s;
    }
  }
  if ('label' in (req.body || {})) {
    fields.label = String(req.body.label || '').trim().slice(0, 120);
  }

  res.json(updatePersonVhsPhoto(photoId, fields));
});

// ── DELETE /api/people/:id/vhs-photos/:photoId ──────────────────────────────
router.delete('/:id/vhs-photos/:photoId', authenticate, checkPeoplePermission, (req, res) => {
  const { getPersonVhsPhotoById, deletePersonVhsPhoto } = require('../database');
  const personId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  const photo = getPersonVhsPhotoById(photoId);
  if (!photo || photo.person_id !== personId) {
    return res.status(404).json({ error: 'Photo not found.' });
  }

  try {
    const imgFile = path.join(PEOPLE_DIR, path.basename(photo.image_path));
    if (fs.existsSync(imgFile)) fs.unlinkSync(imgFile);
  } catch {}

  deletePersonVhsPhoto(photoId);
  res.json({ message: 'Photo deleted.' });
});

module.exports = router;
