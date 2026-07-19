import { describe, expect, it, vi } from "vitest";
import { runScheduledSync } from "../src/sync/scheduler.js";

describe("scheduled sync", () => {
  it("runs immediately and repeats at the configured interval", async () => {
    vi.useFakeTimers();
    const runs: number[] = [];
    const controller = new AbortController();
    const scheduled = runScheduledSync({
      intervalMinutes: 2,
      signal: controller.signal,
      run: async () => {
        runs.push(Date.now());
      }
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toHaveLength(2);

    controller.abort();
    await scheduled;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toHaveLength(2);
    vi.useRealTimers();
  });

  it("reports failures and keeps scheduling later runs", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const errors: string[] = [];
    const controller = new AbortController();
    const scheduled = runScheduledSync({
      intervalMinutes: 1,
      signal: controller.signal,
      run: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary remote failure");
        }
      },
      onError: (error) => {
        errors.push(error.message);
      }
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(2);
    expect(errors).toEqual(["temporary remote failure"]);

    controller.abort();
    await scheduled;
    vi.useRealTimers();
  });

  it("rejects zero or negative intervals", async () => {
    await expect(
      runScheduledSync({
        intervalMinutes: 0,
        signal: new AbortController().signal,
        run: async () => undefined
      })
    ).rejects.toThrow("positive");
  });
});
