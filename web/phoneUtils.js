/**
 * Phone number utilities
 *
 * toE164(raw) — lightweight US-centric E.164 normalizer.
 * Used by the consent ledger and opt-out store so all reads/writes
 * use one canonical form regardless of how the caller formatted the number.
 *
 * Handles: +12025550147, 12025550147, 2025550147, (202) 555-0147,
 *          202-555-0147, 202.555.0147
 * International numbers that already start with + are passed through as-is.
 */

'use strict';

/**
 * Normalize a phone number string to E.164.
 * Returns the original value unchanged if it cannot be parsed.
 *
 * @param {string} raw
 * @returns {string}
 */
function toE164(raw) {
  if (!raw || typeof raw !== 'string') return raw;

  const trimmed = raw.trim();

  // Already canonical E.164 (e.g. +12025550147 or any +<digits> up to 15 chars)
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed;

  // Strip everything except digits
  const digits = trimmed.replace(/\D/g, '');

  if (digits.length === 0) return raw; // can't normalize

  // US 10-digit local number
  if (digits.length === 10) return `+1${digits}`;

  // US 11-digit with leading 1
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;

  // Fallback: prepend + and trust the caller
  return `+${digits}`;
}

module.exports = { toE164 };
