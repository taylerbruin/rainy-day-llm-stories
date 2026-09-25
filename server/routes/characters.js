// /api/characters — the "character spec sheet" controller.
//
// Spring analog: a @Controller with class-level
//   @RequestMapping("/api/characters")
// and method mappings:
//   @GetMapping("?worldId=")  → a world's cast, tier then name order
//   @GetMapping("/{id}")      → one sheet, WITH its stable affiliations
//   @PostMapping("")          → create a sheet
//   @PatchMapping("/{id}")    → partial update (three-state: absent = keep)
//   @DeleteMapping("/{id}")   → delete (affiliations CASCADE)
//
// ── The two location axes (schema 004/005) ───────────────────────
//   AFFILIATION (stable)  → location_association (WHERE they belong)
//   POSITION  (live)      → current_location_id (WHERE they are now)
//
// Both are managed here, but with different semantics:
//   • currentLocationId  — single FK, nullable. Three-state:
//       absent   → keep existing      (like world-state.js)
//       null     → clear it
//       number   → must be a real place (404 if ghost)
//     Committed at chapter close, not mid-chapter — but the API just
//     writes what it's given; the discipline lives in the caller.
//   • locationAffiliations — a BRIDGE table (composite PK, one row per
//     character↔place pair). Spring analog: the @ManyToMany side.
//     We treat it as full-replace when PRESENT (send the complete list),
//     and leave it untouched when ABSENT — the same "absent = keep"
//     contract, applied to a collection instead of a column.
//
// ── tier: the enum lesson again ──────────────────────────────────
//   CHECK (tier IN (1, 2, 3)) lives in SQLite. If we let a bad tier
//   through, it 500s mid-write. So we validate BEFORE the write and
//   return a clean 400 — exactly the chapters.js 'kind' fix. (Spring:
//   @Valid on a @Min(1) @Max(3) int field, failing before the handler.)
//
// As always: NO db access at module scope (TDZ — index.js imports us
// before `export const db` runs). Every query lives in a function or
// handler body, executed at request time.

import { Router } from 'express';
import { db, httpError } from '../index.js';

const router = Router();

// ── Row → JSON (explicit JSON-column parsing, the worlds.js pattern) ──
function parseCharacter(row) {
  if (!row) return null;
  return {
    ...row,
    skills: row.skills ? JSON.parse(row.skills) : [],
    traits: row.traits ? JSON.parse(row.traits) : [],
  };
}

// GET shape: sheet + its stable affiliations (ids + names), the same
// "children as separate clean reads" pattern as chapters.js.
function getCharacterFull(id) {
  const character = db.prepare('SELECT * FROM character WHERE id = ?').get(id);
  if (!character) return null;
  const affiliations = db
    .prepare('SELECT la.place_id AS id, p.name FROM location_association la JOIN place p ON p.id = la.place_id WHERE la.character_id = ? ORDER BY p.name')
    .all(id);
  return { ...parseCharacter(character), affiliations };
}

// ── Small helpers ─────────────────────────────────────────────────

function worldExists(id) {
  return db.prepare('SELECT id FROM world WHERE id = ?').get(id) !== undefined;
}

function placeExists(id) {
  return db.prepare('SELECT id FROM place WHERE id = ?').get(id) !== undefined;
}

// string[] or null. undefined → null (caller decides keep-vs-write).
// (Spring: @Valid List<String> with @NotBlank elements, or @Nullable null.)
function normalizeStringList(value, label) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw httpError(400, `${label} must be an array of strings`);
  return value.map((s, i) => {
    if (typeof s !== 'string' || !s.trim()) throw httpError(400, `${label}[${i}] must be a non-empty string`);
    return s;
  });
}

