/**
 * Shared PagerDuty client and payload builder.
 *
 * IMPORTANT: this file must NOT contain "use step". It is imported by the
 * plugin's step files and by the picker API route, so it exports functions
 * freely; a "use step" file may not.
 *
 * Two PagerDuty APIs are in play and they are not interchangeable:
 *
 * - Events API v2 (events.pagerduty.com/v2/enqueue) takes a per-service
 *   routing key and merges repeat triggers that carry the same dedup key into
 *   the open alert. That merge behaviour is why every action here always sends
 *   a dedup key: it makes a retry, and a re-run of the same check, idempotent.
 * - The REST API (api.pagerduty.com) is used read-only, to list the account's
 *   services and escalation policies and to resolve a service's routing key.
 *   The one exception is the create-incident action, which posts an incident
 *   and is the only action needing a write-capable credential.
 *
 * Hosts are fixed per region, chosen by a checkbox on the connection. No
 * config value reaches the host, so the plugin stays `egress: "fixed-host"`
 * and a workflow can never redirect it.
 */
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import {
  isConnectionFailure,
  isRetryableHttpStatus,
  parseRetryAfterHeaderMs,
} from "@/lib/workflow/retry-policy";
import type { PagerDutyCredentials } from "../credentials";
import {
  buildTriggerEvent,
  MAX_DEDUP_KEY_CHARS,
  MAX_SUMMARY_CHARS,
  type PagerDutyEventBody,
  truncateRunes,
} from "../event-payload";

export {
  buildTriggerEvent,
  buildUpdateEvent,
  deriveDedupKey,
  MAX_DEDUP_KEY_CHARS,
  MAX_EVENT_BYTES,
  MAX_SUMMARY_CHARS,
  normaliseSeverity,
  type PagerDutyEventBody,
  type PagerDutySeverity,
  truncateRunes,
} from "../event-payload";

const EVENTS_HOST = "https://events.pagerduty.com";
const EVENTS_HOST_EU = "https://events.eu.pagerduty.com";
const API_HOST = "https://api.pagerduty.com";
const API_HOST_EU = "https://api.eu.pagerduty.com";
const IDENTITY_TOKEN_URL = "https://identity.pagerduty.com/oauth/token";

const REQUEST_TIMEOUT_MS = 10_000;
const PLUGIN = "pagerduty";
const ACCEPT_V2 = "application/vnd.pagerduty+json;version=2";
/** Scopes the read paths need. services.read also covers reading a service's integrations. */
const OAUTH_SCOPES = "services.read escalation_policies.read incidents.write";
/** Renew a little before expiry so a call never races the boundary. */
const OAUTH_EXPIRY_SKEW_MS = 60_000;

export type PagerDutyService = {
  id: string;
  name: string;
  escalationPolicyId?: string;
  escalationPolicyName?: string;
  /** False when the service has no Events API v2 integration to route events through. */
  acceptsEvents: boolean;
  htmlUrl?: string;
};

export type PagerDutyEscalationPolicy = {
  id: string;
  name: string;
  htmlUrl?: string;
};

/**
 * Why a PagerDuty call failed, in the shape the steps and the picker route
 * both need: a message for the user, whether another attempt could help, and
 * the status for logging.
 */
export type PagerDutyFailure = {
  message: string;
  status?: number;
  retryable: boolean;
  /** Milliseconds PagerDuty asked us to wait, when it said. */
  retryAfterMs?: number;
};

export type PagerDutyResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: PagerDutyFailure };

/**
 * PagerDuty resource ids are short alphanumeric strings. Every id below is
 * also percent-encoded before it reaches a URL, so this is defence in depth:
 * it stops a crafted config value from being smuggled into a request path or
 * a header at all, and gives a clear error instead of a confusing 404.
 */
const PAGERDUTY_ID = /^[A-Za-z0-9_-]{2,64}$/;

export function isPagerDutyId(value: string): boolean {
  return PAGERDUTY_ID.test(value);
}

