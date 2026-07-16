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

// ── Encryption helpers ────────────────────────────────────────────────────────

function getEncryptionKey() {
  const raw = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'dev-insecure-key';
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

// ── Sensitive mode session flag ───────────────────────────────────────────────
// Stored in memory only — resets on server restart. Per-user boolean.
// For persistence between sessions, store in DB (future).
const sensitiveModeUsers = new Set();

function setSensitiveMode(userId, on) {
  if (on) sensitiveModeUsers.add(userId);
  else sensitiveModeUsers.delete(userId);
}

function isSensitiveMode(userId) {
  return sensitiveModeUsers.has(userId);
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
  approveSharing,
  deletePrivateData,
  getAccessLog,
  setSensitiveMode,
  isSensitiveMode,
  scrubForAgentMessage,
  SENSITIVE_CATEGORIES,
  encrypt,
  decrypt,
};
