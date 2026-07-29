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

module.exports = router;
