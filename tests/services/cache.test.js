import { describe, it, expect, vi } from "vitest";
import { query } from "../../src/db.js";

vi.mock("../../src/db.js", () => ({
  query: vi.fn(),
}));

const { cacheGet, cacheSet, cacheClear } = await import("../../src/services/cache.js");

describe("cache", () => {
  afterAll(() => vi.restoreAllMocks());

  it("cacheGet returns value when found", async () => {
    query.mockResolvedValueOnce({ rows: [{ value: { data: "test" } }] });
    const result = await cacheGet("key1");
    expect(result).toEqual({ data: "test" });
  });

  it("cacheGet returns null when not found", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const result = await cacheGet("key_missing");
    expect(result).toBeNull();
  });

  it("cacheSet inserts with TTL", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await cacheSet("key2", { data: "hello" }, 3600);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO response_cache"),
      ["key2", JSON.stringify({ data: "hello" }), "3600 seconds"]
    );
  });

  it("cacheClear deletes by prefix", async () => {
    query.mockResolvedValueOnce({ rowCount: 5 });
    await cacheClear("test_");
    expect(query).toHaveBeenCalledWith("DELETE FROM response_cache WHERE key LIKE $1", ["test_%"]);
  });
});
