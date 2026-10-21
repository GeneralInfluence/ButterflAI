/**
 * geocode.js — where a place is, for Explore's map (🐛 #43, #46). Photon (photon.komoot.io — free, built
 * on OpenStreetMap, forgiving with names; Nominatim found nothing for "Bartley Ranch Regional Park").
 * Only the place's name/address and town are sent — never anything about a person. A result counts only
 * if it's near the person's town and (for a name) its name has the place's distinctive words — Photon
 * offered "Silver Creek Condominiums" for "Silver Apothecary Co.". Off in tests unless a fake fetch is given.
 */
'use strict';

let _enabled = process.env.NODE_ENV !== 'test';
let _fetch = (...a) => fetch(...a);
function _setFetch(f) { _fetch = f; _enabled = !!f; _last = 0; }
let _last = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NEAR_KM = 80;

const GENERIC = new Set('the a an and of at in on co company inc llc studio studios hall center centre park regional ranch bar grill cafe café restaurant club venue house theater theatre room lounge shop store gallery market brewing brewery co. reno'.split(' '));
function distinctive(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !GENERIC.has(w));
}
/** Does a found name look like the place asked for? */
function sameName(asked, found) {
  const want = distinctive(asked);
  if (!want.length) return false;
  const have = new Set(String(found || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/));
  const hits = want.filter((w) => have.has(w)).length;
  return want.length >= 4 ? hits / want.length >= 0.66 : hits === want.length;
}
function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function photon(q, near) {
  const gap = 1100 - (Date.now() - _last);
  if (gap > 0) await wait(gap);
  _last = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const bias = near ? `&lat=${near.lat.toFixed(3)}&lon=${near.lng.toFixed(3)}` : '';
    const r = await _fetch(`https://photon.komoot.io/api/?limit=3${bias}&q=${encodeURIComponent(q.slice(0, 200))}`,
      { headers: { 'User-Agent': 'ButterflAI/1.0 (https://butterflai.social)', Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.features || []).map((f) => ({ lat: Number(f.geometry?.coordinates?.[1]), lng: Number(f.geometry?.coordinates?.[0]), name: f.properties?.name || '',
      street: f.properties?.street || '', type: f.properties?.type || '' })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
  } catch (_) { return []; } finally { clearTimeout(t); }
}

const towns = new Map();
/** Where a town is (once per town). */
async function town(name) {
  if (!_enabled || !name) return null;
  const k = String(name).toLowerCase();
  if (towns.has(k)) return towns.get(k);
  const [hit] = await photon(name, null);
  const out = hit ? { lat: hit.lat, lng: hit.lng } : null;
  towns.set(k, out);
  return out;
}

/** A place (by its address if known, else its name) near a town → { lat, lng } or null. */
async function find(place, townName, { address = null, near = null } = {}) {
  if (!_enabled || (!place && !address)) return null;
  const center = near || await town(townName);
  const close = (x) => !center || km(center, x) <= NEAR_KM;
  if (address) {
    const hit = (await photon(`${address}${townName && !address.toLowerCase().includes(String(townName).toLowerCase()) ? `, ${townName}` : ''}`, center)).find(close);
    if (hit) return { lat: hit.lat, lng: hit.lng };
  }
  if (place) {
    const hit = (await photon(`${place} ${townName || ''}`.trim(), center)).find((x) => close(x) && sameName(place, x.name));
    if (hit) return { lat: hit.lat, lng: hit.lng };
  }
  return null;
}

module.exports = { find, town, sameName, _setFetch };
