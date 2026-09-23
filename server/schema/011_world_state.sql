-- ============================================================
-- 011_world_state — LIVE canon. Exactly ONE row per world (PK = world id).
-- Rewritten atomically at chapter close; the record is what persists
-- as established canon across chapters.
-- (There is NO "active cast" column here: which characters are in play is
--  DERIVED at prompt time from character.current_location_id — in-scene = full
--  sheet, not-in-scene = truncated blurb. No separate table needed.)
-- ============================================================
CREATE TABLE IF NOT EXISTS world_state (
    id                  INTEGER PRIMARY KEY REFERENCES world(id) ON DELETE CASCADE,
    current_location_id INTEGER REFERENCES place(id) ON DELETE SET NULL,  -- nullable FK
    established_facts   JSON,                     -- string[] — committed truth
    open_threads        JSON,                     -- [{thread, detail?}]
    created_by          TEXT    NOT NULL DEFAULT 'local',
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_world_state_after_update
AFTER UPDATE ON world_state
BEGIN
    UPDATE world_state SET last_updated = datetime('now') WHERE id = NEW.id;
END;
