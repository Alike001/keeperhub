import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { safeFetch } from "@/lib/safe-fetch";
import { sleep } from "@/lib/sleep";
import { getErrorMessage } from "@/lib/utils";
import {
  isRetryableHttpStatus,
  linearBackoffMs,
  parseRetryAfterHeaderMs,
  resolveRetryAttempts,
  resolveRetryDelayMs,
} from "@/lib/workflow/retry-policy";
import type { DiscordCredentials } from "../credentials";

type DiscordWebhookResponse = {
  id?: string;
  type?: number;
  channel_id?: string;
  message?: string;
  code?: number;
  /** Seconds to wait before retrying; present on 429 responses. */
  retry_after?: number;
  global?: boolean;
};

type SendDiscordMessageResult =
  | { success: true; messageId: string }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type SendDiscordMessageCoreInput = {
  discordMessage: string;
  /** Extra attempts after the first; a string when set from the editor. */
  retryAttempts?: number | string;
  /** Base backoff in seconds; a string when set from the editor. */
  retryDelay?: number | string;
};

export type SendDiscordMessageInput = StepInput &
  SendDiscordMessageCoreInput & {
    integrationId: string;
  };

const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);

/**
 * Retry policy for transient Discord failures. Parsing, clamping, the
 * retryable status set and the linear backoff are shared with the HTTP
 * Request node (lib/workflow/retry-policy.ts); only the limits are local.
 * The workflow engine's own retries stay off for this step (maxRetries = 0
 * below), so this loop is the only place a webhook post is re-attempted.
 * Retries default to none, so a node only retries when its author opted in.
 * A 429 waits for the interval Discord asks for; other transient failures
 * back off linearly from the configured delay. Every wait is capped at
 * RETRY_MAX_DELAY_MS so a step never hangs on a long global rate limit.
 */
const RETRY_ATTEMPT_LIMITS = { defaultAttempts: 0, maxAttempts: 5 };
const RETRY_DELAY_LIMITS = { defaultDelaySeconds: 1, maxDelaySeconds: 15 };
const RETRY_MAX_DELAY_MS = RETRY_DELAY_LIMITS.maxDelaySeconds * 1000;
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Validates a Discord webhook URL by hostname over https, not by substring.
 * A substring match on "discord.com/api/webhooks/" is satisfied by an
 * off-host URL that carries it in the path (e.g.
 * https://10.0.0.1/discord.com/api/webhooks/x), which points egress at an
 * internal host. The safeFetch SSRF guard is the network-layer backstop;
 * this rejects an off-host URL before any request is attempted.
 */
function isValidDiscordWebhookUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const hostAllowed =
    DISCORD_WEBHOOK_HOSTS.has(host) ||
    host.endsWith(".discord.com") ||
    host.endsWith(".discordapp.com");
  if (!hostAllowed) {
    return false;
  }
  return parsed.pathname.startsWith("/api/webhooks/");
}

/**
 * One attempt outcome, kept separate from the step result so the retry loop
 * can tell a transient failure from one that will fail identically on the
 * next attempt without re-parsing error strings.
 */
type AttemptOutcome =
  | { kind: "success"; messageId: string }
  | {
      kind: "http-error";
      status: number;
      error: string;
      /** Milliseconds Discord asked us to wait, when it said. */
      retryAfterMs?: number;
    }
  | { kind: "network-error"; error: string };

/**
 * Discord reports the rate-limit wait in two places: a `retry_after` body
 * field in seconds (fractional) and a `Retry-After` header in whole seconds.
 * The body is preferred because it carries sub-second precision. Returns
 * undefined when neither is a usable number.
 */
function parseRetryAfterMs(
  response: Response,
  body: DiscordWebhookResponse
): number | undefined {
  if (typeof body.retry_after === "number" && body.retry_after >= 0) {
    return Math.ceil(body.retry_after * 1000);
  }
  return parseRetryAfterHeaderMs(response.headers?.get?.("retry-after"));
}

