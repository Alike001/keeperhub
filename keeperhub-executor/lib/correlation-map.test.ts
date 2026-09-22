import { beforeEach, describe, expect, it, vi } from "vitest";

const { trackLatency, peekLatency, takeLatency, clearLatencyMap } = await import(
  "./correlation-map"
);
const { ExecutionLatency } = await import("../latency");

beforeEach(() => {
  clearLatencyMap();
});

describe("correlation map", () => {
  it("tracks and peeks without removing", () => {
    const latency = new ExecutionLatency("corr-a");
    trackLatency(latency);
    expect(peekLatency("corr-a")).toBe(latency);
    expect(peekLatency("corr-a")).toBe(latency); // still there
  });

  it("take removes the entry", () => {
    const latency = new ExecutionLatency("corr-b");
    trackLatency(latency);
    expect(takeLatency("corr-b")).toBe(latency);
    expect(peekLatency("corr-b")).toBeUndefined();
    expect(takeLatency("corr-b")).toBeUndefined();
  });

  it("returns undefined for unknown ids", () => {
    expect(peekLatency("nope")).toBeUndefined();
    expect(takeLatency("nope")).toBeUndefined();
  });

  it("evicts the oldest entry at the cap instead of growing unbounded", async () => {
    // Re-import with a tiny cap via module state: the cap is a module
    // constant, so exercise the real one cheaply by tracking cap+1 entries.
    const capModule = await import("./correlation-map");
    const { MAX_TRACKED } = (capModule as unknown as {
      MAX_TRACKED?: number;
    }) as { MAX_TRACKED?: number };
    const limit = MAX_TRACKED ?? 1024;
    const first = new ExecutionLatency("corr-first");
    trackLatency(first);
    for (let i = 0; i < limit; i++) {
      trackLatency(new ExecutionLatency(`corr-${i}`));
    }
    // The oldest was evicted; the newest survive.
    expect(peekLatency("corr-first")).toBeUndefined();
    expect(peekLatency(`corr-${limit - 1}`)).toBeDefined();
  });

  it("drops an entry older than the exported age bound on the next track", async () => {
    // The hour bound, exercised through the exported constant. The age scan
    // is throttled to once per minute on the track path, so the test crosses
    // the throttle with the system clock: the first track inserts the stale
    // entry (the scan fires on an empty map and must not remove it early),
    // time advances past the throttle, and the next track's scan - finding
    // an entry whose received stamp predates MAX_TRACKED_AGE_MS - drops it.
    vi.useFakeTimers();
    try {
      const { MAX_TRACKED_AGE_MS } = await import("./correlation-map");
      const stale = new ExecutionLatency("corr-stale");
      stale.mark("received", Date.now() - MAX_TRACKED_AGE_MS - 60_000);
      trackLatency(stale);
      expect(peekLatency("corr-stale")).toBe(stale); // inserted, not yet scanned

      vi.setSystemTime(Date.now() + 61_000); // past the scan throttle
      const fresh = new ExecutionLatency("corr-fresh");
      trackLatency(fresh);
      expect(peekLatency("corr-stale")).toBeUndefined();
      expect(peekLatency("corr-fresh")).toBe(fresh);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an entry younger than the age bound across a scan", () => {
    // Guard on the other edge: the scan fires on this track too (the
    // throttle was reset by beforeEach via clearLatencyMap), and a young
    // entry must survive it - the bound reclaims never-dispatched runs,
    // not slow ones.
    const young = new ExecutionLatency("corr-young");
    young.mark("received", Date.now() - 1_000);
    trackLatency(young);
    trackLatency(new ExecutionLatency("corr-trigger-scan"));
    expect(peekLatency("corr-young")).toBe(young);
  });
});
