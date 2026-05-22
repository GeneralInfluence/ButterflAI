/**
 * ButterflAI crypto helpers — AES-256-GCM with KMS-wrapped data keys
 *
 * Architecture (§2 of IMPLEMENTATION.md):
 *  - Each user's private data is encrypted with a unique per-record data key.
 *  - The data key is wrapped (encrypted) by a KMS master key — never stored raw.
 *  - Decryption goes: unwrap data key via KMS → decrypt ciphertext in RAM → zero key.
 *  - Every decrypt writes an access_audit row (caller must supply purpose).
 *
 * KMS interface:
 *  - In production, swap KMS_PROVIDER to 'aws' | 'gcp' | 'azure'.
 *  - In development / test, KMS_PROVIDER=local uses a master key from env (KMS_MASTER_KEY_HEX).
 *    This is a dev-only convenience — do NOT use local KMS in production.
 *
 * Shape of private data (§2.8):
 * {
 *   version: 1,
 *   private_notes: { "marcus": "going through a breakup, be gentle" },
 *   exclusions: { "dinners_with_kaylee": ["julie"] }
 * }
 */

'use strict';

const crypto = require('crypto');

// ── KMS interface ─────────────────────────────────────────────────────────────

const KMS_PROVIDER = process.env.KMS_PROVIDER || 'local';

/**
 * Generate a fresh 256-bit data key and return it alongside its KMS-wrapped form.
 * Returns { rawKey: Buffer, wrappedKey: string (base64) }
 */
async function generateDataKey() {
  const rawKey = crypto.randomBytes(32);
  const wrappedKey = await kmsWrap(rawKey);
  return { rawKey, wrappedKey };
}

/**
 * Unwrap a previously wrapped data key using KMS.
 * Returns raw key Buffer.
 */
async function unwrapDataKey(wrappedKeyBase64) {
  return kmsUnwrap(Buffer.from(wrappedKeyBase64, 'base64'));
}

// KMS backends
async function kmsWrap(rawKeyBuffer) {
  if (KMS_PROVIDER === 'local') return localKmsWrap(rawKeyBuffer);
  throw new Error(`KMS provider '${KMS_PROVIDER}' not yet implemented. Add it to crypto.js.`);
}

async function kmsUnwrap(wrappedBuffer) {
  if (KMS_PROVIDER === 'local') return localKmsUnwrap(wrappedBuffer);
  throw new Error(`KMS provider '${KMS_PROVIDER}' not yet implemented. Add it to crypto.js.`);
}

// ── Local KMS (dev only) ──────────────────────────────────────────────────────

function getLocalMasterKey() {
  const hex = process.env.KMS_MASTER_KEY_HEX;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'KMS_MASTER_KEY_HEX must be set to a 64-char hex string (32 bytes) when KMS_PROVIDER=local.\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

function localKmsWrap(rawKeyBuffer) {
  const masterKey = getLocalMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([cipher.update(rawKeyBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) || tag(16) || ciphertext(32) — all concatenated, base64-encoded
  const wrapped = Buffer.concat([iv, tag, enc]);
  masterKey.fill(0);
  return wrapped.toString('base64');
}

function localKmsUnwrap(wrappedBuffer) {
  const masterKey = getLocalMasterKey();
  const iv = wrappedBuffer.slice(0, 12);
  const tag = wrappedBuffer.slice(12, 28);
  const enc = wrappedBuffer.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  const rawKey = Buffer.concat([decipher.update(enc), decipher.final()]);
  masterKey.fill(0);
  return rawKey;
}

// ── Record encrypt / decrypt ──────────────────────────────────────────────────

/**
 * Encrypt a JS object (private data blob) for a user.
 * Generates a fresh data key, wraps it via KMS.
 * Returns { ciphertext, iv, tag, wrapped_key } — all hex/base64 strings for DB storage.
 */
async function encryptRecord(obj) {
  const { rawKey, wrappedKey } = await generateDataKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', rawKey, iv);
  const plaintext = JSON.stringify(obj);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Zero the raw key immediately
  rawKey.fill(0);

  return {
    ciphertext: enc.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    wrapped_key: wrappedKey,
  };
}

/**
 * Decrypt a private data row and write an access_audit entry.
 *
 * @param {object} row       - Row from private_data table { ciphertext, iv, tag, wrapped_key }
 * @param {string} userId    - For audit log
 * @param {string} accessor  - 'agent_reasoning' | 'breakglass:<admin_id>'
 * @param {string} purpose   - Human-readable reason, e.g. 'coordinate_lunch_with_kaylee'
 * @param {string} recordClass - 'private_prefs' | 'exclusion' | 'private_note'
 * @param {object} db        - The db module (to write audit row)
 *
 * Returns the decrypted JS object.
 */
async function decryptRecord(row, userId, accessor, purpose, recordClass, db) {
  const rawKey = await unwrapDataKey(row.wrapped_key);

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    rawKey,
    Buffer.from(row.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(row.tag, 'hex'));

  const dec = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'hex')),
    decipher.final(),
  ]);

  const obj = JSON.parse(dec.toString('utf8'));

  // Zero sensitive buffers immediately
  rawKey.fill(0);
  dec.fill(0);

  // Write audit row — every decrypt is logged, no exceptions
  const outsideNormalPath = accessor !== 'agent_reasoning' ? 1 : 0;
  db.writeAccessAudit({ userId, accessor, purpose, recordClass, outsideNormalPath });

  if (outsideNormalPath) {
    console.warn(`[AUDIT ALERT] Break-glass access: user=${userId} accessor=${accessor} purpose=${purpose}`);
  }

  return obj;
}

// ── Convenience: user private data ───────────────────────────────────────────

/**
 * Read a user's private data blob.
 * Returns null if no private data exists yet.
 * Always writes an access_audit row when data exists.
 */
async function readUserPrivateData(userId, purpose, db) {
  const row = db.getPrivateData(userId);
  if (!row) return null;
  return decryptRecord(row, userId, 'agent_reasoning', purpose, 'private_prefs', db);
}

/**
 * Write (create or update) a user's private data blob.
 * Re-encrypts with a fresh data key every write (key rotation on every update).
 */
async function writeUserPrivateData(userId, dataObj, db) {
  const encrypted = await encryptRecord(dataObj);
  db.upsertPrivateData(userId, encrypted);
}

/**
 * Hard-delete a user's private data. Called on account deletion.
 * Caller is responsible for also deleting backups per the stated window.
 */
function deleteUserPrivateData(userId, db) {
  db.deletePrivateData(userId);
}

module.exports = {
  encryptRecord,
  decryptRecord,
  readUserPrivateData,
  writeUserPrivateData,
  deleteUserPrivateData,
};
