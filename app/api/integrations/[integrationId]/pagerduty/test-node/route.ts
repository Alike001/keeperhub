import { NextResponse } from "next/server";
import { getIntegration as getIntegrationFromDb } from "@/lib/db/integrations";
import { isIntegrationCreatorDeactivated } from "@/lib/integrations/authorization";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { generateId } from "@/lib/utils/id";
import {
  buildTriggerEvent,
  buildUpdateEvent,
  findIncidentByKey,
  isPagerDutyId,
  postEvent,
  resolveRoutingKey,
  serviceSwallowsEvents,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import { getCredentialMapping, getIntegration } from "@/plugins/registry";

/**
 * Send a real alert through a PagerDuty service and take it back again, so
 * somebody configuring a node can see it work before an incident depends on it.
 *
 * It is a round trip on purpose: trigger, acknowledge, resolve, in that order
 * and against one dedup key of its own. Each leg is the same call the node
 * makes, so this exercises the routing key, the service's Events API v2
 * integration and the account's permissions rather than approximating them -
 * and it ends with nothing open, because a test that leaves an alert behind is
 * one somebody has to go and tidy up in PagerDuty.
 *
 * It does put a real alert on a real service for a few seconds. The dedup key
 * is this route's own, never a node's, so a test can neither merge into an
 * alert a workflow opened nor resolve one; and the summary says what it is, in
 * case the service notifies before the resolve lands.
 */

type Leg = {
  step: "trigger" | "acknowledge" | "resolve";
  ok: boolean;
  error?: string;
};

export type PagerDutyTestNodeResponse = {
  ok: boolean;
  legs: Leg[];
  /** The alert this test opened and closed, when PagerDuty would say. */
  incidentUrl?: string;
  /** Set when the service takes events and raises no incident from them. */
  warning?: string;
  dedupKey: string;
};

type TestNodeBody = { serviceId?: string; summary?: string };

const SUMMARY_PREFIX = "KeeperHub test alert";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> }
): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return NextResponse.json(
      { error: authContext.error },
      { status: authContext.status }
    );
  }

  // A write scope, not a read one: this genuinely pages a service.
  const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
    credentialType: authContext.authMethod,
  });
  if (scopeError) {
    return scopeError;
  }

  const { integrationId } = await params;
  if (!integrationId) {
    return NextResponse.json(
      { error: "integrationId is required" },
      { status: 400 }
    );
  }

  let body: TestNodeBody = {};
  try {
    body = (await request.json()) as TestNodeBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 }
    );
  }

  const serviceId = body.serviceId?.trim() ?? "";
  if (!isPagerDutyId(serviceId)) {
    return NextResponse.json(
      { error: "Select a PagerDuty service on the node first." },
      { status: 400 }
    );
  }

  const integration = await getIntegrationFromDb(
    integrationId,
    authContext.userId ?? "",
    authContext.organizationId
  );
  if (!integration) {
    return NextResponse.json(
      { error: "Connection not found" },
      { status: 404 }
    );
  }
  if (integration.type !== "pagerduty") {
    return NextResponse.json(
      { error: "This connection is not a PagerDuty connection" },
      { status: 400 }
    );
  }

  // A deactivated creator freezes their connections for everyone, and that has
  // to hold here too. The run-time credential fetch enforces it; this route
  // reads the connection directly, so without this an offboarded person's
  // PagerDuty credential would still work from the editor.
  if (await isIntegrationCreatorDeactivated(integration.createdBy)) {
    return NextResponse.json(
      {
        error:
          "The person who created this connection has been deactivated, which freezes the connections they added. Recreate it under an active member.",
      },
      { status: 403 }
    );
  }

  const plugin = getIntegration("pagerduty");
  if (!plugin) {
    return NextResponse.json(
      { error: "PagerDuty plugin is not registered" },
      { status: 500 }
    );
  }
  const credentials = getCredentialMapping(plugin, integration.config);

  const routingKey = await resolveRoutingKey(credentials, serviceId);
  if (!routingKey.ok) {
    return NextResponse.json(
      { error: routingKey.failure.message },
      { status: 502 }
    );
  }

  // This route's own key, never a node's, so a test can neither merge into an
  // alert a workflow opened nor close one.
  const dedupKey = `keeperhub/test/${generateId()}`;
  const summary = body.summary?.trim()
    ? `${SUMMARY_PREFIX}: ${body.summary.trim()}`
    : `${SUMMARY_PREFIX} - configuring a workflow, no action needed`;

  const legs: Leg[] = [];
  const { body: triggerBody } = buildTriggerEvent({
    routingKey: routingKey.value.routingKey,
    dedupKey,
    timestamp: new Date().toISOString(),
    input: {
      summary,
      // The lowest severity there is. A test should not page at high urgency
      // on a service whose rule keys off severity.
      severity: "info",
      source: "KeeperHub connection test",
      customDetails: {
        keeperhub_test: true,
        note: "Sent by KeeperHub from the node configuration screen, and resolved immediately afterwards.",
      },
      client: "KeeperHub",
    },
  });

  const triggered = await postEvent(credentials, triggerBody);
  legs.push({
    step: "trigger",
    ok: triggered.ok,
    error: triggered.ok ? undefined : triggered.failure.message,
  });

  if (triggered.ok) {
    for (const action of ["acknowledge", "resolve"] as const) {
      const result = await postEvent(
        credentials,
        buildUpdateEvent({
          routingKey: routingKey.value.routingKey,
          dedupKey,
          action,
        })
      );
      legs.push({
        step: action,
        ok: result.ok,
        error: result.ok ? undefined : result.failure.message,
      });
    }
  }

  // Best effort, and never the reason the test fails: it needs incidents.read,
  // which a scoped OAuth app only has if it was granted.
  let incidentUrl: string | undefined;
  if (triggered.ok) {
    const lookup = await findIncidentByKey(credentials, {
      serviceId,
      incidentKey: dedupKey,
    });
    if (lookup.ok) {
      incidentUrl = lookup.value.htmlUrl;
    }
  }

  const suppressed = serviceSwallowsEvents(routingKey.value.serviceStatus);
  const response: PagerDutyTestNodeResponse = {
    ok: legs.every((leg) => leg.ok),
    legs,
    incidentUrl,
    dedupKey,
    warning: suppressed
      ? `PagerDuty accepted every event, but this service is ${routingKey.value.serviceStatus} and raises no incident from them - so this test proves the routing works and proves nothing about anybody being paged.`
      : undefined,
  };
  return NextResponse.json(response);
}
