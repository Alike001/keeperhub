import "server-only";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowStepClaims } from "@/lib/db/schema";
import { ErrorCategory, logInfo, logSystemWarn, logWarn } from "@/lib/logging";
import { getRedis } from "@/lib/redis";
import { stepClaimKey } from "@/lib/redis-keys";
import { pollForCompletedOutput } from "@/lib/workflow/executor/poll-for-output";

/**
 * Identifies one step within one execution.
 *
 * Steps inside a For Each body are deliberately out of scope. The executor
 * describes an iteration with a single (forEachNodeId, iterationIndex) pair
 * naming the innermost loop, so a node in a nested body carries the same pair
 * under every outer iteration. Claiming on that key would make the second
 * outer iteration reuse the first one's output, which is worse than the
 * duplicate work this module exists to remove. Deduplicating loop bodies
 * needs the executor to carry the full nesting path first.
 */
export type StepClaimScope = {
  executionId: string;
  nodeId: string;
};

/**
 * How long a claim is honoured before another replay may take it over. A pod
 * killed mid-step leaves its claim behind; without a takeover window the step
 * would never run again. Longer than any single step is expected to take.
 */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** How long a replay that lost the claim waits for the winner's output. */
const WAIT_FOR_WINNER_MS = 30_000;
const WAIT_POLL_INTERVAL_MS = 1000;

/**
 * Ceiling for the two reads this module makes. Both run on the step's hot
 * path, so a database stall must surface as "run the step" rather than as a
 * replay parked until the pod is killed.
 */
const CLAIM_STATEMENT_TIMEOUT_MS = 5000;

/**
 * Postgres rejects a bind parameter in SET, so the value is inlined. It is a
 * module constant, never caller input.
 */
const SET_CLAIM_TIMEOUT = sql.raw(
  `SET LOCAL statement_timeout = ${CLAIM_STATEMENT_TIMEOUT_MS}`
);

/** Wait rounds before a replay stops deferring and runs the step itself. */
const MAX_WAIT_ROUNDS = 2;

export type StepClaimResult =
  /** This caller owns the step and must run it. */
  | { outcome: "run" }
  /** Another replay already produced this step's output; reuse it. */
  | { outcome: "reuse"; output: unknown };

/**
 * The claim scope for a step, or undefined when the step must not be claimed.
 *
 * Three kinds of step are deliberately left unguarded:
 *
 * - Anything without an execution and node to scope to.
 * - Steps inside a For Each body, for the reason on StepClaimScope.
 * - Direct executions. `/api/execute/node` dispatches the same step wrappers
 *   with a `_context.executionId` naming a `direct_executions` row, not a
 *   `workflow_executions` one, so the claim's foreign key would reject every
 *   one of them -- a warning per call on a paid API path, in exchange for
 *   nothing, since a direct execution runs a single step once and has no
 *   replays to deduplicate. `workflowId` is what separates them: the workflow
 *   executor sets it on every step context it builds, and the direct routes
 *   never do.
 */
export function stepClaimScope(context: {
  executionId?: string;
  nodeId?: string;
  workflowId?: string;
  forEachNodeId?: string;
  iterationIndex?: number;
}): StepClaimScope | undefined {
  if (!(context.executionId && context.nodeId && context.workflowId)) {
    return;
  }
  if (context.forEachNodeId !== undefined) {
    return;
  }
  return { executionId: context.executionId, nodeId: context.nodeId };
}

function redisKeyFor(scope: StepClaimScope): string {
  return stepClaimKey(scope.executionId, scope.nodeId);
}

/**
 * Whether Redis already knows someone holds this claim.
 *
 * Redis is a negative cache, never the authority. The overwhelming majority
 * of replays arrive long after the step was claimed, and answering those here
 * keeps one database write per step rather than one per replay. A miss, or an
 * unreachable Redis, simply falls through to the authoritative insert.
 */
async function heldAccordingToRedis(scope: StepClaimScope): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    return false;
  }
  try {
    return (await redis.exists(redisKeyFor(scope))) === 1;
  } catch {
    return false;
  }
}

async function rememberClaimInRedis(scope: StepClaimScope): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    return;
  }
  try {
    await redis.set(redisKeyFor(scope), "1", "PX", STALE_CLAIM_MS);
  } catch {
    // The claim still stands in Postgres; this only costs a cache miss.
  }
}

/**
 * Take the claim in Postgres, the single authority for who runs a step.
 *
 * The insert is the race: exactly one caller can hold the primary key. The DO
 * UPDATE clause is what lets a claim abandoned by a dead pod be taken over
 * once it is older than STALE_CLAIM_MS, since a plain DO NOTHING would leave
 * the step unrunnable for the rest of the run.
 */
