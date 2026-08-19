import { query } from "../db.js";
import { logger } from "./logger.js";

export async function getTenantById(tenantId) {
  if (!tenantId || tenantId <= 0) return null;
  try {
    const result = await query("SELECT * FROM tenants WHERE id = $1", [tenantId]);
    return result.rows[0] || null;
  } catch (err) {
    logger.error("getTenantById error", { tenantId, error: err.message });
    throw err;
  }
}

export async function getTenantForTenantId(tenantId) {
  if (!tenantId || tenantId <= 0) return null;
  return getTenantById(tenantId);
}

export async function listTenants() {
  try {
    const result = await query(
      `SELECT id, name, site_id, is_active, daily_email_quota, test_mode, created_at, updated_at
       FROM tenants
       ORDER BY id ASC`
    );
    return result.rows;
  } catch (err) {
    logger.error("listTenants error", { error: err.message });
    throw err;
  }
}

export async function createTenant(name, siteId = null, dailyEmailQuota = null, testMode = false) {
  try {
    const result = await query(
      `INSERT INTO tenants (name, site_id, daily_email_quota, test_mode, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id, name, site_id, is_active, daily_email_quota, test_mode, created_at, updated_at`,
      [name, siteId, dailyEmailQuota, testMode]
    );
    const tenant = result.rows[0];
    logger.info("Created tenant", { tenantId: tenant.id, name });
    return tenant;
  } catch (err) {
    logger.error("createTenant error", { name, error: err.message });
    throw err;
  }
}

export async function toggleTenantActive(tenantId, isActive) {
  if (!tenantId || tenantId <= 0) {
    throw new Error("Invalid tenantId");
  }
  try {
    const result = await query(
      `UPDATE tenants SET is_active = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, site_id, is_active, daily_email_quota, test_mode, created_at, updated_at`,
      [isActive, tenantId]
    );
    if (result.rows.length === 0) {
      throw new Error("Tenant not found");
    }
    const tenant = result.rows[0];
    logger.info("Toggled tenant active state", { tenantId, is_active: tenant.is_active });
    return tenant;
  } catch (err) {
    logger.error("toggleTenantActive error", { tenantId, error: err.message });
    throw err;
  }
}

export async function updateTenantQuota(tenantId, dailyEmailQuota) {
  if (!tenantId || tenantId <= 0) {
    throw new Error("Invalid tenantId");
  }
  try {
    const result = await query(
      `UPDATE tenants SET daily_email_quota = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, site_id, is_active, daily_email_quota, test_mode, created_at, updated_at`,
      [dailyEmailQuota, tenantId]
    );
    if (result.rows.length === 0) {
      throw new Error("Tenant not found");
    }
    const tenant = result.rows[0];
    logger.info("Updated tenant quota", { tenantId, quota: tenant.daily_email_quota });
    return tenant;
  } catch (err) {
    logger.error("updateTenantQuota error", { tenantId, error: err.message });
    throw err;
  }
}

export async function updateTenantTestMode(tenantId, testMode) {
  if (!tenantId || tenantId <= 0) {
    throw new Error("Invalid tenantId");
  }
  try {
    const result = await query(
      `UPDATE tenants SET test_mode = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, site_id, is_active, daily_email_quota, test_mode, created_at, updated_at`,
      [testMode, tenantId]
    );
    if (result.rows.length === 0) {
      throw new Error("Tenant not found");
    }
    const tenant = result.rows[0];
    logger.info("Updated tenant test_mode", { tenantId, test_mode: tenant.test_mode });
    return tenant;
  } catch (err) {
    logger.error("updateTenantTestMode error", { tenantId, error: err.message });
    throw err;
  }
}

export async function isTenantActive(tenantId) {
  if (!tenantId || tenantId <= 0) return true;
  try {
    const tenant = await getTenantById(tenantId);
    return tenant ? tenant.is_active : true;
  } catch (err) {
    logger.error("isTenantActive error", { tenantId, error: err.message });
    return true;
  }
}

export async function getTenantQuota(tenantId) {
  if (!tenantId || tenantId <= 0) return null;
  try {
    const tenant = await getTenantById(tenantId);
    return tenant ? tenant.daily_email_quota : null;
  } catch (err) {
    logger.error("getTenantQuota error", { tenantId, error: err.message });
    return null;
  }
}

export async function isTenantTestMode(tenantId) {
  if (!tenantId || tenantId <= 0) return false;
  try {
    const tenant = await getTenantById(tenantId);
    return tenant ? tenant.test_mode : false;
  } catch (err) {
    logger.error("isTenantTestMode error", { tenantId, error: err.message });
    return false;
  }
}
