import { parse } from "csv-parse/sync";
import { query, getClient } from "../db.js";
import { logger } from "./logger.js";
import { normalize } from "./phone-normalizer.js";

const VALID_COLUMNS = [
  'title', 'address', 'via', 'cap', 'comune', 'provincia',
  'latitude', 'longitude', 'rating', 'rating_count',
  'phone_number', 'website', 'email', 'nome_studio',
  'nome_azienda', 'descrizione', 'category',
];

export async function importCsvFromText(csvText, columnMapping, userId, campaignId = null, tenantId = null) {
  if (!tenantId) {
    throw new TypeError("tenantId is required (multi-tenant is now mandatory)");
  }

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: [',', ';', '\t'],
    relax_column_count: true,
  });

  let imported = 0;
  let skipped = 0;
  let errors = [];
  let totalRecords = records.length;
  const BATCH_SIZE = 50;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const client = await getClient();
    try {
      await client.query("BEGIN");

      for (const row of batch) {
        await client.query("SAVEPOINT row_sp");
        try {
          const company = {};
          let hasData = false;

          for (const [csvCol, dbCol] of Object.entries(columnMapping)) {
            if (dbCol && VALID_COLUMNS.includes(dbCol) && row[csvCol] && row[csvCol].trim()) {
              company[dbCol] = row[csvCol].trim();
              hasData = true;
            }
          }

          if (!hasData) {
            await client.query("RELEASE SAVEPOINT row_sp");
            skipped++;
            continue;
          }

          // Validazione email e website
          if (company.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(company.email)) {
            delete company.email;
          }
          if (company.website && !/^https?:\/\/[^\s]+$/.test(company.website)) {
            delete company.website;
          }

          const dedupField = company.website ? 'website' : (company.email ? 'email' : null);
          const dedupValue = dedupField ? company[dedupField] : null;

          if (dedupField && dedupValue) {
            const condition = dedupField === 'website' ? `LOWER(website) = LOWER($1)` : `LOWER(${dedupField}) = LOWER($1)`;
            const existing = await client.query(
              `SELECT id FROM companies WHERE ${condition} LIMIT 1`,
              [dedupValue]
            );
            if (existing.rows.length > 0) {
              if (Object.keys(company).length > 0) {
                const setClauses = [];
                const updateParams = [];
                let pIdx = 1;
                for (const [col, val] of Object.entries(company)) {
                  if (col !== dedupField && col !== 'campaign_id') {
                    setClauses.push(`${col} = $${pIdx++}`);
                    updateParams.push(val);
                  }
                }
                setClauses.push("updated_at = NOW()");
                // Aggiungi campaign_id se fornito
                if (campaignId) {
                  setClauses.push(`campaign_id = $${pIdx++}`);
                  updateParams.push(campaignId);
                }
                updateParams.push(dedupValue);
                updateParams.push(tenantId);
                pIdx++;
                const whereClause = dedupField === 'website' ? `LOWER(website) = LOWER($${pIdx})` : `LOWER(${dedupField}) = LOWER($${pIdx})`;
                const tenantScope = ` AND tenant_id = $${pIdx + 1}`;
                await client.query(
                  `UPDATE companies SET ${setClauses.join(", ")} WHERE ${whereClause}${tenantScope}`,
                  updateParams
                );
              }
              await client.query("RELEASE SAVEPOINT row_sp");
              skipped++;
              continue;
            }
          }

          // Deduplica per telefono
          if (company.phone_number) {
            const phoneNorm = normalize(company.phone_number);
            if (phoneNorm) {
              const existingPhone = await client.query("SELECT id FROM companies WHERE phone_normalized = $1 LIMIT 1", [phoneNorm]);
              if (existingPhone.rows.length > 0) {
                await client.query("RELEASE SAVEPOINT row_sp");
                skipped++;
                continue;
              }
            }
          }

          const columns = [];
          const values = [];
          let pIdx = 1;

          for (const [col, val] of Object.entries(company)) {
            if (VALID_COLUMNS.includes(col)) {
              columns.push(col);
              values.push(val);
              pIdx++;
            }
          }

          // Calcola phone_normalized se phone_number presente
          let extraCols = [], extraVals = [];
          if (company.phone_number) {
            const pn = normalize(company.phone_number);
            if (pn) { extraCols.push('phone_normalized'); extraVals.push(pn); }
          }
          if (campaignId) { extraCols.push('campaign_id'); extraVals.push(campaignId); }
          extraCols.push('tenant_id'); extraVals.push(tenantId);
          const cols = [...columns, ...extraCols];
          const vals = [...values, ...extraVals];
          const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");

          await client.query(
            `INSERT INTO companies (${cols.join(", ")}, created_at, updated_at) VALUES (${placeholders}, NOW(), NOW())`,
            vals
          );
          await client.query("RELEASE SAVEPOINT row_sp");
          imported++;
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT row_sp");
          errors.push({ row: i + batch.indexOf(row), error: err.message });
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      errors.push({ batch: i, error: err.message });
    } finally {
      client.release();
    }
  }

  if (imported > 0 && userId) {
    await query(
      `INSERT INTO audit_log (user_id, action, resource, details)
       VALUES ($1, 'import_csv', 'companies', $2)`,
      [userId, JSON.stringify({ imported, skipped, totalRecords, errors: errors.length })]
    );
  }

  return { imported, skipped, errors, total: totalRecords };
}
