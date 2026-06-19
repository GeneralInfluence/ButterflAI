/**
 * ButterflAI admin routes
 *
 * Mounted at /admin — ALL routes require ADMIN_SECRET header.
 *
 * Routes:
 *   GET  /admin/users                        — list all users
 *   GET  /admin/users/:id                    — user detail + row counts
 *   POST /admin/users/merge                  — merge two user accounts into one
 *   DELETE /admin/users/:id                  — delete a user + all their data
 *   GET  /admin/stats                        — platform-wide counts
 *
 * Auth: request must include header  X-Admin-Secret: <ADMIN_SECRET env var>
 * Never expose these routes without auth.
 */

'use strict';

const express = require('express');
const db      = require('./db');

const router = express.Router();

// ── Auth middleware ───────────────────────────────────────────────────────────

const ADMIN_SECRET = process.env.ADMIN_SECRET;

router.use((req, res, next) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'Admin secret not configured on server.' });
  }
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function userStats(userId) {
  const raw = db._raw();
  const count = (tbl, col) => {
    try { return raw.prepare(`SELECT COUNT(*) as n FROM ${tbl} WHERE ${col}=?`).get(userId).n; }
    catch { return null; }
  };
  return {
    contacts:      count('contacts',             'invited_by_user_id'),
    conversations: count('conversation_history', 'user_id'),
    desires:       count('desires',              'user_id'),
    relationships: count('relationships',        'user_id'),
    inbound:       count('inbound_messages',     'from_id'),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /admin/users — list all users
router.get('/users', (req, res) => {
  const users = db._raw().prepare(
    'SELECT id, name, phone, onboarding_state, created_at FROM users ORDER BY created_at DESC'
  ).all();
  res.json({ users });
});

// GET /admin/users/:id — detail + row counts
router.get('/users/:id', (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user, stats: userStats(req.params.id) });
});

// GET /admin/stats — platform-wide counts
router.get('/stats', (req, res) => {
  const raw = db._raw();
  const count = (tbl) => {
    try { return raw.prepare(`SELECT COUNT(*) as n FROM ${tbl}`).get().n; }
    catch { return null; }
  };
  res.json({
    users:         count('users'),
    contacts:      count('contacts'),
    conversations: count('conversation_history'),
    desires:       count('desires'),
    sessions:      count('coordination_sessions'),
    inbound:       count('inbound_messages'),
  });
});

// POST /admin/users/merge — merge two user accounts
// Body: { keepId: string, dropId: string }
// Keeps keepId, reassigns all data from dropId to keepId, deletes dropId.
router.post('/users/merge', (req, res) => {
  const { keepId, dropId } = req.body;
  if (!keepId || !dropId) return res.status(400).json({ error: 'keepId and dropId required.' });
  if (keepId === dropId) return res.status(400).json({ error: 'keepId and dropId must differ.' });

  const keepUser = db.getUser(keepId);
  const dropUser = db.getUser(dropId);
  if (!keepUser) return res.status(404).json({ error: `keepId ${keepId} not found.` });
  if (!dropUser) return res.status(404).json({ error: `dropId ${dropId} not found.` });

  const raw = db._raw();

  // Tables to reassign and their owner column
  const reassignments = [
    { table: 'contacts',             col: 'invited_by_user_id' },
    { table: 'conversation_history', col: 'user_id' },
    { table: 'desires',              col: 'user_id' },
    { table: 'relationships',        col: 'user_id' },
    { table: 'inbound_messages',     col: 'from_id' },
    { table: 'cadences',             col: null },   // via relationships — handled separately
    { table: 'pending_actions',      col: 'user_id' },
    { table: 'user_preferences',     col: 'user_id' },
    { table: 'private_data',         col: 'user_id' },
    { table: 'access_audit',         col: 'user_id' },
    { table: 'user_wallets',         col: 'user_id' },
    { table: 'coordination_sessions',col: 'initiator_user_id' },
  ];

  const changes = {};

  const merge = raw.transaction(() => {
    for (const { table, col } of reassignments) {
      if (!col) continue;
      try {
        const r = raw.prepare(`UPDATE ${table} SET ${col}=? WHERE ${col}=?`).run(keepId, dropId);
        if (r.changes) changes[table] = r.changes;
      } catch { /* table may not exist */ }
    }
    // Delete the duplicate
    const del = raw.prepare('DELETE FROM users WHERE id=?').run(dropId);
    changes._deleted_user = del.changes;
  });

  merge();

  res.json({
    ok: true,
    kept: { id: keepId, name: keepUser.name, phone: keepUser.phone },
    dropped: { id: dropId, name: dropUser.name, phone: dropUser.phone },
    changes,
  });
});

// DELETE /admin/users/:id — delete user + all their data
// Body: { confirm: true } required as safety gate
router.delete('/users/:id', (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Pass { confirm: true } in body to confirm deletion.' });
  }
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const raw  = db._raw();
  const del  = (tbl, col) => {
    try { return raw.prepare(`DELETE FROM ${tbl} WHERE ${col}=?`).run(req.params.id).changes; }
    catch { return 0; }
  };

  const changes = raw.transaction(() => ({
    contacts:      del('contacts',             'invited_by_user_id'),
    conversations: del('conversation_history', 'user_id'),
    desires:       del('desires',              'user_id'),
    relationships: del('relationships',        'user_id'),
    inbound:       del('inbound_messages',     'from_id'),
    pending:       del('pending_actions',      'user_id'),
    prefs:         del('user_preferences',     'user_id'),
    private_data:  del('private_data',         'user_id'),
    audit:         del('access_audit',         'user_id'),
    wallets:       del('user_wallets',         'user_id'),
    user:          del('users',                'id'),
  }))();

  res.json({ ok: true, deleted: { id: req.params.id, name: user.name }, changes });
});

module.exports = router;
