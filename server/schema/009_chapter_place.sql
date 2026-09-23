-- ============================================================
-- 009_chapter_place — places referenced in a chapter.
--
-- Replaces the old chapter.place_refs JSON ({id}). A pure list of place
-- ids → a bridge table, same shape as location_association (005) and
-- chapter_character (008).
--
--   "places in this chapter" → WHERE chapter_id = ?
--   "chapters at this place" → WHERE place_id   = ?
-- ============================================================
CREATE TABLE IF NOT EXISTS chapter_place (
    chapter_id INTEGER NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
    place_id   INTEGER NOT NULL REFERENCES place(id)   ON DELETE CASCADE,
    created_by   TEXT    NOT NULL DEFAULT 'local',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chapter_id, place_id)
);

CREATE TRIGGER IF NOT EXISTS trg_chapter_place_after_update
AFTER UPDATE ON chapter_place
BEGIN
    UPDATE chapter_place SET last_updated = datetime('now')
    WHERE chapter_id = NEW.chapter_id AND place_id = NEW.place_id;
END;

-- "chapters that reference this place" filters on the non-leading PK column.
CREATE INDEX IF NOT EXISTS idx_chapter_place_place ON chapter_place (place_id);
