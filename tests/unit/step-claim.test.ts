import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedis, mockInsert, mockSelect, mockDelete } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockInsert: vi.fn(),
  mockSelect: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@/lib/db", () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
    delete: mockDelete,
  },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "WORKFLOW_ENGINE" },
  logInfo: vi.fn(),
  logSystemWarn: vi.fn(),
}));

import { stepClaimKey } from "@/lib/redis-keys";
import {
  acquireStepClaim,
  type StepClaimScope,
  stepClaimScope,
} from "@/lib/workflow/executor/step-claim";

const SCOPE: StepClaimScope = {
  executionId: "exec-1",
  nodeId: "node-1",
  forEachNodeId: "",
  iterationIndex: -1,
};

/** db.insert(...).values(...).onConflictDoUpdate(...).returning() */
function dbClaimReturns(rows: unknown[]): void {
  mockInsert.mockReturnValue({
    values: () => ({
      onConflictDoUpdate: () => ({ returning: () => Promise.resolve(rows) }),
    }),
  });
}

/** db.select(...).from(...).where(...).limit(1) */
function dbTerminalRowReturns(rows: unknown[]): void {
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
}

beforeEach(() => {
  mockGetRedis.mockReset();
  mockInsert.mockReset();
  mockSelect.mockReset();
  mockDelete.mockReset();
  dbTerminalRowReturns([]);
});

describe("stepClaimKey", () => {
  it("namespaces the key and includes the iteration coordinates", () => {
    expect(stepClaimKey("exec-1", "node-1", "loop-1", 3)).toBe(
      "local:step-claim:exec-1:node-1:loop-1:3"
    );
  });

  it("separates two iterations of the same body node", () => {
    expect(stepClaimKey("e", "n", "loop", 0)).not.toBe(
      stepClaimKey("e", "n", "loop", 1)
    );
  });
});

describe("stepClaimScope", () => {
  it("fills sentinels for a step outside a For Each body", () => {
    expect(
      stepClaimScope({ executionId: "exec-1", nodeId: "node-1" })
    ).toEqual<StepClaimScope>({
      executionId: "exec-1",
      nodeId: "node-1",
      forEachNodeId: "",
      iterationIndex: -1,
    });
  });

  it("keeps iteration 0 rather than treating it as absent", () => {
    expect(
      stepClaimScope({
        executionId: "exec-1",
        nodeId: "node-1",
        forEachNodeId: "loop-1",
        iterationIndex: 0,
      }).iterationIndex
    ).toBe(0);
  });
});

describe("acquireStepClaim", () => {
  it("runs the step when it wins the Redis claim", async () => {
    mockGetRedis.mockReturnValue({ set: () => Promise.resolve("OK") });

    await expect(acquireStepClaim(SCOPE)).resolves.toEqual({ outcome: "run" });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("reuses the winner's output when it loses and the winner succeeded", async () => {
    mockGetRedis.mockReturnValue({ set: () => Promise.resolve(null) });
    dbTerminalRowReturns([
      { status: "success", outputRaw: { latestBlock: 25_977_159 } },
    ]);

    await expect(acquireStepClaim(SCOPE)).resolves.toEqual({
      outcome: "reuse",
      output: { latestBlock: 25_977_159 },
    });
  });

  it("runs the step when it loses but the winner's attempt failed", async () => {
    mockGetRedis.mockReturnValue({ set: () => Promise.resolve(null) });
    dbTerminalRowReturns([{ status: "error", outputRaw: null }]);

    await expect(acquireStepClaim(SCOPE)).resolves.toEqual({ outcome: "run" });
  });

  it("falls back to the database when Redis is not configured", async () => {
    mockGetRedis.mockReturnValue(null);
    dbClaimReturns([{ nodeId: "node-1" }]);

    await expect(acquireStepClaim(SCOPE)).resolves.toEqual({ outcome: "run" });
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("falls back to the database when the Redis command throws", async () => {
    mockGetRedis.mockReturnValue({
      set: () => Promise.reject(new Error("connection refused")),
    });
    dbClaimReturns([{ nodeId: "node-1" }]);

    await expect(acquireStepClaim(SCOPE)).resolves.toEqual({ outcome: "run" });
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("treats an empty database insert result as losing the claim", async () => {
    mockGetRedis.mockReturnValue(null);
    dbClaimReturns([]);
    dbTerminalRowReturns([{ status: "success", outputRaw: { ok: true } }]);

    await expect(acquireStepClaim(SCOPE)).resolves.toEqual({
      outcome: "reuse",
      output: { ok: true },
    });
  });

  it("runs the step rather than failing when both claim backends are down", async () => {
    mockGetRedis.mockReturnValue(null);
    mockInsert.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(acquireStepClaim(SCOPE)).resolves.toEqual({ outcome: "run" });
  });

  it("runs the step rather than failing when the winner's row cannot be read", async () => {
    mockGetRedis.mockReturnValue({ set: () => Promise.resolve(null) });
    mockSelect.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(acquireStepClaim(SCOPE)).resolves.toEqual({ outcome: "run" });
  });
});
