/**
 * Pure Events API v2 payload helpers - no network, no server-only imports.
 *
 * Split out of the step core so the node's payload preview can build exactly
 * the body the step will send, in the browser, without pulling the SSRF guard
 * into a client bundle. One builder, one set of limits, one place to change
 * them.
 */
export type PagerDutySeverity = "critical" | "error" | "warning" | "info";

/** PagerDuty truncates a longer summary itself; doing it here keeps the alert title readable. */
export const MAX_SUMMARY_CHARS = 1024;
/** Documented dedup key limit. */
export const MAX_DEDUP_KEY_CHARS = 255;
/** Documented Events API v2 size limit for one event. */
export const MAX_EVENT_BYTES = 512_000;

const SEVERITIES: ReadonlySet<string> = new Set([
  "critical",
  "error",
  "warning",
  "info",
]);

/** Trim to a rune count, so a multi-byte summary is not cut mid-character. */
/**
 * UTF-8 byte length without Buffer: this module is imported by the node's
 * preview, which runs in the browser.
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function truncateRunes(value: string, max: number): string {
  const runes = [...value];
  return runes.length <= max ? value : runes.slice(0, max).join("");
}

export function normaliseSeverity(raw: unknown): PagerDutySeverity {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SEVERITIES.has(value) ? (value as PagerDutySeverity) : "error";
}

/**
 * A dedup key that is stable for the node across runs, so a check that keeps
 * failing updates one alert instead of paging on every run. A node-scoped
 * default is the monitoring convention: the alert represents the condition,
 * not the run that noticed it.
 */
export function deriveDedupKey(
  configured: string | undefined,
  context: { workflowId?: string; nodeId?: string }
): string {
  const explicit = configured?.trim();
  if (explicit) {
    return truncateRunes(explicit, MAX_DEDUP_KEY_CHARS);
  }
  const workflowId = context.workflowId ?? "workflow";
  const nodeId = context.nodeId ?? "node";
  return truncateRunes(
    `keeperhub/${workflowId}/${nodeId}`,
    MAX_DEDUP_KEY_CHARS
  );
}

export type EventPayloadInput = {
  summary: string;
  severity: unknown;
  source: string;
  component?: string;
  group?: string;
  class?: string;
  customDetails?: Record<string, unknown>;
  links?: { href: string; text: string }[];
  client?: string;
  clientUrl?: string;
};

export type PagerDutyEventBody = {
  routing_key: string;
  event_action: "trigger" | "acknowledge" | "resolve";
  dedup_key: string;
  client?: string;
  client_url?: string;
  links?: { href: string; text: string }[];
  payload?: {
    summary: string;
    severity: PagerDutySeverity;
    source: string;
    timestamp: string;
    component?: string;
    group?: string;
    class?: string;
    custom_details?: Record<string, unknown>;
  };
};

function omitEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build a trigger body, then make it fit. An event over the documented 512 KB
 * limit is rejected outright by PagerDuty, so the custom details are dropped
 * and replaced by a note rather than losing the page - the same trade
 * Alertmanager and Grafana make.
 */
export function buildTriggerEvent(params: {
  routingKey: string;
  dedupKey: string;
  timestamp: string;
  input: EventPayloadInput;
}): { body: PagerDutyEventBody; detailsDropped: boolean } {
  const { input } = params;
  const body: PagerDutyEventBody = {
    routing_key: params.routingKey,
    event_action: "trigger",
    dedup_key: params.dedupKey,
    client: omitEmpty(input.client),
    client_url: omitEmpty(input.clientUrl),
    links: input.links?.length ? input.links : undefined,
    payload: {
      summary: truncateRunes(input.summary, MAX_SUMMARY_CHARS),
      severity: normaliseSeverity(input.severity),
      // PagerDuty documents no limit on source, but an unbounded templated
      // value is how an event ends up over the size limit with nothing left
      // to drop.
      source: truncateRunes(input.source, MAX_SUMMARY_CHARS),
      timestamp: params.timestamp,
      component: omitEmpty(input.component),
      group: omitEmpty(input.group),
      class: omitEmpty(input.class),
      custom_details: input.customDetails,
    },
  };

  if (byteLength(JSON.stringify(body)) <= MAX_EVENT_BYTES) {
    return { body, detailsDropped: false };
  }

  if (body.payload) {
    body.payload.custom_details = {
      error: `Custom details were removed because the event exceeded PagerDuty's ${MAX_EVENT_BYTES} byte limit.`,
    };
  }
  // Dropping the details is the only lever here; if the event is still too
  // large, the links are the remaining unbounded field and they go too. The
  // alert itself - summary, severity, routing - is never sacrificed.
  if (byteLength(JSON.stringify(body)) > MAX_EVENT_BYTES) {
    body.links = undefined;
  }
  return { body, detailsDropped: true };
}

export function buildUpdateEvent(params: {
  routingKey: string;
  dedupKey: string;
  action: "acknowledge" | "resolve";
}): PagerDutyEventBody {
  return {
    routing_key: params.routingKey,
    event_action: params.action,
    dedup_key: params.dedupKey,
  };
}
