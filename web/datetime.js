'use strict';
/**
 * datetime.js — deterministic day/time resolution for agent-created events.
 *
 * The LLM (Haiku) is unreliable at calendar arithmetic — it mislabels weekdays and
 * picks off-by-one dates even when handed a weekday->date table. So instead of trusting
 * the model to compute an ISO date, the agent passes the user's day+time PHRASE exactly
 * as spoken ("friday 7pm", "saturday evening", "tomorrow at 8pm") and THIS code computes
 * the exact instant in the user's timezone. No model math in the scheduling path.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NAMED_TIMES = { midnight: [0, 0], morning: [9, 0], noon: [12, 0], afternoon: [14, 0], evening: [19, 0], night: [20, 0], tonight: [19, 0] };

// Milliseconds that `tz` is offset from UTC at the given instant (handles DST).
function tzOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) if (part.type !== 'literal') p[part.type] = part.value;
  let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

// The UTC instant for a wall-clock y-m-d HH:MM in `tz` (one refinement absorbs DST).
function zonedWallTimeToUTC(y, m, d, HH, MM, tz) {
  const guess = Date.UTC(y, m - 1, d, HH, MM, 0);
  let inst = guess - tzOffsetMs(new Date(guess), tz);
  inst = guess - tzOffsetMs(new Date(inst), tz);
  return new Date(inst);
}

function todayYMDInTz(now, tz) {
  const [y, m, d] = now.toLocaleDateString('en-CA', { timeZone: tz }).split('-').map(Number);
  return { y, m, d };
}

// Parse a clock time out of free text → { HH, MM } (24h) or null.
function parseTime(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  if (m) {
    let HH = +m[1]; const MM = +m[2];
    if (m[3]) { HH = HH % 12; if (m[3] === 'pm') HH += 12; }
    if (HH < 24 && MM < 60) return { HH, MM };
  }
  m = s.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (m) { let HH = +m[1] % 12; if (m[2] === 'pm') HH += 12; return { HH, MM: 0 }; }
  for (const k of Object.keys(NAMED_TIMES)) {
    if (new RegExp('\\b' + k + '\\b').test(s)) { const [HH, MM] = NAMED_TIMES[k]; return { HH, MM }; }
  }
  return null;
}

// Parse a target date out of free text → { y, m, d } (in `tz`) or null.
function parseDate(text, tz, now) {
  const s = String(text || '').toLowerCase();
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };

  const { y, m, d } = todayYMDInTz(now, tz);
  const todayNoon = Date.UTC(y, m - 1, d, 12);              // noon avoids DST/date-edge
  const shift = (n) => { const dt = new Date(todayNoon + n * 86400000); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; };

  if (/\btoday\b|\btonight\b/.test(s)) return shift(0);
  if (/\btomorrow\b/.test(s)) return shift(1);

  const todayIdx = new Date(todayNoon).getUTCDay();
  const wd = WEEKDAYS.findIndex(w => new RegExp('\\b' + w + '\\b').test(s));
  if (wd >= 0) {
    let delta = (wd - todayIdx + 7) % 7;                    // next occurrence on/after today
    if (/\bnext\b/.test(s) && delta === 0) delta = 7;       // "next friday" when today IS friday
    return shift(delta);
  }
  if (/\bweekend\b/.test(s)) return shift((6 - todayIdx + 7) % 7);   // upcoming Saturday (today if Sat)
  return null;
}

/**
 * Resolve a day+time phrase to a concrete instant in `timezone`.
 * @returns {{ts:number, iso:string, weekday:string, date:string, label:string}|null}
 *          null if either a date or a time can't be extracted (caller should ask / fall back).
 */
function resolveEventDateTime(whenText, timezone, now = new Date()) {
  const tz = timezone || 'America/Los_Angeles';
  const date = parseDate(whenText, tz, now);
  const time = parseTime(whenText);
  if (!date || !time) return null;
  const utc = zonedWallTimeToUTC(date.y, date.m, date.d, time.HH, time.MM, tz);
  return {
    ts: Math.floor(utc.getTime() / 1000),
    iso: utc.toISOString(),
    weekday: utc.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz }),
    date: utc.toLocaleDateString('en-CA', { timeZone: tz }),
    label: utc.toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  };
}

module.exports = { resolveEventDateTime, parseTime, parseDate, zonedWallTimeToUTC };
