import express from "express";
import { SUPPORTED_LANGS } from "../middleware/i18n.js";

const router = express.Router();

router.post("/api/i18n/lang", (req, res) => {
  const { lang } = req.body || {};

  if (!lang || !SUPPORTED_LANGS.includes(lang)) {
    return res.status(400).json({ error: "Lingua non supportata" });
  }

  res.cookie("lang", lang, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 anno
  });

  res.json({ ok: true, lang });
});

export default router;
