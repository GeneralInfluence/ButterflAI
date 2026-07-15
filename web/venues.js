/**
 * ButterflAI venue suggestions (§1.7 IMPLEMENTATION.md)
 *
 * v1 mechanism:
 *  - Each user has a per-user favorites list (unencrypted, not publicly exposed).
 *  - Agent suggests from favorites + new discoveries via Google Places API.
 *  - When two agents coordinate, they share favorites lists bilaterally.
 *
 * NOT built here:
 *  - Cross-user aggregation ("people like you also like X") — blocked on
 *    network-graph consent decision (MEMORY.md Open Q2). Do not build.
 *  - Reservation booking API (OpenTable/Resy) — deferred; manual fallback used.
 *
 * Google Places API (New) used for discovery:
 *  - Text search with cuisine type + neighborhood + open time
 *  - Returns name, address, rating, price level, website
 */

'use strict';

const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// ── Table setup ───────────────────────────────────────────────────────────────

function ensureVenuesTables() {
  db._raw().exec(`
    CREATE TABLE IF NOT EXISTS venue_favorites (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      name        TEXT NOT NULL,
      address     TEXT,
      cuisine     TEXT,
      price_level INTEGER,        -- 1 (cheap) to 4 (expensive)
      rating      REAL,
      website     TEXT,
      google_place_id TEXT,
      notes       TEXT,           -- user's personal notes (e.g. "great for dates")
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_venue_fav_user ON venue_favorites(user_id);
  `);
}

// ── Favorites CRUD ────────────────────────────────────────────────────────────

function addFavorite(userId, { name, address, cuisine, price_level, rating, website, google_place_id, notes }) {
  const id = uuidv4();
  db._raw().prepare(`
    INSERT INTO venue_favorites (id, user_id, name, address, cuisine, price_level, rating, website, google_place_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, name, address || null, cuisine || null, price_level || null,
         rating || null, website || null, google_place_id || null, notes || null);
  return id;
}

function getFavorites(userId) {
  return db._raw()
    .prepare('SELECT * FROM venue_favorites WHERE user_id = ? ORDER BY name')
    .all(userId);
}

function removeFavorite(userId, venueId) {
  db._raw()
    .prepare('DELETE FROM venue_favorites WHERE id = ? AND user_id = ?')
    .run(venueId, userId);
}

// ── Google Places search ──────────────────────────────────────────────────────

/**
 * Search Google Places (New API) for venues matching criteria.
 *
 * @param {object} opts
 *   query        - text query e.g. "italian restaurant SoHo NYC"
 *   max_results  - default 5
 * @returns {Array<venue>}
 */
async function searchPlaces({ query, max_results = 5 }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn('[venues] GOOGLE_PLACES_API_KEY not set — returning empty results');
    return [];
  }

  const body = JSON.stringify({
    textQuery: query,
    maxResultCount: max_results,
    languageCode: 'en',
  });

  const data = await httpsPost(
    'places.googleapis.com',
    '/v1/places:searchText',
    {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.priceLevel,places.websiteUri,places.primaryType',
    },
    body
  );

  // FLAI burn instrumentation — STUB, always permissive (§2.3)
  // TODO: venues.js doesn't receive userId at this call site; wire it when the call chain provides it
  try { require('./flai').burnForUser(null, 'burn:places', {}); } catch (_) {}

  const parsed = JSON.parse(data);
  return (parsed.places || []).map(p => ({
    google_place_id: p.id,
    name: p.displayName?.text || 'Unknown',
    address: p.formattedAddress || '',
    rating: p.rating || null,
    price_level: parsePriceLevel(p.priceLevel),
    website: p.websiteUri || null,
    cuisine: p.primaryType?.replace(/_/g, ' ') || null,
  }));
}

// ── Suggestions engine ────────────────────────────────────────────────────────

/**
 * Generate venue suggestions for a user's activity.
 *
 * Returns up to 3 options: favourites first, then new discoveries.
 *
 * @param {string}  userId
 * @param {object}  opts
 *   activity_type  - 'lunch' | 'dinner' | 'drinks' | etc.
 *   neighborhood   - preferred area (optional)
 *   dietary        - array of dietary restrictions (optional)
 *   party_size     - number of people (default 2)
 *   price_level    - max price level 1–4 (optional)
 * @returns {{ options: venue[], source: string }}
 */
async function suggestVenues(userId, { activity_type, neighborhood, dietary, party_size = 2, price_level } = {}) {
  const favorites = getFavorites(userId);

  // Filter favorites by activity/dietary/price
  const matchingFaves = favorites.filter(v => {
    if (price_level && v.price_level && v.price_level > price_level) return false;
    if (dietary?.includes('vegetarian') && v.notes?.toLowerCase().includes('no veg')) return false;
    return true;
  });

  const options = [];

  // Add up to 2 favourites
  for (const fav of matchingFaves.slice(0, 2)) {
    options.push({ ...fav, source: 'favorite' });
  }

  // Pad with new discoveries from Google Places
  if (options.length < 3) {
    const needed = 3 - options.length;
    const queryParts = [activity_type || 'restaurant'];
    if (dietary?.includes('vegetarian')) queryParts.push('vegetarian');
    if (neighborhood) queryParts.push(neighborhood);
    const query = queryParts.join(' ');

    try {
      const discoveries = await searchPlaces({ query, max_results: needed + 2 });
      // Exclude places already in favorites
      const faveIds = new Set(favorites.map(f => f.google_place_id).filter(Boolean));
      const fresh = discoveries.filter(d => !faveIds.has(d.google_place_id));
      for (const v of fresh.slice(0, needed)) {
        options.push({ ...v, source: 'discovery' });
      }
    } catch (err) {
      console.error('[venues] places search error:', err.message);
    }
  }

  return { options: options.slice(0, 3) };
}

/**
 * Format venue options as an SMS-friendly numbered list.
 */
function formatOptionsForSMS(options) {
  const labels = ['A', 'B', 'C'];
  return options.map((v, i) => {
    const price = v.price_level ? '$'.repeat(v.price_level) : '';
    const rating = v.rating ? ` ⭐${v.rating}` : '';
    const tag = v.source === 'favorite' ? ' (your usual)' : ' (new)';
    return `[${labels[i]}] ${v.name}${tag}\n    ${v.address}${price ? ' · ' + price : ''}${rating}`;
  }).join('\n\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePriceLevel(raw) {
  const map = { PRICE_LEVEL_FREE: 1, PRICE_LEVEL_INEXPENSIVE: 1,
                PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3,
                PRICE_LEVEL_VERY_EXPENSIVE: 4 };
  return map[raw] || null;
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

ensureVenuesTables();

module.exports = {
  addFavorite,
  getFavorites,
  removeFavorite,
  searchPlaces,
  suggestVenues,
  formatOptionsForSMS,
};
