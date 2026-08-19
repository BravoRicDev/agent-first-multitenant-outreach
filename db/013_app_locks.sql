CREATE TABLE IF NOT EXISTS app_locks (
    name        TEXT PRIMARY KEY,
    locked_at   TIMESTAMPTZ DEFAULT NOW(),
    ttl_seconds INTEGER DEFAULT 300,
    instance_id TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_app_locks_locked_at ON app_locks(locked_at);
