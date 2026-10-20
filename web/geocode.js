/**
 * geocode.js — where a place is, for Explore's map (🐛 #43). OpenStreetMap's Nominatim (free, no key;
 * its policy: ≤ 1 request a second and a real User-Agent). Only the place's name and town are sent —
 * never anything about a person. Off in tests unless a fake fetch is given.
 */
'use strict';

let _enabled = process.env.NODE_ENV !== 'test';
let _fetch = (...a) => fetch(...a);
function _setFetch(f) { _fetch = f; _enabled = !!f; _last = 0; }
let _last = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** "Cargo Concert Hall", "Reno" → { lat, lng } or null. */
async function find(place, town) {
  if (!_enabled || !place) return null;
  const q = [place, town].filter(Boolean).join(', ').slice(0, 200);
  const gap = 1100 - (Date.now() - _last);
  if (gap > 0) await wait(gap);
  _last = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await _fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'ButterflAI/1.0 (https://butterflai.social)', Accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const [hit] = await r.json();
    const lat = Number(hit?.lat), lng = Number(hit?.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch (_) { return null; }
}

module.exports = { find, _setFetch };
