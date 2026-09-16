import type {
  ActionConfigField,
  ActionConfigFieldBase,
  IntegrationPlugin,
} from "../registry";
import { registerIntegration } from "../registry-core";
import { PagerDutyIcon } from "./icon";

/**
 * Fields shared by every Events API v2 action. The service picker is the
 * anchor: the workflow stores a service id, and the routing key that actually
 * authorises the event is resolved from it at run time, so no credential ever
 * lands in a workflow definition.
 */
const serviceField: ActionConfigFieldBase = {
  key: "pagerdutyServiceId",
  label: "PagerDuty service",
  type: "pagerduty-service-select",
  required: true,
  helpText:
    "Read from the account behind the selected connection. The workflow stores the service id, never its routing key, so a service renamed in PagerDuty needs no change here. An acknowledge or a resolve must name the same service as the trigger it is closing: PagerDuty drops an update that arrives through a different service's routing key.",
};

const retryFields: ActionConfigFieldBase[] = [
  {
    key: "retryAttempts",
    label: "Retry attempts",
    type: "number",
    min: 0,
    max: 5,
    placeholder: "2",
    example: "2",
    helpText:
      "Extra attempts after the first, for connection failures and the statuses worth another try (408, 425, 429, 5xx). A 400 from PagerDuty is a payload problem and is never retried. Every event carries a dedup key, so an event that arrives twice updates one alert instead of paging twice. Default 2, max 5.",
  },
  {
    key: "retryDelay",
    label: "Retry delay (seconds)",
    type: "number",
    min: 0,
    max: 15,
    placeholder: "1",
    example: "1",
    helpText:
      "Linear backoff: attempt N waits this many seconds times N. A rate-limited request waits for the delay PagerDuty reports instead. Default 1, max 15.",
  },
  {
    key: "failOnError",
    label: "Fail the workflow if the page could not be delivered",
    type: "fail-on-error-switch",
    helpText:
      "On by default, and it covers every way a page fails to land: a rejection, a timeout, an outage, a deleted service. Turn it off to keep the run going and branch on the node's `delivered` or `status` output instead.",
  },
];

const dedupKeyField: ActionConfigFieldBase = {
  key: "dedupKey",
  label: "Dedup key",
  type: "template-input",
  placeholder: "Leave blank for one alert per node",
  helpText:
    "PagerDuty groups events that share this key. Blank means one open alert per node, so a check that keeps failing updates that alert instead of paging again. Put a vault or chain id in here to page per subject. Trimmed to 255 characters.",
};

/**
 * The trigger's key is optional and defaults per node. An acknowledge or a
 * resolve must name the alert it is closing, so this one is required and
 * points at the trigger node's output.
 */
const triggerNodeField: ActionConfigFieldBase = {
  key: "dedupKeyFromNodeId",
  label: "Alert opened by",
  type: "pagerduty-trigger-node-select",
  helpText:
    "The Trigger Incident node in this workflow whose alert this closes. Its dedup key is derived here, so the two always match. This is a node reference rather than a template like {{Trigger Incident.dedupKey}} on purpose: on the healthy branch of a check the trigger node never ran, so a template reference to its output cannot resolve and the run would fail.",
};

const targetDedupKeyField: ActionConfigFieldBase = {
  key: "dedupKey",
  label: "Dedup key of the alert",
  type: "template-input",
  placeholder: "Leave blank to use the key of the node above",
  helpText:
    "Only needed when the trigger sets its own dedup key: put the same value here. PagerDuty requires a key for acknowledge and resolve, and drops an event whose key matches no open alert - with a 202, so it looks exactly like success. The service must be the same one the trigger used, too.",
};

