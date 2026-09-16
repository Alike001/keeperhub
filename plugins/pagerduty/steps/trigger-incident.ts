import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { sleep } from "@/lib/sleep";
import { resolveFailOnError } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  resolveRetryAttempts,
  resolveRetryDelayMs,
} from "@/lib/workflow/retry-policy";
import type { PagerDutyCredentials } from "../credentials";
import {
  type BackupOutcome,
  buildBackupMessage,
  sendBackupNotification,
} from "./backup-notify-core";
import {
  countConsecutiveRuns,
  resolveConsecutiveRuns,
} from "./consecutive-core";
import {
  buildTriggerEvent,
  deriveDedupKey,
  failureIsExternal,
  type PagerDutyFailure,
  postEventWithRetries,
  resolveRoutingKeyWithRetries,
  serviceSwallowsEvents,
} from "./pagerduty-core";

const RETRY_ATTEMPT_LIMITS = { defaultAttempts: 2, maxAttempts: 5 };
const RETRY_DELAY_LIMITS = { defaultDelaySeconds: 1, maxDelaySeconds: 15 };
const DEFAULT_APP_URL = "https://app.keeperhub.com";
const CLIENT_NAME = "KeeperHub";
const TRAILING_SLASHES = /\/+$/;

const LOG_LABELS = {
  plugin_name: "pagerduty",
  action_name: "trigger-incident",
  service: "pagerduty",
};

export type TriggerIncidentCoreInput = {
  pagerdutyServiceId: string;
  summary: string;
  severity?: string;
  source?: string;
  dedupKey?: string;
  component?: string;
  group?: string;
  class?: string;
  customDetails?: string | Record<string, unknown>;
  /** Runs in a row that must reach this node before it pages. 1 pages immediately. */
  consecutiveRuns?: number | string;
  retryAttempts?: number | string;
  retryDelay?: number | string;
  /** Default true. False returns delivered: false instead of failing the run. */
  failOnError?: boolean | string;
  /** Connection to notify when PagerDuty will not take the page. */
  backupIntegrationId?: string;
  /** Slack channel or Telegram chat id, when the backup connection needs one. */
  backupDestination?: string;
};

export type TriggerIncidentInput = StepInput &
  TriggerIncidentCoreInput & {
    integrationId: string;
  };

type TriggerIncidentResult =
  | {
      success: true;
      /** False when the event was held by the consecutive-runs guard, or soft-failed. */
      delivered: boolean;
      dedupKey: string;
      status: "triggered" | "held" | "failed";
      consecutiveRuns: number;
      requiredRuns: number;
      detailsTruncated?: boolean;
      /** PagerDuty's service status at send time. */
      serviceStatus?: string;
      /** True when the service was in maintenance, so no incident was raised. */
      suppressedByService?: boolean;
      /** Whether a backup notification was attempted, and whether it landed. */
      backupAttempted?: boolean;
      backupDelivered?: boolean;
      backupChannel?: BackupOutcome["channel"];
      backupError?: string;
      error?: string;
      message?: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(TRAILING_SLASHES, "") ??
    DEFAULT_APP_URL
  );
}

/**
 * Whatever the author put in the details field, plus the run's own identity.
 * A free-text value is kept under a `details` key rather than dropped, so a
 * non-JSON template still reaches the responder.
 */
function buildCustomDetails(
  raw: string | Record<string, unknown> | undefined,
  context: { workflowId?: string; executionId?: string; nodeName?: string }
): Record<string, unknown> {
  const base: Record<string, unknown> = {};

  if (typeof raw === "object" && raw !== null) {
    Object.assign(base, raw);
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        Object.assign(base, parsed as Record<string, unknown>);
      } else {
        base.details = parsed;
      }
    } catch {
      base.details = raw;
    }
  }

  base.keeperhub_workflow_id = context.workflowId ?? "unknown";
  base.keeperhub_execution_id = context.executionId ?? "unknown";
  base.keeperhub_node = context.nodeName ?? "PagerDuty";
  return base;
}

