// /api/compact — the PROPOSE step of chapter close.
//
// Spring analog: a @PostMapping that orchestrates a @Service (the
// Ollama client) and returns a *proposed* DTO. It writes NOTHING to
// the database. The player reviews/edits it (the "review modal") and
// then POSTs the approved record to POST /api/chapters/:id/close,
// which is the only write — and that one is @Transactional.
//
// Flow (plan.md, "Story model & per-turn context"):
//   1. Chapter close is a PLAYER action (the LLM may only *suggest*
//      one, behind a min-length gate — that gate lives in the
//      narration flow, not here; we still report `meetsMinLength`).
//   2. On close, a DEDICATED compaction call (its own prompt — not
//      part of the narration call) compresses the chapter's full raw
//      transcript into a structured chapter record.
//   3. "What the player approves is what gets stored" — so this
//      endpoint returns the proposal for the review modal and stops.
//      The full raw transcript stays in the transcript table at
//      fidelity either way; the record is what lives in context.
//
// Distinct from /api/narrate + /api/choices (story.js):
//   - those stream Ollama's raw ndjson lines through verbatim;
//   - this is a "smart" route: the server assembles the prompt from
//     DB state (roster + world state + transcript), collects the WHOLE
//     response, and parses/validates the JSON record before it reaches
//     the player. No streaming needed — a record is all-or-nothing.

import { Router } from 'express';
import { db, httpError } from '../index.js';
import { streamChat } from '../lib/ollama.js';

const router = Router();

// plan.md: "Close-suggestion min-length gate = 5000 words of the
// current chapter ... Below that the LLM does not suggest wrapping.
// Player close is always available regardless." — so advisory here:
// reported to the client, never enforced with a 4xx.
export const MIN_SUGGEST_WORDS = 5000;

// ── Prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the archivist of an interactive-fiction world.
You are given the FULL RAW TRANSCRIPT of a chapter, plus the world's
character roster, place roster, and the currently committed world state.
Compress the chapter into one structured JSON record.

Respond with ONE raw JSON object only — no markdown fences, no commentary.
Use ONLY the ids from the provided rosters; if something is not in the
rosters, omit the reference rather than inventing an id.

Shape:
{
  "title": "short chapter title",
  "summary": "2-5 sentence summary of the whole chapter",
  "events": [ { "kind": "major" | "minor", "what": "one-line event", "detail": "fuller note" } ],
  "characters": [ { "characterId": 3, "involvement": "what this character did / what happened to them, this chapter" } ],
  "places": [ { "placeId": 1 } ],
  "worldStateUpdate": {
    "establishedFacts": [ "durable NEW truths established by this chapter" ],
    "openThreads": [ { "thread": "unresolved plot line", "detail": "optional context" } ],
    "currentLocationId": 1
  },
  "characterLocations": [ { "characterId": 3, "currentLocationId": 2 } ]
}

Guidance:
- events: "major" = story pivots; "minor" = atmosphere / small beats. Keep chronological order.
- characters: include EVERY roster character that meaningfully appears; the involvement note is the canon hook that keeps later chapters consistent (injuries, promises, relationships, knowledge).
- worldStateUpdate.establishedFacts: only NEW durable truths — not restatements of prior world state.
- worldStateUpdate.openThreads: unresolved threads worth tracking (a threat, a debt, a question).
- currentLocationId: where the story ends up at the chapter's end (null if it does not change).
- characterLocations: where each listed character is at the END of the chapter (null if unknown).`;

// ── Request-time helpers (TDZ rule: no db access at module scope) ──

function extractJson(text) {
  // The model occasionally wraps the object in ```json fences despite
  // instructions — take the first '{' through the last '}'.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw httpError(422, 'compaction response contained no JSON object — ask to retry');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw httpError(422, `compaction response was not valid JSON: ${e.message} — ask to retry`);
  }
}

