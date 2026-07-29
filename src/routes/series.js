'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  getAllSeries,
  getSeriesById,
  getSeriesVideos,
  canUserAccessSeries,
} = require('../database');

const router = express.Router();

router.use(authenticate);

// ── GET /api/series ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const rows = getAllSeries({
    userId: req.user.id,
    isAdmin: req.user.role === 'admin',
  });
  res.json(rows);
});

// ── GET /api/series/:id ──────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const series = getSeriesById(id);
  if (!series) return res.status(404).json({ error: 'Series not found.' });

  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && !canUserAccessSeries(id, req.user.id)) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const videos = getSeriesVideos({
    seriesId: id,
    userId: req.user.id,
    isAdmin,
  });

  return res.json({
    ...series,
    visible_videos: videos.length,
    videos,
  });
});

// ── GET /api/series/:id/videos ───────────────────────────────────────────────
router.get('/:id/videos', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid series id.' });
  }

  const series = getSeriesById(id);
  if (!series) return res.status(404).json({ error: 'Series not found.' });

  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && !canUserAccessSeries(id, req.user.id)) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const videos = getSeriesVideos({
    seriesId: id,
    userId: req.user.id,
    isAdmin,
  });

  return res.json({
    series,
    videos,
  });
});

module.exports = router;
