-- ============================================================
-- 010_transcript — the BOOK: full chapter narrative, always kept at fidelity.
-- A story, NOT a chat log. One row = one passage of prose (the LLM's
-- narration) — that `content` is what gets loaded into context.
-- Order within a chapter = id (rowid, monotonic); no seq needed.
--
-- player_action = the raw action the player typed that PRODUCED this passage
--   (NULL for pure scene-setting). This is the chapter's "action list" — the
--   non-NULL player_action values in id order. It is stored ONLY for the
--   EDIT/REGEN feature (re-feed the same action → a new passage); it is NOT
--   what the LLM reads for context. Drop it if regen never ships.
-- ============================================================
CREATE TABLE IF NOT EXISTS transcript (
    id            INTEGER PRIMARY KEY,
    chapter_id    INTEGER NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
    player_action TEXT,                            -- seed that produced this passage; NULL = scene-setting
    content       TEXT    NOT NULL,                -- the passage itself (prose); what the LLM reads
    tokens        INTEGER,                         -- optional, for context budgeting
    created_by    TEXT    NOT NULL DEFAULT 'local',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_transcript_after_update
AFTER UPDATE ON transcript
BEGIN
    UPDATE transcript SET last_updated = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_transcript_chapter ON transcript (chapter_id);
