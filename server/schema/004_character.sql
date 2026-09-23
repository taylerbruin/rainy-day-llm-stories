-- ============================================================
-- 004_character — spec sheets (canon, not rules). Tiers drive detail.
--   tier 1 = protagonist spine (always in context)
--   tier 2 = party / companions / optional love interest
--   tier 3 = NPCs / walk-ons (light sheet)
-- Two-axis location:
--   AFFILIATION (stable) → location_association (where they belong)
--   POSITION  (live)     → current_location_id (where they are now;
--                          committed at chapter close, not mid-chapter)
-- ============================================================
CREATE TABLE IF NOT EXISTS character (
    id                    INTEGER PRIMARY KEY,
    world_id              INTEGER NOT NULL REFERENCES world(id) ON DELETE CASCADE,
    name                  TEXT    NOT NULL,
    tier                  INTEGER NOT NULL DEFAULT 3 CHECK (tier IN (1, 2, 3)),
    role                  TEXT,                   -- protagonist / ally / antagonist / bystander ...
    summary               TEXT,                   -- who they are, one paragraph
    skills                JSON,                   -- string[] — free-text, transferable
    traits                JSON,                   -- string[] — personality / habits / motivations
    current_location_id   INTEGER REFERENCES place(id) ON DELETE SET NULL,  -- LIVE
    is_love_interest      INTEGER NOT NULL DEFAULT 0,                          -- 0/1 bool
    status                TEXT,                   -- free-form: active / absent / ...
    -- (per-chapter involvement now lives in chapter_character, 008 — not a JSON blob)
    created_by            TEXT    NOT NULL DEFAULT 'local',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_character_after_update
AFTER UPDATE ON character
BEGIN
    UPDATE character SET last_updated = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_character_world    ON character (world_id);
CREATE INDEX IF NOT EXISTS idx_character_location ON character (current_location_id);
