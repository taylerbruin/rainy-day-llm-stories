// Rainy Day LLM Stories — SQLite access layer.
//
// Opens rainy-day.sqlite at the project root, applies the PRAGMAs and
// the schema files (server/schema/NNN_*.sql) in filename order. All
// schema statements are IF NOT EXISTS, so this is idempotent: running
// it on an existing database is a no-op.
//
// The schema files are applied HERE (in the app) rather than only in
// 000_init.sql, because PRAGMA foreign_keys is PER-CONNECTION and the
// schema files are executed on whichever connection we open. So the
// server sets PRAGMAs on every open, not by trusting a file ran first.
//
// Usage:
//   import { openDb } from './db.js';
//   const db = openDb();      // pragma + schema applied
//   db.prepare('...').run();  // ...

import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.resolve(__dirname, '..', 'rainy-day.sqlite');
export const SCHEMA_DIR = path.resolve(__dirname, 'schema');

export function openDb({ applySchema = true } = {}) {
  const db = new Database(DB_PATH);

  // journal_mode = WAL is PERSISTENT (survives in the .sqlite file),
  // but we set it here too so the first open establishes it.
  // foreign_keys is PER-CONNECTION (default OFF!) — MUST be set on
  // every open, in the same connection that runs the DDL.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (applySchema) {
    applySchemaFiles(db);
  }
  return db;
}

function applySchemaFiles(db) {
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // NNN_ prefix → lexicographic sort = numeric order

  const applyAll = db.transaction(() => {
    for (const file of files) {
      const sql = readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
      db.exec(sql);
    }
  });
  applyAll();
}
