/**
 * Shared body of the acknowledge and resolve actions.
 *
 * IMPORTANT: this file must NOT contain "use step".
 *
 * Both actions are the same call with a different event_action, and both are
 * only meaningful against an alert this workflow opened: PagerDuty applies an
 * acknowledge or a resolve to the open alert with the same dedup key, sent
 * through the same service's routing key, and drops it when there is none.
 * That makes a resolve on the healthy branch of a check safe to run every
 * time - it closes what the workflow opened, or does nothing.
 */
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { sleep } from "@/lib/sleep";
import { resolveFailOnError } from "@/lib/utils";
import {
  resolveRetryAttempts,
  resolveRetryDelayMs,
} from "@/lib/workflow/retry-policy";
import type { PagerDutyCredentials } from "../credentials";
import {
  buildUpdateEvent,
  failureIsExternal,
  findIncidentByKey,
  type IncidentLookup,
  postEventWithRetries,
  resolveRoutingKey,
} from "./pagerduty-core";

const RETRY_ATTEMPT_LIMITS = { defaultAttempts: 2, maxAttempts: 5 };
const RETRY_DELAY_LIMITS = { defaultDelaySeconds: 1, maxDelaySeconds: 15 };

export type UpdateIncidentCoreInput = {
  pagerdutyServiceId: string;
  dedupKey?: string;
  /** Read the incident back afterwards to report what state it is actually in. */
  verifyWithPagerDuty?: boolean | string;
  retryAttempts?: number | string;
  retryDelay?: number | string;
  failOnError?: boolean | string;
};

export type UpdateIncidentResult =
  | {
      success: true;
      /** PagerDuty accepted the event. It does not promise an alert changed state. */
      delivered: boolean;
      dedupKey: string;
      action: "acknowledge" | "resolve";
      /** Only present when verification is on. "unknown" means PagerDuty had nothing to show, which is not proof of absence. */
      incidentStatus?: IncidentLookup["status"];
      incidentUrl?: string;
      /** True when the incident was already in the state this action asks for. */
      alreadyInTargetState?: boolean;
      /** Why verification could not answer, when it could not. Never fails the step. */
      verificationError?: string;
      error?: string;
      message?: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

/**
 * PagerDuty identifies the alert to acknowledge or resolve by dedup key, and
 * the Events API requires one for both actions - it is only optional on a
 * trigger, where PagerDuty will generate it.
 *
 * It is deliberately not defaulted the way the trigger's is. The trigger
 * derives a key from its own node id; deriving one here would derive it from
 * THIS node's id, which is a different node, so the event would carry a key no
 * alert has ever used. PagerDuty answers 202 to that and drops it, which is
 * the quietest possible way to never close an incident. Referencing the
 * trigger node's `dedupKey` output is the shape that works.
 */
function missingDedupKeyError(action: "acknowledge" | "resolve"): string {
  return `This ${action} has no dedup key. PagerDuty needs the key of the alert to ${action}, and it is not derived for you here: point this at the trigger node's dedupKey output, for example {{Trigger Incident.dedupKey}}, or type the same key the trigger uses.`;
}

type Verification = {
  incidentStatus?: IncidentLookup["status"];
  incidentUrl?: string;
  alreadyInTargetState?: boolean;
  verificationError?: string;
};

/**
 * Read the incident back, when the node asks for it.
 *
 * PagerDuty answers 202 to an acknowledge or a resolve whether or not it had
 * anything to apply it to: an alert already resolved, a dedup key that was
 * never used, or an event sent through a different service's routing key all
 * look identical from the response. This turns that into a reported state.
 *
 * Never fails the step. A missing incidents.read scope, a rate limit, or a
 * service that groups alerts (whose incidents carry no incident key) all come
 * back as "unknown" with a note - refusing to resolve an incident because the
 * read-back was inconclusive would be worse than the ambiguity it replaces.
 */
async function verifyIfAsked(params: {
  input: UpdateIncidentCoreInput;
  credentials: PagerDutyCredentials;
  serviceId: string;
  dedupKey: string;
  action: "acknowledge" | "resolve";
}): Promise<Verification> {
  const asked =
    params.input.verifyWithPagerDuty === true ||
    params.input.verifyWithPagerDuty === "true";
  if (!asked) {
    return {};
  }

  const lookup = await findIncidentByKey(params.credentials, {
    serviceId: params.serviceId,
    incidentKey: params.dedupKey,
  });

  if (!lookup.ok) {
    return {
      incidentStatus: "unknown",
      verificationError: lookup.failure.message,
    };
  }

  const target =
    params.action === "resolve" ? "resolved" : "acknowledged";
  return {
    incidentStatus: lookup.value.status,
    incidentUrl: lookup.value.htmlUrl,
    alreadyInTargetState: lookup.value.status === target,
  };
}

export async function runUpdateIncident(params: {
  input: UpdateIncidentCoreInput;
  credentials: PagerDutyCredentials;
  action: "acknowledge" | "resolve";
}): Promise<UpdateIncidentResult> {
  const { input, credentials, action } = params;
  const failOnError = resolveFailOnError(input.failOnError);
  const dedupKey = input.dedupKey?.trim() ?? "";
  const logLabels = {
    plugin_name: "pagerduty",
    action_name: `${action}-incident`,
    service: "pagerduty",
  };

  if (!dedupKey) {
    return {
      success: false,
      error: missingDedupKeyError(action),
      errorClass: ExecutionErrorType.USER,
    };
  }

  const serviceId = input.pagerdutyServiceId?.trim();
  if (!serviceId) {
    return {
      success: false,
      error: `No PagerDuty service selected. An ${action} has to go through the same service that triggered the alert.`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const routingKey = await resolveRoutingKey(credentials, serviceId);
  const result = routingKey.ok
    ? await postEventWithRetries({
        credentials,
        body: buildUpdateEvent({
          routingKey: routingKey.value,
          dedupKey,
          action,
        }),
        maxRetries: resolveRetryAttempts(
          input.retryAttempts,
          RETRY_ATTEMPT_LIMITS
        ),
        baseDelayMs: resolveRetryDelayMs(input.retryDelay, RETRY_DELAY_LIMITS),
        wait: sleep,
        onRetry: (failure, attempt, delayMs) => {
          logUserError(
            ErrorCategory.EXTERNAL_SERVICE,
            "[PagerDuty] Attempt failed, retrying",
            failure.message,
            { ...logLabels, attempt: String(attempt), retry_in_ms: String(delayMs) }
          );
        },
      })
    : routingKey;

  if (result.ok) {
    const verification = await verifyIfAsked({
      input,
      credentials,
      serviceId,
      dedupKey,
      action,
    });
    return {
      success: true,
      delivered: true,
      dedupKey,
      action,
      message: result.value.message,
      ...verification,
    };
  }

  logUserError(
    ErrorCategory.EXTERNAL_SERVICE,
    `[PagerDuty] Could not ${action} incident`,
    result.failure.message,
    result.failure.status
      ? { ...logLabels, status: String(result.failure.status) }
      : logLabels
  );

  if (failOnError) {
    return {
      success: false,
      error: result.failure.message,
      errorClass: failureIsExternal(result.failure)
        ? ExecutionErrorType.EXTERNAL
        : ExecutionErrorType.USER,
    };
  }

  return {
    success: true,
    delivered: false,
    dedupKey,
    action,
    error: result.failure.message,
  };
}
