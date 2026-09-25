// /api/world-state — the LIVE canon controller.
//
// Spring analog: a @Controller at "/api/world-state" managing a 1:1
// @OneToOne entity (WorldState) — world_state.id IS world.id (the PK is
// the FK), so there's no "create" path: the row is seeded by
// POST /api/worlds (see worlds.js) and deleted by cascade.
//
// Distinctive thing: this table is REWRITTEN atomically at chapter
// close (see /api/compact, coming later). So the API shape is:
//   GET /:worldId → read the live canon
//   PUT /:worldId → replace the whole state (established_facts,
//                   open_threads, current_location_id) in one shot
// PUT (full replace) mirrors how JPA's @OneToOne merge works: you send
// the complete entity, not a sparse patch — no ambiguity about which
// fields are "unchanged" vs "cleared".
//
// JSON columns (established_facts, open_threads) are NOT auto-parsed by
// better-sqlite3, so we parse/serialize explicitly — same pattern as
// worlds.js's parseWorld.

import { Router } from 'express';
import { db, httpError } from '../index.js';

const router = Router();

// --- read/parse helpers (request-time only — TDZ rule) ---

function parseWorldState(row) {
  if (!row) return null;
  return {
    ...row,
    established_facts: row.established_facts ? JSON.parse(row.established_facts) : [],
    open_threads: row.open_threads ? JSON.parse(row.open_threads) : [],
  };
}

function worldExists(id) {
  return db.prepare('SELECT id FROM world WHERE id = ?').get(id) !== undefined;
}

// established_facts: string[] (committed truth). undefined → leave as-is
// (null). Anything else must be an array of non-empty strings.
function normalizeFacts(facts) {
  if (facts === undefined) return null; // caller keeps existing
  if (!Array.isArray(facts)) throw httpError(400, 'establishedFacts must be an array of strings');
  return facts.map((f, i) => {
    if (typeof f !== 'string' || !f.trim()) throw httpError(400, `establishedFacts[${i}] must be a non-empty string`);
    return f;
  });
}

// open_threads: [{ thread, detail? }]. undefined → leave as-is (null).
function normalizeThreads(threads) {
  if (threads === undefined) return null; // caller keeps existing
  if (!Array.isArray(threads)) throw httpError(400, 'openThreads must be an array of { thread, detail? }');
  return threads.map((t, i) => {
    if (!t || typeof t.thread !== 'string' || !t.thread.trim()) {
      throw httpError(400, `openThreads[${i}].thread (non-empty string) is required`);
    }
    const detail = t.detail === undefined ? null : t.detail;
    if (detail !== null && typeof detail !== 'string') {
      throw httpError(400, `openThreads[${i}].detail must be a string or null`);
    }
    return { thread: t.thread, detail };
  });
}

// current_location_id: number (must exist) or null. undefined → leave as-is.
function normalizeLocation(locationId) {
  if (locationId === undefined) return undefined; // caller keeps existing
  if (locationId === null) return null;
  if (typeof locationId !== 'number') throw httpError(400, 'currentLocationId must be a number or null');
  if (!db.prepare('SELECT id FROM place WHERE id = ?').get(locationId)) {
    throw httpError(404, `place ${locationId} not found`);
  }
  return locationId;
}

// GET /api/world-state/:worldId — read the live canon.
router.get('/:worldId', (req, res) => {
  const { worldId } = req.params;
  if (!worldExists(worldId)) throw httpError(404, `world ${worldId} not found`);
  // Row may legitimately not exist yet (world created, never closed) —
  // return the empty canonical shape instead of 404.
  const row = db.prepare('SELECT * FROM world_state WHERE id = ?').get(worldId);
  if (row) return res.json(parseWorldState(row));
  res.json({
    id: Number(worldId),
    current_location_id: null,
    established_facts: [],
    open_threads: [],
  });
});

// PUT /api/world-state/:worldId — atomically rewrite the live canon
// (the "chapter close" commit). Body (all optional; omitted = unchanged):
//   { establishedFacts?: string[], openThreads?: {thread, detail?}[], currentLocationId?: number|null }
router.put('/:worldId', (req, res) => {
  const { worldId } = req.params;
  if (!worldExists(worldId)) throw httpError(404, `world ${worldId} not found`);

  const facts = normalizeFacts(req.body?.establishedFacts);
  const threads = normalizeThreads(req.body?.openThreads);
  const location = normalizeLocation(req.body?.currentLocationId);

  const existing = db.prepare('SELECT * FROM world_state WHERE id = ?').get(worldId);

  if (existing) {
    // Full-replace semantics for provided fields; omitted fields keep
    // their current values.
    db.prepare(
      'UPDATE world_state SET established_facts = ?, open_threads = ?, current_location_id = ? WHERE id = ?',
    ).run(
      facts !== null ? JSON.stringify(facts) : existing.established_facts,
      threads !== null ? JSON.stringify(threads) : existing.open_threads,
      location !== undefined ? location : existing.current_location_id,
      worldId,
    );
  } else {
    // First write: seed the row (same as worlds.js does on create).
    db.prepare(
      'INSERT INTO world_state (id, established_facts, open_threads, current_location_id) VALUES (?, ?, ?, ?)',
    ).run(
      Number(worldId),
      facts !== null ? JSON.stringify(facts) : null,
      threads !== null ? JSON.stringify(threads) : null,
      location !== undefined ? location : null,
    );
  }

  // Fresh read-back so the client sees the committed state verbatim.
  res.json(parseWorldState(db.prepare('SELECT * FROM world_state WHERE id = ?').get(worldId)));
});

export default router;
