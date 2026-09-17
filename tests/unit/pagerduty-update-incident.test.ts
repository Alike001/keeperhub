import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);
vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    VALIDATION: "validation",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: vi.fn(),
}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const { mockFetchCredentials } = vi.hoisted(() => ({
  mockFetchCredentials: vi.fn(),
}));
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

import { acknowledgeIncidentStep } from "@/plugins/pagerduty/steps/acknowledge-incident";
import {
  clearOAuthTokenCache,
  clearRoutingKeyCache,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import { resolveIncidentStep } from "@/plugins/pagerduty/steps/resolve-incident";

const CONTEXT = {
  nodeId: "node-9",
  nodeName: "Resolve",
  nodeType: "pagerduty/resolve-incident",
  workflowId: "wf-8",
  organizationId: "org-1",
};

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

function mockRoutingKey() {
  safeFetch
    .mockResolvedValueOnce(
      response(200, {
        service: {
          integrations: [
            { id: "PI1", type: "events_api_v2_inbound_integration" },
          ],
        },
      })
    )
    .mockResolvedValueOnce(
      response(200, { integration: { integration_key: "R1" } })
    );
}

beforeEach(() => {
  safeFetch.mockReset();
  mockFetchCredentials.mockReset();
  mockFetchCredentials.mockResolvedValue({ PAGERDUTY_API_TOKEN: "t" });
  clearOAuthTokenCache();
  clearRoutingKeyCache();
});

describe("resolve incident", () => {
  it("sends resolve with the dedup key of the alert it is closing", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, { status: "success" }));

    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKey: "keeperhub/wf-8/node-3",
      _context: CONTEXT,
    } as never);

    expect(result).toMatchObject({
      success: true,
      delivered: true,
      action: "resolve",
    });
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body).toEqual({
      routing_key: "R1",
      event_action: "resolve",
      dedup_key: "keeperhub/wf-8/node-3",
    });
  });

  /**
   * The Events API requires a dedup key for resolve, and deriving one from
   * this node's id would produce a key no alert has ever carried - PagerDuty
   * would answer 202 and drop it. Failing loudly is the only safe answer.
   */
  /**
   * The healthy branch of a check never runs the trigger node, so a template
   * reference to its output cannot resolve there. Picking the trigger node
   * derives the same key without needing it to have run.
   */
  it("derives the trigger node's key when the node is picked", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, {}));

    await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKeyFromNodeId: "node-3",
      _context: CONTEXT,
    } as never);

    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.dedup_key).toBe("keeperhub/wf-8/node-3");
  });

  it("prefers an explicit key over the picked node", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, {}));

    await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKeyFromNodeId: "node-3",
      dedupKey: "vault-7",
      _context: CONTEXT,
    } as never);

    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.dedup_key).toBe("vault-7");
  });

  it("refuses to run without a dedup key instead of sending one nothing matches", async () => {
    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      _context: CONTEXT,
    } as never);

    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect(result.error).toContain("Trigger Incident node");
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("reports the incident as already resolved when the check is on", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "PINC1", status: "resolved" }] })
      );

    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKey: "k1",
      verifyWithPagerDuty: true,
      _context: CONTEXT,
    } as never);

    // The read happens after the event, so this is the state observed
    // afterwards - it cannot claim the incident was ALREADY resolved.
    expect(result).toMatchObject({
      delivered: true,
      incidentStatus: "resolved",
    });
  });

  /**
   * The default dedup key is per node, so every incident that node has ever
   * opened carries it. PagerDuty sorts /incidents by created_at ascending, so
   * asking for one without a sort returns the oldest in the six-month window -
   * a resolve would read back the status of an incident from months ago.
   */
  it("asks PagerDuty for the newest incident carrying the key", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "PINC9", status: "resolved" }] })
      );

    await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKey: "k1",
      verifyWithPagerDuty: true,
      _context: CONTEXT,
    } as never);

    const url = String((safeFetch.mock.calls[3] as [string])[0]);
    expect(url).toContain("sort_by=created_at%3Adesc");
  });

  it("calls an inconclusive check unknown, and still succeeds", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(response(403, {}));

    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKey: "k1",
      verifyWithPagerDuty: true,
      _context: CONTEXT,
    } as never);

    expect(result).toMatchObject({
      success: true,
      delivered: true,
      incidentStatus: "unknown",
    });
    if (result.success) {
      expect(result.verificationError).toBeTruthy();
    }
  });

  it("does not call the incidents API when the check is off", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, {}));

    await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKey: "k1",
      _context: CONTEXT,
    } as never);

    expect(safeFetch).toHaveBeenCalledTimes(3);
  });
});

describe("acknowledge incident", () => {
  it("sends acknowledge, not resolve", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, {}));

    const result = await acknowledgeIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKey: "k1",
      _context: { ...CONTEXT, nodeType: "pagerduty/acknowledge-incident" },
    } as never);

    expect(result).toMatchObject({ action: "acknowledge" });
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.event_action).toBe("acknowledge");
  });

  it("reports an already acknowledged incident as such when checked", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "P1", status: "acknowledged" }] })
      );

    const result = await acknowledgeIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSKY1",
      dedupKey: "k1",
      verifyWithPagerDuty: true,
      _context: { ...CONTEXT, nodeType: "pagerduty/acknowledge-incident" },
    } as never);

    expect(result).toMatchObject({ incidentStatus: "acknowledged" });
  });
});
