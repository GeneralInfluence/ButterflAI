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

// Common English nicknames → given names (2026-10-09: "Liz" didn't find Elizabeth). A
// nickname match is LIKELY, not certain: the agent confirms once, then the alias is
// learned (learnedAlias) and it's an exact match from then on.
const NICKNAMES = {
  abby: ['abigail'], al: ['albert', 'alan', 'allen', 'alfred', 'alexander', 'alexandra'], alex: ['alexander', 'alexandra', 'alexandria', 'alexis'],
  allie: ['allison', 'alison', 'alexandra', 'alice'], ally: ['allison', 'alison', 'alexandra'], andy: ['andrew', 'andrea'], annie: ['ann', 'anne', 'anna'],
  barb: ['barbara'], becky: ['rebecca'], ben: ['benjamin', 'benedict'], beth: ['elizabeth', 'bethany'], betsy: ['elizabeth'], betty: ['elizabeth'],
  bill: ['william'], billy: ['william'], bob: ['robert'], bobby: ['robert'], cathy: ['catherine', 'cathleen'], kate: ['katherine', 'catherine', 'kathleen'],
  katie: ['katherine', 'catherine', 'kathleen'], kathy: ['katherine', 'kathleen'], chris: ['christopher', 'christine', 'christina'], chuck: ['charles'],
  charlie: ['charles', 'charlotte'], dan: ['daniel'], danny: ['daniel'], dave: ['david'], deb: ['deborah', 'debra'], debbie: ['deborah', 'debra'],
  dick: ['richard'], ed: ['edward', 'edwin', 'edmund'], eddie: ['edward'], ellie: ['eleanor', 'elizabeth', 'ellen'], fred: ['frederick'],
  gabe: ['gabriel'], greg: ['gregory'], hank: ['henry'], jack: ['john', 'jackson'], jake: ['jacob'], jen: ['jennifer'], jenny: ['jennifer'],
  jim: ['james'], jimmy: ['james'], jamie: ['james', 'jameson'], joe: ['joseph'], joey: ['joseph'], john: ['jonathan'], jon: ['jonathan'], josh: ['joshua'],
  kim: ['kimberly'], larry: ['lawrence'], liz: ['elizabeth'], lizzie: ['elizabeth'], lou: ['louis', 'louise'], maddie: ['madison', 'madeline'],
  mandy: ['amanda'], matt: ['matthew'], meg: ['margaret', 'megan'], mel: ['melanie', 'melissa', 'melinda'], mike: ['michael'], mikey: ['michael'],
  mitch: ['mitchell'], nate: ['nathan', 'nathaniel'], nick: ['nicholas'], nikki: ['nicole'], pam: ['pamela'], pat: ['patrick', 'patricia'],
  patty: ['patricia'], peggy: ['margaret'], pete: ['peter'], phil: ['philip', 'phillip'], rich: ['richard'], rick: ['richard', 'eric', 'frederick'],
  rob: ['robert'], robbie: ['robert'], ron: ['ronald'], sam: ['samuel', 'samantha'], sandy: ['sandra'], steve: ['steven', 'stephen'],
  sue: ['susan', 'suzanne'], susie: ['susan'], ted: ['theodore', 'edward'], teddy: ['theodore'], tim: ['timothy'], tom: ['thomas'], tommy: ['thomas'],
  tony: ['anthony'], trish: ['patricia'], val: ['valerie'], vicky: ['victoria'], vince: ['vincent'], will: ['william'], zach: ['zachary'], zack: ['zachary'],
};
// Query first word is a nickname of the contact's first name, other words start name words.
function nicknameMatch(queryWords, target) {
  const [qFirst, ...rest] = queryWords;
  const [first, ...others] = words(target);
  if (!qFirst || !first || !(NICKNAMES[qFirst] || []).includes(first)) return false;
  return !rest.length || allWordsStart(rest, others.join(' '));
}

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
 *  101 a name the user has used for them before (learned alias — beats a namesake) ·
 *  100 exact name/nickname · 90 phone · 85 every word starts a name word · 80 prefix ·
 *  75 alias prefix · 70 common nickname ("Liz" → Elizabeth) · 60 first four letters ·
 *  50 substring.
 */
function matchScore(c, query) {
  const q = norm(query);
  if (!q) return 0;
  const qw = q.split(' ');
  const name = norm(c.name), nick = norm(c.nickname), akas = String(c.also_known_as || '').split(/[,;]+/).map(norm).filter(Boolean);
  const digits = String(query).replace(/\D/g, '');
  if (akas.includes(q)) return 101;
  if (name === q || nick === q) return 100;
  if (digits.length >= 4 && String(c.phone || '').replace(/\D/g, '').includes(digits)) return 90;
  if (allWordsStart(qw, c.name) || allWordsStart(qw, c.nickname)) return 85;
  if (name.startsWith(q) || nick.startsWith(q)) return 80;
  if (akas.some((a) => allWordsStart(qw, a))) return 85;
  if (akas.some((a) => a.startsWith(q))) return 75;
  if (nicknameMatch(qw, c.name) || nicknameMatch(qw, c.nickname)) return 70;
  const prefix4 = q.slice(0, 4);
  if (prefix4.length >= 3 && words(c.name).some((w) => w.startsWith(prefix4))) return 60;
  if (name.includes(q) || nick.includes(q) || akas.some((a) => a.includes(q))) return 50;
  return 0;
}

/** People tab search: any real match (word starts, prefix, substring, phone). */
function matchesSearch(c, query) {
  return matchScore(c, query) >= 50;
}

/**
 * A name the user called this contact, worth remembering as an alias — or null.
 * Only real names (1–4 words, letters), and only if it isn't already an exact match.
 */
function learnedAlias(c, query) {
  const q = String(query || '').trim().replace(/\s+/g, ' ');
  if (!q || q.length > 40 || /\d/.test(q) || !/^[\p{L}' .-]+$/u.test(q) || q.split(' ').length > 4) return null;
  return matchScore(c, q) >= 100 ? null : q;
}

module.exports = { matchScore, matchesSearch, learnedAlias, norm, NICKNAMES };
