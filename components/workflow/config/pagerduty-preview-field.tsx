"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { buildTriggerEvent, normaliseSeverity } from "@/plugins/pagerduty/event-payload";
import { usePagerDutyServices } from "./pagerduty-resource-field";

const ROUTING_KEY_PLACEHOLDER = "resolved from the service at run time";
const DEDUP_KEY_PLACEHOLDER = "keeperhub/<workflow>/<node>";

type PreviewConfig = Record<string, unknown>;

function text(config: PreviewConfig, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

/**
 * Parse the custom-details field the way the step does, so the preview shows
 * what will actually be sent rather than the raw string. Unparseable text is
 * kept under `details` here too.
 */
function previewDetails(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Left as free text below.
  }
  return { details: raw };
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-border/40 border-b py-1.5 text-xs last:border-b-0">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

/**
 * Two views of the same node config: the exact JSON that leaves KeeperHub, and
 * the alert PagerDuty will hold once it has it.
 *
 * Templates are left unrendered on purpose - the point is to check the shape
 * and the routing before anyone is woken up, and a half-rendered template
 * reads worse than the template itself.
 */
export function PagerDutyPreviewField({
  config,
  disabled,
}: {
  config: PreviewConfig;
  disabled?: boolean;
}) {
  const [tab, setTab] = useState<"payload" | "incident">("payload");
  const [copied, setCopied] = useState(false);

  const integrationId = text(config, "integrationId") || undefined;
  const serviceId = text(config, "pagerdutyServiceId");
  const { items, accountSubdomain } = usePagerDutyServices(integrationId);
  const service = items.find((candidate) => candidate.id === serviceId);

  const summary = text(config, "summary");
  const dedupKey = text(config, "dedupKey") || DEDUP_KEY_PLACEHOLDER;
  const severity = normaliseSeverity(text(config, "severity"));
  const source = text(config, "source") || "<node name>";

  const { body, detailsDropped } = buildTriggerEvent({
    routingKey: ROUTING_KEY_PLACEHOLDER,
    dedupKey,
    timestamp: "<sent at run time>",
    input: {
      summary: summary || "<summary is required>",
      severity,
      source,
      component: text(config, "component"),
      group: text(config, "group"),
      class: text(config, "class"),
      customDetails: previewDetails(text(config, "customDetails")),
      client: "KeeperHub",
      clientUrl: "<link to this workflow>",
    },
  });

  const json = JSON.stringify(body, null, 2);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: the JSON is on screen and selectable anyway.
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex rounded-md border border-border p-0.5">
          <button
            className={`rounded px-2 py-0.5 text-xs ${tab === "payload" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
            disabled={disabled}
            onClick={() => setTab("payload")}
            type="button"
          >
            Payload
          </button>
          <button
            className={`rounded px-2 py-0.5 text-xs ${tab === "incident" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
            disabled={disabled}
            onClick={() => setTab("incident")}
            type="button"
          >
            Incident
          </button>
        </div>
        {tab === "payload" && (
          <button
            className="ml-auto inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
            onClick={copy}
            type="button"
          >
            {copied ? (
              <Check className="size-3" />
            ) : (
              <Copy className="size-3" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      {tab === "payload" ? (
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">
            POST https://events.pagerduty.com/v2/enqueue
          </p>
          <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">
            {json}
          </pre>
        </div>
      ) : (
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-border border-b bg-muted/30 px-3 py-2">
            <span className="rounded bg-destructive/20 px-1.5 py-0.5 font-semibold text-[10px] text-destructive uppercase tracking-wide">
              Triggered
            </span>
            <span className="text-muted-foreground text-xs">
              severity {severity}
            </span>
          </div>
          <div className="space-y-1 p-3">
            <p className="font-medium text-sm">
              {summary || "Summary is required"}
            </p>
            <div className="pt-1">
              <Row
                label="Account"
                value={
                  accountSubdomain ? (
                    <span className="font-mono">
                      {accountSubdomain}.pagerduty.com
                    </span>
                  ) : (
                    "Read from PagerDuty once a connection is selected"
                  )
                }
              />
              <Row
                label="Service"
                value={
                  service ? (
                    <>
                      {service.name}{" "}
                      <span className="font-mono text-muted-foreground">
                        {service.id}
                      </span>
                    </>
                  ) : (
                    (serviceId ?? "Not selected")
                  )
                }
              />
              <Row
                label="Escalation policy"
                value={
                  service?.escalationPolicyName ??
                  "Read from PagerDuty once a service is selected"
                }
              />
              <Row label="Source" value={source} />
              <Row label="Dedup key" value={dedupKey} />
              <Row label="Created by" value="KeeperHub" />
            </div>
          </div>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Templates render when the node runs. The routing key is never shown
        here or stored in the workflow: it is read from the service each time
        the node runs.
        {detailsDropped
          ? " Custom details are over PagerDuty's size limit and would be replaced by a note."
          : ""}
      </p>
    </div>
  );
}
