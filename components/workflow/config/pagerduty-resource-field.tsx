"use client";

import { AlertTriangle, Info, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  PagerDutyEscalationPolicy,
  PagerDutyPriority,
  PagerDutyService,
} from "@/plugins/pagerduty/steps/pagerduty-core";

type Resource = "services" | "escalation-policies" | "priorities";

type LoadState<T> = {
  items: T[];
  loading: boolean;
  /** A message from PagerDuty or the route, shown instead of the list. */
  error: string | null;
  /** The account these came from, e.g. "acme" for acme.pagerduty.com. */
  accountSubdomain?: string;
  /** True when the account holds more than the route paged through. */
  truncated?: boolean;
};

/**
 * Lists a PagerDuty connection's services or escalation policies.
 *
 * Names are never stored on the node: only the id is, so a service renamed in
 * PagerDuty keeps paging the same rota and simply shows its new name here.
 * The flip side is that a deleted object cannot be resolved to a name, which
 * is exactly the case the warning below exists for.
 */
function usePagerDutyResources<T>(
  integrationId: string | undefined,
  resource: Resource,
  pick: (body: {
    services?: PagerDutyService[];
    escalationPolicies?: PagerDutyEscalationPolicy[];
    priorities?: PagerDutyPriority[];
    accountSubdomain?: string;
    truncated?: boolean;
  }) => T[]
): LoadState<T> & { reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({
    items: [],
    loading: false,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!integrationId) {
      setState({ items: [], loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ items: [], loading: true, error: null });

    fetch(
      `/api/integrations/${encodeURIComponent(integrationId)}/pagerduty/resources?resource=${resource}`
    )
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setState({
            items: [],
            loading: false,
            error:
              typeof body?.error === "string"
                ? body.error
                : `PagerDuty could not be reached (HTTP ${response.status}).`,
          });
          return;
        }
        setState({
          items: pick(body),
          loading: false,
          error: null,
          accountSubdomain:
            typeof body?.accountSubdomain === "string"
              ? body.accountSubdomain
              : undefined,
          truncated: body?.truncated === true,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // A fetch that rejects never reached KeeperHub, so this says nothing
        // about PagerDuty or the credentials. Saying "could not load services"
        // here would send someone looking at the wrong thing, and the stored
        // service id is deliberately left alone: see `missing` below, which
        // only warns when the list actually loaded.
        setState({
          items: [],
          loading: false,
          error:
            typeof navigator !== "undefined" && navigator.onLine === false
              ? "You are offline, so the service list could not be loaded. What is already configured on this node is untouched."
              : `Could not reach KeeperHub to load the service list${error instanceof Error ? ` (${error.message})` : ""}. Nothing configured on this node has changed.`,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [integrationId, resource, pick, nonce]);

  return { ...state, reload };
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warning";
  children: React.ReactNode;
}) {
  const Icon = tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-2 text-xs ${
        tone === "warning"
          ? "border-yellow-500/40 bg-yellow-500/5 text-yellow-700 dark:text-yellow-300"
          : "border-border bg-muted/30 text-muted-foreground"
      }`}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ReloadButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="inline-flex items-center gap-1 text-muted-foreground text-xs underline hover:text-foreground"
      onClick={onClick}
      type="button"
    >
      <RefreshCw className="size-3" />
      Reload from PagerDuty
    </button>
  );
}

const pickServices = (body: { services?: PagerDutyService[] }) =>
  body.services ?? [];

/** The same live service list, for the payload and incident preview. */
export function usePagerDutyServices(integrationId: string | undefined) {
  return usePagerDutyResources(integrationId, "services", pickServices);
}
const pickPolicies = (body: {
  escalationPolicies?: PagerDutyEscalationPolicy[];
}) => body.escalationPolicies ?? [];

const pickPriorities = (body: { priorities?: PagerDutyPriority[] }) =>
  body.priorities ?? [];

export function PagerDutyServiceField({
  value,
  disabled,
  integrationId,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  integrationId?: string;
  onChange: (value: string) => void;
}) {
  const { items, loading, error, reload, accountSubdomain, truncated } =
    usePagerDutyResources(integrationId, "services", pickServices);

  const selected = items.find((service) => service.id === value);
  // A stored id that the account no longer lists: deleted, moved, or outside
  // what these credentials can see. The id is kept exactly as it is - silently
  // repointing a node at another service would send a page to another team.
  // Never claimed on a truncated list, where the service may simply be on a
  // page nobody fetched.
  const missing =
    Boolean(value) && !(loading || error || truncated) && !selected;

  if (!integrationId) {
    return (
      <Notice tone="info">
        Select a PagerDuty connection first - the services are read from that
        account.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled || loading}
        onValueChange={onChange}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          {loading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading services
            </span>
          ) : (
            <SelectValue placeholder="Select a service" />
          )}
        </SelectTrigger>
        <SelectContent>
          {items.map((service) => (
            <SelectItem key={service.id} value={service.id}>
              <span className="flex flex-col items-start">
                <span>{service.name}</span>
                <span className="text-muted-foreground text-xs">
                  <span className="font-mono">{service.id}</span>
                  {" - "}
                  {service.escalationPolicyName
                    ? `pages ${service.escalationPolicyName}`
                    : "no escalation policy visible"}
                  {service.acceptsEvents ? "" : " - takes no events"}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {(accountSubdomain || selected) && (
        <p className="ml-1 text-muted-foreground text-xs">
          {accountSubdomain ? (
            <span className="font-mono">{accountSubdomain}.pagerduty.com</span>
          ) : null}
          {accountSubdomain && selected ? " - " : null}
          {selected ? <span className="font-mono">{selected.id}</span> : null}
        </p>
      )}

      {error && (
        <Notice tone="warning">
          <p>{error}</p>
          <div className="mt-1">
            <ReloadButton onClick={reload} />
          </div>
        </Notice>
      )}

      {!(loading || error) && items.length === 0 && (
        <Notice tone="warning">
          This PagerDuty account has no services. A service is what an alert
          attaches to and what carries the escalation policy - create one in
          PagerDuty, give it an Events API v2 integration, then reload.
          <div className="mt-1">
            <ReloadButton onClick={reload} />
          </div>
        </Notice>
      )}

      {missing && (
        <Notice tone="warning">
          Service <code className="font-mono">{value}</code> is not in this
          account any more - deleted, or outside what this connection can see.
          The node still points at it, so nothing has been quietly repointed at
          another team. Pick a service to fix it.
          <div className="mt-1">
            <ReloadButton onClick={reload} />
          </div>
        </Notice>
      )}

      {selected && !selected.acceptsEvents && (
        <Notice tone="warning">
          {selected.name} has no Events API v2 integration, so it cannot accept
          events. Add one in PagerDuty under Service, Integrations, then
          reload.
        </Notice>
      )}

      {selected && selected.status === "disabled" && (
        <Notice tone="warning">
          {selected.name} is disabled in PagerDuty. It accepts events and
          raises no incident, so a page sent to it goes nowhere. This node
          fails rather than reporting a page that never happened.
        </Notice>
      )}

      {selected && selected.status === "maintenance" && (
        <Notice tone="warning">
          {selected.name} is in a maintenance window, so PagerDuty will take
          the event and raise no incident until the window ends. The node
          reports that rather than claiming someone was paged.
        </Notice>
      )}

      {truncated && (
        <Notice tone="info">
          This account has more services than are listed here. Search narrows
          what is shown; a service further down the list is not missing.
        </Notice>
      )}

      {selected?.acceptsEvents && (
        <Notice tone="info">
          Pages{" "}
          <span className="text-foreground">
            {selected.escalationPolicyName ?? "the service's escalation policy"}
          </span>
          . Events route by the service's own policy; only the REST Create
          Incident action can override it.
        </Notice>
      )}
    </div>
  );
}

export function PagerDutyEscalationPolicyField({
  value,
  disabled,
  integrationId,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  integrationId?: string;
  onChange: (value: string) => void;
}) {
  const { items, loading, error, reload, accountSubdomain } =
    usePagerDutyResources(integrationId, "escalation-policies", pickPolicies);

  const selected = items.find((policy) => policy.id === value);
  const missing = Boolean(value) && !loading && !error && !selected;

  if (!integrationId) {
    return (
      <Notice tone="info">
        Select a PagerDuty connection first.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled || loading}
        onValueChange={onChange}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={
              loading ? "Loading policies" : "Service default (recommended)"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {items.map((policy) => (
            <SelectItem key={policy.id} value={policy.id}>
              <span className="flex flex-col items-start">
                <span>{policy.name}</span>
                <span className="font-mono text-muted-foreground text-xs">
                  {policy.id}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {accountSubdomain && (
        <p className="ml-1 font-mono text-muted-foreground text-xs">
          {accountSubdomain}.pagerduty.com
        </p>
      )}

      {error && (
        <Notice tone="warning">
          <p>{error}</p>
          <div className="mt-1">
            <ReloadButton onClick={reload} />
          </div>
        </Notice>
      )}

      {missing && (
        <Notice tone="warning">
          Escalation policy <code className="font-mono">{value}</code> is not in
          this account any more. Unless the fallback below is off, the incident
          will page the service's own policy instead.
        </Notice>
      )}
    </div>
  );
}

/**
 * The account's incident priorities. REST-only, and a paid-plan feature, so an
 * empty list is a normal state rather than an error.
 */
export function PagerDutyPriorityField({
  value,
  disabled,
  integrationId,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  integrationId?: string;
  onChange: (value: string) => void;
}) {
  const { items, loading, error } = usePagerDutyResources(
    integrationId,
    "priorities",
    pickPriorities
  );

  if (!integrationId) {
    return <Notice tone="info">Select a PagerDuty connection first.</Notice>;
  }

  if (!(loading || error) && items.length === 0) {
    return (
      <Notice tone="info">
        This PagerDuty account has no incident priorities. They come with the
        plans that include them; without one, PagerDuty decides the priority
        itself.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled || loading}
        onValueChange={onChange}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Leave it to PagerDuty" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Leave it to PagerDuty</SelectItem>
          {items.map((priority) => (
            <SelectItem key={priority.id} value={priority.id}>
              <span className="flex flex-col items-start">
                <span>{priority.name}</span>
                {priority.description && (
                  <span className="text-muted-foreground text-xs">
                    {priority.description}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <Notice tone="warning">{error}</Notice>}
    </div>
  );
}

/**
 * Picks the Trigger Incident node whose alert an acknowledge or resolve
 * closes. A node reference, not a template: the healthy branch of a check is
 * exactly the branch where the trigger node did not run, so a reference to its
 * output would be unresolved and the run would fail.
 */
export type TriggerNodeChoice = {
  id: string;
  label: string;
  /** The service that trigger pages, so a mismatch can be caught here. */
  serviceId?: string;
  /** Set when that trigger uses a dedup key of its own rather than the derived one. */
  dedupKey?: string;
};

/**
 * Picks the Trigger Incident node whose alert an acknowledge or resolve
 * closes, and catches the two ways this silently closes nothing.
 *
 * PagerDuty drops an update that names a different service from the trigger,
 * or a dedup key no alert carries, and answers 202 to both - so neither shows
 * up at run time. The editor has the trigger node's own configuration, so it
 * can say so while there is still someone reading.
 */
export function PagerDutyTriggerNodeField({
  value,
  disabled,
  nodes,
  currentServiceId,
  currentDedupKey,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  nodes: TriggerNodeChoice[];
  currentServiceId?: string;
  currentDedupKey?: string;
  onChange: (value: string) => void;
}) {
  const selected = nodes.find((node) => node.id === value);
  const serviceMismatch =
    selected?.serviceId &&
    currentServiceId &&
    selected.serviceId !== currentServiceId;
  const dedupKeyMissing =
    Boolean(selected?.dedupKey?.trim()) && !currentDedupKey?.trim();

  if (nodes.length === 0) {
    return (
      <Notice tone="info">
        No Trigger Incident node in this workflow yet. Add one, or set the
        dedup key below by hand on both nodes.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled}
        onValueChange={onChange}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select the trigger node" />
        </SelectTrigger>
        <SelectContent>
          {nodes.map((node) => (
            <SelectItem key={node.id} value={node.id}>
              {node.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {Boolean(value) && !selected && (
        <Notice tone="warning">
          The trigger node this pointed at is gone from the workflow. Pick
          another, or set the dedup key by hand - otherwise this closes
          nothing.
        </Notice>
      )}

      {serviceMismatch && (
        <Notice tone="warning">
          {selected?.label} pages service{" "}
          <code className="font-mono">{selected?.serviceId}</code>, and this
          node names <code className="font-mono">{currentServiceId}</code>.
          PagerDuty drops an update that arrives through a different service,
          and answers 202 while doing it, so this would close nothing and look
          like it worked. Use the same service on both.
        </Notice>
      )}

      {dedupKeyMissing && (
        <Notice tone="warning">
          {selected?.label} sets its own dedup key (
          <code className="font-mono">{selected?.dedupKey}</code>). Put the
          same value in the dedup key field below, or this closes nothing.
        </Notice>
      )}
    </div>
  );
}

/** Connection types that can carry a backup notification if a page fails. */
const BACKUP_TYPES: ReadonlySet<string> = new Set([
  "discord",
  "slack",
  "telegram",
]);

const BACKUP_TYPE_LABEL: Record<string, string> = {
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
};

/**
 * Picks the connection that gets told when PagerDuty will not take the page.
 *
 * Only existing connections are offered - no URL field - so the step keeps
 * talking to a fixed set of hosts, and the credential stays where credentials
 * belong.
 */
export function PagerDutyBackupConnectionField({
  value,
  disabled,
  connections,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  connections: { id: string; name: string; type: string }[];
  onChange: (value: string) => void;
}) {
  const usable = connections.filter((connection) =>
    BACKUP_TYPES.has(connection.type)
  );
  const selected = usable.find((connection) => connection.id === value);
  const missing = Boolean(value) && !selected;

  if (usable.length === 0) {
    return (
      <Notice tone="info">
        No Discord, Slack or Telegram connection in this organisation yet. Add
        one under Settings, Connections to use it as a backup when a page
        cannot be delivered.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled}
        onValueChange={onChange}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="No backup - just fail the run" />
        </SelectTrigger>
        <SelectContent>
          {usable.map((connection) => (
            <SelectItem key={connection.id} value={connection.id}>
              {connection.name}
              <span className="ml-1 text-muted-foreground text-xs">
                {BACKUP_TYPE_LABEL[connection.type] ?? connection.type}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {missing && (
        <Notice tone="warning">
          The backup connection this node pointed at has been removed. Pick
          another one, or the node will only report the failure.
        </Notice>
      )}

      {selected && selected.type !== "discord" && (
        <Notice tone="info">
          {BACKUP_TYPE_LABEL[selected.type]} also needs a destination below:
          a channel like #alerts for Slack, a chat id for Telegram.
        </Notice>
      )}
    </div>
  );
}
