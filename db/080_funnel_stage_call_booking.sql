-- 080: Tracciamento "setting telefonico" + booking videocall + avanzamento
-- funnel B2B lato outreach.
--
-- Il funnel di riferimento (vedi GAP-ANALYSIS-FUNNEL.md, cartella padre):
--   prospect -> contacted -> called -> booked -> demo -> won/lost
-- L'outreach copre gli stadi fino al booking; vendita/demo/won-lost restano di
-- competenza del CMS (pipeline/opportunities). Qui teniamo solo uno stato
-- sintetico lato outreach per sapere "a che punto è" un prospect senza dover
-- interrogare il CMS ad ogni richiesta, e per far avanzare/creare l'opportunità
-- CMS quando un contatto telefonico o un booking hanno esito positivo.
BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS funnel_stage VARCHAR(20) NOT NULL DEFAULT 'prospect'
  CHECK (funnel_stage IN ('prospect','contacted','called','booked','demo','won','lost'));

-- Esito del "setting telefonico" (chiamata a freddo dopo l'email di cold outreach).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS call_status VARCHAR(20)
  CHECK (call_status IN ('da_chiamare','non_risponde','richiamare','non_interessato','interessato'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS call_notes TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS call_outcome_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS next_call_at TIMESTAMPTZ;

-- Booking/esito della videocall (creata sul CMS calls/booking, non duplicato qui:
-- booking_link punta all'evento reale sul CMS/calendario).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_status VARCHAR(20)
  CHECK (booking_status IN ('da_prenotare','prenotato','effettuata','no_show','annullata'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_notes TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_link TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_funnel_stage ON companies(funnel_stage);
CREATE INDEX IF NOT EXISTS idx_companies_call_status ON companies(call_status);
CREATE INDEX IF NOT EXISTS idx_companies_next_call_at ON companies(next_call_at) WHERE next_call_at IS NOT NULL;

COMMIT;
