-- Tabella per salvare l'ultimo UID IMAP processato per account
CREATE TABLE IF NOT EXISTS imap_state (
  account_id INT PRIMARY KEY REFERENCES smtp_accounts(id) ON DELETE CASCADE,
  last_uid INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
