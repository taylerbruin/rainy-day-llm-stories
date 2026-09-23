-- ============================================================
-- 006_chapter — IMMUTABLE history. One row per (closed) chapter,
-- holding the compacted structured record (the thing that lives
-- in context), plus raw bookkeeping.
-- ============================================================
CREATE TABLE IF NOT EXISTS chapter (
    id           INTEGER PRIMARY KEY,
    world_id     INTEGER NOT NULL REFERENCES world(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,                -- 1-based order within the world
    title        TEXT,
    summary      TEXT,
    -- structured refs normalized out into join tables (query with JOINs):
    --   major/minor events → chapter_event     (007)
    --   characters involved → chapter_character (008)
    --   places referenced  → chapter_place     (009)
    word_count   INTEGER,                         -- raw transcript length (close-gate = 5000)
    closed_at    TEXT,                            -- NULL until the player closes the chapter
    created_by   TEXT    NOT NULL DEFAULT 'local',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (world_id, seq)                  -- enforces the 1-based seq order (no gaps, no dupes)
);

CREATE TRIGGER IF NOT EXISTS trg_chapter_after_update
AFTER UPDATE ON chapter
BEGIN
    UPDATE chapter SET last_updated = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_chapter_world ON chapter (world_id);
