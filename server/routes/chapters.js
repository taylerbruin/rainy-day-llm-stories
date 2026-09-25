// /api/chapters — the "chapter" controller (IMMUTABLE history).
//
// Spring analog: a @Controller with class-level
//   @RequestMapping("/api/chapters")
// and these method mappings:
//   @PostMapping("")            → create a chapter (chapter-close / compact output)
//   @GetMapping("?worldId=")    → a world's chapters, in seq order
//   @GetMapping("/{id}")        → one chapter WITH its events/characters/places
//   @PatchMapping("/{id}")      → close a chapter (set summary/wordCount/closedAt)
//   @DeleteMapping("/{id}")     → delete (cascades to children)
//
// ── Two things here that are NOT in the simpler controllers ──────
//
// 1. seq is SERVER-assigned, not client-supplied.
//    The invariant is "1-based, no gaps, no dupes within a world"
//    (enforced by UNIQUE(world_id, seq)). The server computes it as
//    MAX(seq)+1 for that world, so a client can't hand us a gap or a
//    duplicate. (Spring analog: the entity's @GeneratedValue / the
//    service computing the aggregate's position, not trusting the DTO.)
//
// 2. The create is a TRANSACTION.
//    A chapter + its N events + its M characters + its K places must
//    either all land or none — otherwise a half-written chapter (with a
//    summary but no events) is exactly the kind of partial state that
//    later confuses the LLM's canon. better-sqlite3's db.transaction(fn)
//    is the Spring @Transactional: it runs fn in a BEGIN/COMMIT and
//    ROLLBACKs if anything throws. We throw httpError() for bad input,
//    so validation failures roll back cleanly too.
//
// The three children are CASCADE-deleted from chapter (schema 007/008/
// 009), so DELETE on a chapter cleans them automatically.

import { Router } from 'express';
import { db, httpError } from '../index.js';

const router = Router();

// ── Small helpers ────────────────────────────────────────────────

function worldExists(worldId) {
  return db.prepare('SELECT id FROM world WHERE id = ?').get(worldId) !== undefined;
}

function chapterExists(id) {
  return db.prepare('SELECT id FROM chapter WHERE id = ?').get(id) !== undefined;
}

// Validate + normalize the nested children arrays up front (BEFORE we
// open a transaction), so a bad payload rolls back nothing and the error
// is clean. Each returns the sanitized array we're about to insert.
function normalizeEvents(events) {
  if (events === undefined) return [];
  if (!Array.isArray(events)) throw httpError(400, 'events must be an array of { kind?, what, detail? }');
  return events.map((e, i) => {
    if (!e || typeof e.what !== 'string' || !e.what.trim()) {
      throw httpError(400, `events[${i}].what (non-empty string) is required`);
    }
    // Default to 'minor' (matches the CHECK default), but reject unknown kinds
    // cleanly — otherwise SQLite would 500 on the CHECK constraint mid-transaction.
    const kind = e.kind === undefined ? 'minor' : e.kind;
    if (kind !== 'major' && kind !== 'minor') {
      throw httpError(400, `events[${i}].kind must be 'major' or 'minor' (got ${JSON.stringify(e.kind)})`);
    }
    return { kind, what: e.what, detail: typeof e.detail === 'string' ? e.detail : null };
  });
}

function normalizeCharacters(characters) {
  if (characters === undefined) return [];
  if (!Array.isArray(characters)) throw httpError(400, 'characters must be an array of { characterId, involvement? }');
  return characters.map((c, i) => {
    if (typeof c?.characterId !== 'number') throw httpError(400, `characters[${i}].characterId (number) is required`);
    if (!db.prepare('SELECT id FROM character WHERE id = ?').get(c.characterId)) {
      throw httpError(404, `character ${c.characterId} not found`);
    }
    return { characterId: c.characterId, involvement: typeof c.involvement === 'string' ? c.involvement : null };
  });
}

function normalizePlaces(places) {
  if (places === undefined) return [];
  if (!Array.isArray(places)) throw httpError(400, 'places must be an array of { placeId }');
  return places.map((p, i) => {
    if (typeof p?.placeId !== 'number') throw httpError(400, `places[${i}].placeId (number) is required`);
    if (!db.prepare('SELECT id FROM place WHERE id = ?').get(p.placeId)) {
      throw httpError(404, `place ${p.placeId} not found`);
    }
    return { placeId: p.placeId };
  });
}

// ── INSERT one chapter + children ─────────────────────────────────
// A plain function (NOT db.transaction at module scope — `db` is still in
// the temporal dead zone here, since index.js declares it after importing
// this module; touching it at eval time is exactly what broke the boot).
// The caller wraps it in db.transaction(...) at REQUEST time, when db is
// live. Spring analog: the @Transactional proxy wrapping the method call,
// not the method self-declaring a transaction at class-load.
// Returns the new chapter id.
function insertChapter(worldId, { title, summary, wordCount, events, characters, places }) {
  // Server-assigned seq: 1-based, no gaps within the world.
  const nextSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM chapter WHERE world_id = ?').get(worldId)).n;

  const info = db
    .prepare('INSERT INTO chapter (world_id, seq, title, summary, word_count) VALUES (?, ?, ?, ?, ?)')
    .run(worldId, nextSeq, title, summary, wordCount);
  const chapterId = info.lastInsertRowid;

  const insEvent = db.prepare('INSERT INTO chapter_event (chapter_id, kind, what, detail, seq) VALUES (?, ?, ?, ?, ?)');
  events.forEach((e, i) => insEvent.run(chapterId, e.kind, e.what, e.detail, i + 1)); // seq within chapter, 1-based

  const insChar = db.prepare('INSERT INTO chapter_character (chapter_id, character_id, involvement) VALUES (?, ?, ?)');
  characters.forEach((c) => insChar.run(chapterId, c.characterId, c.involvement));

  const insPlace = db.prepare('INSERT INTO chapter_place (chapter_id, place_id) VALUES (?, ?)');
  places.forEach((p) => insPlace.run(chapterId, p.placeId));

  return chapterId;
}

