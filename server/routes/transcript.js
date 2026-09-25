// /api/transcript — the "book" controller.
//
// Spring analog: a @Controller with class-level
//   @RequestMapping("/api/transcript")
// and these method mappings:
//   @PostMapping("")              → append one passage
//   @GetMapping("?chapterId=")    → read a chapter's full book (in order)
//   @GetMapping("/{id}")          → one passage
//   @DeleteMapping("/{id}")       → remove one passage (regen = delete + re-POST)
//
// The transcript table IS the story: one row = one passage of prose.
// Order within a chapter = id (monotonic), so we always ORDER BY id —
// there is no seq column to keep honest (see schema 010).
//
// Chapter FK: transcript.chapter_id REFERENCES chapter(id) ON DELETE
// CASCADE. We still pre-check the chapter's existence ourselves so a
// missing chapter is a clean 404 with a useful message, rather than a
// raw SQLITE_CONSTRAINT_FOREIGNKEY thrown by better-sqlite3.
//   (Spring analog: validating the @RequestBody's FK before letting
//    the repository/exception handler see it.)

import { Router } from 'express';
import { db, httpError } from '../index.js';

const router = Router();

// No JSON columns in this table — content is plain prose — so the row
// comes back shaped exactly as we want to send it. (Contrast worlds.js,
// which had to JSON.parse `tags` because better-sqlite3 returns TEXT.)
function parsePassage(row) {
  if (!row) return null;
  return { ...row };
}

function chapterExists(chapterId) {
  return db.prepare('SELECT id FROM chapter WHERE id = ?').get(chapterId) !== undefined;
}

// POST /api/transcript — append one passage to a chapter.
// Body: { chapterId: number, content: string, playerAction?: string|null, tokens?: number|null }
//
// We accept camelCase keys (chapterId/playerAction) because this is the
// contract the Svelte app writes against — it's a JS object, not SQL.
router.post('/', (req, res) => {
  const { chapterId, content, playerAction = null, tokens = null } = req.body ?? {};

  if (typeof chapterId !== 'number') throw httpError(400, 'chapterId (number) is required');
  if (!chapterExists(chapterId)) throw httpError(404, `chapter ${chapterId} not found`);
  if (!content || typeof content !== 'string') throw httpError(400, 'content (non-empty string) is required');
  if (playerAction !== null && typeof playerAction !== 'string') {
    throw httpError(400, 'playerAction must be a string or null');
  }

  const info = db
    .prepare('INSERT INTO transcript (chapter_id, player_action, content, tokens) VALUES (?, ?, ?, ?)')
    .run(chapterId, playerAction, content, tokens);

  // Fresh read back — the canonical "return the entity after create"
  // pattern, same as worlds.js POST.
  res.status(201).json(parsePassage(db.prepare('SELECT * FROM transcript WHERE id = ?').get(info.lastInsertRowid)));
});

// GET /api/transcript?chapterId=N — the chapter's full book, in order.
// Query param ≈ @RequestParam("chapterId").
router.get('/', (req, res) => {
  const { chapterId } = req.query;
  if (chapterId === undefined || chapterId === '') throw httpError(400, 'chapterId (query param) is required');
  if (!chapterExists(chapterId)) throw httpError(404, `chapter ${chapterId} not found`);

  const rows = db.prepare('SELECT * FROM transcript WHERE chapter_id = ? ORDER BY id').all(chapterId);
  res.json(rows);
});

// GET /api/transcript/:id — one passage. req.params.id ≈ @PathVariable.
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM transcript WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, `transcript ${req.params.id} not found`);
  res.json(parsePassage(row));
});

// DELETE /api/transcript/:id — remove one passage.
// This is the regen primitive: delete the passage, re-POST with the same
// playerAction, and the book has a rewritten passage in its place.
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM transcript WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, `transcript ${req.params.id} not found`);
  db.prepare('DELETE FROM transcript WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
