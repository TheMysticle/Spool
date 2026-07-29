'use strict';

const express = require('express');
const { getVideoByShareToken } = require('../database');

const router = express.Router();

router.get('/:token', (req, res) => {
  const token = req.params.token;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const video = getVideoByShareToken(token);
  if (!video) {
    return res.status(404).json({ error: 'Share link not found or expired.' });
  }

  // Return only necessary public metadata
  res.json({
    id: video.id,
    title: video.title,
    duration: video.duration,
    video_width: video.video_width,
    video_height: video.video_height,
    thumbnail_path: video.thumbnail_path,
    category: video.category
  });
});

module.exports = router;