/**
 * A `From` header value PagerDuty will accept and no proxy can misread. The
 * shape check is loose on purpose - PagerDuty owns the real validation - but
 * control characters are rejected outright, because a header value carrying
 * CR or LF is a header-injection attempt, never a typo.
 */
const HEADER_SAFE_EMAIL = /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;

export function isHeaderSafeEmail(value: string): boolean {
  return value.length <= 320 && HEADER_SAFE_EMAIL.test(value);
}

function invalidId(kind: string, value: string): PagerDutyFailure {
  return {
    message: `"${value}" is not a valid PagerDuty ${kind} id. Pick the ${kind} again on this node rather than typing an id by hand.`,
    retryable: false,
  };
}

export function isEuRegion(credentials: PagerDutyCredentials): boolean {
  return credentials.PAGERDUTY_EU_REGION === "true";
}

export function eventsUrl(
  credentials: PagerDutyCredentials,
  path: string
): string {
  return `${isEuRegion(credentials) ? EVENTS_HOST_EU : EVENTS_HOST}${path}`;
}

export function apiUrl(
  credentials: PagerDutyCredentials,
  path: string
): string {
  return `${isEuRegion(credentials) ? API_HOST_EU : API_HOST}${path}`;
}

/**
 * In-process cache of OAuth bearer tokens, keyed by client id, subdomain and
 * region. Tokens are short-lived and never persisted: a restart simply
 * re-exchanges the client credentials.
 */
const oauthTokens = new Map<string, { header: string; expiresAt: number }>();

/** Exported for tests, which need a clean cache between cases. */
export function clearOAuthTokenCache(): void {
  oauthTokens.clear();
}

/**
 * Drop a cached bearer token. Called on a 401 so a token revoked in PagerDuty
 * - the app registration deleted, its scopes narrowed, the owning user
 * deactivated - is re-exchanged on the next call instead of being retried from
 * cache until it expires on its own.
 */
function invalidateOAuthToken(credentials: PagerDutyCredentials): void {
  oauthTokens.delete(oauthCacheKey(credentials));
}

type OAuthTokenResponse = { access_token?: string; expires_in?: number };

function oauthCacheKey(credentials: PagerDutyCredentials): string {
  return [
    credentials.PAGERDUTY_OAUTH_CLIENT_ID ?? "",
    credentials.PAGERDUTY_SUBDOMAIN ?? "",
    isEuRegion(credentials) ? "eu" : "us",
  ].join("|");
}

async function fetchOAuthHeader(
  credentials: PagerDutyCredentials
): Promise<PagerDutyResult<string>> {
  const clientId = credentials.PAGERDUTY_OAUTH_CLIENT_ID ?? "";
  const clientSecret = credentials.PAGERDUTY_OAUTH_CLIENT_SECRET ?? "";
  const subdomain = credentials.PAGERDUTY_SUBDOMAIN ?? "";
  const region = isEuRegion(credentials) ? "eu" : "us";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: `as_account-${region}.${subdomain} ${OAUTH_SCOPES}`,
  });

  try {
    const response = await safeFetch(IDENTITY_TOKEN_URL, {
      plugin: PLUGIN,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        ok: false,
        failure: {
          message:
            response.status === 400 || response.status === 401
              ? "PagerDuty rejected the OAuth client credentials. Check the client id, secret and subdomain, and that the app grants services.read."
              : `PagerDuty could not issue an OAuth token (HTTP ${response.status}).`,
          status: response.status,
          retryable: isRetryableHttpStatus(response.status),
        },
      };
    }

    const parsed = (await response.json()) as OAuthTokenResponse;
    if (!parsed.access_token) {
      return {
        ok: false,
        failure: {
          message: "PagerDuty returned no access token for these credentials.",
          retryable: false,
        },
      };
    }

    const header = `Bearer ${parsed.access_token}`;
    const lifetimeMs = (parsed.expires_in ?? 0) * 1000;
    if (lifetimeMs > OAUTH_EXPIRY_SKEW_MS) {
      oauthTokens.set(oauthCacheKey(credentials), {
        header,
        expiresAt: Date.now() + lifetimeMs - OAUTH_EXPIRY_SKEW_MS,
      });
    }
    return { ok: true, value: header };
  } catch (error) {
    return {
      ok: false,
      failure: {
        message: `Could not reach PagerDuty to exchange the OAuth credentials: ${getErrorMessage(error)}`,
        retryable: isConnectionFailure(error),
      },
    };
  }
}

