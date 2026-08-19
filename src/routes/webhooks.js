import { Router } from "express";

const router = Router();

// Webhook disabilitato — Listmonk è stato rimosso.
// Le email sono inviate direttamente via nodemailer e il tracking
// è gestito internamente via endpoint /track/open/:id e /track/click/:id.
router.post("/api/webhooks/listmonk", async (req, res) => {
  res.json({ success: false, message: "Listmonk non più in uso" });
});

export default router;