// Lenient by design: this normalizes an LLM's DRAFT for the review
// modal, so unknown/misspelled references are DROPPED with a warning
// (the player sees the warning and can delete the bad row) rather than
// failing the whole proposal. Contrast the APPLY step
// (chapters.js POST /:id/close), which is strict — by then the data is
// the player's approved record, and a ghost id is a real bug (404).
function normalizeProposal(obj, worldId, warnings) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw httpError(422, 'compaction result must be a JSON object');
  }

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const title = str(obj.title);
  const summary = str(obj.summary);
  if (!title) throw httpError(422, 'compaction result has no usable "title" — ask to retry');
  if (!summary) throw httpError(422, 'compaction result has no usable "summary" — ask to retry');

  // events
  let events = [];
  if (obj.events === undefined || obj.events === null) {
    /* an empty chapter of events is legal */
  } else if (Array.isArray(obj.events)) {
    for (const e of obj.events) {
      const what = str(e?.what);
      if (!what) continue;
      events.push({
        kind: e.kind === 'major' ? 'major' : 'minor',
        what,
        detail: str(e.detail),
      });
    }
  } else {
    warnings.push('"events" was not an array — dropped');
  }

  // characters (must exist IN THIS WORLD — check the root of the chain)
  const characters = [];
  if (Array.isArray(obj.characters)) {
    for (const c of obj.characters) {
      if (typeof c?.characterId !== 'number') continue;
      const ok = db.prepare('SELECT id FROM character WHERE id = ? AND world_id = ?').get(c.characterId, worldId);
      if (!ok) {
        warnings.push(`dropped characterId ${c.characterId} (not in this world's roster)`);
        continue;
      }
      characters.push({ characterId: c.characterId, involvement: str(c.involvement) });
    }
  } else if (obj.characters !== undefined && obj.characters !== null) {
    warnings.push('"characters" was not an array — dropped');
  }

  // places — MUST match the close endpoint's contract ({placeId}),
  // because the review modal posts the approved proposal straight back.
  // Lenient bonus: bare numeric ids are also accepted.
  const places = [];
  if (Array.isArray(obj.places)) {
    for (const p of obj.places) {
      const pid = typeof p === 'number' ? p : p?.placeId;
      if (typeof pid !== 'number') continue;
      const ok = db.prepare('SELECT id FROM place WHERE id = ? AND world_id = ?').get(pid, worldId);
      if (!ok) {
        warnings.push(`dropped placeId ${pid} (not in this world's roster)`);
        continue;
      }
      places.push({ placeId: pid });
    }
  } else if (obj.places !== undefined && obj.places !== null) {
    warnings.push('"places" was not an array — dropped');
  }

  // worldStateUpdate
  const wsu = obj.worldStateUpdate && typeof obj.worldStateUpdate === 'object' ? obj.worldStateUpdate : {};
  const establishedFacts = Array.isArray(wsu.establishedFacts)
    ? wsu.establishedFacts.map((f) => str(f)).filter(Boolean)
    : [];
  const openThreads = Array.isArray(wsu.openThreads)
    ? wsu.openThreads
        .map((t) => (str(t?.thread) ? { thread: str(t.thread), detail: str(t?.detail) } : null))
        .filter(Boolean)
    : [];
  let currentLocationId = null;
  if (wsu.currentLocationId !== undefined && wsu.currentLocationId !== null) {
    if (typeof wsu.currentLocationId === 'number') {
      const ok = db.prepare('SELECT id FROM place WHERE id = ? AND world_id = ?').get(wsu.currentLocationId, worldId);
      if (ok) currentLocationId = wsu.currentLocationId;
      else warnings.push(`worldStateUpdate.currentLocationId ${wsu.currentLocationId} not in roster — set to null`);
    } else {
      warnings.push('worldStateUpdate.currentLocationId had a bad type — set to null');
    }
  }

  // characterLocations
  const characterLocations = [];
  if (Array.isArray(obj.characterLocations)) {
    for (const l of obj.characterLocations) {
      if (typeof l?.characterId !== 'number') continue;
      const chOk = db.prepare('SELECT id FROM character WHERE id = ? AND world_id = ?').get(l.characterId, worldId);
      if (!chOk) {
        warnings.push(`characterLocations: characterId ${l.characterId} not in roster — dropped`);
        continue;
      }
      let loc = null;
      if (l.currentLocationId !== undefined && l.currentLocationId !== null) {
        if (typeof l.currentLocationId === 'number') {
          const ok = db.prepare('SELECT id FROM place WHERE id = ? AND world_id = ?').get(l.currentLocationId, worldId);
          if (ok) loc = l.currentLocationId;
          else warnings.push(`characterLocations: placeId ${l.currentLocationId} not in roster — set to null`);
        }
      }
      characterLocations.push({ characterId: l.characterId, currentLocationId: loc });
    }
  } else if (obj.characterLocations !== undefined && obj.characterLocations !== null) {
    warnings.push('"characterLocations" was not an array — dropped');
  }

  return {
    title,
    summary,
    events,
    characters,
    places,
    worldStateUpdate: { establishedFacts, openThreads, currentLocationId },
    characterLocations,
  };
}

