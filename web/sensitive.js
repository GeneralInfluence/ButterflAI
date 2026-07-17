'use strict';
/**
 * sensitive.js — Sensitivity classifier and private data store
 *
 * Enforces PRIVACY.md Invariants 1, 2, 6, 7.
 * All sensitive data goes through here — never directly into user_preferences.
 *
 * Encryption: AES-256-GCM per record, key derived from ENCRYPTION_KEY env var
 * (falls back to JWT_SECRET). This is trust-based storage — ButterflAI can
 * read the data. Access is audited. See PRIVACY.md for the honest trust model.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Canonical key for the user's shareable health/safety note in the encrypted store.
// It has a fixed key (unlike free-form store_private_data entries) so the agent-to-agent
// hard-constraints path can find it. The value is HEALTH-category sensitive data and must
// live ONLY here (encrypted), never in plaintext user_preferences (PRIVACY.md Invariant 1).
const HEALTH_NOTES_KEY = 'health.safety_notes';

// ── Encryption helpers ────────────────────────────────────────────────────────

function getEncryptionKey() {
  // Fail closed: never encrypt/decrypt private data under a hardcoded default key.
  // (The removed 'dev-insecure-key' fallback silently encrypted real data under a
  // public constant.) JWT_SECRET remains a fallback so data already encrypted under
  // it stays decryptable; migrating to a dedicated ENCRYPTION_KEY is Phase 0.4.
  const raw = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!raw) {
    throw new Error(
      'Refusing to run: neither ENCRYPTION_KEY nor JWT_SECRET is set. Private data must ' +
      'not be encrypted under a hardcoded default. Set ENCRYPTION_KEY in the environment.'
    );
  }
  if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
    console.warn('[sensitive] PRODUCTION is using JWT_SECRET as the private-data key (key reuse). Set a dedicated ENCRYPTION_KEY and migrate — see docs/REARCHITECTURE.md Phase 0.4.');
  }
  // Derive a 32-byte key
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted_v: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: authTag.toString('base64'),
  };
}

function decrypt(encryptedV, iv, authTag) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedV, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ── Sensitivity classifier ────────────────────────────────────────────────────

const SENSITIVE_CATEGORIES = {
  HEALTH: [
    /\bSTI\b/i, /\bSTD\b/i, /\bHIV\b/i, /\bHPV\b/i, /\bherpes\b/i, /\bhepatitis\b/i,
    /\btest.*result/i, /\bresult.*test/i, /\bcame back (positive|negative)/i,
    /\bdiagnos/i, /\bmedication\b/i, /\bprescription\b/i, /\bchronic\b/i,
    /\bdisabilit/i, /\bpregnant\b/i, /\bpregnancy\b/i, /\bcancer\b/i,
    /\bsurger/i, /\bhospital/i, /\btreatment\b/i, /\btherapy\b/i,
  ],
  SEXUAL: [
    /\bsexual\b/i, /\bsex\b/i, /\borientation\b/i, /\bgay\b/i, /\blesbian\b/i,
    /\bbisexual\b/i, /\btransgender\b/i, /\bqueer\b/i, /\bkink\b/i,
    /\bintimate\b/i, /\bhooking up\b/i, /\bslept with\b/i,
  ],
  FINANCIAL: [
    /\bdebt\b/i, /\bbankrupt/i, /\bowing\b/i, /\bcan't afford\b/i, /\bcannot afford\b/i,
    /\bstruggling financially\b/i, /\bloan\b/i, /\bcredit score\b/i,
  ],
  LEGAL: [
    /\barrest/i, /\bcriminal\b/i, /\bconvict/i, /\blawsuit\b/i, /\bcourt\b/i,
    /\bcharge/i, /\bprobation\b/i, /\bparole\b/i, /\battorney\b/i,
  ],
  MENTAL_HEALTH: [
    /\bdepress/i, /\banxiet/i, /\bpsychiatri/i, /\bpsycholog/i, /\btherapist\b/i,
    /\bsuicid/i, /\bself.harm\b/i, /\bmental health\b/i, /\bmedication.*mood\b/i,
    /\bantidepressant/i, /\bOCD\b/i, /\bPTSD\b/i, /\bbipolar\b/i,
  ],
  RELATIONSHIP: [
    /\baffair\b/i, /\bcheating\b/i, /\bcheat\b/i, /\binfidelity\b/i,
    /\bbreaking up\b/i, /\bdivorc/i, /\bseparation\b/i,
  ],
};

/**
 * Classify text for sensitivity.
 * Returns { sensitive: bool, category: string|null, confidence: 'high'|'low'|'uncertain' }
 * Errs on the side of sensitive (Invariant 6).
 */