// tier: 1 | 2 | 3, else 400. (The 'kind' lesson — never let a bad enum
// reach SQLite's CHECK constraint.)
function normalizeTier(value, { optional = false } = {}) {
  if (value === undefined) return null; // caller keeps default/existing
  if (value !== 1 && value !== 2 && value !== 3) {
    throw httpError(400, `tier must be 1, 2, or 3 (got ${JSON.stringify(value)})`);
  }
  return value;
}

// currentLocationId: number → must exist; null/undefined → null.
function normalizeLocationId(value, label = 'currentLocationId') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw httpError(400, `${label} must be a number or null`);
  if (!placeExists(value)) throw httpError(404, `place ${value} not found`);
  return value;
}

// affiliation ids → sorted unique array (stable order for full-replace).
function normalizeAffiliations(value) {
  if (!Array.isArray(value)) throw httpError(400, 'affiliations must be an array of place ids (numbers)');
  const seen = new Set();
  return value.map((p, i) => {
    if (typeof p !== 'number') throw httpError(400, `affiliations[${i}] must be a place id (number)`);
    if (!placeExists(p)) throw httpError(404, `place ${p} not found (affiliations)`);
    seen.add(p);
    return p;
  });
}

// ── Routes ────────────────────────────────────────────────────────

// GET /api/characters?worldId=N — a world's cast (tier asc, name asc —
// the protagonist spine first, which is the whole point of tiers).
// A worldId is NOT required: a global cast list is a legitimate query
// (world 1's world-state test data lives there).
router.get('/', (req, res) => {
  const { worldId: rawWorldId } = req.query;
  let worldId;
  if (rawWorldId !== undefined) {
    // Query params arrive as STRINGS (unlike JSON body keys, which can be
    // real numbers) — parse explicitly. (Spring: @RequestParam int is
    // converted for you; Express leaves the conversion to us.)
    worldId = Number(rawWorldId);
    if (!Number.isInteger(worldId)) throw httpError(400, 'worldId must be an integer');
    if (!worldExists(worldId)) throw httpError(404, `world ${rawWorldId} not found`);
  }
  const rows = worldId !== undefined
    ? db.prepare('SELECT * FROM character WHERE world_id = ? ORDER BY tier, name').all(Number(worldId))
    : db.prepare('SELECT * FROM character ORDER BY world_id, tier, name').all();
  res.json(rows.map((r) => parseCharacter(r)));
});

// GET /api/characters/:id — one sheet + affiliations.
router.get('/:id', (req, res) => {
  const full = getCharacterFull(req.params.id);
  if (!full) throw httpError(404, `character ${req.params.id} not found`);
  res.json(full);
});

