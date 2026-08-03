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

  res.setHeader('Cache-Control', 'public, max-age=86400');
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
    if (person.channel_id !== userChannel.id) {
      return res.status(403).json({ error: 'You do not have permission to modify this person.' });
    }
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
    // Only admins can link users to people? For now we'll let owners link users if they want.
    const uid = user_id ? parseInt(user_id, 10) : null;
    setPersonUserLink(id, uid);
  }

  res.json({ message: 'Person updated.', person: getPersonById(id) });
});

// ── DELETE /api/people/:id ──────────────────────────────────────────────────
router.delete('/:id', authenticate, checkPeoplePermission, (req, res) => {
  const { getPersonById, deletePerson } = require('../database');
  const id = parseInt(req.params.id, 10);
  const person = getPersonById(id);

  if (person.image_path) {
    try {
      const imgFile = path.join(PEOPLE_DIR, path.basename(person.image_path));
      if (fs.existsSync(imgFile)) fs.unlinkSync(imgFile);
    } catch {}
  }

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

module.exports = router;
