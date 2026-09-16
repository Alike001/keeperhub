/**
 * "Page only after N consecutive runs" - the flap guard for the trigger
 * action.
 *
 * IMPORTANT: this file must NOT contain "use step".
 *
 * The streak is derived from run history rather than kept in a counter of its
 * own: a run that reached this node is a run where the branch leading to it
 * was taken, which is exactly the condition the user wants counted. A run that
 * did not reach the node breaks the streak, so one healthy check clears it.
 * No new table, and the history a user can already see is the source of truth.
 */
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";

export const MIN_CONSECUTIVE_RUNS = 1;
export const MAX_CONSECUTIVE_RUNS = 20;

/**
 * Parse the configured threshold. The editor sends strings and MCP callers
 * send numbers; anything unparseable means "page immediately" rather than an
 * error, so a stale config can never silence an alert.
 */
export function resolveConsecutiveRuns(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return MIN_CONSECUTIVE_RUNS;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return MIN_CONSECUTIVE_RUNS;
  }
  return Math.min(
    Math.max(MIN_CONSECUTIVE_RUNS, Math.trunc(value)),
    MAX_CONSECUTIVE_RUNS
  );
}

export type ConsecutiveContext = {
  workflowId?: string;
  nodeId?: string;
  executionId?: string;
};

/**
 * How many runs in a row, ending with this one, reached this node. Returns 1
 * when there is nothing to count against: a threshold of 1, a missing
 * identifier, or a database that will not answer. Failing open matters more
 * than the guard here - an alerting node that goes quiet because a count query
 * failed is the worst outcome available.
 */
export async function countConsecutiveRuns(
  context: ConsecutiveContext,
  threshold: number
): Promise<number> {
  if (threshold <= MIN_CONSECUTIVE_RUNS) {
    return 1;
  }
  const { workflowId, nodeId, executionId } = context;
  if (!(workflowId && nodeId)) {
    return 1;
  }

  const priorRuns = await db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(
      executionId
        ? and(
            eq(workflowExecutions.workflowId, workflowId),
            ne(workflowExecutions.id, executionId)
          )
        : eq(workflowExecutions.workflowId, workflowId)
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(threshold - 1);

  if (priorRuns.length === 0) {
    return 1;
  }

  const priorIds = priorRuns.map((run) => run.id);
  const reachedRows = await db
    .select({ executionId: workflowExecutionLogs.executionId })
    .from(workflowExecutionLogs)
    .where(
      and(
        inArray(workflowExecutionLogs.executionId, priorIds),
        eq(workflowExecutionLogs.nodeId, nodeId),
        isNull(workflowExecutionLogs.deletedAt)
      )
    );

  const reached = new Set(reachedRows.map((row) => row.executionId));

  // Walk back from the most recent run; the first run that did not reach this
  // node ends the streak.
  let streak = 1;
  for (const run of priorRuns) {
    if (!reached.has(run.id)) {
      break;
    }
    streak += 1;
  }
  return streak;
}
