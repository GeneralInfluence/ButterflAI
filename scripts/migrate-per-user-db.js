#!/usr/bin/env node
'use strict';

/**
 * migrate-per-user-db.js
 *
 * One-time migration: splits butterflai.sqlite (single DB) into:
 *   /data/main.sqlite          — shared tables
 *   /data/users/{user_id}.sqlite — per-user sensitive data
 *
 * Run ONCE on the Fly machine before deploying the split-DB build.
 * The app MUST be stopped (or scaled to 0) during migration.
 *
 * Usage:
 *   fly ssh console -a butterflai
 *   node /app/scripts/migrate-per-user-db.js
 *
 * Safe to re-run: checks for already-migrated state and exits cleanly.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR   = process.env.DATA_DIR || '/data';
const OLD_PATH   = path.join(DATA_DIR, 'butterflai.sqlite');
const MAIN_PATH  = path.join(DATA_DIR, 'main.sqlite');
const USERS_DIR  = path.join(DATA_DIR, 'users');

function _readSchema(name) {
  for (const p of [
    path.join(__dirname, '..', 'db', name),   // local dev / Docker /app/scripts/../db/
    path.join(__dirname, 'db', name),          // fallback
  ]) { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); }
  throw new Error('Schema not found: ' + name);
}
const MAIN_SCHEMA = _readSchema('main-schema.sql');
const USER_SCHEMA = _readSchema('user-schema.sql');

// Tables that go into main.sqlite
const MAIN_TABLES = [
  'users', 'contacts', 'contact_preferences', 'invites',
  'sms_optouts', 'consent_records', 'inbound_messages',
  'coordination_sessions', 'coord_session_peers', 'ambient_signals',
  '_migrations',
];

// Per-user tables and the column that identifies the owner
const USER_TABLES = [
  { table: 'private_data',        ownerCol: 'user_id' },
  { table: 'access_audit',        ownerCol: 'user_id' },
  { table: 'conversation_history',ownerCol: 'user_id' },
  { table: 'desires',             ownerCol: 'user_id' },
  { table: 'desire_deletions',    ownerCol: 'user_id' },
  { table: 'relationships',       ownerCol: 'user_id' },
  { table: 'cadences',            ownerCol: null       }, // via relationship_id join
  { table: 'activities',          ownerCol: null       }, // via cadence_id join
  { table: 'onboarding_intents',  ownerCol: 'user_id' },
  { table: 'pending_actions',     ownerCol: 'user_id' },
  { table: 'budgets',             ownerCol: 'user_id' },
  { table: 'user_preferences',    ownerCol: 'user_id' },
  { table: 'user_wallets',        ownerCol: 'user_id' },
  { table: 'agent_messages',      ownerCol: 'to_user'  }, // recipients' DB
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function tableExists(db, name) {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name);
}

function openUserDb(userId) {
  const p   = path.join(USERS_DIR, `${userId}.sqlite`);
  const udb = new Database(p);
  udb.pragma('journal_mode = WAL');
  udb.pragma('foreign_keys = OFF');  // no FKs in per-user schema (user_id is the filename)
  udb.exec(USER_SCHEMA);
  return udb;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function run() {
  if (!fs.existsSync(OLD_PATH)) {
    console.log('butterflai.sqlite not found — nothing to migrate (fresh install?)');
    process.exit(0);
  }

  if (fs.existsSync(MAIN_PATH)) {
    console.log('main.sqlite already exists — migration already done, exiting.');
    process.exit(0);
  }

  console.log(`Migrating ${OLD_PATH} → split DB architecture…`);
  fs.mkdirSync(USERS_DIR, { recursive: true });

  const old  = new Database(OLD_PATH, { readonly: true });
  const main = new Database(MAIN_PATH);
  main.pragma('journal_mode = WAL');
  main.pragma('foreign_keys = OFF');
  main.exec(MAIN_SCHEMA);

  // ── 1. Copy main tables ───────────────────────────────────────────────────
  let totalMain = 0;
  for (const tbl of MAIN_TABLES) {
    if (!tableExists(old, tbl)) { console.log(`  skip ${tbl} (not in source)`); continue; }
    const rows = old.prepare(`SELECT * FROM ${tbl}`).all();
    if (!rows.length) { console.log(`  ${tbl}: 0 rows`); continue; }
    // Intersect columns — old schema may have extra cols (e.g. timezone) not in new schema
    const targetCols = new Set(main.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name));
    const useCols = Object.keys(rows[0]).filter(c => targetCols.has(c));
    if (!useCols.length) { console.log(`  skip ${tbl} (no matching columns)`); continue; }
    const stmt = main.prepare(
      `INSERT OR IGNORE INTO ${tbl} (${useCols.join(',')}) VALUES (${useCols.map(() => '?').join(',')})`
    );
    const ins = main.transaction((rs) => rs.forEach(r => stmt.run(useCols.map(c => r[c]))));
    ins(rows);
    console.log(`  ${tbl}: ${rows.length} rows → main`);
    totalMain += rows.length;
  }

  // ── 2. Copy per-user tables ───────────────────────────────────────────────
  const users = old.prepare('SELECT id FROM users').all();
  console.log(`\nMigrating ${users.length} user(s)…`);

  const userDbCache = {};
  const getUdb = (userId) => {
    if (!userDbCache[userId]) userDbCache[userId] = openUserDb(userId);
    return userDbCache[userId];
  };

  for (const { id: userId } of users) {
    console.log(`\n  user: ${userId}`);

    for (const { table, ownerCol } of USER_TABLES) {
      if (!tableExists(old, table)) continue;

      let rows;
      if (ownerCol) {
        rows = old.prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = ?`).all(userId);
      } else if (table === 'cadences') {
        // cadences → via relationships
        rows = tableExists(old, 'relationships')
          ? old.prepare(`
              SELECT c.* FROM cadences c
              JOIN relationships r ON r.id = c.relationship_id
              WHERE r.user_id = ?`).all(userId)
          : [];
      } else if (table === 'activities') {
        // activities → via cadences → relationships
        rows = (tableExists(old, 'cadences') && tableExists(old, 'relationships'))
          ? old.prepare(`
              SELECT a.* FROM activities a
              JOIN cadences c ON c.id = a.cadence_id
              JOIN relationships r ON r.id = c.relationship_id
              WHERE r.user_id = ?`).all(userId)
          : [];
      } else {
        rows = [];
      }

      if (!rows.length) continue;

      const udb  = getUdb(userId);
      // Drop user_id column (it's implicit in the per-user DB)
      const cols = Object.keys(rows[0]).filter(c => c !== 'user_id' && c !== ownerCol || table === 'agent_messages');

      // For tables where we keep ownerCol (e.g. agent_messages.to_user), keep all cols
      const allCols = Object.keys(rows[0]);

      // Determine which columns the target table actually has
      let targetCols;
      try {
        const pragma = udb.prepare(`PRAGMA table_info(${table})`).all();
        targetCols = new Set(pragma.map(c => c.name));
      } catch { targetCols = new Set(allCols); }

      const useCols = allCols.filter(c => targetCols.has(c));
      if (!useCols.length) { console.log(`    ${table}: no matching columns, skip`); continue; }

      const stmt = udb.prepare(
        `INSERT OR IGNORE INTO ${table} (${useCols.join(',')}) VALUES (${useCols.map(() => '?').join(',')})`
      );
      const ins = udb.transaction((rs) => rs.forEach(r => stmt.run(useCols.map(c => r[c]))));
      ins(rows);
      console.log(`    ${table}: ${rows.length} rows`);
    }
  }

  // Close all user DBs
  Object.values(userDbCache).forEach(udb => udb.close());
  old.close();
  main.close();

  // ── 3. Verify ─────────────────────────────────────────────────────────────
  console.log('\n── Verification ──');
  const mainCheck = new Database(MAIN_PATH, { readonly: true });
  const userCount = mainCheck.prepare('SELECT COUNT(*) as n FROM users').get().n;
  const contactCount = mainCheck.prepare('SELECT COUNT(*) as n FROM contacts').get().n;
  console.log(`  main.sqlite: ${userCount} users, ${contactCount} contacts`);
  mainCheck.close();

  let totalUserRows = 0;
  const userFiles = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.sqlite'));
  for (const f of userFiles) {
    const udb = new Database(path.join(USERS_DIR, f), { readonly: true });
    const conv = tableExists(udb, 'conversation_history')
      ? udb.prepare('SELECT COUNT(*) as n FROM conversation_history').get().n : 0;
    const desires = tableExists(udb, 'desires')
      ? udb.prepare('SELECT COUNT(*) as n FROM desires').get().n : 0;
    console.log(`  ${f}: conv=${conv} desires=${desires}`);
    totalUserRows += conv + desires;
    udb.close();
  }

  console.log(`\n✓ Migration complete. ${userFiles.length} user DB(s) created.`);
  console.log(`  Rename butterflai.sqlite to butterflai.sqlite.bak when satisfied.`);
  console.log(`  DO NOT delete it yet — keep as a backup for 7 days.`);
}

// Run immediately when invoked directly; export for require() from db.js
if (require.main === module) {
  try { run(); } catch (err) {
    console.error('\n✗ Migration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
} else {
  // Called via require() from db.js on startup
  run();
  module.exports = { run };
}