// ── GET shape: chapter + its children (three reads, clean shape) ──
// Separate queries per child rather than one big multi-JOIN: the result
// shape stays flat and readable (events[], characters[], places[]), and
// each child is small. The joins that DO matter (character name, place
// name) happen inside their child query.
function getChapterFull(id) {
  const chapter = db.prepare('SELECT * FROM chapter WHERE id = ?').get(id);
  if (!chapter) return null;
  const events = db.prepare('SELECT * FROM chapter_event WHERE chapter_id = ? ORDER BY seq').all(id);
  const characters = db
    .prepare('SELECT cc.character_id AS id, c.name, cc.involvement FROM chapter_character cc JOIN character c ON c.id = cc.character_id WHERE cc.chapter_id = ? ORDER BY c.name')
    .all(id);
  const places = db
    .prepare('SELECT cp.place_id AS id, p.name FROM chapter_place cp JOIN place p ON p.id = cp.place_id WHERE cp.chapter_id = ? ORDER BY p.name')
    .all(id);
  return { ...chapter, events, characters, places };
}

// ── Routes ────────────────────────────────────────────────────────

// POST /api/chapters — create a chapter (the chapter-close / compact result).
// Body: { worldId, title?, summary?, wordCount?, events?, characters?, places? }
// seq is computed server-side (MAX+1) and NOT read from the body.
router.post('/', (req, res) => {
  const { worldId, title = null, summary = null, wordCount = null, events, characters, places } = req.body ?? {};

  if (typeof worldId !== 'number') throw httpError(400, 'worldId (number) is required');
  if (!worldExists(worldId)) throw httpError(404, `world ${worldId} not found`);
  if (title !== null && typeof title !== 'string') throw httpError(400, 'title must be a string or null');
  if (summary !== null && typeof summary !== 'string') throw httpError(400, 'summary must be a string or null');

  // Validate/normalize children BEFORE the transaction opens.
  const ev = normalizeEvents(events);
  const ch = normalizeCharacters(characters);
  const pl = normalizePlaces(places);

  // db.transaction(fn) returns a wrapped fn that BEGIN/COMMITs around fn
  // and ROLLBACKs if it throws — our httpError throws trigger the rollback.
  const tx = db.transaction(insertChapter);
  const id = tx(worldId, { title, summary, wordCount, events: ev, characters: ch, places: pl });
  res.status(201).json(getChapterFull(id));
});

// GET /api/chapters?worldId=N — a world's chapters in seq order.
router.get('/', (req, res) => {
  const { worldId } = req.query;
  if (worldId === undefined || worldId === '') throw httpError(400, 'worldId (query param) is required');
  if (!worldExists(worldId)) throw httpError(404, `world ${worldId} not found`);
  const rows = db.prepare('SELECT * FROM chapter WHERE world_id = ? ORDER BY seq').all(worldId);
  res.json(rows);
});

// GET /api/chapters/:id — one chapter with events/characters/places.
router.get('/:id', (req, res) => {
  const row = getChapterFull(req.params.id);
  if (!row) throw httpError(404, `chapter ${req.params.id} not found`);
  res.json(row);
});

// PATCH /api/chapters/:id — the "close the chapter" moment.
// Body (all optional): { title?, summary?, wordCount? }
// Sets closed_at = now() when any of them is provided (a closed chapter
// is an immutable record; this is the one write we expect after create).
router.patch('/:id', (req, res) => {
  if (!chapterExists(req.params.id)) throw httpError(404, `chapter ${req.params.id} not found`);
  const { title, summary, wordCount } = req.body ?? {};

  const sets = [];
  const args = [];
  if (title !== undefined) {
    if (title !== null && typeof title !== 'string') throw httpError(400, 'title must be a string or null');
    sets.push('title = ?'); args.push(title);
  }
  if (summary !== undefined) {
    if (summary !== null && typeof summary !== 'string') throw httpError(400, 'summary must be a string or null');
    sets.push('summary = ?'); args.push(summary);
  }
  if (wordCount !== undefined) {
    if (typeof wordCount !== 'number') throw httpError(400, 'wordCount must be a number');
    sets.push('word_count = ?'); args.push(wordCount);
  }
  if (sets.length === 0) throw httpError(400, 'provide at least one of: title, summary, wordCount');

  sets.push("closed_at = datetime('now')"); // closing = stamp it
  db.prepare(`UPDATE chapter SET ${sets.join(', ')} WHERE id = ?`).run(...args, req.params.id);
  res.json(getChapterFull(req.params.id));
});

// DELETE /api/chapters/:id — remove; CASCADE clears events/characters/places.
router.delete('/:id', (req, res) => {
  if (!chapterExists(req.params.id)) throw httpError(404, `chapter ${req.params.id} not found`);
  db.prepare('DELETE FROM chapter WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
