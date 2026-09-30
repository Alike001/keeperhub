import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PythRegistry } from "../../src/pyth/registry";

const { consume, submit } = vi.hoisted(() => ({
  consume: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("../../src/pyth/hermes-stream", () => ({
  consumeHermesStream: consume,
}));
vi.mock("../../src/pyth/client", () => ({ submitPythObservation: submit }));
vi.mock("../../lib/utils/logger", () => ({ logger: { warn: vi.fn() } }));
const first = {
  workflowId: "first",
  feedId: "a".repeat(64),
  configHash: "b".repeat(64),
};
const second = { ...first, workflowId: "second" };
let registry: PythRegistry;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  consume.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  submit.mockResolvedValue(undefined);
  registry = new PythRegistry("test-only-key");
});
afterEach(async () => {
  await registry.stopAll();
  vi.useRealTimers();
});

describe("Pyth stream lifecycle", () => {
  it("shares one feed connection and isolates a failing workflow", async () => {
    await registry.reconcile([first, second]);
    expect(consume).toHaveBeenCalledTimes(1);
    const price = {
      id: first.feedId,
      price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
    };
    submit.mockRejectedValueOnce(new Error("first workflow unavailable"));
    await consume.mock.calls[0][0].onPrice(price);
    expect(submit.mock.calls.map((call) => call[0].workflowId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("recovers pending deliveries even when no price is arriving", async () => {
    await registry.reconcile([first]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(submit).toHaveBeenCalledWith(first, expect.any(String));
  });

  it("keeps its lease identity across reconnects and asks for a fresh baseline", async () => {
    consume.mockResolvedValueOnce(undefined);
    submit.mockResolvedValue("baseline");
    await registry.reconcile([first]);
    const price = {
      id: first.feedId,
      price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
    };
    await consume.mock.calls[0][0].onPrice(price);
    await vi.advanceTimersByTimeAsync(1500);
    expect(consume).toHaveBeenCalledTimes(2);
    const onPrice = consume.mock.calls[1][0].onPrice;
    await onPrice(price);
    submit.mockResolvedValue("observed");
    await onPrice(price);
    const sessions = submit.mock.calls.map((call) => call[1]);
    expect(new Set(sessions).size).toBe(1);
    expect(submit.mock.calls.map((call) => call[3])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("keeps requesting a baseline until the server records one", async () => {
    submit.mockResolvedValueOnce("out_of_order").mockResolvedValue("baseline");
    await registry.reconcile([first]);
    const price = {
      id: first.feedId,
      price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
    };
    const { onPrice } = consume.mock.calls[0][0];
    await onPrice(price);
    await onPrice(price);
    await onPrice(price);
    expect(submit.mock.calls.map((call) => call[3])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("does not create replacement streams if shutdown races with reconciliation", async () => {
    await registry.reconcile([first]);
    const reconciliation = registry.reconcile([
      { ...second, feedId: "c".repeat(64) },
    ]);
    await registry.stopAll();
    await reconciliation;
    await registry.reconcile([first]);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
