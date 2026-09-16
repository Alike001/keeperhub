/**
 * Backup notification for a page that could not be delivered.
 *
 * IMPORTANT: this file must NOT contain "use step".
 *
 * A PagerDuty outage, a revoked token or a deleted service must not end with
 * nobody being told. When the node is set to fall back, the trigger step calls
 * this with the alert it could not raise, and it posts through a connection
 * the organisation already has.
 *
 * The destination is always a stored connection, never a URL typed into the
 * node: every host below is a constant, so the PagerDuty plugin keeps its
 * fixed-host egress classification and a workflow cannot point it anywhere.
 * The channel is inferred from the credentials the connection holds, so
 * swapping the connection needs no second config field to be kept in sync.
 */
import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";

const PLUGIN = "pagerduty";
const REQUEST_TIMEOUT_MS = 10_000;
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const TELEGRAM_API_HOST = "https://api.telegram.org";
const DISCORD_WEBHOOK_HOSTS: ReadonlySet<string> = new Set([
  "discord.com",
  "discordapp.com",
]);

export type BackupChannel = "discord" | "slack" | "telegram";

export type BackupOutcome = {
  /** False when the node did not ask for a backup, or had nothing to send through. */
  attempted: boolean;
  delivered: boolean;
  channel?: BackupChannel;
  error?: string;
};

type Credentials = Record<string, string | undefined>;

function detectChannel(credentials: Credentials): BackupChannel | null {
  if (credentials.webhookUrl) {
    return "discord";
  }
  if (credentials.SLACK_API_KEY) {
    return "slack";
  }
  if (credentials.TELEGRAM_BOT_TOKEN) {
    return "telegram";
  }
  return null;
}

/** Host check on the stored webhook, the same shape the Discord step applies. */
function isDiscordWebhook(rawUrl: string): boolean {
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
  const allowed =
    DISCORD_WEBHOOK_HOSTS.has(host) ||
    host.endsWith(".discord.com") ||
    host.endsWith(".discordapp.com");
  return allowed && parsed.pathname.startsWith("/api/webhooks/");
}

async function postDiscord(
  credentials: Credentials,
  message: string
): Promise<BackupOutcome> {
  const webhookUrl = credentials.webhookUrl ?? "";
  if (!isDiscordWebhook(webhookUrl)) {
    return {
      attempted: true,
      delivered: false,
      channel: "discord",
      error: "The backup Discord connection does not hold a Discord webhook URL.",
    };
  }
  const response = await safeFetch(webhookUrl, {
    plugin: PLUGIN,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response.ok
    ? { attempted: true, delivered: true, channel: "discord" }
    : {
        attempted: true,
        delivered: false,
        channel: "discord",
        error: `Discord returned HTTP ${response.status}.`,
      };
}

async function postSlack(
  credentials: Credentials,
  destination: string,
  message: string
): Promise<BackupOutcome> {
  if (!destination) {
    return {
      attempted: true,
      delivered: false,
      channel: "slack",
      error: "A Slack backup needs a channel, for example #alerts.",
    };
  }
  const response = await safeFetch(SLACK_POST_MESSAGE_URL, {
    plugin: PLUGIN,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.SLACK_API_KEY}`,
    },
    body: JSON.stringify({ channel: destination, text: message }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  return response.ok && body.ok
    ? { attempted: true, delivered: true, channel: "slack" }
    : {
        attempted: true,
        delivered: false,
        channel: "slack",
        error: body.error ?? `Slack returned HTTP ${response.status}.`,
      };
}

async function postTelegram(
  credentials: Credentials,
  destination: string,
  message: string
): Promise<BackupOutcome> {
  if (!destination) {
    return {
      attempted: true,
      delivered: false,
      channel: "telegram",
      error: "A Telegram backup needs a chat id.",
    };
  }
  const response = await safeFetch(
    `${TELEGRAM_API_HOST}/bot${credentials.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      plugin: PLUGIN,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: destination, text: message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  return response.ok
    ? { attempted: true, delivered: true, channel: "telegram" }
    : {
        attempted: true,
        delivered: false,
        channel: "telegram",
        error: `Telegram returned HTTP ${response.status}.`,
      };
}

/** The message the responder sees instead of a page. */
export function buildBackupMessage(params: {
  summary: string;
  severity: string;
  serviceId: string;
  reason: string;
  workflowUrl?: string;
}): string {
  const lines = [
    "PagerDuty page FAILED - this is the backup notification.",
    `Alert: ${params.summary}`,
    `Severity: ${params.severity}`,
    `PagerDuty service: ${params.serviceId}`,
    `Why PagerDuty did not take it: ${params.reason}`,
  ];
  if (params.workflowUrl) {
    lines.push(`Workflow: ${params.workflowUrl}`);
  }
  return lines.join("\n");
}

/**
 * Post the backup message. Never throws: a failed backup is reported in the
 * step output next to the PagerDuty failure that caused it, because the one
 * thing worse than a missed page is a missed page whose backup failed silently.
 */
export async function sendBackupNotification(params: {
  integrationId?: string;
  destination?: string;
  organizationId?: string | null;
  message: string;
}): Promise<BackupOutcome> {
  if (!params.integrationId) {
    return { attempted: false, delivered: false };
  }

  try {
    const credentials = (await fetchCredentials(params.integrationId, {
      organizationId: params.organizationId ?? null,
    })) as Credentials;

    const channel = detectChannel(credentials);
    const destination = params.destination?.trim() ?? "";

    if (channel === "discord") {
      return await postDiscord(credentials, params.message);
    }
    if (channel === "slack") {
      return await postSlack(credentials, destination, params.message);
    }
    if (channel === "telegram") {
      return await postTelegram(credentials, destination, params.message);
    }
    return {
      attempted: true,
      delivered: false,
      error:
        "The backup connection is not a Discord, Slack or Telegram connection, or it no longer exists.",
    };
  } catch (error) {
    return {
      attempted: true,
      delivered: false,
      error: `Backup notification failed: ${getErrorMessage(error)}`,
    };
  }
}
