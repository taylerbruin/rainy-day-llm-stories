// One-shot schema apply. Run with: node server/apply_schema.js
// Opens the DB (creating rainy-day.sqlite if absent), applies the
// schema files in order, and prints a summary so the result is
// verifiable in the SQLite extension.

import { openDb, DB_PATH } from './db.js';

const db = openDb();

const tables = db
  .prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name
  `)
  .all();

const triggers = db
  .prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'
     ORDER BY name
  `)
  .all();

const indexes = db
  .prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
     ORDER BY name
  `)
  .all();

const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();

console.log(`[schema] DB file: ${DB_PATH}`);
console.log(`[schema] schema_version: ${version?.value}`);
console.log(`[schema] journal_mode: ${db.pragma('journal_mode', { simple: true })}`);
console.log(`[schema] foreign_keys: ${db.pragma('foreign_keys', { simple: true })}`);
console.log(`[schema] tables (${tables.length}):`);
for (const t of tables) console.log(`  - ${t.name}`);
console.log(`[schema] triggers (${triggers.length}):`);
for (const t of triggers) console.log(`  - ${t.name}`);
console.log(`[schema] indexes (${indexes.length}):`);
for (const t of indexes) console.log(`  - ${t.name}`);

db.close();
