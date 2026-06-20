'use strict';

/**
 * Rough area-code → city/region lookup.
 * Used to seed location during onboarding — always confirmed with the user.
 * Only covers the most common US codes; returns null for unknowns.
 */

const AREA_CODE_MAP = {
  // New York
  '212': 'New York City', '332': 'New York City', '646': 'New York City', '917': 'New York City',
  '718': 'New York City', '929': 'New York City', '347': 'New York City',
  // New Jersey
  '201': 'New Jersey', '551': 'New Jersey', '609': 'New Jersey', '732': 'New Jersey',
  '848': 'New Jersey', '856': 'New Jersey', '862': 'New Jersey', '908': 'New Jersey', '973': 'New Jersey',
  // Los Angeles
  '213': 'Los Angeles', '310': 'Los Angeles', '323': 'Los Angeles', '424': 'Los Angeles',
  '442': 'Los Angeles', '562': 'Los Angeles', '626': 'Los Angeles', '747': 'Los Angeles', '818': 'Los Angeles',
  // San Francisco Bay Area
  '415': 'San Francisco', '510': 'Bay Area', '628': 'San Francisco', '650': 'Bay Area',
  '408': 'San Jose', '669': 'San Jose',
  // Washington DC
  '202': 'Washington DC', '301': 'DC Metro', '240': 'DC Metro', '703': 'DC Metro', '571': 'DC Metro',
  // Chicago
  '312': 'Chicago', '773': 'Chicago', '872': 'Chicago', '630': 'Chicago', '847': 'Chicago',
  // Miami
  '305': 'Miami', '786': 'Miami', '954': 'Fort Lauderdale',
  // Boston
  '617': 'Boston', '857': 'Boston', '781': 'Boston', '339': 'Boston',
  // Seattle
  '206': 'Seattle', '425': 'Seattle', '253': 'Seattle',
  // Denver
  '303': 'Denver', '720': 'Denver',
  // Atlanta
  '404': 'Atlanta', '678': 'Atlanta', '770': 'Atlanta',
  // Dallas
  '214': 'Dallas', '469': 'Dallas', '972': 'Dallas',
  // Houston
  '713': 'Houston', '832': 'Houston', '281': 'Houston',
  // Phoenix
  '602': 'Phoenix', '480': 'Phoenix', '623': 'Phoenix',
  // Portland
  '503': 'Portland', '971': 'Portland',
  // Austin
  '512': 'Austin', '737': 'Austin',
  // Las Vegas
  '702': 'Las Vegas', '725': 'Las Vegas',
  // San Diego
  '619': 'San Diego', '858': 'San Diego',
  // Minneapolis
  '612': 'Minneapolis', '651': 'Minneapolis',
  // Detroit
  '313': 'Detroit', '248': 'Detroit', '586': 'Detroit',
};

/**
 * Given an E.164 phone number, return a city guess or null.
 * e.g. '+16099233179' → 'New Jersey'
 */
function cityFromPhone(phone) {
  if (!phone || !phone.startsWith('+1')) return null;
  const digits = phone.replace(/\D/g, '');  // e.g. '16099233179'
  if (digits.length < 4) return null;
  const areaCode = digits.slice(1, 4);       // skip country code '1'
  return AREA_CODE_MAP[areaCode] || null;
}

module.exports = { cityFromPhone };
