/**
 * names.js — how a typed or spoken name matches a contact. Shared by the agent's
 * lookup_contact and the People tab search.
 *
 * 2026-10-09: "Alex Spargo" didn't find "Alexandria Spargo" — both searches matched the
 * whole phrase. Now each word you give must start a word of the contact's name (or
 * nickname / also-known-as), in any order: "alex spargo" → Alexandria Spargo,
 * "spargo" → Alexandria Spargo, "al spar" → Alexandria Spargo.
 */
'use strict';

const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);

// Every query word starts a different word of `target`.
function allWordsStart(queryWords, target) {
  const pool = words(target);
  if (!queryWords.length || !pool.length) return false;
  const used = new Set();
  return queryWords.every((q) => {
    const i = pool.findIndex((w, idx) => !used.has(idx) && w.startsWith(q));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

/**
 * Match quality, 0 = no match. 80+ = a strong match the agent may act on.
 *  100 exact name/nickname · 90 phone · 85 every word starts a name word · 80 prefix ·
 *  75 also-known-as · 60 first four letters ("Allie" → "Allison") · 50 substring.
 */
function matchScore(c, query) {
  const q = norm(query);
  if (!q) return 0;
  const qw = q.split(' ');
  const name = norm(c.name), nick = norm(c.nickname), akas = String(c.also_known_as || '').split(/[,;]+/).map(norm).filter(Boolean);
  const digits = String(query).replace(/\D/g, '');
  if (name === q || nick === q) return 100;
  if (digits.length >= 4 && String(c.phone || '').replace(/\D/g, '').includes(digits)) return 90;
  if (allWordsStart(qw, c.name) || allWordsStart(qw, c.nickname)) return 85;
  if (name.startsWith(q) || nick.startsWith(q)) return 80;
  if (akas.some((a) => a === q || a.startsWith(q) || allWordsStart(qw, a))) return 75;
  const prefix4 = q.slice(0, 4);
  if (prefix4.length >= 3 && words(c.name).some((w) => w.startsWith(prefix4))) return 60;
  if (name.includes(q) || nick.includes(q) || akas.some((a) => a.includes(q))) return 50;
  return 0;
}

/** People tab search: any real match (word starts, prefix, substring, phone). */
function matchesSearch(c, query) {
  return matchScore(c, query) >= 50;
}

module.exports = { matchScore, matchesSearch, norm };