/**
 * The Authorization header for REST calls. An API token wins when both are
 * set, because it needs no round trip; otherwise the OAuth client credentials
 * are exchanged for a bearer token and cached until shortly before expiry.
 */
export async function resolveAuthHeader(
  credentials: PagerDutyCredentials
): Promise<PagerDutyResult<string>> {
  const token = credentials.PAGERDUTY_API_TOKEN?.trim();
  if (token) {
    return { ok: true, value: `Token token=${token}` };
  }

  const hasOAuth =
    credentials.PAGERDUTY_OAUTH_CLIENT_ID &&
    credentials.PAGERDUTY_OAUTH_CLIENT_SECRET &&
    credentials.PAGERDUTY_SUBDOMAIN;
  if (!hasOAuth) {
    return {
      ok: false,
      failure: {
        message:
          "This PagerDuty connection has no credentials. Add a REST API token, or an OAuth client id, secret and subdomain.",
        retryable: false,
      },
    };
  }

  const cached = oauthTokens.get(oauthCacheKey(credentials));
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, value: cached.header };
  }
  return await fetchOAuthHeader(credentials);
}

function restFailure(status: number, detail?: string): PagerDutyFailure {
  if (status === 401) {
    return {
      message:
        "PagerDuty rejected the credentials (401). Rotate the token in Settings, Connections.",
      status,
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      message:
        "PagerDuty refused the request (403). The credentials are valid but lack the read access this needs (services.read).",
      status,
      retryable: false,
    };
  }
  // 402 is PagerDuty's documented "account does not have the abilities to
  // perform the action": a lapsed subscription, or a plan that no longer
  // covers this. Retrying cannot fix it and the account owner has to act.
  if (status === 402) {
    return {
      message:
        "PagerDuty answered 402: this account's plan does not allow the request. Check the PagerDuty subscription - a lapsed or downgraded account stops serving the API.",
      status,
      retryable: false,
    };
  }
  return {
    message: detail ?? `PagerDuty returned HTTP ${status}.`,
    status,
    retryable: isRetryableHttpStatus(status),
  };
}

/** One authenticated GET against the REST API, with the failure already classified. */
async function restGet<T>(
  credentials: PagerDutyCredentials,
  path: string
): Promise<PagerDutyResult<T>> {
  const auth = await resolveAuthHeader(credentials);
  if (!auth.ok) {
    return auth;
  }

  try {
    const response = await safeFetch(apiUrl(credentials, path), {
      plugin: PLUGIN,
      method: "GET",
      headers: { Authorization: auth.value, Accept: ACCEPT_V2 },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 401) {
        invalidateOAuthToken(credentials);
      }
      return {
        ok: false,
        failure: {
          ...restFailure(response.status),
          retryAfterMs: parseRetryAfterHeaderMs(
            response.headers?.get?.("retry-after")
          ),
        },
      };
    }

    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    // Deliberately stricter than the events path: an incident key that repeats
    // is rejected rather than merged, so a retry after a lost response could
    // create a second incident. Only a request that provably never left is
    // safe to repeat.
    return {
      ok: false,
      failure: {
        message: `Could not reach PagerDuty: ${getErrorMessage(error)}`,
        retryable: isConnectionFailure(error),
      },
    };
  }
}

type ServiceIntegrationRef = { id?: string; type?: string };

