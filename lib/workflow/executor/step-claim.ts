import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowStepClaims } from "@/lib/db/schema";
import { ErrorCategory, logInfo, logSystemWarn } from "@/lib/logging";
import { getRedis } from "@/lib/redis";
import { stepClaimKey } from "@/lib/redis-keys";
import { pollForCompletedOutput } from "@/lib/workflow/executor/poll-for-output";

/**
 * Identifies one step within one execution. forEachNodeId and iterationIndex
 * carry sentinels outside a For Each body so the claim key is total: a
 * nullable member would make every non-loop step distinct from itself in the
 * primary key and defeat the claim.
 */
export type StepClaimScope = {
  executionId: string;
  nodeId: string;
  forEachNodeId: string;
  iterationIndex: number;
};

/**
 * How long a claim is honoured before another replay may take it over. A pod
 * killed mid-step leaves its claim behind; without a takeover window the step
 * would never run again. Longer than any single step is expected to take.
 */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** How long a replay that lost the claim waits for the winner's output. */
const WAIT_FOR_WINNER_MS = 30_000;
const WAIT_POLL_INTERVAL_MS = 250;

export type StepClaimResult =
  /** This caller owns the step and must run it. */
  | { outcome: "run" }
  /** Another replay already produced this step's output; reuse it. */
  | { outcome: "reuse"; output: unknown };

export function stepClaimScope(context: {
  executionId: string;
  nodeId: string;
  forEachNodeId?: string;
  iterationIndex?: number;
}): StepClaimScope {
  return {
    executionId: context.executionId,
    nodeId: context.nodeId,
    forEachNodeId: context.forEachNodeId ?? "",
    iterationIndex:
      typeof context.iterationIndex === "number" ? context.iterationIndex : -1,
  };
}

/**
 * Take the claim in Redis. Returns true when this caller won, false when
 * someone else holds it, and null when Redis cannot answer at all -- the
 * caller then falls through to the database, which holds the same claim.
 */
async function claimInRedis(scope: StepClaimScope): Promise<boolean | null> {
  const redis = getRedis();
  if (!redis) {
    return null;
  }
  try {
    const key = stepClaimKey(
      scope.executionId,
      scope.nodeId,
      scope.forEachNodeId,
      scope.iterationIndex
    );
    const result = await redis.set(key, "1", "PX", STALE_CLAIM_MS, "NX");
    return result === "OK";
  } catch {
    return null;
  }
}

/**
 * Take the claim in Postgres. The insert is the race: exactly one caller can
 * hold the primary key. The DO UPDATE clause is what lets a claim abandoned by
 * a dead pod be taken over once it is older than STALE_CLAIM_MS, since a plain
 * DO NOTHING would leave the step unrunnable forever.
 */
async function claimInDb(scope: StepClaimScope): Promise<boolean> {
  const rows = await db
    .insert(workflowStepClaims)
    .values({
      executionId: scope.executionId,
      nodeId: scope.nodeId,
      forEachNodeId: scope.forEachNodeId,
      iterationIndex: scope.iterationIndex,
    })
    .onConflictDoUpdate({
      target: [
        workflowStepClaims.executionId,
        workflowStepClaims.nodeId,
        workflowStepClaims.forEachNodeId,
        workflowStepClaims.iterationIndex,
      ],
      set: { claimedAt: sql`now()` },
      setWhere: sql`${workflowStepClaims.claimedAt} < now() - make_interval(secs => ${STALE_CLAIM_MS / 1000})`,
    })
    .returning({ nodeId: workflowStepClaims.nodeId });

  return rows.length > 0;
}

