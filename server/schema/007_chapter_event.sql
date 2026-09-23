-- ============================================================
-- 007_chapter_event — events in a chapter, major or minor.
--
-- Replaces the old chapter.major_events / chapter.minor_events JSON.
-- Those two were really ONE thing differing only in importance + note
-- length, so they collapse into a single table with a `kind` flag.
--
--   "all events in this chapter" → WHERE chapter_id = ?
--   "just the major ones"        → WHERE chapter_id = ? AND kind = 'major'
--
-- Child table (own PK + content), NOT a composite-PK bridge, because a
-- chapter has many events and each carries its own text.
-- ============================================================
CREATE TABLE IF NOT EXISTS chapter_event (
    id         INTEGER PRIMARY KEY,
    chapter_id INTEGER NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL DEFAULT 'minor' CHECK (kind IN ('major', 'minor')),
    what       TEXT    NOT NULL,   -- the event itself
    detail     TEXT,               -- the note; longer for major, brief for minor
    seq        INTEGER NOT NULL,   -- order WITHIN the chapter; app-assigned (no trigger)
    created_by   TEXT    NOT NULL DEFAULT 'local',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_chapter_event_after_update
AFTER UPDATE ON chapter_event
BEGIN
    UPDATE chapter_event SET last_updated = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_chapter_event_chapter ON chapter_event (chapter_id);
