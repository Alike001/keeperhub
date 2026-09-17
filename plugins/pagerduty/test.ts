/**
 * Connection test for a PagerDuty credential.
 *
 * Reachable from the client-bundled plugin registry, so it cannot import the
 * server-only SSRF guard and uses the raw fetch global, like every other
 * plugin's test.ts. Both hosts it talks to are constants; the connection form
 * has no URL field for `handlePluginTest` to pre-flight.
 *
 * The check is GET /services?limit=1 rather than a generic ping, because that
 * is the exact permission every action needs: a token that cannot list
 * services cannot resolve a routing key, however valid it is.
 */
const API_HOST = "https://api.pagerduty.com";
const API_HOST_EU = "https://api.eu.pagerduty.com";
const IDENTITY_TOKEN_URL = "https://identity.pagerduty.com/oauth/token";
const OAUTH_SCOPES = "services.read escalation_policies.read";
/**
 * Every request here is bounded, as every request the steps make is.
 *
 * Without it a host that accepts the connection and never answers holds Test
 * Connection open for as long as the platform allows, with a spinner and no
 * way to tell it from a slow account. The 401 path makes a second round trip
 * to probe the other service region, so the exposure is two of these, not one.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const ACCEPT_V2 = "application/vnd.pagerduty+json;version=2";
/** Printable ASCII only, mirroring the guard the steps apply. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]{1,256}$/;
/** The region flag reaches this file as a string from a form or an env var. */
const TRUTHY_REGION_FLAGS: ReadonlySet<string> = new Set([
  "true",
  "1",
  "yes",
  "eu",
  "on",
]);

type TestResult = { success: boolean; error?: string };

async function resolveHeader(
  credentials: Record<string, string>,
  region: string
): Promise<{ header: string } | TestResult> {
  const token = credentials.PAGERDUTY_API_TOKEN?.trim();
  if (token) {
    // Without this, a token pasted with a line break makes fetch throw on the
    // header, and the catch below reports it as "could not reach PagerDuty" -
    // sending someone to check their network over a fixable paste. The steps
    // already refuse it with this message; Test Connection is where somebody
    // is most likely to have just pasted it.
    if (!HEADER_SAFE_TOKEN.test(token)) {
      return {
        success: false,
        error:
          "The API token contains characters that cannot go in a request header - it was probably pasted with a line break or a space. Re-copy it from PagerDuty.",
      };
    }
    return { header: `Token token=${token}` };
  }

  const clientId = credentials.PAGERDUTY_OAUTH_CLIENT_ID?.trim();
  const clientSecret = credentials.PAGERDUTY_OAUTH_CLIENT_SECRET?.trim();
  const subdomain = credentials.PAGERDUTY_SUBDOMAIN?.trim();
  if (!(clientId && clientSecret && subdomain)) {
    return {
      success: false,
      error:
        "Add a REST API token, or an OAuth client id, client secret and subdomain.",
    };
  }

  const response = await fetch(IDENTITY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: `as_account-${region}.${subdomain} ${OAUTH_SCOPES}`,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    return {
      success: false,
      error:
        response.status === 400 || response.status === 401
          ? "PagerDuty rejected the OAuth client credentials. Check the client id, secret and subdomain."
          : `PagerDuty could not issue an OAuth token (HTTP ${response.status}).`,
    };
  }

  const parsed = (await response.json()) as { access_token?: string };
  if (!parsed.access_token) {
    return { success: false, error: "PagerDuty returned no access token." };
  }
  return { header: `Bearer ${parsed.access_token}` };
}

function describeStatus(status: number): string {
  if (status === 401) {
    return "PagerDuty rejected the credentials. Check the token was copied in full.";
  }
  if (status === 403) {
    return "The credentials are valid but cannot read services. A read-only API key works; a scoped OAuth app needs services.read.";
  }
  if (status === 429) {
    return "PagerDuty rate limited the check. Try again in a minute.";
  }
  return `PagerDuty returned HTTP ${status}.`;
}

async function listServices(
  host: string,
  header: string
): Promise<Response> {
  return await fetch(`${host}/services?limit=1`, {
    method: "GET",
    headers: { Authorization: header, Accept: ACCEPT_V2 },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * A credential presented to the wrong regional host comes back as a plain 401,
 * which reads exactly like a mistyped token and sends people hunting in the
 * wrong place. On a 401 the other region is tried once: if it answers, the
 * region checkbox is the fault and the message says so.
 */
async function describeAuthFailure(
  credentials: Record<string, string>,
  region: "us" | "eu",
  status: number
): Promise<string> {
  if (status !== 401) {
    return describeStatus(status);
  }

  const otherRegion = region === "eu" ? "us" : "eu";
  const otherHost = otherRegion === "eu" ? API_HOST_EU : API_HOST;
  try {
    const auth = await resolveHeader(credentials, otherRegion);
    if ("header" in auth) {
      const response = await listServices(otherHost, auth.header);
      if (response.ok) {
        return otherRegion === "eu"
          ? "These credentials belong to a PagerDuty account in the EU service region. Tick EU service region."
          : "These credentials belong to a PagerDuty account in the US service region. Untick EU service region.";
      }
    }
  } catch {
    // The probe is a diagnostic: if it cannot run, fall through to the plain
    // message rather than turning a 401 into a network error.
  }
  return describeStatus(status);
}

export async function testPagerDuty(
  credentials: Record<string, string>
): Promise<TestResult> {
  try {
    const region = TRUTHY_REGION_FLAGS.has(
      credentials.PAGERDUTY_EU_REGION?.trim().toLowerCase() ?? ""
    )
      ? "eu"
      : "us";
    const host = region === "eu" ? API_HOST_EU : API_HOST;

    const auth = await resolveHeader(credentials, region);
    if (!("header" in auth)) {
      return auth;
    }

    const response = await listServices(host, auth.header);

    if (!response.ok) {
      return {
        success: false,
        error: await describeAuthFailure(credentials, region, response.status),
      };
    }

    return { success: true };
  } catch (error) {
    // A dropped connection between KeeperHub and PagerDuty is not a bad
    // token, and saying so stops someone rotating a perfectly good key
    // because the network blinked while they were setting it up.
    return {
      success: false,
      error: `Could not reach PagerDuty (${error instanceof Error ? error.message : String(error)}). The credentials were not checked - try again once the connection is back.`,
    };
  }
}
