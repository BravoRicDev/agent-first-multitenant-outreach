import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { query } from "../../src/db.js";

// Mock the db module
vi.mock("../../src/db.js", () => ({
  query: vi.fn(),
}));

// Re-import after mocking
const { acquireLock, releaseLock, withLock } = await import("../../src/services/locks.js");

describe("locks", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("acquireLock returns true when lock is acquired", async () => {
    query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
    const result = await acquireLock("test", 60);
    expect(result).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO app_locks"), expect.any(Array));
  });

  it("acquireLock returns false when lock is not acquired", async () => {
    query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    const result = await acquireLock("test", 60);
    expect(result).toBe(false);
  });

  it("acquireLock returns false on error", async () => {
    query.mockRejectedValueOnce(new Error("DB error"));
    const result = await acquireLock("test", 60);
    expect(result).toBe(false);
  });

  it("releaseLock calls DELETE", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await releaseLock("test");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM app_locks"), expect.any(Array));
  });

  it("withLock executes fn when lock acquired", async () => {
    query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const fn = vi.fn();
    const result = await withLock("test", fn, 60);
    expect(result).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("withLock skips fn when lock not acquired", async () => {
    query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    const fn = vi.fn();
    const result = await withLock("test", fn, 60);
    expect(result).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
