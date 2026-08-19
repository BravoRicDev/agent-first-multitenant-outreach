INSERT INTO settings (key, value) VALUES ('scraper_allowed_domains', '*.it,*.eu,*.ch,*.fr,*.at')
ON CONFLICT (key) DO NOTHING;