type ServiceResponseItem = {
  id?: string;
  name?: string;
  html_url?: string;
  escalation_policy?: { id?: string; summary?: string };
  integrations?: ServiceIntegrationRef[];
};

const EVENTS_V2_INTEGRATION_TYPES: ReadonlySet<string> = new Set([
  "events_api_v2_inbound_integration",
  "events_api_v2_inbound_integration_reference",
]);

function toService(item: ServiceResponseItem): PagerDutyService | null {
  if (!(item.id && item.name)) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    escalationPolicyId: item.escalation_policy?.id,
    escalationPolicyName: item.escalation_policy?.summary,
    acceptsEvents: (item.integrations ?? []).some((integration) =>
      EVENTS_V2_INTEGRATION_TYPES.has(integration.type ?? "")
    ),
    htmlUrl: item.html_url,
  };
}

/**
 * The account's services, with the escalation policy each one pages and
 * whether it can take events at all. One page of 100 covers every account we
 * would show in a dropdown; the picker filters client-side from there.
 */
export async function listServices(
  credentials: PagerDutyCredentials
): Promise<PagerDutyResult<PagerDutyService[]>> {
  const result = await restGet<{ services?: ServiceResponseItem[] }>(
    credentials,
    "/services?limit=100&sort_by=name&include%5B%5D=escalation_policies&include%5B%5D=integrations"
  );
  if (!result.ok) {
    return result;
  }
  const services: PagerDutyService[] = [];
  for (const item of result.value.services ?? []) {
    const service = toService(item);
    if (service) {
      services.push(service);
    }
  }
  return { ok: true, value: services };
}

export async function listEscalationPolicies(
  credentials: PagerDutyCredentials
): Promise<PagerDutyResult<PagerDutyEscalationPolicy[]>> {
  const result = await restGet<{
    escalation_policies?: { id?: string; name?: string; html_url?: string }[];
  }>(credentials, "/escalation_policies?limit=100&sort_by=name");
  if (!result.ok) {
    return result;
  }
  const policies: PagerDutyEscalationPolicy[] = [];
  for (const item of result.value.escalation_policies ?? []) {
    if (item.id && item.name) {
      policies.push({ id: item.id, name: item.name, htmlUrl: item.html_url });
    }
  }
  return { ok: true, value: policies };
}

/**
 * The routing key of a service's Events API v2 integration.
 *
 * Kept out of the workflow definition on purpose: a routing key is a
 * credential, and a workflow is exported, shared and listed. It is read here,
 * per run, from the service id the node stores.
 */
export async function resolveRoutingKey(
  credentials: PagerDutyCredentials,
  serviceId: string
): Promise<PagerDutyResult<string>> {
  if (!isPagerDutyId(serviceId)) {
    return { ok: false, failure: invalidId("service", serviceId) };
  }
  const service = await restGet<{ service?: ServiceResponseItem }>(
    credentials,
    `/services/${encodeURIComponent(serviceId)}?include%5B%5D=integrations`
  );
  if (!service.ok) {
    if (service.failure.status === 404) {
      return {
        ok: false,
        failure: {
          message: `PagerDuty service ${serviceId} no longer exists, or these credentials cannot see it. Pick the service again on this node.`,
          status: 404,
          retryable: false,
        },
      };
    }
    return service;
  }

  const integration = (service.value.service?.integrations ?? []).find((item) =>
    EVENTS_V2_INTEGRATION_TYPES.has(item.type ?? "")
  );
  if (!integration?.id) {
    return {
      ok: false,
      failure: {
        message: `PagerDuty service ${serviceId} has no Events API v2 integration, so it cannot accept events. Add one in PagerDuty under Service, Integrations.`,
        retryable: false,
      },
    };
  }

  const detail = await restGet<{ integration?: { integration_key?: string } }>(
    credentials,
    `/services/${encodeURIComponent(serviceId)}/integrations/${encodeURIComponent(integration.id)}`
  );
  if (!detail.ok) {
    return detail;
  }

  const key = detail.value.integration?.integration_key;
  if (!key) {
    return {
      ok: false,
      failure: {
        message:
          "PagerDuty did not return the integration key for this service. The credentials may lack permission to read it.",
        retryable: false,
      },
    };
  }
  return { ok: true, value: key };
}

