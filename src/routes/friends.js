'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  getUserByUsername,
  sendFriendRequest,
  acceptFriendRequest,
  denyFriendRequest,
  removeFriend,
  getFriends,
  getPendingFriendRequests,
  getSentFriendRequests,
} = require('../database');

const router = express.Router();

// ── GET /api/friends ─────────────────────────────────────────────────────────
// Returns list of accepted friends
router.get('/', authenticate, (req, res) => {
  const friends = getFriends(req.user.id);
  res.json({ friends });
});

// ── GET /api/friends/requests ────────────────────────────────────────────────
// Returns incoming pending friend requests
router.get('/requests', authenticate, (req, res) => {
  const incoming = getPendingFriendRequests(req.user.id);
  const sent = getSentFriendRequests(req.user.id);
  res.json({ incoming, sent });
});

// ── POST /api/friends/request ────────────────────────────────────────────────
// Send a friend request by username
router.post('/request', authenticate, (req, res) => {
  const { username } = req.body || {};
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Username is required.' });
  }

  const trimmed = username.trim().toLowerCase();
  const targetUser = getUserByUsername(trimmed);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (targetUser.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot add yourself.' });
  }

  const result = sendFriendRequest(req.user.id, targetUser.id);
  if (result.error) {
    return res.status(409).json({ error: result.error });
  }

  res.json({ message: 'Friend request sent.', userId: targetUser.id });
});

// ── POST /api/friends/accept/:userId ─────────────────────────────────────────
router.post('/accept/:userId', authenticate, (req, res) => {
  const fromUserId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const result = acceptFriendRequest(req.user.id, fromUserId);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json({ message: 'Friend request accepted.' });
});

// ── POST /api/friends/deny/:userId ───────────────────────────────────────────
router.post('/deny/:userId', authenticate, (req, res) => {
  const fromUserId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const result = denyFriendRequest(req.user.id, fromUserId);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json({ message: 'Friend request denied.' });
});

// ── DELETE /api/friends/:userId ──────────────────────────────────────────────
router.delete('/:userId', authenticate, (req, res) => {
  const friendId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(friendId) || friendId <= 0) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  removeFriend(req.user.id, friendId);
  res.json({ message: 'Friend removed.' });
});

// ── POST /api/friends/cancel/:userId ─────────────────────────────────────────
// Cancel a sent friend request
router.post('/cancel/:userId', authenticate, (req, res) => {
  const targetUserId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  // Remove the outgoing request (user_id = me, friend_id = target, status = pending)
  const { removeFriend: rm } = require('../database');
  rm(req.user.id, targetUserId);
  res.json({ message: 'Friend request cancelled.' });
});

module.exports = router;
