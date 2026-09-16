import { NextResponse } from "next/server";
import { getIntegration as getIntegrationFromDb } from "@/lib/db/integrations";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import {
  listEscalationPolicies,
  listServices,
  type PagerDutyEscalationPolicy,
  type PagerDutyService,
  subdomainFromHtmlUrl,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import { getCredentialMapping, getIntegration } from "@/plugins/registry";

export type PagerDutyResourcesResponse = {
  services?: PagerDutyService[];
  escalationPolicies?: PagerDutyEscalationPolicy[];
  /** Which PagerDuty account these came from, for the "who am I paging" line. */
  accountSubdomain?: string;
};

/**
 * Lists the services and escalation policies behind one PagerDuty connection,
 * for the pickers in the node config.
 *
 * Two things this deliberately does not do: it never returns an integration
 * key (the picker only needs ids and names, and a routing key is a
 * credential), and it never accepts credentials from the caller - the
 * connection is resolved from the caller's own organisation, so one
 * organisation cannot read another's PagerDuty account through this route.
 *
 * Names are served live rather than cached in the workflow: a service renamed
 * in PagerDuty keeps its id, so the node keeps paging the right rota and the
 * picker simply shows the new name.
 */
export async function GET(
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

  const scopeError = requireScope(authContext.scope, SCOPE_MCP_READ, {
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

  const plugin = getIntegration("pagerduty");
  if (!plugin) {
    return NextResponse.json(
      { error: "PagerDuty plugin is not registered" },
      { status: 500 }
    );
  }
  const credentials = getCredentialMapping(plugin, integration.config);

  const resource = new URL(request.url).searchParams.get("resource");
  const wantPolicies = resource === "escalation-policies";

  const result = wantPolicies
    ? await listEscalationPolicies(credentials)
    : await listServices(credentials);

  if (!result.ok) {
    // PagerDuty's own status is echoed for 401/403/402/404 so the picker can
    // say what is wrong; anything else is reported as an upstream failure.
    const status =
      result.failure.status && result.failure.status < 500
        ? result.failure.status
        : 502;
    return NextResponse.json({ error: result.failure.message }, { status });
  }

  const items = result.value as (
    | PagerDutyService
    | PagerDutyEscalationPolicy
  )[];
  const accountSubdomain = items
    .map((item) => subdomainFromHtmlUrl(item.htmlUrl))
    .find((subdomain) => subdomain !== undefined);

  return NextResponse.json(
    wantPolicies
      ? {
          escalationPolicies: items as PagerDutyEscalationPolicy[],
          accountSubdomain,
        }
      : { services: items as PagerDutyService[], accountSubdomain }
  );
}
