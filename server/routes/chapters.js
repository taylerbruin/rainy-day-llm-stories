// /api/chapters — the "chapter" controller (IMMUTABLE history).
//
// Spring analog: a @Controller with class-level
//   @RequestMapping("/api/chapters")
// and these method mappings:
//   @PostMapping("")            → create a chapter (chapter-close / compact output)
//   @GetMapping("?worldId=")    → a world's chapters, in seq order
//   @GetMapping("/{id}")        → one chapter WITH its events/characters/places
//   @PostMapping("/{id}/close") → APPLY the player-approved compaction (compact.js proposes)
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

// ── POST /:id/close — APPLY the player-approved compaction ───────
// The write-half of the compact flow (compact.js is the propose-half).
// compact.js returns a lenient DRAFT for the review modal (unknown
// refs dropped + warned); here the record is the PLAYER'S APPROVED
// data, so validation is STRICT — a ghost id or bad type is 400/404
// and the transaction rolls back, leaving the chapter open.
// (Spring: the same DTO validated at two gates — a lenient @JsonPatch
//  draft, then full @Valid in the service that actually writes.)
//
// Body: { title, summary,
//         events: [{kind?, what, detail?}], characters: [{characterId, involvement?}],
//         places: [placeId],
//         worldStateUpdate?: { establishedFacts?, openThreads?, currentLocationId? },
//         applyWorldUpdate?: boolean (default true),
//         characterLocations?: [{characterId, currentLocationId?|null}] }
function normalizeWorldStateUpdate(wsu) {
  if (wsu === undefined || wsu === null) return null; // no world-state commit this close
  if (typeof wsu !== 'object' || Array.isArray(wsu)) throw httpError(400, 'worldStateUpdate must be an object');

  const facts = wsu.establishedFacts === undefined ? null : (
    !Array.isArray(wsu.establishedFacts)
      ? (() => { throw httpError(400, 'worldStateUpdate.establishedFacts must be an array of strings'); })()
      : wsu.establishedFacts.map((f, i) => {
          if (typeof f !== 'string' || !f.trim()) throw httpError(400, `establishedFacts[${i}] must be a non-empty string`);
          return f.trim();
        })
  );

  const threads = wsu.openThreads === undefined ? null : (
    !Array.isArray(wsu.openThreads)
      ? (() => { throw httpError(400, 'worldStateUpdate.openThreads must be an array of {thread, detail?}'); })()
      : wsu.openThreads.map((t, i) => {
          if (!t || typeof t.thread !== 'string' || !t.thread.trim()) {
            throw httpError(400, `openThreads[${i}].thread (non-empty string) is required`);
          }
          const detail = t.detail === undefined ? null : t.detail;
          if (detail !== null && typeof detail !== 'string') throw httpError(400, `openThreads[${i}].detail must be a string or null`);
          return { thread: t.thread.trim(), detail };
        })
  );

  let location = null;
  if (wsu.currentLocationId !== undefined && wsu.currentLocationId !== null) {
    if (typeof wsu.currentLocationId !== 'number') throw httpError(400, 'worldStateUpdate.currentLocationId must be a number or null');
    location = wsu.currentLocationId;
  }
  return { facts, threads, location };
}

function normalizeCharacterLocations(locations, worldId) {
  if (locations === undefined || locations === null) return [];
  if (!Array.isArray(locations)) throw httpError(400, 'characterLocations must be an array of {characterId, currentLocationId?}');
  return locations.map((l, i) => {
    if (typeof l?.characterId !== 'number') throw httpError(400, `characterLocations[${i}].characterId (number) is required`);
    if (!db.prepare('SELECT id FROM character WHERE id = ? AND world_id = ?').get(l.characterId, worldId)) {
      throw httpError(404, `character ${l.characterId} not found in this chapter's world`);
    }
    let loc = null;
    if (l.currentLocationId !== undefined && l.currentLocationId !== null) {
      if (typeof l.currentLocationId !== 'number') throw httpError(400, `characterLocations[${i}].currentLocationId must be a number or null`);
      if (!db.prepare('SELECT id FROM place WHERE id = ? AND world_id = ?').get(l.currentLocationId, worldId)) {
        throw httpError(404, `place ${l.currentLocationId} not found in this chapter's world`);
      }
      loc = l.currentLocationId;
    }
    return { characterId: l.characterId, currentLocationId: loc };
  });
}

function readWorldState(worldId) {
  const row = db.prepare('SELECT * FROM world_state WHERE id = ?').get(worldId);
  return {
    id: Number(worldId),
    established_facts: row?.established_facts ? JSON.parse(row.established_facts) : [],
    open_threads: row?.open_threads ? JSON.parse(row.open_threads) : [],
    current_location_id: row?.current_location_id ?? null,
  };
}

