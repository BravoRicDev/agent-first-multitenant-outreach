ALTER TABLE email_queue ADD CONSTRAINT fk_email_queue_smtp_account
  FOREIGN KEY (smtp_account_id) REFERENCES smtp_accounts(id);