function classifyText(text) {
  if (!text || typeof text !== 'string') return { sensitive: false, category: null, confidence: 'high' };

  for (const [category, patterns] of Object.entries(SENSITIVE_CATEGORIES)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return { sensitive: true, category, confidence: 'high' };
      }
    }
  }

  // Uncertain signal words — flag as uncertain, default to sensitive (Invariant 6)
  const uncertainPatterns = [
    /\bprivate\b/i, /\bconfidential\b/i, /\bdon't tell\b/i, /\bonly.*know\b/i,
    /\bkeep.*between us\b/i, /\bbetween you and me\b/i, /\bsecret\b/i,
  ];
  for (const pattern of uncertainPatterns) {
    if (pattern.test(text)) {
      return { sensitive: true, category: 'OTHER', confidence: 'uncertain' };
    }
  }

  return { sensitive: false, category: null, confidence: 'high' };
}

// ── Private data store ────────────────────────────────────────────────────────

let _db = null;
function getDb() {
  if (!_db) _db = require('./db.js');
  return _db;
}

/**
 * Store sensitive data for a user. Encrypts and writes to user_private_data.
 * Also writes an access audit log entry.
 */
function storePrivateData(userId, dataKey, plaintext, category = 'OTHER') {
  const db = getDb();
  const raw = db._raw();
  const { encrypted_v, iv, auth_tag } = encrypt(String(plaintext));
  const id = uuidv4();

  raw.prepare(`
    INSERT INTO user_private_data (id, user_id, category, data_key, encrypted_v, iv, auth_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, data_key) DO UPDATE SET
      encrypted_v = excluded.encrypted_v,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      category = excluded.category,
      updated_at = strftime('%s','now')
  `).run(id, userId, category, dataKey, encrypted_v, iv, auth_tag);

  logAccess(userId, null, dataKey, 'write', 'user stored sensitive data');
  return { stored: true, data_key: dataKey, category };
}

/**
 * Read sensitive data for the owner user only.
 * Logs every read. Returns null if not found.
 * NEVER called with a different accessor — enforced by callers.
 */
function readPrivateData(userId, dataKey, context = 'user read own data') {
  const db = getDb();
  const raw = db._raw();
  const row = raw.prepare(
    'SELECT encrypted_v, iv, auth_tag FROM user_private_data WHERE user_id = ? AND data_key = ?'
  ).get(userId, dataKey);
  if (!row) return null;

  logAccess(userId, null, dataKey, 'read', context);
  try {
    return decrypt(row.encrypted_v, row.iv, row.auth_tag);
  } catch {
    return null; // decryption failure — don't leak
  }
}

/**
 * Read ALL private data for the owner user (for their own Settings view).
 * Returns array of { data_key, category, updated_at } — NOT the values (no bulk decrypt without user intent).
 */
