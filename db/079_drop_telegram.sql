-- 079: Rimuove l'integrazione Telegram (bot, notifiche, login, preferenze).
--
-- Il bot Telegram non serve piu': droppa le tabelle orfane create dalle
-- migrazioni storiche 005/006/020 (che restano come archivio, non vengono
-- eliminate). Nessuna altra tabella referenzia queste, ma si usa CASCADE
-- per sicurezza.
BEGIN;

DROP TABLE IF EXISTS telegram_notification_prefs CASCADE;
DROP TABLE IF EXISTS telegram_pairs CASCADE;
DROP TABLE IF EXISTS telegram_login_tokens CASCADE;

COMMIT;