// POST /api/characters — create a spec sheet.
// Body: { worldId, name, tier?, role?, summary?, skills?, traits?,
//         currentLocationId?, isLoveInterest?, status?, affiliations? }
router.post('/', (req, res) => {
  const b = req.body ?? {};

  // Validate EVERYTHING before any write (the worlds/chapters discipline):
  // a 400/404 here means nothing was touched — no half-created character.
  const worldId = b.worldId;
  if (typeof worldId !== 'number') throw httpError(400, 'worldId (number) is required');
  if (!worldExists(worldId)) throw httpError(404, `world ${worldId} not found`);

  const name = b.name;
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'name (non-empty string) is required');

  const tier = normalizeTier(b.tier === undefined ? 3 : b.tier); // default 3 = walk-on
  const role = typeof b.role === 'string' ? b.role : null;
  const summary = typeof b.summary === 'string' ? b.summary : null;
  const status = typeof b.status === 'string' ? b.status : null;
  const skills = normalizeStringList(b.skills ?? [], 'skills');
  const traits = normalizeStringList(b.traits ?? [], 'traits');
  const locationId = normalizeLocationId(b.currentLocationId ?? null);
  const loveInterest = b.isLoveInterest === true ? 1 : 0;
  const affiliations = normalizeAffiliations(b.affiliations ?? []);

  // A character + its affiliations land together (Spring: @Transactional
  // over the aggregate — the bridge rows are part of THIS entity's state).
  const info = db
    .prepare(
      `INSERT INTO character
         (world_id, name, tier, role, summary, skills, traits, current_location_id, is_love_interest, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(worldId, name, tier, role, summary, JSON.stringify(skills), JSON.stringify(traits), locationId, loveInterest, status);
  const id = Number(info.lastInsertRowid);

  const insAff = db.prepare('INSERT OR IGNORE INTO location_association (character_id, place_id) VALUES (?, ?)');
  const tx = db.transaction(() => affiliations.forEach((p) => insAff.run(id, p)));
  tx();

  res.status(201).json(getCharacterFull(id));
});

// PATCH /api/characters/:id — partial update, three-state semantics:
//   field ABSENT  → keep existing value   (undefined)
//   field = null  → clear (text columns / location)
//   field = value → validate + write
// The exception is the collection: `affiliations` ABSENT → keep;
// PRESENT (even []) → full-replace with exactly that list.
// (Spring: a DTO with @Nullable fields where "not in JSON" ≠ "null".)
router.patch('/:id', (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT * FROM character WHERE id = ?').get(id);
  if (!existing) throw httpError(404, `character ${id} not found`);

  const b = req.body ?? {};

  // Validate all provided fields BEFORE writing anything.
  const sets = [];
  const params = [];

  const handle = (key, col, value, validator) => {
    if (b[key] === undefined) return; // absent → keep
    const v = validator(b[key]);
    sets.push(`${col} = ?`);
    params.push(v);
  };

  handle('name', 'name', undefined, (v) => {
    if (typeof v !== 'string' || !v.trim()) throw httpError(400, 'name (non-empty string) is required');
    return v;
  });
  handle('tier', 'tier', undefined, (v) => normalizeTier(v));
  handle('role', 'role', undefined, (v) => (v === null ? null : typeof v === 'string' ? v : (() => { throw httpError(400, 'role must be a string or null'); })()));
  handle('summary', 'summary', undefined, (v) => (v === null ? null : typeof v === 'string' ? v : (() => { throw httpError(400, 'summary must be a string or null'); })()));
  handle('status', 'status', undefined, (v) => (v === null ? null : typeof v === 'string' ? v : (() => { throw httpError(400, 'status must be a string or null'); })()));
  handle('skills', 'skills', undefined, (v) => JSON.stringify(normalizeStringList(v, 'skills') ?? []));
  handle('traits', 'traits', undefined, (v) => JSON.stringify(normalizeStringList(v, 'traits') ?? []));
  handle('currentLocationId', 'current_location_id', undefined, (v) => normalizeLocationId(v));
  handle('isLoveInterest', 'is_love_interest', undefined, (v) => (v === true ? 1 : v === false ? 0 : (() => { throw httpError(400, 'isLoveInterest must be a boolean'); })()));

  if (sets.length === 0 && b.affiliations === undefined) {
    throw httpError(400, 'provide at least one field to update (or affiliations)');
  }

  // Write inside one transaction (columns + bridge rows = one state change).
  const tx = db.transaction(() => {
    if (sets.length > 0) {
      params.push(id);
      db.prepare(`UPDATE character SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    if (b.affiliations !== undefined) {
      const next = normalizeAffiliations(b.affiliations);
      db.prepare('DELETE FROM location_association WHERE character_id = ?').run(id);
      const insAff = db.prepare('INSERT INTO location_association (character_id, place_id) VALUES (?, ?)');
      next.forEach((p) => insAff.run(id, p));
    }
  });
  tx();

  res.json(getCharacterFull(id));
});

// DELETE /api/characters/:id — 204. location_association rows CASCADE;
// chapter_character refs CASCADE too; current_location_id on OTHER
// characters is unaffected (it points at a place, not a character).
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM character WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, `character ${req.params.id} not found`);
  db.prepare('DELETE FROM character WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
