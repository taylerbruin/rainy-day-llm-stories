// /api/places — location sheets (003_place). Parallel to characters.js, but simpler:
// a place is a leaf — nothing hangs off it in the schema (characters POINT here via
// current_location_id and location_association.place_id, but those are the CHARACTER's
// business, so affiliation writes happen through /api/characters).
//
// Spring analog: @Controller + @RequestMapping("/api/places"). The derived
// `affiliatedCharacters` on GET :id is read-only projection — like returning a
// DTO that lazy-loads a @ManyToMany from the other side of the bridge.
//
// The distinctive rule here: starting_mood is CANON (set once at creation, the
// worldgen-established atmosphere) while current_mood is LIVE (committed at
// chapter close). So:
//   POST   → may set both (starting_mood defaults to current_mood when omitted?
//            no — both default null; a bare {name} place is legal per schema)
//   PATCH  → startingMood is IMMUTABLE: sending it is a 400, not a silent ignore.
//            (Spring: an @JsonProperty that throws in the setter — fail loud.)
//
// Same house rules as every other router:
//  - `db` only at request time (TDZ rule — index.js imports this before it
//    exports `db`).
//  - Query params arrive as STRINGS → Number() + Number.isInteger(), never typeof.
//  - Validate every FK before any write; 404 for ghosts, 400 for bad shapes.
//  - better-sqlite3 does NOT parse JSON columns → explicit parse/stringify.

import { Router } from 'express';
import { db, httpError } from '../index.js';

const router = Router();

function parsePlace(row) {
  if (!row) return null;
  return {
    ...row,
    layout: row.layout ? JSON.parse(row.layout) : null,
  };
}

// Full shape for GET :id — the sheet plus who's affiliated here (read-only,
// derived from the bridge the character side owns).
function getPlaceFull(id) {
  const place = parsePlace(db.prepare('SELECT * FROM place WHERE id = ?').get(id));
  if (!place) return null;
  place.affiliatedCharacters = db
    .prepare(
      `SELECT c.id, c.name
         FROM location_association la
         JOIN character c ON c.id = la.character_id
        WHERE la.place_id = ?
        ORDER BY c.tier, c.name`
    )
    .all(id);
  return place;
}

function worldExists(id) {
  return db.prepare('SELECT 1 FROM world WHERE id = ?').get(id) !== undefined;
}

// Optional text field: undefined → null (absent), null → null, string → string.
function normalizeOptionalText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, `${label} must be a non-empty string (or null)`);
  }
  return value;
}

// layout: optional structured map (rooms/exits/notables per plan.md).
// Must be a plain object when present — an array is almost certainly a mistake.
function normalizeLayout(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'layout must be a JSON object (or null)');
  }
  return value;
}

// GET /api/places?worldId=N — list sheets for one world (or all, if unfiltered).
router.get('/', (req, res) => {
  const { worldId: rawWorldId } = req.query;
  let worldId;
  if (rawWorldId !== undefined) {
    worldId = Number(rawWorldId); // query params are strings — parse explicitly
    if (!Number.isInteger(worldId)) throw httpError(400, 'worldId must be an integer');
    if (!worldExists(worldId)) throw httpError(404, `world ${rawWorldId} not found`);
  }
  const rows =
    worldId !== undefined
      ? db.prepare('SELECT * FROM place WHERE world_id = ? ORDER BY name').all(worldId)
      : db.prepare('SELECT * FROM place ORDER BY world_id, name').all();
  res.json(rows.map(parsePlace));
});

// GET /api/places/:id — one sheet + affiliated characters (req.params ≈ @PathVariable).
router.get('/:id', (req, res) => {
  const place = getPlaceFull(req.params.id);
  if (!place) throw httpError(404, `place ${req.params.id} not found`);
  res.json(place);
});

// POST /api/places — create a sheet.
// Body: { worldId, name, description?, startingMood?, currentMood?, layout? }
router.post('/', (req, res) => {
  const b = req.body ?? {};

  // Validate everything BEFORE any write (≈ @Valid @RequestBody failing before the
  // handler does its work).
  if (typeof b.worldId !== 'number' || !Number.isInteger(b.worldId)) {
    throw httpError(400, 'worldId (integer) is required');
  }
  if (!worldExists(b.worldId)) throw httpError(404, `world ${b.worldId} not found`);
  if (!b.name || typeof b.name !== 'string' || b.name.trim() === '') {
    throw httpError(400, 'name (string) is required');
  }
  const description = normalizeOptionalText(b.description, 'description');
  const startingMood = normalizeOptionalText(b.startingMood, 'startingMood');
  const currentMood = normalizeOptionalText(b.currentMood, 'currentMood');
  const layout = normalizeLayout(b.layout);

  const info = db
    .prepare(
      `INSERT INTO place (world_id, name, description, starting_mood, current_mood, layout)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(b.worldId, b.name, description, startingMood, currentMood, layout ? JSON.stringify(layout) : null);

  res.status(201).json(getPlaceFull(info.lastInsertRowid));
});

// PATCH /api/places/:id — three-state merge: absent = keep, null/value = write.
//   name            string, required when present (never null)
//   description     string | null
//   currentMood     string | null   (LIVE — the only mutable mood)
//   layout          object | null
//   startingMood    400 if present  (IMMUTABLE canon — send it and you get a loud error)
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM place WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, `place ${req.params.id} not found`);

  const b = req.body ?? {};
  const sets = [];
  const params = [];

  function handle(key, col, normalize) {
    if (b[key] === undefined) return; // absent → keep existing
    const v = normalize(b[key]);
    sets.push(`${col} = ?`);
    params.push(v);
  }

  handle('name', 'name', (v) => {
    if (typeof v !== 'string' || v.trim() === '') throw httpError(400, 'name must be a non-empty string (not null)');
    return v;
  });
  handle('description', 'description', (v) => normalizeOptionalText(v, 'description'));
  handle('currentMood', 'current_mood', (v) => normalizeOptionalText(v, 'currentMood'));
  handle('layout', 'layout', (v) => (v === null ? null : JSON.stringify(normalizeLayout(v))));

  if (b.startingMood !== undefined) {
    throw httpError(400, 'startingMood is immutable canon (set it at creation; update currentMood instead)');
  }
  if (sets.length === 0) {
    throw httpError(400, 'provide at least one field to update (name, description, currentMood, layout)');
  }

  db.prepare(`UPDATE place SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
  res.json(getPlaceFull(row.id));
});

// DELETE /api/places/:id — 204. FK fallout is the schema doing its job:
//   character.current_location_id → SET NULL (position becomes "somewhere else")
//   location_association          → CASCADE (affiliation gone)
//   chapter_place                 → CASCADE (chapter refs gone)
//   world_state.current_location_id → SET NULL
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM place WHERE id = ?').run(req.params.id);
  if (info.changes === 0) throw httpError(404, `place ${req.params.id} not found`);
  res.status(204).end();
});

export default router;
