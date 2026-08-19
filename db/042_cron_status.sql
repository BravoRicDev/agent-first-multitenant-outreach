CREATE TABLE IF NOT EXISTS cron_status (
    name TEXT PRIMARY KEY,
    last_run_at TIMESTAMPTZ,
    last_duration_seconds INT,
    last_error TEXT
);
