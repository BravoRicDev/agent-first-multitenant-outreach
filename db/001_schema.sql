CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    surname         VARCHAR(255) NOT NULL DEFAULT '',
    email           VARCHAR(255) NOT NULL UNIQUE,
    role            VARCHAR(50) NOT NULL DEFAULT 'collaboratore'
                    CHECK (role IN ('superadmin','admin','collaboratore')),
    status          VARCHAR(20) DEFAULT 'active'
                    CHECK (status IN ('active','disabled')),
    notify_telegram_reports BOOLEAN DEFAULT false,
    notify_email_reports    BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE roles_permissions (
    id              SERIAL PRIMARY KEY,
    role            VARCHAR(50) NOT NULL,
    resource        VARCHAR(100) NOT NULL,
    can_create      BOOLEAN DEFAULT false,
    can_read        BOOLEAN DEFAULT false,
    can_update      BOOLEAN DEFAULT false,
    can_delete      BOOLEAN DEFAULT false,
    UNIQUE(role, resource)
);

CREATE TABLE magic_links (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token           VARCHAR(255) NOT NULL UNIQUE,
    otp             VARCHAR(6) NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token);
CREATE INDEX IF NOT EXISTS idx_magic_links_user ON magic_links(user_id);

CREATE TABLE settings (
    key             VARCHAR(255) PRIMARY KEY,
    value           TEXT,
    category        VARCHAR(100) DEFAULT 'general',
    description     TEXT,
    sensitive       BOOLEAN DEFAULT false,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_by      INTEGER REFERENCES users(id)
);

CREATE TABLE audit_log (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id),
    action          VARCHAR(50) NOT NULL,
    resource        VARCHAR(100) NOT NULL,
    resource_id     INTEGER,
    details         JSONB,
    ip_address      VARCHAR(45),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE telegram_pairs (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id         BIGINT,
    code            VARCHAR(10),
    paired          BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);
