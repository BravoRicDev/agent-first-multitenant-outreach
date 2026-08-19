CREATE TABLE municipalities (
    id                      SERIAL PRIMARY KEY,
    codice_istat            DOUBLE PRECISION,
    denominazione_ita_altra TEXT,
    cap                     DOUBLE PRECISION,
    ripartizione_geografica TEXT,
    denominazione_regione   TEXT,
    denominazione_provincia TEXT,
    sigla_provincia         TEXT,
    ultima_lavorazione      TEXT,
    eseguito                BOOLEAN DEFAULT false,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_municipalities_eseguito ON municipalities(eseguito);
CREATE INDEX idx_municipalities_provincia ON municipalities(sigla_provincia);
