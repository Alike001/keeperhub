import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { subdomainFromHtmlUrl } from "@/plugins/pagerduty/steps/pagerduty-core";

/**
 * The picker's "open it in PagerDuty" link is built from the account it read,
 * not from the service's own `html_url` - the case it exists for is a service
 * the account no longer lists, which therefore has no `html_url` here.
 *
 * The one part that has to be right is the account, and the picker learns it
 * by parsing the url of some other object PagerDuty returned. These pin that
 * round trip: the host this builds must be the host PagerDuty itself uses.
 */
function pagerDutyServiceUrl(
  subdomain: string,
  euRegion: boolean | undefined,
  serviceId: string
): string {
  return `https://${subdomain}${euRegion ? ".eu" : ""}.pagerduty.com/services/${encodeURIComponent(serviceId)}`;
}

describe("the PagerDuty service link", () => {
  it("matches the shape PagerDuty returns for a US account", () => {
    const fromPagerDuty = "https://acme.pagerduty.com/services/PSKY1";
    const subdomain = subdomainFromHtmlUrl(fromPagerDuty);
    expect(subdomain).toBe("acme");
    expect(pagerDutyServiceUrl(subdomain ?? "", false, "PSKY1")).toBe(
      fromPagerDuty
    );
  });

  it("matches the shape PagerDuty returns for an EU account", () => {
    const fromPagerDuty = "https://acme.eu.pagerduty.com/services/PSKY1";
    const subdomain = subdomainFromHtmlUrl(fromPagerDuty);
    // The parser strips the region, which is why the builder puts it back.
    expect(subdomain).toBe("acme");
    expect(pagerDutyServiceUrl(subdomain ?? "", true, "PSKY1")).toBe(
      fromPagerDuty
    );
  });

  /**
   * The id reaching this link is one the account could not account for, so it
   * is whatever the node had stored - never assume it is a well-formed id.
   */
  it("encodes an id rather than letting it shape the path", () => {
    expect(pagerDutyServiceUrl("acme", false, "../../admin")).toBe(
      "https://acme.pagerduty.com/services/..%2F..%2Fadmin"
    );
    expect(pagerDutyServiceUrl("acme", false, "P 1?x=2")).toBe(
      "https://acme.pagerduty.com/services/P%201%3Fx%3D2"
    );
  });

  it("stays on pagerduty.com whatever the id is", () => {
    for (const id of ["../../../evil.com", "PSKY1#@evil.com", "a/b"]) {
      expect(new URL(pagerDutyServiceUrl("acme", false, id)).hostname).toBe(
        "acme.pagerduty.com"
      );
    }
  });
});
