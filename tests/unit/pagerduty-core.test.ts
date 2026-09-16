import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import {
  clearOAuthTokenCache,
  createIncident,
  findIncidentByKey,
  listServices,
  postEvent,
  postEventWithRetries,
  resolveAuthHeader,
  resolveRoutingKey,
  subdomainFromHtmlUrl,
} from "@/plugins/pagerduty/steps/pagerduty-core";

const TOKEN_CREDS = { PAGERDUTY_API_TOKEN: "u+token" };
const OAUTH_CREDS = {
  PAGERDUTY_OAUTH_CLIENT_ID: "client",
  PAGERDUTY_OAUTH_CLIENT_SECRET: "secret",
  PAGERDUTY_SUBDOMAIN: "acme",
};

function response(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  };
}

function lastCall(index = 0): [string, Record<string, unknown>] {
  return safeFetch.mock.calls[index] as [string, Record<string, unknown>];
}

beforeEach(() => {
  safeFetch.mockReset();
  clearOAuthTokenCache();
});

describe("resolveAuthHeader", () => {
  it("uses the API token directly, with no round trip", async () => {
    const result = await resolveAuthHeader(TOKEN_CREDS);
    expect(result).toEqual({ ok: true, value: "Token token=u+token" });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("exchanges OAuth client credentials and caches the bearer token", async () => {
    safeFetch.mockResolvedValue(
      response(200, { access_token: "abc", expires_in: 3600 })
    );

    const first = await resolveAuthHeader(OAUTH_CREDS);
    const second = await resolveAuthHeader(OAUTH_CREDS);

    expect(first).toEqual({ ok: true, value: "Bearer abc" });
    expect(second).toEqual({ ok: true, value: "Bearer abc" });
    expect(safeFetch).toHaveBeenCalledTimes(1);

    const [url, init] = lastCall();
    expect(url).toBe("https://identity.pagerduty.com/oauth/token");
    expect(String(init.body)).toContain("grant_type=client_credentials");
    expect(String(init.body)).toContain("as_account-us.acme");
  });

  it("scopes the OAuth request to the EU account when the region is set", async () => {
    safeFetch.mockResolvedValue(
      response(200, { access_token: "abc", expires_in: 3600 })
    );
    await resolveAuthHeader({ ...OAUTH_CREDS, PAGERDUTY_EU_REGION: "true" });
    expect(String(lastCall()[1].body)).toContain("as_account-eu.acme");
  });

  it("explains a rejected OAuth app rather than echoing the status", async () => {
    safeFetch.mockResolvedValue(response(401, {}));
    const result = await resolveAuthHeader(OAUTH_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("rejected the OAuth client");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("asks for credentials when the connection holds none", async () => {
    const result = await resolveAuthHeader({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("no credentials");
    }
  });
});

describe("listServices", () => {
  it("maps the account's services, including whether they can take events", async () => {
    safeFetch.mockResolvedValue(
      response(200, {
        services: [
          {
            id: "PSKY1",
            name: "Sky Keeper Bots",
            html_url: "https://acme.pagerduty.com/service-directory/PSKY1",
            escalation_policy: { id: "PEP1", summary: "Platform On-Call" },
            integrations: [
              { id: "PI1", type: "events_api_v2_inbound_integration" },
            ],
          },
          {
            id: "PSKY2",
            name: "Email only",
            integrations: [
              { id: "PI2", type: "generic_email_inbound_integration" },
            ],
          },
        ],
      })
    );

    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatchObject({
        id: "PSKY1",
        name: "Sky Keeper Bots",
        escalationPolicyName: "Platform On-Call",
        acceptsEvents: true,
      });
      expect(result.value[1].acceptsEvents).toBe(false);
    }
    expect(lastCall()[0]).toContain("https://api.pagerduty.com/services");
  });

  it("talks to the EU host for an EU account", async () => {
    safeFetch.mockResolvedValue(response(200, { services: [] }));
    await listServices({ ...TOKEN_CREDS, PAGERDUTY_EU_REGION: "true" });
    expect(lastCall()[0]).toContain("https://api.eu.pagerduty.com/");
  });

  it("names the missing read access on a 403 instead of saying 'failed'", async () => {
    safeFetch.mockResolvedValue(response(403, {}));
    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("services.read");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("calls out a lapsed PagerDuty subscription on a 402", async () => {
    safeFetch.mockResolvedValue(response(402, {}));
    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("subscription");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("points at connection rotation on a 401", async () => {
    safeFetch.mockResolvedValue(response(401, {}));
    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("Settings");
    }
  });

  it("re-exchanges an OAuth token after a 401 instead of reusing the cached one", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, { access_token: "a", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce(
        response(200, { access_token: "b", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(200, { services: [] }));

    await listServices(OAUTH_CREDS);
    const second = await listServices(OAUTH_CREDS);

    expect(second.ok).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(4);
  });
});

describe("resolveRoutingKey", () => {
  it("reads the key from the service's Events API v2 integration", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          service: {
            id: "PSKY1",
            integrations: [
              { id: "PI9", type: "events_api_v2_inbound_integration" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        response(200, { integration: { integration_key: "R123" } })
      );

    const result = await resolveRoutingKey(TOKEN_CREDS, "PSKY1");
    expect(result).toEqual({ ok: true, value: "R123" });
  });

  it("says the service is gone on a 404, and does not ask for a retry", async () => {
    safeFetch.mockResolvedValue(response(404, {}));
    const result = await resolveRoutingKey(TOKEN_CREDS, "PGONE");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("PGONE");
      expect(result.failure.message).toContain("no longer exists");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("explains a service with no Events integration", async () => {
    safeFetch.mockResolvedValue(
      response(200, {
        service: {
          id: "PSKY2",
          integrations: [
            { id: "PI2", type: "generic_email_inbound_integration" },
          ],
        },
      })
    );
    const result = await resolveRoutingKey(TOKEN_CREDS, "PSKY2");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("no Events API v2 integration");
    }
  });

  it("does not invent a key when PagerDuty withholds it", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          service: {
            integrations: [
              { id: "PI9", type: "events_api_v2_inbound_integration" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(response(200, { integration: {} }));

    const result = await resolveRoutingKey(TOKEN_CREDS, "PSKY1");
    expect(result.ok).toBe(false);
  });
});

describe("postEvent", () => {
  it("posts to the events host and returns the dedup key PagerDuty settled on", async () => {
    safeFetch.mockResolvedValue(
      response(202, {
        status: "success",
        message: "Event processed",
        dedup_key: "k1",
      })
    );
    const result = await postEvent(TOKEN_CREDS, { routing_key: "R1" } as never);
    expect(result).toEqual({
      ok: true,
      value: { dedupKey: "k1", message: "Event processed" },
    });
    expect(lastCall()[0]).toBe("https://events.pagerduty.com/v2/enqueue");
  });

  it("quotes PagerDuty's own errors on a 400 and refuses to retry it", async () => {
    safeFetch.mockResolvedValue(
      response(400, {
        status: "invalid event",
        message: "Event object is invalid",
        errors: ["Invalid routing key"],
      })
    );
    const result = await postEvent(TOKEN_CREDS, {} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("Invalid routing key");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("treats a rate limit as retryable and keeps PagerDuty's own wait", async () => {
    safeFetch.mockResolvedValue(response(429, {}, { "retry-after": "3" }));
    const result = await postEvent(TOKEN_CREDS, {} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.retryable).toBe(true);
      expect(result.failure.retryAfterMs).toBe(3000);
    }
  });
});

describe("postEventWithRetries", () => {
  it("retries a 500 and reports the eventual success", async () => {
    safeFetch
      .mockResolvedValueOnce(response(500, {}))
      .mockResolvedValueOnce(response(202, { dedup_key: "k1" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await postEventWithRetries({
      credentials: TOKEN_CREDS,
      body: {} as never,
      maxRetries: 2,
      baseDelayMs: 1000,
      wait,
    });

    expect(result.ok).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1000);
  });

  it("never retries a rejected payload", async () => {
    safeFetch.mockResolvedValue(response(400, { message: "bad" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await postEventWithRetries({
      credentials: TOKEN_CREDS,
      body: {} as never,
      maxRetries: 3,
      baseDelayMs: 1000,
      wait,
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("honours the wait PagerDuty asks for on a rate limit", async () => {
    safeFetch
      .mockResolvedValueOnce(response(429, {}, { "retry-after": "5" }))
      .mockResolvedValueOnce(response(202, {}));
    const wait = vi.fn().mockResolvedValue(undefined);

    await postEventWithRetries({
      credentials: TOKEN_CREDS,
      body: {} as never,
      maxRetries: 1,
      baseDelayMs: 1000,
      wait,
    });

    expect(wait).toHaveBeenCalledWith(5000);
  });
});

describe("findIncidentByKey", () => {
  it("reports the incident's status", async () => {
    safeFetch.mockResolvedValue(
      response(200, {
        incidents: [{ id: "PINC1", status: "resolved", html_url: "https://x" }],
      })
    );
    const result = await findIncidentByKey(TOKEN_CREDS, {
      serviceId: "PSKY1",
      incidentKey: "k1",
    });
    expect(result).toEqual({
      ok: true,
      value: { status: "resolved", id: "PINC1", htmlUrl: "https://x" },
    });
  });

  it("answers unknown rather than 'absent' when PagerDuty returns nothing", async () => {
    safeFetch.mockResolvedValue(response(200, { incidents: [] }));
    const result = await findIncidentByKey(TOKEN_CREDS, {
      serviceId: "PSKY1",
      incidentKey: "k1",
    });
    expect(result).toEqual({ ok: true, value: { status: "unknown" } });
  });
});

describe("createIncident", () => {
  it("sends the From header PagerDuty requires and returns the incident", async () => {
    safeFetch.mockResolvedValue(
      response(201, {
        incident: {
          id: "PINC1",
          incident_number: 42,
          html_url: "https://acme.pagerduty.com/incidents/PINC1",
          status: "triggered",
        },
      })
    );

    const result = await createIncident(TOKEN_CREDS, {
      serviceId: "PSKY1",
      title: "Keeper stalled",
      fromEmail: "ops@acme.io",
    });

    expect(result.ok).toBe(true);
    const [url, init] = lastCall();
    expect(url).toBe("https://api.pagerduty.com/incidents");
    expect((init.headers as Record<string, string>).From).toBe("ops@acme.io");
  });

  it("carries the escalation policy override when one is given", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    await createIncident(TOKEN_CREDS, {
      serviceId: "PSKY1",
      title: "t",
      fromEmail: "ops@acme.io",
      escalationPolicyId: "PEP9",
    });
    const body = JSON.parse(String(lastCall()[1].body));
    expect(body.incident.escalation_policy).toEqual({
      id: "PEP9",
      type: "escalation_policy_reference",
    });
  });
});

describe("subdomainFromHtmlUrl", () => {
  it("reads the account from a US url", () => {
    expect(
      subdomainFromHtmlUrl("https://acme.pagerduty.com/service-directory/P1")
    ).toBe("acme");
  });

  it("reads the account from an EU url", () => {
    expect(
      subdomainFromHtmlUrl("https://acme.eu.pagerduty.com/incidents/P1")
    ).toBe("acme");
  });

  it("ignores anything that is not a PagerDuty url", () => {
    expect(subdomainFromHtmlUrl("https://example.com/x")).toBeUndefined();
    expect(subdomainFromHtmlUrl(undefined)).toBeUndefined();
    expect(subdomainFromHtmlUrl("not a url")).toBeUndefined();
  });
});
