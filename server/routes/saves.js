// ============================================================
//  server/routes/saves.js — save points (012_save)
//  A linear save list per world: "Save 1", "Save 2", ...
//
//  Spring analog: `@Controller` + `@RequestMapping("/api/saves")`.
//  A save is a LEAF row (world CASCADEs it; chapter/transcript SET NULL
//  it) — but unlike places, its whole job is to be a RESUME POINT:
//    chapter_id         = last CLOSED chapter at save time (nullable)
//    open_transcript_id = resume point inside an OPEN chapter (nullable)
//  LATEST-STATE-ONLY model (no snapshot columns): loading a save reads
//  world_state / character positions LIVE from their own tables. The
//  save is a bookmark, not a photo.
//
//  House rules (same as every other router): no top-level `db` access
//  (TDZ — index.js imports this router before `openDb()` runs), all
//  validation BEFORE the write, fresh read-back afterwards.
// ============================================================
import { Router } from 'express';
import { db, httpError } from '../index.js';

const router = Router();

// ---- helpers ---------------------------------------------------------

function worldExists(id) {
  return db.prepare('SELECT 1 FROM world WHERE id = ?').get(id) !== undefined;
}

function chapterInWorld(chapterId, worldId) {
  return db
    .prepare('SELECT 1 FROM chapter WHERE id = ? AND world_id = ?')
    .get(chapterId, worldId) !== undefined;
}

function transcriptInWorld(transcriptId, worldId) {
  // transcript has no world_id of its own — it hangs off a chapter, which
  // does. (Spring: a @ManyToOne chain; check the root of the chain.)
  return db
    .prepare('SELECT 1 FROM transcript t JOIN chapter c ON c.id = t.chapter_id WHERE t.id = ? AND c.world_id = ?')
    .get(transcriptId, worldId) !== undefined;
}

// Read-only resume-context projection: what a UI would show for this
// save ("Save 3 — Ch. 4: The Rooftop, mid-scene"). The save row itself
// is just ids; the names live in chapter / transcript.
function getSaveFull(id) {
  const row = db.prepare('SELECT * FROM save WHERE id = ?').get(id);
  if (row === undefined) throw httpError(404, `save ${id} not found`);
  const chapter = row.chapter_id !== null
    ? db.prepare('SELECT id, seq, title FROM chapter WHERE id = ?').get(row.chapter_id)
    : null;
  const transcript = row.open_transcript_id !== null
    ? db.prepare('SELECT id FROM transcript WHERE id = ?').get(row.open_transcript_id)
    : null;
  return { ...row, chapter, transcript };
}

// ---- GET /?worldId=N — list saves for a world, oldest first ----------
router.get('/', (req, res) => {
  const { worldId: rawWorldId } = req.query;
  let worldId;
  if (rawWorldId !== undefined) {
    worldId = Number(rawWorldId);
    if (!Number.isInteger(worldId)) throw httpError(400, 'worldId must be an integer');
    if (!worldExists(worldId)) throw httpError(404, `world ${rawWorldId} not found`);
    const rows = db
      .prepare('SELECT id, world_id, name, chapter_id, open_transcript_id, created_at FROM save WHERE world_id = ? ORDER BY id')
      .all(worldId);
    res.json(rows);
    return;
  }
  // No filter — all saves, oldest first (still useful for a debug dump).
  const rows = db
    .prepare('SELECT id, world_id, name, chapter_id, open_transcript_id, created_at FROM save ORDER BY id')
    .all();
  res.json(rows);
});

// ---- GET /:id — one save + resume context (chapter/transcript names) --
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(400, 'id must be an integer');
  res.json(getSaveFull(id));
});

// ---- POST / — create a save point ------------------------------------
//  { worldId (number, required), name? (string, default "Save N"),
//    chapterId? (number, last CLOSED chapter), openTranscriptId? (number,
//    resume point in an OPEN chapter) }
router.post('/', (req, res) => {
  const body = req.body ?? {};
  const { worldId, name, chapterId, openTranscriptId } = body;

  // World is the hard anchor: FK must resolve AND be real.
  if (typeof worldId !== 'number' || !Number.isInteger(worldId)) {
    throw httpError(400, 'worldId must be an integer');
  }
  if (!worldExists(worldId)) throw httpError(404, `world ${worldId} not found`);

  // Optional FKs: must resolve (FK does that) AND belong to the same
  // world (a domain check the FK can't express).
  if (chapterId !== undefined) {
    if (typeof chapterId !== 'number' || !Number.isInteger(chapterId)) {
      throw httpError(400, 'chapterId must be an integer');
    }
    if (!chapterInWorld(chapterId, worldId)) {
      throw httpError(404, `chapter ${chapterId} not found in world ${worldId}`);
    }
  }
  if (openTranscriptId !== undefined) {
    if (typeof openTranscriptId !== 'number' || !Number.isInteger(openTranscriptId)) {
      throw httpError(400, 'openTranscriptId must be an integer');
    }
    if (!transcriptInWorld(openTranscriptId, worldId)) {
      throw httpError(404, `transcript ${openTranscriptId} not found in world ${worldId}`);
    }
  }

  // Name is NOT NULL — default to the linear convention "Save N".
  const finalName =
    name === undefined || name === null
      ? `Save ${db.prepare('SELECT COUNT(*) AS n FROM save WHERE world_id = ?').get(worldId).n + 1}`
      : name;
  if (typeof finalName !== 'string' || finalName.trim().length === 0) {
    throw httpError(400, 'name must be a non-empty string');
  }

  const info = db
    .prepare(
      'INSERT INTO save (world_id, name, chapter_id, open_transcript_id) VALUES (?, ?, ?, ?)'
    )
    .run(worldId, finalName.trim(), chapterId ?? null, openTranscriptId ?? null);

  res.status(201).json(getSaveFull(info.lastInsertRowid));
});

// ---- PATCH /:id — rename (the only mutable field) --------------------
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(400, 'id must be an integer');
  const existing = db.prepare('SELECT id FROM save WHERE id = ?').get(id);
  if (existing === undefined) throw httpError(404, `save ${id} not found`);

  const body = req.body ?? {};
  if (body.name === undefined) {
    throw httpError(400, 'nothing to update — name is the only mutable field');
  }
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    throw httpError(400, 'name must be a non-empty string');
  }

  db.prepare('UPDATE save SET name = ? WHERE id = ?').run(body.name.trim(), id);
  res.json(getSaveFull(id));
});

// ---- DELETE /:id — drop a save point ---------------------------------
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(400, 'id must be an integer');
  const info = db.prepare('DELETE FROM save WHERE id = ?').run(id);
  if (info.changes === 0) throw httpError(404, `save ${id} not found`);
  res.status(204).end();
});

export default router;
