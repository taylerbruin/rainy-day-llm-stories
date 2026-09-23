-- ============================================================
-- 003_place — location sheets (may be very small; optional layout)
-- ============================================================
CREATE TABLE IF NOT EXISTS place (
    id             INTEGER PRIMARY KEY,
    world_id       INTEGER NOT NULL REFERENCES world(id) ON DELETE CASCADE,
    name           TEXT    NOT NULL,
    description    TEXT,
    starting_mood  TEXT,   -- established at worldgen; immutable canon (e.g. "bustling, rain-slicked")
    current_mood   TEXT,   -- LIVE: committed at chapter close (e.g. "panicked" during dragon attack)
    layout         JSON,   -- optional structured map (rooms/exits/notables)
    created_by     TEXT    NOT NULL DEFAULT 'local',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_place_after_update
AFTER UPDATE ON place
BEGIN
    UPDATE place SET last_updated = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_place_world ON place (world_id);