async function attemptSend(
  webhookUrl: string,
  content: string
): Promise<AttemptOutcome> {
  try {
    const response = await safeFetch(webhookUrl, {
      plugin: "discord",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({}))) as DiscordWebhookResponse;
      const retryAfterMs =
        response.status === HTTP_TOO_MANY_REQUESTS
          ? parseRetryAfterMs(response, errorData)
          : undefined;
      return {
        kind: "http-error",
        status: response.status,
        error:
          errorData.message ||
          `HTTP ${response.status}: Failed to send Discord message`,
        retryAfterMs,
      };
    }

    // Discord webhooks return 204 No Content on success or the message object
    const result =
      response.status === 204
        ? null
        : ((await response.json().catch(() => ({}))) as DiscordWebhookResponse);

    return { kind: "success", messageId: result?.id || "sent" };
  } catch (error) {
    return {
      kind: "network-error",
      error: `Failed to send Discord message: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * The retryable statuses are the HTTP Request node's set (408, 425, 429 and
 * the transient 5xx family); a network error most often means the connection
 * never completed. Every other 4xx (bad payload, unknown webhook, forbidden)
 * fails identically on retry and is not retried.
 */
function isRetryable(outcome: AttemptOutcome): boolean {
  if (outcome.kind === "network-error") {
    return true;
  }
  return outcome.kind === "http-error" && isRetryableHttpStatus(outcome.status);
}

/**
 * Wait before the given retry (1-based). A 429 uses Discord's own interval;
 * everything else backs off linearly. Both are capped.
 */
function retryDelayMs(
  outcome: AttemptOutcome,
  retry: number,
  baseDelayMs: number
): number {
  const fallback = linearBackoffMs(baseDelayMs, retry);
  const requested =
    outcome.kind === "http-error" && outcome.retryAfterMs !== undefined
      ? outcome.retryAfterMs
      : fallback;
  return Math.min(requested, RETRY_MAX_DELAY_MS);
}

function toResult(outcome: AttemptOutcome): SendDiscordMessageResult {
  if (outcome.kind === "success") {
    return { success: true, messageId: outcome.messageId };
  }
  if (outcome.kind === "network-error") {
    return {
      success: false,
      error: outcome.error,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
  const external = isRetryableHttpStatus(outcome.status) || outcome.status >= 500;
  return {
    success: false,
    error: outcome.error,
    errorClass: external ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
  };
}

/**
 * Core logic - portable between app and export
 */
async function stepHandler(
  input: SendDiscordMessageCoreInput,
  credentials: DiscordCredentials
): Promise<SendDiscordMessageResult> {
  console.log("[Discord] Starting send message step");

  const webhookUrl = credentials.webhookUrl;

  if (!webhookUrl) {
    logUserError(
      ErrorCategory.CONFIGURATION,
      "[Discord] No webhook URL provided in integration",
      undefined,
      {
        plugin_name: "discord",
        action_name: "send-message",
      }
    );
    return {
      success: false,
      error:
        "Discord webhook URL is required. Please configure it in the integration settings.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Validate webhook URL by hostname (not substring) before egress
  if (!isValidDiscordWebhookUrl(webhookUrl)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Discord] Invalid webhook URL format",
      webhookUrl,
      {
        plugin_name: "discord",
        action_name: "send-message",
      }
    );
    return {
      success: false,
      error: "Invalid Discord webhook URL format",
      errorClass: ExecutionErrorType.USER,
    };
  }

  console.log("[Discord] Sending message to webhook");

  const maxRetries = resolveRetryAttempts(
    input.retryAttempts,
    RETRY_ATTEMPT_LIMITS
  );
  const baseDelayMs = resolveRetryDelayMs(input.retryDelay, RETRY_DELAY_LIMITS);

  let outcome = await attemptSend(webhookUrl, input.discordMessage);
  for (let retry = 1; retry <= maxRetries; retry++) {
    if (outcome.kind === "success" || !isRetryable(outcome)) {
      break;
    }
    const delayMs = retryDelayMs(outcome, retry, baseDelayMs);
    console.log(
      `[Discord] Transient failure, retrying in ${delayMs}ms (${retry}/${maxRetries}): ${outcome.error}`
    );
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    outcome = await attemptSend(webhookUrl, input.discordMessage);
  }

  if (outcome.kind === "success") {
    console.log("[Discord] Message sent successfully");
    return toResult(outcome);
  }

  logUserError(
    ErrorCategory.EXTERNAL_SERVICE,
    outcome.kind === "http-error"
      ? "[Discord] API error:"
      : "[Discord] Error sending message:",
    outcome.error,
    {
      plugin_name: "discord",
      action_name: "send-message",
      service: "discord",
    }
  );
  return toResult(outcome);
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function sendDiscordMessageStep(
  input: SendDiscordMessageInput
): Promise<SendDiscordMessageResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null });

  return runPluginStep(
    { pluginName: "discord", actionName: "send-message" },
    input,
    () => stepHandler(input, credentials)
  );
}
sendDiscordMessageStep.maxRetries = 0;

export const _integrationType = "discord";
