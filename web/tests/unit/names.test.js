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
  // 70 since the nickname list (Allie is a known nickname for Allison); was 60 (first 4 letters).
  assert.equal(matchScore({ name: 'Allison McLaine' }, 'Allie'), 70);
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

// 2026-10-09: nicknames, and names the user has used before.
test('common nicknames are a likely (not certain) match', () => {
  assert.equal(matchScore({ name: 'Elizabeth Taylor' }, 'Liz'), 70);
  assert.equal(matchScore({ name: 'Robert Smith' }, 'Bobby Smith'), 70);
  assert.equal(matchScore({ name: 'Robert Smith' }, 'Bobby Jones'), 0);
  assert.ok(matchScore({ name: 'Elizabeth Taylor' }, 'Liz') < 80, 'the agent confirms the first time');
});

test('a learned alias is an exact match and beats a namesake', () => {
  const picked = { name: 'Allie', also_known_as: 'Al, allie' };
  const namesake = { name: 'Allie' };
  assert.equal(matchScore(picked, 'Allie'), 101);
  assert.equal(matchScore(namesake, 'Allie'), 100);
  assert.equal(matchScore({ name: 'Elizabeth Taylor', also_known_as: 'Liz' }, 'liz'), 101);
});

test('learnedAlias: only real names, only if not already exact', () => {
  const { learnedAlias } = require('../../names');
  assert.equal(learnedAlias({ name: 'Elizabeth Taylor' }, 'Liz'), 'Liz');
  assert.equal(learnedAlias({ name: 'Elizabeth Taylor' }, 'Elizabeth Taylor'), null);
  assert.equal(learnedAlias({ name: 'Elizabeth Taylor' }, '555-1234'), null);
  assert.equal(learnedAlias({ name: 'Elizabeth Taylor' }, 'the one from work who always brings cake'), null);
});