async function claimInDb(scope: StepClaimScope): Promise<boolean> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(SET_CLAIM_TIMEOUT);
    return await tx
      .insert(workflowStepClaims)
      .values({ executionId: scope.executionId, nodeId: scope.nodeId })
      .onConflictDoUpdate({
        target: [workflowStepClaims.executionId, workflowStepClaims.nodeId],
        set: { claimedAt: sql`now()` },
        setWhere: sql`${workflowStepClaims.claimedAt} < now() - make_interval(secs => ${STALE_CLAIM_MS / 1000})`,
      })
      .returning({ nodeId: workflowStepClaims.nodeId });
  });

  return rows.length > 0;
}

/**
 * The output the winning replay recorded, if it has finished successfully.
 *
 * Matches only a success row carrying output, newest first, exactly as the
 * sibling readers in get-completed-step-output.step.ts do. A node routinely
 * carries a success row alongside an orphaned error row -- releaseStepClaim
 * on failure produces that very shape -- so an unordered read that accepted
 * either status could hand back a stale failure and send this replay off to
 * run the step next to the winner.
 */
async function findWinnerOutput(
  scope: StepClaimScope
): Promise<{ outputRaw: unknown } | null> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(SET_CLAIM_TIMEOUT);
    return await tx
      .select({ outputRaw: workflowExecutionLogs.outputRaw })
      .from(workflowExecutionLogs)
      .where(
        and(
          eq(workflowExecutionLogs.executionId, scope.executionId),
          eq(workflowExecutionLogs.nodeId, scope.nodeId),
          eq(workflowExecutionLogs.status, "success"),
          isNotNull(workflowExecutionLogs.outputRaw)
        )
      )
      .orderBy(desc(workflowExecutionLogs.completedAt))
      .limit(1);
  });

  return rows[0] ?? null;
}

/**
 * Decide whether this caller runs the step or reuses another replay's output.
 *
 * A replay that loses the claim waits for the winner's success row. On
 * timeout it tries to take the claim over rather than simply proceeding:
 * every loser started its wait at the same moment, so a winner killed
 * mid-step would otherwise release the whole crowd to run the step at once,
 * which is the pile-up this module exists to prevent.
 *
 * Any failure to reach Redis or the database resolves to "run". The claim
 * reduces duplicated work; it must never be the reason a step does not
 * happen at all.
 */
export async function acquireStepClaim(
  scope: StepClaimScope,
  /** Injectable so the wait loop is deterministic under test, matching
   *  pollForCompletedOutput's own seam. */
  waitOptions?: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<StepClaimResult> {
  const timeoutMs = waitOptions?.timeoutMs ?? WAIT_FOR_WINNER_MS;
  for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
    let won: boolean;
    try {
      // Skip the authoritative write only on the first pass, where Redis
      // answers the bulk of replays. A later round is a takeover attempt and
      // has to reach the row that carries the staleness check.
      const held = round === 0 && (await heldAccordingToRedis(scope));
      won = held ? false : await claimInDb(scope);
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
      await rememberClaimInRedis(scope);
      return { outcome: "run" };
    }

    let winner: { outputRaw: unknown } | null;
    try {
      winner = await pollForCompletedOutput(() => findWinnerOutput(scope), {
        timeoutMs,
        intervalMs: WAIT_POLL_INTERVAL_MS,
        sleep: waitOptions?.sleep,
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

    if (winner) {
      logInfo(
        "[stepClaim] Reusing output from the replay that owns this step",
        {
          execution_id: scope.executionId,
          node_id: scope.nodeId,
        }
      );
      return { outcome: "reuse", output: winner.outputRaw };
    }
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
      await redis.del(redisKeyFor(scope));
    } catch {
      // Best-effort: the claim goes stale on its own after STALE_CLAIM_MS.
    }
  }

  try {
    await db
      .delete(workflowStepClaims)
      .where(
        and(
          eq(workflowStepClaims.executionId, scope.executionId),
          eq(workflowStepClaims.nodeId, scope.nodeId)
        )
      );
  } catch {
    // Same: the row is taken over once it goes stale.
  }
}

/**
 * Drop every claim an execution took, once it can no longer run steps.
 *
 * A failure here leaves rows behind but breaks nothing: the claims cascade
 * when the execution row is eventually purged, and a stale claim is taken
 * over after STALE_CLAIM_MS anyway. Benign, so it is not raised as a system
 * warning.
 */
export async function clearStepClaims(executionId: string): Promise<void> {
  try {
    await db
      .delete(workflowStepClaims)
      .where(eq(workflowStepClaims.executionId, executionId));
  } catch {
    logWarn("[stepClaim] Could not clear claims for a finished execution", {
      execution_id: executionId,
    });
  }
}