// ── Route ────────────────────────────────────────────────────────

// POST /api/compact — run the dedicated compaction call, return the
// proposed chapter record for the review modal. Writes NOTHING.
// Body: { chapterId: number, think?: boolean }
router.post('/', async (req, res) => {
  const { chapterId, think } = req.body ?? {};
  if (typeof chapterId !== 'number') throw httpError(400, 'chapterId (number) is required');

  const chapter = db.prepare('SELECT * FROM chapter WHERE id = ?').get(chapterId);
  if (!chapter) throw httpError(404, `chapter ${chapterId} not found`);
  if (chapter.closed_at) {
    throw httpError(409, `chapter ${chapterId} is already closed — its record is immutable`);
  }

  const passages = db
    .prepare('SELECT player_action, content FROM transcript WHERE chapter_id = ? ORDER BY id')
    .all(chapterId);
  if (passages.length === 0) {
    throw httpError(400, `chapter ${chapterId} has no transcript passages to compact`);
  }

  // Ground the LLM on the ids it may reference (tier-2 context per
  // plan.md) — it must point at roster rows, not invent ids.
  const characters = db
    .prepare('SELECT id, name, role FROM character WHERE world_id = ? ORDER BY tier, name')
    .all(chapter.world_id);
  const places = db.prepare('SELECT id, name FROM place WHERE world_id = ? ORDER BY name').all(chapter.world_id);
  const wsRow = db.prepare('SELECT * FROM world_state WHERE id = ?').get(chapter.world_id);

  const wordCount = passages.reduce(
    (n, p) => n + (p.content ? p.content.split(/\s+/).filter(Boolean).length : 0),
    0,
  );

  const userContent = JSON.stringify(
    {
      chapter: { id: chapter.id, seq: chapter.seq, title: chapter.title },
      characters,
      places,
      worldState: wsRow
        ? {
            establishedFacts: wsRow.established_facts ? JSON.parse(wsRow.established_facts) : [],
            openThreads: wsRow.open_threads ? JSON.parse(wsRow.open_threads) : [],
            currentLocationId: wsRow.current_location_id,
          }
        : { establishedFacts: [], openThreads: [], currentLocationId: null },
      transcript: passages.map((p) => ({ playerAction: p.player_action, content: p.content })),
    },
    null,
    2,
  );

  // Collect the whole response (a JSON record is all-or-nothing — no
  // reason to stream deltas into the review modal).
  let buffer = '';
  await streamChat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    // Default OFF (same as story.js): the reasoning pass is a luxury
    // here, opt in with { "think": true } for a more careful record.
    think: think === true,
    writeLine: (line) => {
      const chunk = JSON.parse(line);
      if (chunk.message?.content) buffer += chunk.message.content;
    },
  });

  const warnings = [];
  const proposed = normalizeProposal(extractJson(buffer), chapter.world_id, warnings);

  res.json({
    chapterId: chapter.id,
    worldId: chapter.world_id,
    wordCount,
    passageCount: passages.length,
    // Advisory only (min-length GATE is for the close *suggestion*).
    meetsMinLength: wordCount >= MIN_SUGGEST_WORDS,
    warnings,
    proposed,
  });
});

export default router;
