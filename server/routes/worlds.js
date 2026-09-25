// /api/worlds — the "worlds controller".
//
// Spring analog: a @Controller class with a class-level
//   @RequestMapping("/api/worlds")
// and method mappings relative to it:
//   @GetMapping("")     → list
//   @GetMapping("/{id}") → one
//   @PostMapping("")    → create
//
// index.js mounts this router at the /api/worlds prefix
// (app.use('/api/worlds', router)), so every path declared
// here is relative to that prefix — exactly how Spring's
// class-level + method-level mappings compose.
//
// We import `db` and `httpError` back from index.js: that's a
// circular import, but it's safe because we only touch them at
// request time, long after both modules have finished loading.

import { Router } from 'express';
import { db, httpError } from '../index.js';

const router = Router();

// JSON columns are NOT auto-parsed by better-sqlite3 (the one thing
// a JPA mapper would do for free), so we parse explicitly here.
function parseWorld(row) {
  if (!row) return null;
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : null,
  };
}

// GET /api/worlds — list all worlds (Step 0 of the world-gen wizard).
router.get('/', (req, res) => {
  const worlds = db.prepare('SELECT * FROM world ORDER BY created_at DESC').all();
  res.json(worlds);
});

// GET /api/worlds/:id — one world. req.params.id ≈ @PathVariable("id").
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM world WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, `world ${req.params.id} not found`);
  res.json(parseWorld(row));
});

// POST /api/worlds — create a world (Step 1 of the wizard lands here).
// Body: { name, description?, tags?, tone?, era? }  (req.body ≈ @RequestBody)
router.post('/', (req, res) => {
  const { name, description = null, tags = null, tone = null, era = null } = req.body ?? {};
  if (!name || typeof name !== 'string') throw httpError(400, 'name (string) is required');

  const info = db
    .prepare('INSERT INTO world (name, description, tags, tone, era) VALUES (?, ?, ?, ?, ?)')
    .run(name, description, tags ? JSON.stringify(tags) : null, tone, era);

  // Also seed the live-canon row so the world is immediately usable.
  db.prepare('INSERT INTO world_state (id) VALUES (?)').run(info.lastInsertRowid);

  res.status(201).json(parseWorld(db.prepare('SELECT * FROM world WHERE id = ?').get(info.lastInsertRowid)));
});

export default router;
