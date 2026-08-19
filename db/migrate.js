import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query, getClient } from "../src/db.js";
import { logger } from "../src/services/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await query(`
  CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    executed_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith(".sql"))
  .sort();

for (const file of files) {
  const { rows } = await query("SELECT 1 FROM migrations WHERE name = $1", [file]);
  if (rows.length > 0) {
    logger.info(`Migration ${file} già eseguita, skip`);
    continue;
  }

  const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    logger.info(`Migration ${file} eseguita con successo`);
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error(`Migration ${file} fallita: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

logger.info("Tutte le migrazioni completate");
process.exit(0);
