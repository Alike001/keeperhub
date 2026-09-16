import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testPagerDuty } from "@/plugins/pagerduty/test";

const originalFetch = global.fetch;
const fetchMock = vi.fn();

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("PagerDuty connection test", () => {
  it("checks the permission the plugin actually needs", async () => {
    fetchMock.mockResolvedValue(response(200, { services: [] }));
    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result).toEqual({ success: true });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.pagerduty.com/services?limit=1"
    );
  });

  it("uses the EU host when the account is in the EU region", async () => {
    fetchMock.mockResolvedValue(response(200, {}));
    await testPagerDuty({
      PAGERDUTY_API_TOKEN: "t",
      PAGERDUTY_EU_REGION: "true",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("api.eu.pagerduty.com");
  });

  /**
   * The most confusing failure this connection has: a US account with the EU
   * box ticked answers 401, which reads as a bad token.
   */
  it("names the region when the credentials work in the other one", async () => {
    fetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, {}));

    const result = await testPagerDuty({
      PAGERDUTY_API_TOKEN: "t",
      PAGERDUTY_EU_REGION: "true",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("US service region");
    expect(result.error).toContain("Untick");
  });

  it("names the other direction too", async () => {
    fetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, {}));

    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result.error).toContain("EU service region");
    expect(result.error).toContain("Tick");
  });

  it("reports a genuinely bad token as a bad token", async () => {
    fetchMock.mockResolvedValue(response(401));
    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result.error).toContain("rejected the credentials");
  });

  it("explains a token that cannot read services", async () => {
    fetchMock.mockResolvedValue(response(403));
    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result.error).toContain("services.read");
  });

  it("asks for credentials when the form is empty", async () => {
    const result = await testPagerDuty({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("REST API token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges OAuth client credentials before checking access", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: "abc" }))
      .mockResolvedValueOnce(response(200, {}));

    const result = await testPagerDuty({
      PAGERDUTY_OAUTH_CLIENT_ID: "client",
      PAGERDUTY_OAUTH_CLIENT_SECRET: "secret",
      PAGERDUTY_SUBDOMAIN: "acme",
    });

    expect(result).toEqual({ success: true });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://identity.pagerduty.com/oauth/token"
    );
  });
});