const verifyField: ActionConfigFieldBase = {
  key: "verifyWithPagerDuty",
  label: "Check the incident afterwards",
  type: "select",
  defaultValue: "false",
  options: [
    { value: "false", label: "No" },
    { value: "true", label: "Yes, read the incident back" },
  ],
  helpText:
    "Off by default. PagerDuty answers 202 to an acknowledge or a resolve even when it had nothing to apply it to - the alert was already resolved, the key was never used, or the event went to a different service - so the response alone cannot tell you what happened. Turning this on reads the incident back and reports its actual status. Needs incidents.read on a scoped OAuth app; a read-only API token already has it. A service that groups alerts produces incidents with no incident key, so the answer can be \"unknown\", which is never treated as a failure.",
};

const pagerDutyPlugin: IntegrationPlugin = {
  type: "pagerduty",
  egress: "fixed-host",
  label: "PagerDuty",
  description: "Trigger, acknowledge and resolve PagerDuty incidents",

  icon: PagerDutyIcon,

  formFields: [
    {
      id: "apiToken",
      label: "REST API token",
      type: "password",
      placeholder: "20-character key from PagerDuty",
      configKey: "apiToken",
      envVar: "PAGERDUTY_API_TOKEN",
      helpText:
        "PagerDuty: Integrations, Developer Tools, API Access Keys, Create New API Key - tick Read-only API Key. Creating one of those needs the Admin or Account Owner role; a personal read-only token from User Settings works too. PagerDuty shows the key once. Read-only covers Trigger, Acknowledge, Resolve and Change Event. Leave blank to use scoped OAuth below. Docs: ",
      helpLink: {
        text: "support.pagerduty.com/main/docs/api-access-keys",
        url: "https://support.pagerduty.com/main/docs/api-access-keys",
      },
    },
    {
      id: "oauthClientId",
      label: "OAuth client ID",
      type: "text",
      placeholder: "PDABC12.oauth.pagerduty.com",
      configKey: "oauthClientId",
      envVar: "PAGERDUTY_OAUTH_CLIENT_ID",
      helpText:
        "Tighter than an API token, and PagerDuty's own recommendation. Register the app under Integrations, Developer Tools, App Registration, set Functionality to Scoped OAuth, and grant only services.read and escalation_policies.read.",
    },
    {
      id: "oauthClientSecret",
      label: "OAuth client secret",
      type: "password",
      placeholder: "Shown once when the app is created",
      configKey: "oauthClientSecret",
      envVar: "PAGERDUTY_OAUTH_CLIENT_SECRET",
      helpText:
        "Exchanged for a short-lived token on demand; KeeperHub stores no token of its own.",
    },
    {
      id: "subdomain",
      label: "Account subdomain",
      type: "text",
      placeholder: "acme",
      configKey: "subdomain",
      envVar: "PAGERDUTY_SUBDOMAIN",
      helpText:
        "The first label of your PagerDuty address: acme.pagerduty.com means acme. Required for scoped OAuth, ignored when an API token is set. If the account is ever renamed, update this field: the OAuth scope string carries the subdomain, so the old one stops issuing tokens. Nothing else in a node has to change, because services and policies are stored by id.",
    },
    {
      id: "euRegion",
      label: "EU service region",
      type: "checkbox",
      configKey: "euRegion",
      envVar: "PAGERDUTY_EU_REGION",
      defaultValue: false,
      helpText:
        "Tick this if your PagerDuty address contains .eu (acme.eu.pagerduty.com). It switches both hosts to api.eu.pagerduty.com and events.eu.pagerduty.com. Get it wrong and PagerDuty answers 401, which looks like a bad token - Test Connection checks the other region for you and says which way to set it.",
    },
    {
      id: "fromEmail",
      label: "From email",
      type: "text",
      placeholder: "oncall-bot@acme.io",
      configKey: "fromEmail",
      envVar: "PAGERDUTY_FROM_EMAIL",
      helpText:
        "Optional, and not a password. Only the REST Create Incident action needs it: PagerDuty attributes that incident to this user, who must exist in the account.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testPagerDuty } = await import("./test");
      return testPagerDuty;
    },
  },

  actions: [
    {
      slug: "trigger-incident",
      label: "Trigger Incident",
      description:
        "Open or update a PagerDuty alert on a service, with a dedup key so repeat runs do not page again",
      category: "PagerDuty",
      stepFunction: "triggerIncidentStep",
      stepImportPath: "trigger-incident",
      docUrl: "https://developer.pagerduty.com/docs/events-api-v2/trigger-events/",
      outputFields: [
        { field: "delivered", description: "Whether PagerDuty accepted the event" },
        { field: "dedupKey", description: "Key that identifies the alert" },
        {
          field: "status",
          description:
            "triggered, held by the consecutive-runs guard, or failed when the event could not be delivered",
        },
        { field: "consecutiveRuns", description: "Runs in a row that reached this node" },
        { field: "requiredRuns", description: "Runs in a row configured before paging" },
        { field: "error", description: "Why the event was not delivered, when it was not" },
        { field: "backupAttempted", description: "Whether a backup notification was sent" },
        { field: "backupDelivered", description: "Whether the backup notification landed" },
        { field: "backupChannel", description: "discord, slack or telegram" },
        { field: "backupError", description: "Why the backup notification failed, when it did" },
        { field: "serviceStatus", description: "PagerDuty's service status when the event was sent" },
        {
          field: "suppressedByService",
          description:
            "True when the service was in maintenance, so PagerDuty took the event and raised no incident",
        },
        { field: "detailsTruncated", description: "True when custom details were dropped for size" },
        { field: "message", description: "PagerDuty's own response message" },
      ],
      configFields: [
        serviceField,
        {
          key: "summary",
          label: "Summary",
          type: "template-input",
          placeholder: "Keeper stalled: {{Check Vault.message}}",
          example: "Keeper stalled on Ethereum",
          required: true,
          helpText:
            "Becomes the alert title. Trimmed to PagerDuty's 1024-character limit.",
        },
        {
          key: "severity",
          label: "Severity",
          type: "select",
          defaultValue: "error",
          options: [
            { value: "critical", label: "Critical" },
            { value: "error", label: "Error" },
            { value: "warning", label: "Warning" },
            { value: "info", label: "Info" },
          ],
          helpText:
            "How bad the condition is. Who gets woken up is the service's urgency rule and escalation policy, not this field.",
        },
        {
          key: "source",
          label: "Source",
          type: "template-input",
          placeholder: "The system the event is about",
          helpText:
            "PagerDuty requires a source. Defaults to this node's name.",
        },
        dedupKeyField,
        {
          type: "group",
          label: "When to page",
          fields: [
            {
              key: "consecutiveRuns",
              label: "Consecutive runs before paging",
              type: "number",
              min: 1,
              max: 20,
              placeholder: "1",
              example: "2",
              helpText:
                "1 pages the first time this node is reached. 2 holds the first run and pages on the second run in a row that reaches it. A run that does not reach this node resets the count, so one healthy check clears the streak. Held runs are recorded in the run history, not silent.",
            },
          ],
        },
        {
          type: "group",
          label: "Details",
          fields: [
            {
              key: "component",
              label: "Component",
              type: "template-input",
              placeholder: "vault-monitor",
              helpText: "The part of the source the event is about.",
            },
            {
              key: "group",
              label: "Group",
              type: "template-input",
              placeholder: "sky-keepers",
              helpText: "A logical grouping of components.",
            },
            {
              key: "class",
              label: "Class",
              type: "template-input",
              placeholder: "liquidation",
              helpText: "The type of event, used by PagerDuty event rules.",
            },
            {
              key: "customDetails",
              label: "Custom details",
              type: "template-textarea",
              rows: 4,
              placeholder: '{ "vault": "{{Check Vault.id}}" }',
              helpText:
                "JSON object shown on the incident. The workflow, run and node ids are added automatically. Dropped with a note if the event would exceed PagerDuty's 512 KB limit.",
            },
          ],
        },
        {
          type: "group",
          label: "Delivery",
          fields: retryFields,
        },
        {
          type: "group",
          label: "If PagerDuty cannot be reached",
          fields: [
            {
              key: "backupIntegrationId",
              label: "Backup connection",
              type: "pagerduty-backup-connection-select",
              helpText:
                "Optional, and the answer to a PagerDuty outage: when the event cannot be delivered after the retries above, the same alert - plus why PagerDuty refused it - is posted here instead. Only existing Discord, Slack and Telegram connections are offered, so the node never gains a URL a workflow could point elsewhere. The backup fires either way; whether the run itself is then marked failed is the switch above.",
            },
            {
              key: "backupDestination",
              label: "Backup channel or chat id",
              type: "template-input",
              placeholder: "#alerts, or a Telegram chat id",
              helpText:
                "Needed for Slack and Telegram. A Discord connection already carries its webhook, so leave this blank for one.",
            },
          ],
        },
        {
          key: "pagerdutyPreview",
          label: "Preview",
          type: "pagerduty-preview",
        },
      ],
    },
    {
      slug: "resolve-incident",
      label: "Resolve Incident",
      description:
        "Close the alert carrying this dedup key. PagerDuty drops it silently when no open alert matches, so this is a no-op rather than an error",
      category: "PagerDuty",
      stepFunction: "resolveIncidentStep",
      stepImportPath: "resolve-incident",
      docUrl: "https://developer.pagerduty.com/docs/events-api-v2/trigger-events/",
      outputFields: [
        { field: "delivered", description: "Whether PagerDuty accepted the event" },
        { field: "dedupKey", description: "Key of the alert that was resolved" },
        {
          field: "incidentStatus",
          description:
            "Incident status when the check is on: triggered, acknowledged, resolved, or unknown",
        },
        {
          field: "incidentPriority",
          description: "The incident's priority when the check is on and it has one",
        },
        { field: "incidentUrl", description: "Link to the incident, when the check found it" },
      ],
      configFields: [
        serviceField,
        triggerNodeField,
        targetDedupKeyField,
        verifyField,
        { type: "group", label: "Delivery", fields: retryFields },
      ],
    },
    {
      slug: "acknowledge-incident",
      label: "Acknowledge Incident",
      description:
        "Acknowledge the alert carrying this dedup key. PagerDuty drops it silently when no open alert matches, and acknowledging an acknowledged alert changes nothing",
      category: "PagerDuty",
      stepFunction: "acknowledgeIncidentStep",
      stepImportPath: "acknowledge-incident",
      docUrl: "https://developer.pagerduty.com/docs/events-api-v2/trigger-events/",
      outputFields: [
        { field: "delivered", description: "Whether PagerDuty accepted the event" },
        { field: "dedupKey", description: "Key of the alert that was acknowledged" },
        {
          field: "incidentStatus",
          description:
            "Incident status when the check is on: triggered, acknowledged, resolved, or unknown",
        },
        {
          field: "incidentPriority",
          description: "The incident's priority when the check is on and it has one",
        },
        { field: "incidentUrl", description: "Link to the incident, when the check found it" },
      ],
      configFields: [
        serviceField,
        triggerNodeField,
        targetDedupKeyField,
        verifyField,
        { type: "group", label: "Delivery", fields: retryFields },
      ],
    },
    {
      slug: "send-change-event",
      label: "Send Change Event",
      description:
        "Record a deploy or configuration change on a service timeline. Never pages anyone",
      category: "PagerDuty",
      stepFunction: "sendChangeEventStep",
      stepImportPath: "send-change-event",
      docUrl: "https://developer.pagerduty.com/docs/events-api-v2/send-change-events/",
      outputFields: [
        { field: "delivered", description: "Whether PagerDuty accepted the change event" },
      ],
      configFields: [
        serviceField,
        {
          key: "summary",
          label: "Summary",
          type: "template-input",
          placeholder: "Deployed keeper {{Build.version}}",
          required: true,
          helpText: "What changed. Shown on the service's activity timeline.",
        },
        {
          key: "source",
          label: "Source",
          type: "template-input",
          placeholder: "The system that made the change",
        },
        {
          key: "customDetails",
          label: "Custom details",
          type: "template-textarea",
          rows: 3,
          placeholder: '{ "commit": "{{Build.sha}}" }',
        },
        { type: "group", label: "Delivery", fields: retryFields },
      ],
    },
    {
      slug: "create-incident",
      label: "Create Incident (REST)",
      description:
        "Create an incident directly, with an escalation policy override and urgency. Needs a write-capable token",
      category: "PagerDuty",
      stepFunction: "createIncidentStep",
      stepImportPath: "create-incident",
      docUrl:
        "https://developer.pagerduty.com/api-reference/a7d81b0e9200f-create-an-incident",
      outputFields: [
        { field: "incidentId", description: "PagerDuty incident id" },
        { field: "incidentNumber", description: "Incident number" },
        { field: "incidentUrl", description: "Link to the incident" },
        { field: "status", description: "Incident status as PagerDuty created it" },
        {
          field: "escalationPolicyFellBack",
          description: "True when the chosen policy was gone and the service's own was used",
        },
      ],
      configFields: [
        serviceField,
        {
          key: "title",
          label: "Title",
          type: "template-input",
          placeholder: "Keeper stalled: {{Check Vault.message}}",
          required: true,
        },
        {
          key: "details",
          label: "Details",
          type: "template-textarea",
          rows: 4,
          placeholder: "What happened, and what the responder should check",
        },
        {
          key: "pagerdutyEscalationPolicyId",
          label: "Escalation policy",
          type: "pagerduty-escalation-policy-select",
          helpText:
            "Optional. Leave blank to page the service's own policy, which is what every Events API action does.",
        },
        {
          key: "fallbackToServicePolicy",
          label: "Fall back to the service policy if that one is gone",
          type: "fail-on-error-switch",
          helpText:
            "On by default: a policy that has been deleted should not stop the incident, because paging the default rota beats paging nobody. The node's output says when it fell back.",
        },
        {
          key: "urgency",
          label: "Urgency",
          type: "select",
          defaultValue: "service-default",
          options: [
            { value: "service-default", label: "Service default" },
            { value: "high", label: "High" },
            { value: "low", label: "Low" },
          ],
          helpText:
            "High urgency notifies on-call the way the escalation policy says; low urgency does not page. Left at the service default, PagerDuty decides from the service's urgency rule.",
        },
        {
          key: "pagerdutyPriorityId",
          label: "Priority",
          type: "pagerduty-priority-select",
          helpText:
            "The account's incident priorities (P1, P2, and so on), read from PagerDuty. A paid-plan feature: an account without it shows nothing here. Only this REST action can set a priority - an Events API alert takes its priority from the account's Event Orchestration rules instead.",
        },
        {
          key: "incidentKey",
          label: "Incident key",
          type: "template-input",
          placeholder: "Optional",
          helpText:
            "PagerDuty rejects a repeat of an open incident's key rather than merging it, unlike the Events API dedup key. Leave blank unless you are deliberately guarding against a double-create.",
        },
        {
          key: "fromEmail",
          label: "From email",
          type: "template-input",
          placeholder: "Falls back to the connection's From email",
          helpText:
            "The PagerDuty user the incident is attributed to. Required by PagerDuty for this call.",
        },
        {
          key: "failOnError",
          label: "Fail workflow if PagerDuty rejects the incident",
          type: "fail-on-error-switch",
        },
      ],
    },
  ],
};

registerIntegration(pagerDutyPlugin);

export default pagerDutyPlugin;
