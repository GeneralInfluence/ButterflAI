/**
 * weather.test.js — forecast tool (2026-10-09: Grover Hot Springs, "will it freeze?").
 * Open-Meteo is stubbed; no network.
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const weather = require('../../weather');

function stub(responses) {
  const calls = [];
  weather._setFetch(async (url) => {
    calls.push(url);
    const body = responses.find(([match]) => url.includes(match))?.[1];
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  });
  return calls;
}
const DAILY = {
  daily: {
    time: ['2026-10-09', '2026-10-10', '2026-10-11'],
    temperature_2m_max: [77.2, 65, 50.4], temperature_2m_min: [51, 31.6, 32.4],
    precipitation_probability_max: [2, 10, 60], weathercode: [1, 0, 71],
  },
};

describe('weather.forecast', () => {
  test('labels weekdays in code and flags freezing nights', async () => {
    stub([['geocoding-api', { results: [{ name: 'Grover Hot Springs State Park', admin1: 'California', country_code: 'US', latitude: 38.7, longitude: -119.84, timezone: 'America/Los_Angeles' }] }], ['api.open-meteo.com/v1/forecast', DAILY]]);
    const r = await weather.forecast({ place: 'Grover Hot Springs State Park, CA' });
    assert.equal(r.location, 'Grover Hot Springs State Park, California, US');
    assert.deepEqual(r.days.map((d) => d.weekday), ['Friday', 'Saturday', 'Sunday'], 'Oct 10 2026 is a Saturday');
    assert.deepEqual(r.days.map((d) => d.freezing), [false, true, true]);
    assert.deepEqual(r.freezing_nights, ['Saturday 2026-10-10 (low 32°F)', 'Sunday 2026-10-11 (low 32°F)']);
    assert.equal(r.days[2].conditions, 'light snow');
    assert.equal(r.covers_through, '2026-10-11');
  });

  test('falls back to a simpler name, then reports not found clearly', async () => {
    const calls = stub([['name=Grover%20Hot%20Springs&', { results: [{ name: 'Grover Hot Springs', latitude: 1, longitude: 2 }] }], ['forecast', DAILY]]);
    const r = await weather.forecast({ place: 'Grover Hot Springs State Park' });
    assert.ok(!r.error);
    assert.ok(calls.some((u) => u.includes('name=Grover%20Hot%20Springs&')));
    stub([]);
    const nf = await weather.forecast({ place: 'Nowhere Special' });
    assert.equal(nf.error, 'PLACE_NOT_FOUND');
  });

  test('coordinates skip geocoding; network failure is reported, not thrown', async () => {
    const calls = stub([['forecast', DAILY]]);
    const r = await weather.forecast({ latitude: 38.7, longitude: -119.84 });
    assert.ok(!calls.some((u) => u.includes('geocoding')));
    assert.equal(r.days.length, 3);
    weather._setFetch(async () => { throw new Error('ECONNRESET'); });
    assert.equal((await weather.forecast({ latitude: 1, longitude: 2 })).error, 'WEATHER_UNAVAILABLE');
  });
});
