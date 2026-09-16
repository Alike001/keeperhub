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
  failureIsExternal,
  MAX_SUMMARY_CHARS,
  postEventWithRetries,
  resolveRoutingKey,
  truncateRunes,
} from "./pagerduty-core";

const RETRY_ATTEMPT_LIMITS = { defaultAttempts: 2, maxAttempts: 5 };
const RETRY_DELAY_LIMITS = { defaultDelaySeconds: 1, maxDelaySeconds: 15 };
const CHANGE_EVENT_PATH = "/v2/change/enqueue";

const LOG_LABELS = {
  plugin_name: "pagerduty",
  action_name: "send-change-event",
  service: "pagerduty",
};

export type SendChangeEventCoreInput = {
  pagerdutyServiceId: string;
  summary: string;
  source?: string;
  customDetails?: string | Record<string, unknown>;
  retryAttempts?: number | string;
  retryDelay?: number | string;
  failOnError?: boolean | string;
};

export type SendChangeEventInput = StepInput &
  SendChangeEventCoreInput & {
    integrationId: string;
  };

type SendChangeEventResult =
  | { success: true; delivered: boolean; error?: string; message?: string }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function parseDetails(
  raw: string | Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (typeof raw === "object" && raw !== null) {
    return raw;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: keep the author's text rather than dropping it.
  }
  return { details: raw };
}

async function stepHandler(
  input: SendChangeEventInput,
  credentials: PagerDutyCredentials
): Promise<SendChangeEventResult> {
  const failOnError = resolveFailOnError(input.failOnError);
  const serviceId = input.pagerdutyServiceId?.trim();
  const summary = input.summary?.trim();

  if (!serviceId) {
    return {
      success: false,
      error: "No PagerDuty service selected.",
      errorClass: ExecutionErrorType.USER,
    };
  }
  if (!summary) {
    return {
      success: false,
      error: "Summary is empty, and a change event needs one.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const routingKey = await resolveRoutingKey(credentials, serviceId);
  const result = routingKey.ok
    ? await postEventWithRetries({
        credentials,
        path: CHANGE_EVENT_PATH,
        body: {
          routing_key: routingKey.value,
          payload: {
            summary: truncateRunes(summary, MAX_SUMMARY_CHARS),
            timestamp: new Date().toISOString(),
            source:
              input.source?.trim() || input._context?.nodeName || "KeeperHub",
            custom_details: parseDetails(input.customDetails),
          },
        },
        maxRetries: resolveRetryAttempts(
          input.retryAttempts,
          RETRY_ATTEMPT_LIMITS
        ),
        baseDelayMs: resolveRetryDelayMs(input.retryDelay, RETRY_DELAY_LIMITS),
        wait: sleep,
      })
    : routingKey;

  if (result.ok) {
    return { success: true, delivered: true, message: result.value.message };
  }

  logUserError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[PagerDuty] Could not send change event",
    result.failure.message,
    LOG_LABELS
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
  return { success: true, delivered: false, error: result.failure.message };
}

export async function sendChangeEventStep(
  input: SendChangeEventInput
): Promise<SendChangeEventResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, {
    organizationId: input._context?.organizationId ?? null,
  });

  return runPluginStep(
    { pluginName: "pagerduty", actionName: "send-change-event" },
    input,
    () => stepHandler(input, credentials as PagerDutyCredentials)
  );
}
sendChangeEventStep.maxRetries = 0;

export const _integrationType = "pagerduty";
