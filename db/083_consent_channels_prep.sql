-- 083: Predisposizione consenso granulare per canale + base giuridica
-- (requisito 4). Solo campi PREPARATORI, retro-compatibili (default NULL,
-- nessuna riga esistente modificata, nessuna logica applicativa cambiata):
-- `consent_status` (cold/marketing) resta l'UNICA fonte di verità usata da
-- enforceConsent oggi. `consent_channels`/`consent_basis` sono lo schema di
-- destinazione per l'evoluzione descritta in SPEC-MULTITENANT-FUNNEL.md
-- (cartella padre) §Blueprint fase 2, allineato a contacts.pref_* del CMS
-- (pref_email/pref_sms/pref_phone/pref_whatsapp/pref_marketing).
BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS consent_channels JSONB;
COMMENT ON COLUMN companies.consent_channels IS
  'Consenso granulare per canale (non ancora applicato da enforceConsent), forma prevista: {"email":true,"sms":false,"phone":true,"whatsapp":false} — allineato a contacts.pref_* del CMS agent-first.';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS consent_basis VARCHAR(30)
  CHECK (consent_basis IS NULL OR consent_basis IN ('consent', 'legitimate_interest'));
COMMENT ON COLUMN companies.consent_basis IS
  'Base giuridica del consenso (GDPR): consent = consenso esplicito, legitimate_interest = interesse legittimo (default B2B cold outreach). Non ancora applicato da enforceConsent.';

COMMIT;