/** The terminal log row another replay wrote for this step, if it has one. */
async function findTerminalRow(
  scope: StepClaimScope
): Promise<{ status: string; outputRaw: unknown } | null> {
  const rows = await db
    .select({
      status: workflowExecutionLogs.status,
      outputRaw: workflowExecutionLogs.outputRaw,
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        eq(workflowExecutionLogs.executionId, scope.executionId),
        eq(workflowExecutionLogs.nodeId, scope.nodeId),
        scope.forEachNodeId === ""
          ? sql`${workflowExecutionLogs.forEachNodeId} is null`
          : eq(workflowExecutionLogs.forEachNodeId, scope.forEachNodeId),
        scope.iterationIndex === -1
          ? sql`${workflowExecutionLogs.iterationIndex} is null`
          : eq(workflowExecutionLogs.iterationIndex, scope.iterationIndex),
        sql`${workflowExecutionLogs.status} in ('success', 'error')`
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Decide whether this caller runs the step or reuses another replay's output.
 *
 * Losing the claim does not by itself mean the output exists: the winner may
 * still be mid-flight, or may have died. So a loser waits for a terminal row
 * and only reuses a success. An error row means the winner's attempt failed
 * and this caller should run, and a timeout means the winner is gone and
 * running is better than hanging the execution.
 *
 * Any failure to reach Redis or the database resolves to "run". The claim is
 * an optimisation over correctness that already exists elsewhere, so it must
 * never be the reason a step does not happen.
 */
export async function acquireStepClaim(
  scope: StepClaimScope
): Promise<StepClaimResult> {
  let won: boolean;
  try {
    const viaRedis = await claimInRedis(scope);
    won = viaRedis ?? (await claimInDb(scope));
  } catch (error) {
    logSystemWarn(
      ErrorCategory.WORKFLOW_ENGINE,
      "[stepClaim] Claim unavailable, running step unguarded",
      error instanceof Error ? error : new Error(String(error)),
      { execution_id: scope.executionId, node_id: scope.nodeId }
    );
    return { outcome: "run" };
  }

  if (won) {
    return { outcome: "run" };
  }

  let terminal: { status: string; outputRaw: unknown } | null;
  try {
    terminal = await pollForCompletedOutput(() => findTerminalRow(scope), {
      timeoutMs: WAIT_FOR_WINNER_MS,
      intervalMs: WAIT_POLL_INTERVAL_MS,
    });
  } catch (error) {
    logSystemWarn(
      ErrorCategory.WORKFLOW_ENGINE,
      "[stepClaim] Could not read the winning attempt, running step",
      error instanceof Error ? error : new Error(String(error)),
      { execution_id: scope.executionId, node_id: scope.nodeId }
    );
    return { outcome: "run" };
  }

  if (terminal?.status === "success") {
    logInfo("[stepClaim] Reusing output from the replay that owns this step", {
      execution_id: scope.executionId,
      node_id: scope.nodeId,
    });
    return { outcome: "reuse", output: terminal.outputRaw };
  }

  return { outcome: "run" };
}

/**
 * Give up the claim so a later attempt can run the step. Called when the step
 * failed: holding the claim after a failure would make the failure permanent
 * for the rest of the execution.
 */
export async function releaseStepClaim(scope: StepClaimScope): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(
        stepClaimKey(
          scope.executionId,
          scope.nodeId,
          scope.forEachNodeId,
          scope.iterationIndex
        )
      );
    } catch {
      // Best-effort: the claim expires on its own after STALE_CLAIM_MS.
    }
  }

  try {
    await db
      .delete(workflowStepClaims)
      .where(
        and(
          eq(workflowStepClaims.executionId, scope.executionId),
          eq(workflowStepClaims.nodeId, scope.nodeId),
          eq(workflowStepClaims.forEachNodeId, scope.forEachNodeId),
          eq(workflowStepClaims.iterationIndex, scope.iterationIndex)
        )
      );
  } catch {
    // Same: the row is taken over once it goes stale.
  }
}

/** Drop every claim an execution took, once it can no longer run steps. */
export async function clearStepClaims(executionId: string): Promise<void> {
  try {
    await db
      .delete(workflowStepClaims)
      .where(eq(workflowStepClaims.executionId, executionId));
  } catch (error) {
    logSystemWarn(
      ErrorCategory.WORKFLOW_ENGINE,
      "[stepClaim] Failed to clear claims for a finished execution",
      error instanceof Error ? error : new Error(String(error)),
      { execution_id: executionId }
    );
  }
}
