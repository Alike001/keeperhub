import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: selectMock } }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemWarn: vi.fn(),
}));
vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {
    id: "id",
    workflowId: "workflow_id",
    startedAt: "started_at",
    completedAt: "completed_at",
    deletedAt: "deleted_at",
  },
  workflowExecutionLogs: {
    executionId: "execution_id",
    nodeId: "node_id",
    deletedAt: "deleted_at",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  eq: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  isNotNull: (value: unknown) => value,
  isNull: (value: unknown) => value,
  lt: (...args: unknown[]) => args,
}));

import {
  countConsecutiveRuns,
  MAX_CONSECUTIVE_RUNS,
  resolveConsecutiveRuns,
} from "@/plugins/pagerduty/steps/consecutive-core";

/**
 * Three chained queries: this run's start time, the runs before it, then the
 * log rows showing which of those reached this node.
 */
function mockQueries(priorRuns: { id: string }[], reached: string[]) {
  selectMock
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ startedAt: new Date() }]),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve(priorRuns) }),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({
        where: () =>
          Promise.resolve(reached.map((id) => ({ executionId: id }))),
      }),
    });
}

const CONTEXT = {
  workflowId: "wf-1",
  nodeId: "node-3",
  executionId: "exec-current",
};

beforeEach(() => {
  selectMock.mockReset();
});

describe("resolveConsecutiveRuns", () => {
  it("defaults to paging immediately", () => {
    expect(resolveConsecutiveRuns(undefined)).toBe(1);
    expect(resolveConsecutiveRuns("")).toBe(1);
    expect(resolveConsecutiveRuns("not a number")).toBe(1);
  });

  it("accepts the editor's strings and MCP's numbers alike", () => {
    expect(resolveConsecutiveRuns("3")).toBe(3);
    expect(resolveConsecutiveRuns(3)).toBe(3);
  });

  it("clamps out-of-range values rather than rejecting them", () => {
    expect(resolveConsecutiveRuns(0)).toBe(1);
    expect(resolveConsecutiveRuns(-5)).toBe(1);
    expect(resolveConsecutiveRuns(999)).toBe(MAX_CONSECUTIVE_RUNS);
  });
});

describe("countConsecutiveRuns", () => {
  it("does not query at all when the node pages immediately", async () => {
    expect(await countConsecutiveRuns(CONTEXT, 1)).toBe(1);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("counts this run alone when there is no history", async () => {
    mockQueries([], []);
    expect(await countConsecutiveRuns(CONTEXT, 3)).toBe(1);
  });

  it("counts a run where the node was reached before", async () => {
    mockQueries([{ id: "exec-2" }, { id: "exec-1" }], ["exec-2", "exec-1"]);
    expect(await countConsecutiveRuns(CONTEXT, 3)).toBe(3);
  });

  it("breaks the streak on a run that did not reach the node", async () => {
    // exec-2 is the most recent prior run and skipped this node: one healthy
    // check is enough to clear the streak.
    mockQueries([{ id: "exec-2" }, { id: "exec-1" }], ["exec-1"]);
    expect(await countConsecutiveRuns(CONTEXT, 3)).toBe(1);
  });

  /**
   * The database is least healthy exactly when an incident is in progress. A
   * page held back because a count query failed is the outcome this feature
   * exists to prevent, so it pages instead.
   */
  it("pages anyway when the database will not answer", async () => {
    selectMock.mockImplementation(() => {
      throw new Error("connection pool exhausted");
    });
    expect(await countConsecutiveRuns(CONTEXT, 3)).toBe(3);
  });

  it("pages anyway when a query rejects rather than throws", async () => {
    selectMock.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.reject(new Error("statement timeout")),
        }),
      }),
    });
    expect(await countConsecutiveRuns(CONTEXT, 2)).toBe(2);
  });

  it("fails open when the run has no identity to count against", async () => {
    expect(await countConsecutiveRuns({ nodeId: "node-3" }, 3)).toBe(1);
    expect(await countConsecutiveRuns({ workflowId: "wf-1" }, 3)).toBe(1);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
