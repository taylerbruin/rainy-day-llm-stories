-- ============================================================
-- 012_save — linear save list (not a tree). Mid-scene saves allowed:
--   chapter_id         = last CLOSED chapter at save time (nullable)
--   open_transcript_id = resume point inside an OPEN chapter (nullable)
-- On load, an un-compacted open chapter is rebuilt from its transcript.
-- LATEST-STATE-ONLY resume (user decision): saves do NOT replay point-in-time
-- state, so there are no snapshot columns — the save points at world_id /
-- chapter_id / open_transcript_id and world state + character positions are
-- read LIVE from their own tables (world_state, character) at load time.
-- ============================================================
CREATE TABLE IF NOT EXISTS save (
    id                    INTEGER PRIMARY KEY,
    world_id              INTEGER NOT NULL REFERENCES world(id) ON DELETE CASCADE,
    name                  TEXT    NOT NULL,       -- "Save 1", "Save 2", ...
    chapter_id            INTEGER REFERENCES chapter(id)  ON DELETE SET NULL,
    open_transcript_id    INTEGER REFERENCES transcript(id) ON DELETE SET NULL,
    created_by            TEXT    NOT NULL DEFAULT 'local',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_save_after_update
AFTER UPDATE ON save
BEGIN
    UPDATE save SET last_updated = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_save_world ON save (world_id);
