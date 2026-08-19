import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { query } from "../../src/db.js";

vi.mock("../../src/db.js", () => ({
  query: vi.fn(),
}));

const {
  getTenantById,
  getTenantForTenantId,
  listTenants,
  createTenant,
  toggleTenantActive,
  updateTenantQuota,
  updateTenantTestMode,
  isTenantActive,
  getTenantQuota,
  isTenantTestMode,
} = await import("../../src/services/tenants.js");

describe("tenants.js", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("getTenantById", () => {
    it("returns tenant when found", async () => {
      const mockTenant = { id: 1, name: "Tenant 1", is_active: true, daily_email_quota: null, test_mode: false };
      query.mockResolvedValueOnce({ rows: [mockTenant] });
      const result = await getTenantById(1);
      expect(result).toEqual(mockTenant);
      expect(query).toHaveBeenCalledWith("SELECT * FROM tenants WHERE id = $1", [1]);
    });

    it("returns null when tenant not found", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      const result = await getTenantById(999);
      expect(result).toBeNull();
    });

    it("returns null for invalid tenantId", async () => {
      const result = await getTenantById(null);
      expect(result).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it("returns null for tenantId <= 0", async () => {
      const result = await getTenantById(0);
      expect(result).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("getTenantForTenantId", () => {
    it("calls getTenantById with tenantId", async () => {
      const mockTenant = { id: 5, name: "Tenant 5" };
      query.mockResolvedValueOnce({ rows: [mockTenant] });
      const result = await getTenantForTenantId(5);
      expect(result).toEqual(mockTenant);
    });
  });

  describe("listTenants", () => {
    it("returns all tenants", async () => {
      const mockTenants = [
        { id: 1, name: "Tenant 1", is_active: true },
        { id: 2, name: "Tenant 2", is_active: false },
      ];
      query.mockResolvedValueOnce({ rows: mockTenants });
      const result = await listTenants();
      expect(result).toEqual(mockTenants);
    });

    it("returns empty array when no tenants", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      const result = await listTenants();
      expect(result).toEqual([]);
    });
  });

  describe("createTenant", () => {
    it("creates tenant with all fields", async () => {
      const mockTenant = {
        id: 10,
        name: "New Tenant",
        site_id: 1,
        daily_email_quota: 1000,
        test_mode: false,
      };
      query.mockResolvedValueOnce({ rows: [mockTenant] });
      const result = await createTenant("New Tenant", 1, 1000, false);
      expect(result).toEqual(mockTenant);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO tenants"),
        ["New Tenant", 1, 1000, false]
      );
    });

    it("creates tenant with minimal fields", async () => {
      const mockTenant = {
        id: 11,
        name: "Simple Tenant",
        site_id: null,
        daily_email_quota: null,
        test_mode: false,
      };
      query.mockResolvedValueOnce({ rows: [mockTenant] });
      const result = await createTenant("Simple Tenant");
      expect(result).toEqual(mockTenant);
    });
  });

  describe("toggleTenantActive", () => {
    it("toggles tenant active state", async () => {
      const mockTenant = {
        id: 1,
        name: "Tenant 1",
        is_active: false,
        daily_email_quota: null,
        test_mode: false,
      };
      query.mockResolvedValueOnce({ rows: [mockTenant] });
      const result = await toggleTenantActive(1, false);
      expect(result).toEqual(mockTenant);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE tenants SET is_active"),
        [false, 1]
      );
    });

    it("throws error for invalid tenantId", async () => {
      await expect(toggleTenantActive(0, true)).rejects.toThrow("Invalid tenantId");
    });

    it("throws error when tenant not found", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await expect(toggleTenantActive(999, true)).rejects.toThrow("Tenant not found");
    });
  });

  describe("updateTenantQuota", () => {
    it("updates tenant quota", async () => {
      const mockTenant = {
        id: 1,
        name: "Tenant 1",
        daily_email_quota: 5000,
        test_mode: false,
      };
      query.mockResolvedValueOnce({ rows: [mockTenant] });
      const result = await updateTenantQuota(1, 5000);
      expect(result).toEqual(mockTenant);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE tenants SET daily_email_quota"),
        [5000, 1]
      );
    });

    it("updates quota to null (unlimited)", async () => {
      const mockTenant = {
        id: 1,
        name: "Tenant 1",
        daily_email_quota: null,
        test_mode: false,
      };
      query.mockResolvedValueOnce({ rows: [mockTenant] });
      const result = await updateTenantQuota(1, null);
      expect(result.daily_email_quota).toBeNull();
    });
  });

  describe("updateTenantTestMode", () => {
    it("updates tenant test_mode", async () => {
      const mockTenant = {
        id: 1,
        name: "Tenant 1",
        test_mode: true,
        is_active: true,
      };
      query.mockResolvedValueOnce({ rows: [mockTenant] });
      const result = await updateTenantTestMode(1, true);
      expect(result).toEqual(mockTenant);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE tenants SET test_mode"),
        [true, 1]
      );
    });
  });

  describe("isTenantActive", () => {
    it("returns true when tenant is active", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, is_active: true }] });
      const result = await isTenantActive(1);
      expect(result).toBe(true);
    });

    it("returns false when tenant is inactive", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, is_active: false }] });
      const result = await isTenantActive(1);
      expect(result).toBe(false);
    });

    it("returns true for null/0 tenantId (backward compat)", async () => {
      const result = await isTenantActive(null);
      expect(result).toBe(true);
    });
  });

  describe("getTenantQuota", () => {
    it("returns quota when set", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, daily_email_quota: 5000 }] });
      const result = await getTenantQuota(1);
      expect(result).toBe(5000);
    });

    it("returns null when quota is unlimited", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, daily_email_quota: null }] });
      const result = await getTenantQuota(1);
      expect(result).toBeNull();
    });

    it("returns null for null/0 tenantId", async () => {
      const result = await getTenantQuota(null);
      expect(result).toBeNull();
    });
  });

  describe("isTenantTestMode", () => {
    it("returns true when test_mode is on", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, test_mode: true }] });
      const result = await isTenantTestMode(1);
      expect(result).toBe(true);
    });

    it("returns false when test_mode is off", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, test_mode: false }] });
      const result = await isTenantTestMode(1);
      expect(result).toBe(false);
    });

    it("returns false for null/0 tenantId", async () => {
      const result = await isTenantTestMode(null);
      expect(result).toBe(false);
    });
  });
});
