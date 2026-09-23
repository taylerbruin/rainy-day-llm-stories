-- ============================================================
-- 002_world — world identity (created by the world generator wizard)
-- ============================================================
CREATE TABLE IF NOT EXISTS world (
    id           INTEGER PRIMARY KEY,             -- auto-increment
    name         TEXT    NOT NULL,
    description  TEXT,
    tags         JSON,                             -- string[] — app-side filtering, not model
    tone         TEXT,
    era          TEXT,
    created_by   TEXT    NOT NULL DEFAULT 'local',-- placeholder identity (no DB users in SQLite)
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_updated TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- SQLite has no ON UPDATE CURRENT_TIMESTAMP; this trigger keeps
-- last_updated honest on every UPDATE (recursive_triggers is OFF
-- by default, so the trigger's own UPDATE does not re-fire it).
CREATE TRIGGER IF NOT EXISTS trg_world_after_update
AFTER UPDATE ON world
BEGIN
    UPDATE world SET last_updated = datetime('now') WHERE id = NEW.id;
END;
