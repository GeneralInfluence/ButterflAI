/**
 * weather.js — daily forecast for a place, for planning (Open-Meteo: free, no key).
 *
 * 2026-10-09: Sean asked his agent to plan a Grover Hot Springs camping weekend and
 * whether it would freeze; the agent had no weather tool. This returns up to 16 days of
 * daily highs/lows (°F), chance of rain/snow, and a plain-English summary — with each
 * day's weekday and date labelled HERE, in code, because the model mislabels weekdays.
 * Nights at or below freezing are flagged.
 */

'use strict';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_DAYS = 16;
const FREEZING_F = 32;

// WMO weather codes → words (subset that matters for plans)
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'heavy rain showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};

let _fetch = (...a) => fetch(...a);
function _setFetch(f) { _fetch = f; }   // tests only

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await _fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// "Grover Hot Springs State Park, CA" → try the full name, then simpler forms.
async function geocode(place) {
  const tries = [place, place.replace(/\b(state park|national park|campground|park|resort)\b/ig, ''), place.split(',')[0]]
    .map((s) => s.replace(/\s+/g, ' ').trim()).filter((s, i, a) => s && a.indexOf(s) === i);
  for (const name of tries) {
    let d = null;
    try { d = await getJson(`${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`); }
    catch (_) { continue; }                      // one failed lookup → try the simpler name
    const g = d?.results?.[0];
    if (g) return { name: [g.name, g.admin1, g.country_code].filter(Boolean).join(', '), latitude: g.latitude, longitude: g.longitude, timezone: g.timezone };
  }
  return null;
}

/**
 * Forecast for a place. Pass `place` (a town, park or address) and/or coordinates.
 * Returns { location, days: [{date, weekday, high_f, low_f, freezing, precip_chance, conditions}], freezing_nights, covers_through }.
 */
async function forecast({ place, latitude, longitude } = {}) {
  let loc;
  try {
    if (latitude != null && longitude != null) {
      loc = { name: place || `${latitude}, ${longitude}`, latitude: +latitude, longitude: +longitude, timezone: 'auto' };
    } else if (place) {
      loc = await geocode(String(place));
      if (!loc) return { error: 'PLACE_NOT_FOUND', message: `Couldn't find "${place}". Try the nearest town (e.g. "Markleeville, CA"), or pass latitude/longitude.` };
    } else {
      return { error: 'PLACE_REQUIRED', message: 'Say where — a town, park, or coordinates.' };
    }
    const q = new URLSearchParams({
      latitude: loc.latitude, longitude: loc.longitude, timezone: loc.timezone || 'auto', forecast_days: FORECAST_DAYS,
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode',
      temperature_unit: 'fahrenheit',
    });
    const d = await getJson(`${FORECAST_URL}?${q}`);
    const t = d.daily || {};
    const days = (t.time || []).map((date, i) => {
      const low = Math.round(t.temperature_2m_min[i]);
      return {
        date,
        // Weekday computed here (noon UTC avoids date-edge shifts) — never by the model.
        weekday: new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
        high_f: Math.round(t.temperature_2m_max[i]),
        low_f: low,
        freezing: low <= FREEZING_F,
        precip_chance: t.precipitation_probability_max?.[i] ?? null,
        conditions: WMO[t.weathercode?.[i]] || 'mixed',
      };
    });
    return {
      location: loc.name,
      days,
      freezing_nights: days.filter((x) => x.freezing).map((x) => `${x.weekday} ${x.date} (low ${x.low_f}°F)`),
      covers_through: days.length ? days[days.length - 1].date : null,
      note: `Forecast covers the next ${days.length} days only. For dates after ${days.length ? days[days.length - 1].date : 'that'}, say it's too far out and give typical conditions instead (web_search).`,
    };
  } catch (err) {
    return { error: 'WEATHER_UNAVAILABLE', message: `Couldn't get the forecast right now (${err.message}).` };
  }
}

module.exports = { forecast, geocode, _setFetch, FREEZING_F };