function toFailureResult(
  failure: PagerDutyFailure,
  failOnError: boolean,
  dedupKey: string,
  consecutive: number,
  required: number,
  backup: BackupOutcome
): TriggerIncidentResult {
  logUserError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[PagerDuty] Could not trigger incident",
    failure.message,
    failure.status
      ? { ...LOG_LABELS, status: String(failure.status) }
      : LOG_LABELS
  );

  if (failOnError) {
    return {
      success: false,
      error: backup.attempted
        ? `${failure.message} Backup notification: ${backup.delivered ? "sent" : (backup.error ?? "failed")}.`
        : failure.message,
      errorClass: failureIsExternal(failure)
        ? ExecutionErrorType.EXTERNAL
        : ExecutionErrorType.USER,
    };
  }

  // Soft failure: the run continues so a Condition on `delivered` can route to
  // a backup channel. The error travels with the output rather than vanishing.
  return {
    success: true,
    delivered: false,
    dedupKey,
    status: "failed",
    consecutiveRuns: consecutive,
    requiredRuns: required,
    error: failure.message,
    backupAttempted: backup.attempted,
    backupDelivered: backup.delivered,
    backupChannel: backup.channel,
    backupError: backup.error,
  };
}

/**
 * Tell someone, through whatever channel the node names, that the page did not
 * go out. Runs before the failure is returned, whether or not the node is set
 * to fail the workflow: the run being marked failed is for the operator
 * reading history later, the backup is for the person who is supposed to be
 * woken up now.
 */
async function notifyBackup(params: {
  input: TriggerIncidentInput;
  failure: PagerDutyFailure;
  summary: string;
  serviceId: string;
  workflowUrl?: string;
}): Promise<BackupOutcome> {
  const { input, failure } = params;
  if (!input.backupIntegrationId) {
    return { attempted: false, delivered: false };
  }
  const outcome = await sendBackupNotification({
    integrationId: input.backupIntegrationId,
    destination: input.backupDestination,
    organizationId: input._context?.organizationId ?? null,
    message: buildBackupMessage({
      summary: params.summary,
      severity: String(input.severity ?? "error"),
      serviceId: params.serviceId,
      reason: failure.message,
      workflowUrl: params.workflowUrl,
    }),
  });

  if (outcome.attempted && !outcome.delivered) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[PagerDuty] Backup notification also failed",
      outcome.error,
      LOG_LABELS
    );
  }
  return outcome;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear path - validate, gate, resolve, send - each branch returning its own result
