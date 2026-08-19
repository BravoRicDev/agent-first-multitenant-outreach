import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().email("Email non valida"),
});

export const verifySchema = z.object({
  token: z.string().min(10, "Token non valido").max(200, "Token non valido").optional(),
  otp: z.string().length(6, "OTP deve essere di 6 cifre").optional(),
}).refine(data => data.token || data.otp, { message: "Token o OTP richiesto" });

export const scraperUrlSchema = z.object({
  url: z.string().url("URL non valido"),
});

export const scraperExtractSchema = z.object({
  website: z.string().url("URL non valido"),
  companyId: z.coerce.number().int().positive().optional(),
});

export const companyUpdateSchema = z.object({
  inviato: z.boolean().optional(),
  bozza_rifai: z.boolean().optional(),
  bozza_email: z.string().max(50000, "Email troppo lunga").optional(),
  bozza_email_oggetto: z.string().max(500, "Oggetto troppo lungo").optional(),
  email: z.string().trim().email().optional(),
}).strict();

export const createUserSchema = z.object({
  name: z.string().min(1, "Nome richiesto").max(100),
  surname: z.string().max(100).optional().default(""),
  email: z.string().trim().email("Email non valida"),
  role: z.enum(["superadmin", "admin", "collaboratore"]).optional().default("collaboratore"),
});

export const updateUserSchema = z.object({
  role: z.enum(["superadmin", "admin", "collaboratore"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: "Almeno un campo richiesto (role o status)",
});

export const campaignBatchSchema = z.object({
  provincia: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  delay_seconds: z.coerce.number().int().min(1).max(60).optional().default(3),
});
