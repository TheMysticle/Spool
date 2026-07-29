'use strict';

const express = require('express');
const { getPendingDialogsForUser, markDialogRead, createAuditLog } = require('../database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// ── GET /api/dialogs/pending ──────────────────────────────────────────────────
router.get('/pending', (req, res) => {
  const dialogs = getPendingDialogsForUser(req.user.id);
  res.json(dialogs);
});

// ── POST /api/dialogs/:id/ack ─────────────────────────────────────────────────
router.post('/:id/ack', (req, res) => {
  const dialogId = Number(req.params.id);
  if (!Number.isInteger(dialogId) || dialogId < 1) {
    return res.status(400).json({ error: 'Invalid dialog id.' });
  }
  const result = markDialogRead(req.user.id, dialogId);
  if (result && result.changes > 0) {
    createAuditLog({
      userId: req.user.id,
      action: 'dialog_acknowledged',
      details: `Dialog ID ${dialogId} acknowledged.`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || null,
    });
  }
  res.json({ ok: true });
});

module.exports = router;