router.post('/:id/close', (req, res) => {
  const id = req.params.id;
  const chapter = db.prepare('SELECT * FROM chapter WHERE id = ?').get(id);
  if (!chapter) throw httpError(404, `chapter ${id} not found`);
  if (chapter.closed_at) throw httpError(409, `chapter ${id} is already closed — its record is immutable`);

  const b = req.body ?? {};
  if (typeof b.title !== 'string' || !b.title.trim()) throw httpError(400, 'title (non-empty string) is required');
  if (typeof b.summary !== 'string' || !b.summary.trim()) throw httpError(400, 'summary (non-empty string) is required');

  // Reuse the strict child normalizers from the create path (they
  // 404 ghost ids; unknown event kinds 400) — same contract the
  // review modal was built against.
  const events = normalizeEvents(b.events);
  const characters = normalizeCharacters(b.characters);
  const places = normalizePlaces(b.places);

  const worldStateUpdate = normalizeWorldStateUpdate(b.worldStateUpdate);
  const applyWorld = b.applyWorldUpdate === undefined ? true : b.applyWorldUpdate;
  if (applyWorld && worldStateUpdate) {
    const { facts, threads, location } = worldStateUpdate;
    if (location !== null && !db.prepare('SELECT id FROM place WHERE id = ? AND world_id = ?').get(location, chapter.world_id)) {
      throw httpError(404, `worldStateUpdate.currentLocationId ${location} not found in this world`);
    }
  }
  const characterLocations = normalizeCharacterLocations(b.characterLocations, chapter.world_id);

  // ── The commit: ONE transaction, all-or-nothing ─────────────────
  // Stamping closed_at inside the tx (not via PATCH) keeps the
  // invariant "closed_at set ⇔ the record was written" transactional.
  const tx = db.transaction(() => {
    // word_count = the transcript's word length (schema 006: "raw
    // transcript length (close-gate = 5000)") — the same metric
    // compact.js reports as `wordCount`, so the two agree.
    const wordCount = db
      .prepare('SELECT content FROM transcript WHERE chapter_id = ?')
      .all(id)
      .reduce((n, r) => n + (r.content ? r.content.split(/\s+/).filter(Boolean).length : 0), 0);

    db.prepare('UPDATE chapter SET title = ?, summary = ?, word_count = ?, closed_at = datetime(\'now\') WHERE id = ?')
      .run(b.title.trim(), b.summary.trim(), wordCount, id);

    db.prepare('DELETE FROM chapter_event WHERE chapter_id = ?').run(id);
    const insEvent = db.prepare('INSERT INTO chapter_event (chapter_id, kind, what, detail, seq) VALUES (?, ?, ?, ?, ?)');
    events.forEach((e, i) => insEvent.run(id, e.kind, e.what, e.detail, i + 1));

    db.prepare('DELETE FROM chapter_character WHERE chapter_id = ?').run(id);
    const insChar = db.prepare('INSERT INTO chapter_character (chapter_id, character_id, involvement) VALUES (?, ?, ?)');
    characters.forEach((c) => insChar.run(id, c.characterId, c.involvement));

    db.prepare('DELETE FROM chapter_place WHERE chapter_id = ?').run(id);
    const insPlace = db.prepare('INSERT INTO chapter_place (chapter_id, place_id) VALUES (?, ?)');
    places.forEach((p) => insPlace.run(id, p.placeId));

    if (applyWorld && worldStateUpdate) {
      const { facts, threads, location } = worldStateUpdate;
      const existing = db.prepare('SELECT * FROM world_state WHERE id = ?').get(chapter.world_id);
      if (existing) {
        db.prepare('UPDATE world_state SET established_facts = ?, open_threads = ?, current_location_id = ? WHERE id = ?').run(
          facts !== null ? JSON.stringify(facts) : existing.established_facts,
          threads !== null ? JSON.stringify(threads) : existing.open_threads,
          location !== null ? location : existing.current_location_id,
          chapter.world_id,
        );
      } else {
        db.prepare('INSERT INTO world_state (id, established_facts, open_threads, current_location_id) VALUES (?, ?, ?, ?)').run(
          chapter.world_id,
          facts ? JSON.stringify(facts) : null,
          threads ? JSON.stringify(threads) : null,
          location,
        );
      }
    }

    characterLocations.forEach((l) =>
      db.prepare('UPDATE character SET current_location_id = ? WHERE id = ?').run(l.currentLocationId, l.characterId),
    );
  });
  tx();

  // Fresh read-back (the "return the entity after the write" pattern):
  // the immutable chapter record + the canon now established, so the
  // client's world-state cache and character cache can be updated from
  // one response.
  res.json({
    chapter: getChapterFull(id),
    worldState: readWorldState(chapter.world_id),
    characterLocations,
  });
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
