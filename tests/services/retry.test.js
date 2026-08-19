import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../src/services/retry.js";

describe("withRetry", () => {
  it("resolves on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error then succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { status: 429 }))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10, maxDelay: 100 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries", async () => {
    const err = Object.assign(new Error("timeout"), { status: 503 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 10, maxDelay: 100 })).rejects.toThrow("timeout");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("bad request"));
    await expect(withRetry(fn)).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