type EventsApiResponse = {
  status?: string;
  message?: string;
  dedup_key?: string;
  errors?: string[];
};

/**
 * POST one event. A 202 is the only success; a 400 names what PagerDuty
 * disliked and is never worth another attempt, while 429 and 5xx are.
 */
export async function postEvent(
  credentials: PagerDutyCredentials,
  body: PagerDutyEventBody | Record<string, unknown>,
  path = "/v2/enqueue"
): Promise<PagerDutyResult<{ dedupKey?: string; message?: string }>> {
  try {
    const response = await safeFetch(eventsUrl(credentials, path), {
      plugin: PLUGIN,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const parsed = (await response
      .json()
      .catch(() => ({}))) as EventsApiResponse;

    if (!response.ok) {
      const detail = parsed.errors?.length
        ? `${parsed.message ?? "PagerDuty rejected the event"}: ${parsed.errors.join("; ")}`
        : (parsed.message ??
          `PagerDuty rejected the event (HTTP ${response.status}).`);
      return {
        ok: false,
        failure: {
          message: detail,
          status: response.status,
          retryable: isRetryableHttpStatus(response.status),
          retryAfterMs: parseRetryAfterHeaderMs(
            response.headers?.get?.("retry-after")
          ),
        },
      };
    }

    return {
      ok: true,
      value: { dedupKey: parsed.dedup_key, message: parsed.message },
    };
  } catch (error) {
    // Any network fault is worth another attempt here, not only the ones that
    // prove the request never left the process. A chat integration has to be
    // stricter, because a reply whose response was lost would post twice; an
    // event carries a dedup key, so a duplicate merges into the same alert.
    // A dropped connection mid-flight is exactly when a page must still land.
    return {
      ok: false,
      failure: {
        message: `Could not reach PagerDuty: ${getErrorMessage(error)}. The event was not confirmed.`,
        retryable: true,
      },
    };
  }
}

/**
 * Post an event, retrying transient failures.
 *
 * Retrying is safe here in a way it is not for a chat message: every event
 * this plugin sends carries a dedup key, so an event that arrives twice
 * updates one alert instead of paging twice. The retryable set is the shared
 * one (408, 425, 429 and the transient 5xx family) plus errors that prove the
 * request never left this process. A 400 is a payload problem and is never
 * retried. A 429 waits for the interval PagerDuty reports, when it reports
 * one, and backs off linearly otherwise.
 */
export async function postEventWithRetries(params: {
  credentials: PagerDutyCredentials;
  body: PagerDutyEventBody | Record<string, unknown>;
  path?: string;
  maxRetries: number;
  baseDelayMs: number;
  onRetry?: (failure: PagerDutyFailure, attempt: number, delayMs: number) => void;
  wait: (ms: number) => Promise<void>;
}): Promise<PagerDutyResult<{ dedupKey?: string; message?: string }>> {
  let result = await postEvent(params.credentials, params.body, params.path);

  for (let retry = 1; retry <= params.maxRetries; retry++) {
    if (result.ok || !result.failure.retryable) {
      break;
    }
    const delayMs = result.failure.retryAfterMs ?? params.baseDelayMs * retry;
    params.onRetry?.(result.failure, retry, delayMs);
    if (delayMs > 0) {
      await params.wait(delayMs);
    }
    result = await postEvent(params.credentials, params.body, params.path);
  }

  return result;
}

/**
 * Fault domain for a PagerDuty failure. A rejected credential or a service
 * that no longer exists is the workflow author's to fix; a rate limit or a
 * 5xx is PagerDuty's.
 */
export function failureIsExternal(failure: PagerDutyFailure): boolean {
  if (failure.status === undefined) {
    // No status means the request never got an answer: a network fault.
    return true;
  }
  return failure.status >= 500 || isRetryableHttpStatus(failure.status);
}

/** One escalation policy by id. Used to tell "deleted" from "PagerDuty is unhappy" before an incident is posted. */
export async function getEscalationPolicy(
  credentials: PagerDutyCredentials,
  policyId: string
): Promise<PagerDutyResult<PagerDutyEscalationPolicy | null>> {
  if (!isPagerDutyId(policyId)) {
    return { ok: false, failure: invalidId("escalation policy", policyId) };
  }
  const result = await restGet<{
    escalation_policy?: { id?: string; name?: string; html_url?: string };
  }>(credentials, `/escalation_policies/${encodeURIComponent(policyId)}`);

  if (!result.ok) {
    if (result.failure.status === 404) {
      return { ok: true, value: null };
    }
    return result;
  }

  const policy = result.value.escalation_policy;
  if (!(policy?.id && policy.name)) {
    return { ok: true, value: null };
  }
  return {
    ok: true,
    value: { id: policy.id, name: policy.name, htmlUrl: policy.html_url },
  };
}

export type CreateIncidentParams = {
  serviceId: string;
  title: string;
  fromEmail: string;
  details?: string;
  urgency?: "high" | "low";
  incidentKey?: string;
  escalationPolicyId?: string;
};

export type CreatedIncident = {
  id: string;
  number?: number;
  htmlUrl?: string;
  status?: string;
};

/**
 * POST /incidents. The only write this plugin makes, and the only action that
 * can override the escalation policy, set urgency, or carry an incident key
 * that PagerDuty rejects on repeat rather than merging.
 */
export async function createIncident(
  credentials: PagerDutyCredentials,
  params: CreateIncidentParams
): Promise<PagerDutyResult<CreatedIncident>> {
  if (!isPagerDutyId(params.serviceId)) {
    return { ok: false, failure: invalidId("service", params.serviceId) };
  }
  if (!isHeaderSafeEmail(params.fromEmail)) {
    return {
      ok: false,
      failure: {
        message:
          "The From email is not a valid email address. PagerDuty sends it as a request header, so it has to be one.",
        retryable: false,
      },
    };
  }

  const auth = await resolveAuthHeader(credentials);
  if (!auth.ok) {
    return auth;
  }

  const incident: Record<string, unknown> = {
    type: "incident",
    title: truncateRunes(params.title, MAX_SUMMARY_CHARS),
    service: { id: params.serviceId, type: "service_reference" },
  };
  if (params.details?.trim()) {
    incident.body = { type: "incident_body", details: params.details };
  }
  if (params.urgency) {
    incident.urgency = params.urgency;
  }
  if (params.incidentKey?.trim()) {
    incident.incident_key = truncateRunes(
      params.incidentKey.trim(),
      MAX_DEDUP_KEY_CHARS
    );
  }
  if (params.escalationPolicyId) {
    incident.escalation_policy = {
      id: params.escalationPolicyId,
      type: "escalation_policy_reference",
    };
  }

  try {
    const response = await safeFetch(apiUrl(credentials, "/incidents"), {
      plugin: PLUGIN,
      method: "POST",
      headers: {
        Authorization: auth.value,
        Accept: ACCEPT_V2,
        "Content-Type": "application/json",
        From: params.fromEmail,
      },
      body: JSON.stringify({ incident }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const parsed = (await response.json().catch(() => ({}))) as {
      incident?: { id?: string; incident_number?: number; html_url?: string; status?: string };
      error?: { message?: string; errors?: string[] };
    };

    if (!response.ok) {
      if (response.status === 401) {
        invalidateOAuthToken(credentials);
      }
      const detail = parsed.error?.errors?.length
        ? `${parsed.error.message ?? "PagerDuty rejected the incident"}: ${parsed.error.errors.join("; ")}`
        : (parsed.error?.message ??
          restFailure(response.status).message);
      return {
        ok: false,
        failure: {
          message: detail,
          status: response.status,
          retryable: isRetryableHttpStatus(response.status),
          retryAfterMs: parseRetryAfterHeaderMs(
            response.headers?.get?.("retry-after")
          ),
        },
      };
    }

    const created = parsed.incident;
    if (!created?.id) {
      return {
        ok: false,
        failure: {
          message: "PagerDuty accepted the request but returned no incident.",
          retryable: false,
        },
      };
    }

    return {
      ok: true,
      value: {
        id: created.id,
        number: created.incident_number,
        htmlUrl: created.html_url,
        status: created.status,
      },
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        message: `Could not reach PagerDuty: ${getErrorMessage(error)}`,
        retryable: isConnectionFailure(error),
      },
    };
  }
}

const PAGERDUTY_HOST_SUFFIX = ".pagerduty.com";

/**
 * The account a connection actually points at, read from any html_url
 * PagerDuty returns (they are all subdomain.pagerduty.com/...). Shown next to
 * the service picker so nobody wires a production page into a sandbox account
 * without noticing - the connection name alone does not prove which account it
 * holds. Renaming the account changes this line and nothing else, because
 * every id stays the same.
 */
export function subdomainFromHtmlUrl(
  htmlUrl: string | undefined
): string | undefined {
  if (!htmlUrl) {
    return;
  }
  try {
    const host = new URL(htmlUrl).hostname.toLowerCase();
    if (!host.endsWith(PAGERDUTY_HOST_SUFFIX)) {
      return;
    }
    const label = host.slice(0, -PAGERDUTY_HOST_SUFFIX.length);
    // EU accounts publish subdomain.eu.pagerduty.com.
    const subdomain = label.endsWith(".eu") ? label.slice(0, -3) : label;
    return subdomain || undefined;
  } catch {
    return;
  }
}

export type IncidentLookup = {
  status: "triggered" | "acknowledged" | "resolved" | "unknown";
  id?: string;
  htmlUrl?: string;
};

/**
 * Find the incident carrying a dedup key on a service.
 *
 * Exists because the Events API cannot answer "did that actually land". It
 * accepts an acknowledge or a resolve with 202 and then drops it when no open
 * alert matches - the alert was already resolved, the key was never used, or
 * the event went through a different service's routing key. A read here turns
 * that silence into a state the workflow can report.
 *
 * "unknown" is a real answer, not an error: a service with alert grouping
 * turned on produces incidents that carry child alerts and no incident key, so
 * a miss does not prove the alert is absent. Callers must not fail a run on it.
 */
export async function findIncidentByKey(
  credentials: PagerDutyCredentials,
  params: { serviceId: string; incidentKey: string }
): Promise<PagerDutyResult<IncidentLookup>> {
  if (!isPagerDutyId(params.serviceId)) {
    return { ok: false, failure: invalidId("service", params.serviceId) };
  }
  const query = new URLSearchParams({
    incident_key: params.incidentKey,
    limit: "1",
  });
  query.append("service_ids[]", params.serviceId);
  for (const status of ["triggered", "acknowledged", "resolved"]) {
    query.append("statuses[]", status);
  }

  const result = await restGet<{
    incidents?: { id?: string; status?: string; html_url?: string }[];
  }>(credentials, `/incidents?${query.toString()}`);
  if (!result.ok) {
    return result;
  }

  const incident = result.value.incidents?.[0];
  if (!incident?.id) {
    return { ok: true, value: { status: "unknown" } };
  }

  const status = incident.status;
  return {
    ok: true,
    value: {
      status:
        status === "triggered" ||
        status === "acknowledged" ||
        status === "resolved"
          ? status
          : "unknown",
      id: incident.id,
      htmlUrl: incident.html_url,
    },
  };
}
