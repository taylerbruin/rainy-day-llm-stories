-- ============================================================
-- 005_location_association — stable NPC→place affiliation
-- Drives density-per-location (3–8 associated chars each).
-- Composite PK: a character can be affiliated with several places.
-- ============================================================
CREATE TABLE IF NOT EXISTS location_association (
    character_id INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
    place_id     INTEGER NOT NULL REFERENCES place(id)     ON DELETE CASCADE,
    created_by   TEXT    NOT NULL DEFAULT 'local',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (character_id, place_id)
);

CREATE TRIGGER IF NOT EXISTS trg_location_association_after_update
AFTER UPDATE ON location_association
BEGIN
    UPDATE location_association SET last_updated = datetime('now')
    WHERE character_id = NEW.character_id AND place_id = NEW.place_id;
END;

CREATE INDEX IF NOT EXISTS idx_location_association_place ON location_association (place_id);
