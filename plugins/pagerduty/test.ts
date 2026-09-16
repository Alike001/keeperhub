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
const ACCEPT_V2 = "application/vnd.pagerduty+json;version=2";

type TestResult = { success: boolean; error?: string };

async function resolveHeader(
  credentials: Record<string, string>,
  region: string
): Promise<{ header: string } | TestResult> {
  const token = credentials.PAGERDUTY_API_TOKEN?.trim();
  if (token) {
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
    const region = credentials.PAGERDUTY_EU_REGION === "true" ? "eu" : "us";
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
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
