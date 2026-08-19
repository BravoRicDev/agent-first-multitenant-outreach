CREATE TABLE IF NOT EXISTS blacklist_patterns (
  id SERIAL PRIMARY KEY,
  pattern TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  blocked_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by INT REFERENCES users(id)
);

INSERT INTO blacklist_patterns (pattern, description) VALUES
  ('\\[Nome Azienda\\]', 'Placeholder generico'),
  ('\\[Inserisci Oggetto\\]', 'Placeholder oggetto'),
  ('\\{\\{azienda\\}\\}', 'Variabile template'),
  ('\\[Il tuo nome\\]', 'Placeholder nome'),
  ('\\[Nome Cognome\\]', 'Placeholder nome cognome'),
  ('\\[Tua Posizione\\]', 'Placeholder posizione'),
  ('Come modello linguistico', 'Frase AI generica'),
  ('Ecco un''opzione', 'Frase AI opzione'),
  ('Certamente, ecco la bozza', 'Frase AI bozza'),
  ('As an AI', 'Frase AI inglese'),
  ('Spero che questa email', 'Frase AI spero'),
  ('Lorem ipsum', 'Testo fittizio'),
  ('Hello world', 'Testo fittizio'),
  ('```json', 'Code fence'),
  ('```', 'Code fence'),
  ('^\\s*Test\\s*$', 'Sola parola Test'),
  ('^\\s*test\\s*$', 'Sola parola test')
ON CONFLICT DO NOTHING;
