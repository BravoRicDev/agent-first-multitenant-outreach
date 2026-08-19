import { ZodError } from "zod";

export function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          error: "Validazione fallita",
          details: err.errors.map(e => ({ field: e.path.join("."), message: e.message })),
        });
      }
      next(err);
    }
  };
}
