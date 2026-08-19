CREATE TABLE IF NOT EXISTS bug_reports (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    categoria TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    browser_info TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'aperto'
        CHECK (status IN ('aperto','in_lavorazione','risolto','chiuso')),
    priority TEXT NOT NULL DEFAULT 'normale'
        CHECK (priority IN ('bassa','normale','alta','critica')),
    note_sviluppatore TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
