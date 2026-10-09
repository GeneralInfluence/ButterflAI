/**
 * names.test.js — matching a name to a contact (names.js).
 * Regression (2026-10-09): "Alex Spargo" didn't find "Alexandria Spargo".
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchScore, matchesSearch } = require('../../names');

const alexandria = { name: 'Alexandria Spargo', phone: '+15305550142' };
const priest = { name: 'Alexander Priest', phone: '+12705551307' };

test('every word starting a name word is a strong match, any order', () => {
  assert.equal(matchScore(alexandria, 'Alex Spargo'), 85);
  assert.equal(matchScore(alexandria, 'spargo alex'), 85);
  assert.equal(matchScore(alexandria, 'al spar'), 85);
  assert.ok(matchScore(alexandria, 'Spargo') >= 80);
});

test('"Alex Spargo" is a weak match for Alexander Priest — the agent must not pick him', () => {
  assert.ok(matchScore(priest, 'Alex Spargo') < 80);
  assert.ok(matchScore(alexandria, 'Alex Spargo') > matchScore(priest, 'Alex Spargo'));
});

test('existing behaviour kept: exact, nickname, Allie→Allison, phone, punctuation and accents', () => {
  assert.equal(matchScore({ name: 'Allie' }, 'allie'), 100);
  assert.equal(matchScore({ name: 'Sean Gonzalez', nickname: 'Aphilos' }, 'aphilos'), 100);
  assert.equal(matchScore({ name: 'Allison McLaine' }, 'Allie'), 60);
  assert.equal(matchScore(alexandria, '0142'), 90);
  assert.equal(matchScore({ name: "Mama's Crew" }, 'mamas'), 85);
  assert.equal(matchScore({ name: 'José Núñez' }, 'jose nunez'), 100);
  assert.equal(matchScore(alexandria, 'xyz'), 0);
});

test('People search: word by word', () => {
  assert.equal(matchesSearch(alexandria, 'alex spargo'), true);
  assert.equal(matchesSearch(priest, 'alex spargo'), true, 'still listed, ranked lower');
  assert.equal(matchesSearch({ name: 'Bob Jones' }, 'alex spargo'), false);
});