async function stepHandler(
  input: TriggerIncidentInput,
  credentials: PagerDutyCredentials
): Promise<TriggerIncidentResult> {
  const failOnError = resolveFailOnError(input.failOnError);
  const context = input._context ?? { nodeId: "", nodeName: "", nodeType: "" };
  const dedupKey = deriveDedupKey(input.dedupKey, {
    workflowId: context.workflowId,
    nodeId: context.nodeId,
  });
  const requiredRuns = resolveConsecutiveRuns(input.consecutiveRuns);

  const serviceId = input.pagerdutyServiceId?.trim();
  if (!serviceId) {
    return {
      success: false,
      error:
        "No PagerDuty service selected. Pick the service this node should page.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const summary = input.summary?.trim();
  if (!summary) {
    return {
      success: false,
      error:
        "Summary is empty, and PagerDuty requires one. It becomes the alert title - check the template it is built from.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const consecutiveRuns = await countConsecutiveRuns(
    {
      workflowId: context.workflowId,
      nodeId: context.nodeId,
      executionId: context.executionId,
    },
    requiredRuns
  );

  if (consecutiveRuns < requiredRuns) {
    return {
      success: true,
      delivered: false,
      dedupKey,
      status: "held",
      consecutiveRuns,
      requiredRuns,
      message: `Held: this is run ${consecutiveRuns} of the ${requiredRuns} consecutive runs configured before paging.`,
    };
  }

  const workflowUrl = context.workflowId
    ? `${appUrl()}/workflows/${context.workflowId}`
    : undefined;

  const maxRetries = resolveRetryAttempts(
    input.retryAttempts,
    RETRY_ATTEMPT_LIMITS
  );
  const baseDelayMs = resolveRetryDelayMs(input.retryDelay, RETRY_DELAY_LIMITS);
  const onRetry = (
    failure: PagerDutyFailure,
    attempt: number,
    delayMs: number
  ): void => {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[PagerDuty] Attempt failed, retrying",
      failure.message,
      { ...LOG_LABELS, attempt: String(attempt), retry_in_ms: String(delayMs) }
    );
  };

  const routingKey = await resolveRoutingKeyWithRetries({
    credentials,
    serviceId,
    maxRetries,
    baseDelayMs,
    wait: sleep,
    onRetry,
  });
  if (!routingKey.ok) {
    return toFailureResult(
      routingKey.failure,
      failOnError,
      dedupKey,
      consecutiveRuns,
      requiredRuns,
      await notifyBackup({
        input,
        failure: routingKey.failure,
        summary,
        serviceId,
        workflowUrl,
      })
    );
  }

  if (routingKey.value.serviceStatus === "disabled") {
    const disabled: PagerDutyFailure = {
      message: `PagerDuty service ${serviceId} is disabled. It accepts events and creates no incident, so this page would have gone nowhere. Re-enable the service in PagerDuty, or point this node at another one.`,
      retryable: false,
    };
    return toFailureResult(
      disabled,
      failOnError,
      dedupKey,
      consecutiveRuns,
      requiredRuns,
      await notifyBackup({
        input,
        failure: disabled,
        summary,
        serviceId,
        workflowUrl,
      })
    );
  }

  const { body, detailsDropped } = buildTriggerEvent({
    routingKey: routingKey.value.routingKey,
    dedupKey,
    timestamp: new Date().toISOString(),
    input: {
      summary,
      severity: input.severity,
      source: input.source?.trim() || context.nodeName || CLIENT_NAME,
      component: input.component,
      group: input.group,
      class: input.class,
      customDetails: buildCustomDetails(input.customDetails, {
        workflowId: context.workflowId,
        executionId: context.executionId,
        nodeName: context.nodeName,
      }),
      client: CLIENT_NAME,
      clientUrl: workflowUrl,
    },
  });

  const result = await postEventWithRetries({
    credentials,
    body,
    maxRetries,
    baseDelayMs,
    wait: sleep,
    onRetry,
  });

  if (!result.ok) {
    return toFailureResult(
      result.failure,
      failOnError,
      dedupKey,
      consecutiveRuns,
      requiredRuns,
      await notifyBackup({
        input,
        failure: result.failure,
        summary,
        serviceId,
        workflowUrl,
      })
    );
  }

  const suppressed = serviceSwallowsEvents(routingKey.value.serviceStatus);
  return {
    success: true,
    delivered: true,
    dedupKey: result.value.dedupKey ?? dedupKey,
    status: "triggered",
    consecutiveRuns,
    requiredRuns,
    detailsTruncated: detailsDropped,
    serviceStatus: routingKey.value.serviceStatus,
    suppressedByService: suppressed,
    message: suppressed
      ? `PagerDuty accepted the event, but the service is in ${routingKey.value.serviceStatus} and will not raise an incident from it.`
      : result.value.message,
  };
}

export async function triggerIncidentStep(
  input: TriggerIncidentInput
): Promise<TriggerIncidentResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, {
    organizationId: input._context?.organizationId ?? null,
  });

  return runPluginStep(
    { pluginName: "pagerduty", actionName: "trigger-incident" },
    input,
    () => stepHandler(input, credentials as PagerDutyCredentials)
  );
}
// The step runs its own retry loop, which is the only place an event is
// re-sent; the engine must not stack a second one on top.
triggerIncidentStep.maxRetries = 0;

export const _integrationType = "pagerduty";
