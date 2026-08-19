CREATE TABLE direzione (
    id                  SERIAL PRIMARY KEY,
    info_azienda        TEXT,
    cta                 TEXT,
    link_cta            TEXT,
    email_spunti        TEXT,
    email_template_bozza TEXT,
    correzione_prompt   TEXT,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_by          INTEGER REFERENCES users(id)
);

INSERT INTO direzione (info_azienda, cta, link_cta)
VALUES ('[Ragione sociale: servizio professionale generico]', 'GUARDA LA REGISTRAZIONE DEL WEBINAR', 'https://example.com/funnel-outreach');