function listPrivateData(userId) {
  const db = getDb();
  const raw = db._raw();
  return raw.prepare(
    'SELECT data_key, category, updated_at FROM user_private_data WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(userId);
}

/**
 * Read a specific private datum for sharing with another user's agent.
 * Enforces: target_user_id must be in sharing_approved_to for this data_key.
 * Logs every share attempt (approved or denied).
 */
function readPrivateDataForSharing(ownerUserId, dataKey, requestingUserId) {
  const db = getDb();
  const raw = db._raw();
  const row = raw.prepare(
    'SELECT encrypted_v, iv, auth_tag, sharing_approved_to FROM user_private_data WHERE user_id = ? AND data_key = ?'
  ).get(ownerUserId, dataKey);

  if (!row) {
    logAccess(ownerUserId, requestingUserId, dataKey, 'share', 'denied — no data');
    return { allowed: false, reason: 'not_found' };
  }

  let approved = [];
  try { approved = JSON.parse(row.sharing_approved_to || '[]'); } catch { approved = []; }

  if (!approved.includes(requestingUserId)) {
    logAccess(ownerUserId, requestingUserId, dataKey, 'share', 'denied — not in approved list');
    return { allowed: false, reason: 'not_approved' };
  }

  logAccess(ownerUserId, requestingUserId, dataKey, 'share', 'approved share');
  try {
    return { allowed: true, value: decrypt(row.encrypted_v, row.iv, row.auth_tag) };
  } catch {
    return { allowed: false, reason: 'decryption_error' };
  }
}

/**
 * Approve sharing a specific data key with a specific user.
 */
function approveSharing(ownerUserId, dataKey, approvedUserId) {
  const db = getDb();
  const raw = db._raw();
  const row = raw.prepare(
    'SELECT sharing_approved_to FROM user_private_data WHERE user_id = ? AND data_key = ?'
  ).get(ownerUserId, dataKey);
  if (!row) return false;

  let approved = [];
  try { approved = JSON.parse(row.sharing_approved_to || '[]'); } catch { approved = []; }
  if (!approved.includes(approvedUserId)) approved.push(approvedUserId);

  raw.prepare(
    'UPDATE user_private_data SET sharing_approved_to = ?, updated_at = strftime(\'%s\',\'now\') WHERE user_id = ? AND data_key = ?'
  ).run(JSON.stringify(approved), ownerUserId, dataKey);

  logAccess(ownerUserId, null, dataKey, 'share', `approved sharing with user ${approvedUserId}`);
  return true;
}

/**
 * Revoke a previously-granted per-edge sharing approval (owner → recipient, for one datum).
 * Consent is per user-pair, so it must be individually revocable.
 */
function revokeSharing(ownerUserId, dataKey, revokedUserId) {
  const db = getDb();
  const raw = db._raw();
  const row = raw.prepare(
    'SELECT sharing_approved_to FROM user_private_data WHERE user_id = ? AND data_key = ?'
  ).get(ownerUserId, dataKey);
  if (!row) return false;

  let approved = [];
  try { approved = JSON.parse(row.sharing_approved_to || '[]'); } catch { approved = []; }
  const next = approved.filter(id => id !== revokedUserId);
  if (next.length === approved.length) return false; // nothing to revoke

  raw.prepare(
    'UPDATE user_private_data SET sharing_approved_to = ?, updated_at = strftime(\'%s\',\'now\') WHERE user_id = ? AND data_key = ?'
  ).run(JSON.stringify(next), ownerUserId, dataKey);

  logAccess(ownerUserId, null, dataKey, 'share', `revoked sharing with user ${revokedUserId}`);
  return true;
}

/**
 * Who is this datum currently shared with? Returns an array of approved user_ids.
 */
function listSharingApprovals(ownerUserId, dataKey) {
  const db = getDb();
  const row = db._raw().prepare(
    'SELECT sharing_approved_to FROM user_private_data WHERE user_id = ? AND data_key = ?'
  ).get(ownerUserId, dataKey);
  if (!row) return [];
  try { return JSON.parse(row.sharing_approved_to || '[]'); } catch { return []; }
}

/**
 * Does a private datum exist for this user+key? Metadata only — no decrypt, no value.
 * Used to tell "has health info but not shared" from "has none" without exposing it.
 */
function hasPrivateData(userId, dataKey) {
  const db = getDb();
  return !!db._raw()
    .prepare('SELECT 1 FROM user_private_data WHERE user_id = ? AND data_key = ?')
    .get(userId, dataKey);
}

/**
 * One-time, idempotent migration: move any plaintext health_safety_notes still sitting in
 * user_preferences into the encrypted store, then NULL the plaintext column. Safe to run on
 * every startup — after the first pass there is nothing left to move. See PRIVACY.md
 * Invariant 1 and migration 025 (the column is retained but must stay NULL).
 */
function migratePlaintextHealthNotes() {
  const db = getDb();
  const raw = db._raw();
  let rows;
  try {
    rows = raw.prepare(
      "SELECT user_id, health_safety_notes FROM user_preferences WHERE health_safety_notes IS NOT NULL AND health_safety_notes != ''"
    ).all();
  } catch {
    return { migrated: 0 }; // column absent (e.g. a minimal test schema) — nothing to do
  }
  if (!rows.length) return { migrated: 0 };
  const run = raw.transaction(() => {
    let n = 0;
    for (const r of rows) {
      // Never clobber an existing encrypted note — that value is newer and authoritative.
      // Only adopt the legacy plaintext when there is nothing encrypted yet. Either way,
      // clear the plaintext column so no health data lingers in user_preferences.
      if (!hasPrivateData(r.user_id, HEALTH_NOTES_KEY)) {
        storePrivateData(r.user_id, HEALTH_NOTES_KEY, r.health_safety_notes, 'HEALTH');
      }
      raw.prepare('UPDATE user_preferences SET health_safety_notes = NULL WHERE user_id = ?').run(r.user_id);
      n++;
    }
    return n;
  });
  const migrated = run();
  if (migrated) console.log(`[sensitive] migrated ${migrated} plaintext health note(s) to the encrypted store`);
  return { migrated };
}

/**
 * Delete a private datum. Hard delete with audit log entry.
 */
function deletePrivateData(userId, dataKey) {
  const db = getDb();
  const raw = db._raw();
  logAccess(userId, null, dataKey, 'delete', 'user deleted private datum');
  raw.prepare('DELETE FROM user_private_data WHERE user_id = ? AND data_key = ?').run(userId, dataKey);
  return { deleted: true };
}

// ── Access audit log ──────────────────────────────────────────────────────────

function logAccess(userId, accessorId, dataKey, action, context) {
  try {
    const db = getDb();
    const raw = db._raw();
    raw.prepare(`
      INSERT INTO private_data_access_log (id, user_id, accessor_id, data_key, action, context)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), userId, accessorId || null, dataKey, action, context || null);
  } catch { /* non-fatal — never suppress the main operation for a log failure */ }
}

function getAccessLog(userId, limit = 20) {
  const db = getDb();
  const raw = db._raw();
  return raw.prepare(
    'SELECT action, data_key, accessor_id, context, created_at FROM private_data_access_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, limit);
}

// ── Sensitive mode flag — persisted in user_preferences ──────────────────────
// Survives server restarts. Stored as `sensitive_mode INTEGER` in user_preferences.

function setSensitiveMode(userId, on) {
  try {
    const db = getDb();
    const raw = db._raw();
    const existing = raw.prepare('SELECT user_id FROM user_preferences WHERE user_id = ?').get(userId);
    if (!existing) {
      raw.prepare('INSERT INTO user_preferences (user_id, sensitive_mode) VALUES (?, ?)').run(userId, on ? 1 : 0);
    } else {
      raw.prepare('UPDATE user_preferences SET sensitive_mode = ?, updated_at = strftime(\'%s\',\'now\') WHERE user_id = ?').run(on ? 1 : 0, userId);
    }
  } catch (_) { /* non-fatal */ }
}

function isSensitiveMode(userId) {
  try {
    const db = getDb();
    const row = db._raw().prepare('SELECT sensitive_mode FROM user_preferences WHERE user_id = ?').get(userId);
    return !!(row?.sensitive_mode);
  } catch { return false; }
}

// ── Agent message scrubber ────────────────────────────────────────────────────

/**
 * Scrub an object to ensure no sensitive fields cross the agent-to-agent wire.
 * Used before serializing any agent_messages payload.
 * Returns a safe copy with sensitive fields removed.
 */
const BANNED_CROSS_AGENT_KEYS = [
  'exclusion_reason', 'health_safety_notes', 'sexual_health_notes',
  'private_notes', 'mental_health_notes', 'financial_notes', 'legal_notes',
];

function scrubForAgentMessage(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const safe = { ...obj };
  for (const key of BANNED_CROSS_AGENT_KEYS) {
    if (key in safe) {
      delete safe[key];
    }
  }
  return safe;
}

module.exports = {
  classifyText,
  storePrivateData,
  readPrivateData,
  listPrivateData,
  readPrivateDataForSharing,
  hasPrivateData,
  migratePlaintextHealthNotes,
  approveSharing,
  revokeSharing,
  listSharingApprovals,
  deletePrivateData,
  HEALTH_NOTES_KEY,
  getAccessLog,
  setSensitiveMode,
  isSensitiveMode,
  scrubForAgentMessage,
  SENSITIVE_CATEGORIES,
  encrypt,
  decrypt,
};
