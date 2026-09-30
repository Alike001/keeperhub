import { beforeEach, describe, expect, it, vi } from "vitest";
import { observePythPrice } from "@/lib/pyth/observe-price";

const { checkDispatchAdmission } = vi.hoisted(() => ({
  checkDispatchAdmission: vi.fn(),
}));
vi.mock("@/lib/billing/dispatch-admission", () => ({ checkDispatchAdmission }));

const workflowRow = { organizationId: "org-test", nodes: [{ id: "trigger" }] };
const where = vi.fn();
const transaction = vi.fn();
const database = {
  select: () => ({ from: () => ({ where }) }),
  transaction,
} as unknown as Parameters<typeof observePythPrice>[2];
const request = new Request("http://localhost/api/internal/pyth-triggers", {
  method: "POST",
});
const identity = {
  workflowId: "workflow-test",
  configHash: "b".repeat(64),
  sessionId: "00000000-0000-4000-8000-000000000000",
};

beforeEach(() => {
  vi.clearAllMocks();
  where.mockResolvedValue([workflowRow]);
  transaction.mockResolvedValue({ outcome: "inactive" });
  checkDispatchAdmission.mockResolvedValue(null);
});

describe("Pyth observation admission", () => {
  it("resolves plan admission before the transaction takes its connection", async () => {
    await observePythPrice(
      {
        ...identity,
        action: "observe",
        update: {
          id: "a".repeat(64),
          price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
        },
      },
      request,
      database
    );
    expect(checkDispatchAdmission).toHaveBeenCalledWith(workflowRow);
    expect(checkDispatchAdmission.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0]
    );
  });

  it.each([
    { ...identity, action: "pending" as const },
    { ...identity, action: "ack" as const, executionId: "execution-test" },
  ])(
    "skips admission for $action, which never creates a run",
    async (command) => {
      await observePythPrice(command, request, database);
      expect(where).not.toHaveBeenCalled();
      expect(checkDispatchAdmission).not.toHaveBeenCalled();
      expect(transaction).toHaveBeenCalledTimes(1);
    }
  );
});
