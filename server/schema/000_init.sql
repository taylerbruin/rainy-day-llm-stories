-- ============================================================
-- 000_init — connection pragmas (applied first, always)
-- ============================================================
-- journal_mode = WAL is PERSISTENT (written into the .sqlite file).
-- foreign_keys is PER-CONNECTION (default OFF in SQLite!) — the
-- server must also set this on every open, not rely on this file.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
