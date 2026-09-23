-- ============================================================
-- 008_chapter_character — per-chapter involvement for a character.
--
-- Replaces the old `character.chapter_history` JSON. A JSON blob had to
-- copy the same event string into EVERY character's row (a battle with 5
-- cast = 5 copies). Instead, each (chapter, character) pair carries ONE
-- note: what THIS character did / was involved in during this chapter.
--
--   * "chapters a character is in"  → SELECT DISTINCT chapter_id ...
--   * "what did they actually do"   → the `involvement` note (the part
--                                     that keeps the LLM from contradicting
--                                     prior canon, e.g. Marn's wounded arm)
--
-- Same shape / philosophy as location_association (005): a bridge table
-- with a composite PK. A character appears at most ONCE per chapter
-- (one involvement note).
-- ============================================================
CREATE TABLE IF NOT EXISTS chapter_character (
    chapter_id   INTEGER NOT NULL REFERENCES chapter(id)   ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
    involvement  TEXT,                   -- what THIS character did / was involved in, this chapter
    created_by   TEXT    NOT NULL DEFAULT 'local',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chapter_id, character_id)
);

CREATE TRIGGER IF NOT EXISTS trg_chapter_character_after_update
AFTER UPDATE ON chapter_character
BEGIN
    UPDATE chapter_character SET last_updated = datetime('now')
    WHERE chapter_id = NEW.chapter_id AND character_id = NEW.character_id;
END;

-- "which chapters is this character in?" filters on character_id, which the
-- composite PK does not cover (PK leads with chapter_id) — index it, like
-- location_association indexes its non-leading FK.
CREATE INDEX IF NOT EXISTS idx_chapter_character_character ON chapter_character (character_id);
