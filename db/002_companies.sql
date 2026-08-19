CREATE TABLE companies (
    id                      SERIAL PRIMARY KEY,
    position                TEXT,
    title                   TEXT,
    address                 TEXT,
    latitude                TEXT,
    longitude               TEXT,
    rating                  TEXT,
    rating_count            TEXT,
    category                TEXT,
    phone_number            TEXT,
    website                 TEXT,
    booking_links           TEXT,
    cid                     TEXT,
    via                     TEXT,
    cap                     TEXT,
    comune                  TEXT,
    provincia               TEXT,
    email                   TEXT,
    nome_studio             TEXT,
    nome_azienda            TEXT,
    descrizione             TEXT,
    altre_pagine_rilevanti  TEXT,
    bozza_email             TEXT,
    bozza_email_oggetto     TEXT,
    approvato               BOOLEAN DEFAULT false,
    inviato                 BOOLEAN DEFAULT false,
    bozza_creata            BOOLEAN DEFAULT false,
    bozza_rifai             BOOLEAN DEFAULT false,
    foglio_google_riga      DOUBLE PRECISION,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

DROP INDEX IF EXISTS idx_companies_website;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_website_lower ON companies(LOWER(website)) WHERE website IS NOT NULL AND website != '';
CREATE INDEX IF NOT EXISTS idx_companies_website ON companies(website) WHERE website IS NOT NULL AND website != '';

CREATE INDEX idx_companies_comune ON companies(comune);
CREATE INDEX idx_companies_email ON companies(email);
CREATE INDEX idx_companies_approvato ON companies(approvato);
CREATE INDEX idx_companies_bozza_creata ON companies(bozza_creata);
