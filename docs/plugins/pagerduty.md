---
title: "PagerDuty Plugin"
description: "Trigger, acknowledge and resolve PagerDuty incidents from a workflow, without pasting routing keys."
---

# PagerDuty Plugin

Page on-call from a workflow. You pick a service from your PagerDuty account and KeeperHub builds the Events API request, including the deduplication key that stops a repeating check from paging someone every run.

The routing key that authorises an event is never stored in the workflow. The node stores the service id, and the key is read from PagerDuty each time the node runs.

## Actions

| Action | Description |
|--------|-------------|
| Trigger Incident | Open or update an alert on a service |
| Resolve Incident | Close the alert carrying a given dedup key |
| Acknowledge Incident | Acknowledge that alert without resolving it |
| Send Change Event | Record a deploy or config change on a service timeline; never pages |
| Create Incident (REST) | Create an incident directly, with an escalation policy override and urgency |

The first four use the Events API v2 and work with a read-only credential. Create Incident uses the REST API and needs a write-capable one.

## Setup

1. In PagerDuty, go to **Integrations > Developer Tools > API Access Keys > Create New API Key**
2. Tick **Read-only API Key**. Read-only is enough for every action except Create Incident
3. Copy the key. PagerDuty shows it once
4. In KeeperHub, go to **Settings > Organization > Connections**, click **Add Connection** and select PagerDuty
5. Paste the key. Tick **EU service region** if your PagerDuty address contains `.eu`
6. Click **Test Connection**, then save

The connection belongs to the organization it is created in and is not visible to any other organization.

### What happens when the person who added it leaves

A connection stays owned by whoever created it.

- **Deactivated account:** KeeperHub freezes every connection that person created, for the whole organization and immediately. Workflows using them fail with a message saying so. The fix is to recreate the connection under an active member - editing it is not enough, because it keeps its original owner.
- **Removed from the organization, account still active:** the connection keeps working. Removing someone from a team does not revoke the PagerDuty credential they configured, so rotate the key in PagerDuty and update the connection, or delete it, as part of offboarding.
- **Someone else edits it:** rotating the token through **Edit** takes effect on the next run. Removing the connection in KeeperHub does not revoke the key at PagerDuty; delete it there too, under **Integrations > Developer Tools > API Access Keys**.

### Scoped OAuth instead of a token

PagerDuty recommends scoped OAuth over account-wide keys, and the plugin accepts either. Register an app under **Integrations > Developer Tools > App Registration**, set Functionality to **Scoped OAuth**, and grant only:

- `services.read`
- `escalation_policies.read`

Add `incidents.read` if you want the acknowledge and resolve actions to check the incident afterwards, and `incidents.write` if you use Create Incident. Fill in the client id, client secret and your account subdomain, and leave the API token blank.

If the account is ever renamed, update the subdomain field: the OAuth scope string carries it. An API token is unaffected by a rename, and nothing in a workflow has to change either way, because services and escalation policies are stored by id.

### Every service needs an Events API v2 integration

An event reaches a service through an integration on that service. In PagerDuty, open the service, go to **Integrations**, and add an **Events API v2** integration if it has none. The service picker marks services that cannot take events.

## Trigger Incident

Open an alert, or update the one already open for the same dedup key.

**Inputs:** PagerDuty service (picked from your account), Summary (becomes the alert title), Severity (`critical`, `error`, `warning`, `info`), Source, Dedup key, and optional Component, Group, Class and Custom details. Supports `{{NodeName.field}}` variables throughout.

**Outputs:** `delivered`, `dedupKey`, `status` (`triggered`, `held`, or `failed`), `consecutiveRuns`, `requiredRuns`, `error`, `summaryFellBack`, `serviceStatus`, `suppressedByService`, `detailsTruncated`, `message`, and the backup fields below.

**Deduplication.** Leave the dedup key blank and the node uses one key per node, so a check that keeps failing updates one alert instead of paging on every run. Put a vault address or chain id in the field to page per subject instead. Once an alert is resolved, the next trigger with the same key opens a new one.

**Paging only after several failures.** Set **Consecutive runs before paging** to hold a flapping check. With 3, the first two runs that reach the node are held and the third pages. Any run that does not reach the node resets the count, so one healthy check clears it. Held runs are recorded in the output, not silently dropped.

**Severity, urgency and priority are three different things.** Severity describes the condition. On a service using dynamic urgency, `critical` and `error` page at high urgency while `warning` and `info` do not; on other services the service's urgency rule decides. Priority (P1, P2) cannot be set on an event at all: PagerDuty assigns it from the service's Event Orchestration rules, or you set it directly with Create Incident.

**An empty summary still pages.** If the summary template renders to nothing, the alert goes out with a title saying so and carries the template in its details, and the output sets `summaryFellBack`. A page with a poor title beats no page.

**When to use:** A keeper has stopped submitting, a vault crossed a liquidation threshold, a bridge stalled, a balance ran dry.

**Example workflow:**
```
Schedule (every 5 min)
  -> Check keeper health
  -> Condition: last submission older than 3 blocks
  -> PagerDuty: Trigger Incident (severity error, hold for 2 consecutive runs)
```

## Resolve Incident and Acknowledge Incident

Close, or acknowledge, the alert carrying a given dedup key.

**Inputs:** PagerDuty service, Dedup key of the alert (required), and an optional check of the incident afterwards.

**Outputs:** `delivered`, `dedupKey`, `error` when the event was not delivered and the node was told not to fail the run, and, when the check is on, `incidentStatus`, `incidentUrl`, `incidentPriority` and `verificationError`. The status is the one observed after the event was sent; the Events API is asynchronous, so it can still show the previous state for a moment.

Both actions need the dedup key of the alert they are closing. Pick the **Trigger Incident node** whose alert this closes and the same key is derived here; only set the dedup key field when that trigger uses a key of its own, in which case put the same value on both nodes.

Pick the node rather than referencing `{{Trigger Incident.dedupKey}}`: on the healthy branch of a check the trigger node never ran, so a template reference to its output cannot resolve and the run would fail -- which is exactly the branch a resolve belongs on. The service must also be the same one the trigger used, because PagerDuty drops an update that arrives through a different service's routing key.

PagerDuty answers `202 Accepted` to an acknowledge or a resolve whether or not it had an open alert to apply it to, so a key that matches nothing looks exactly like success. Turn on **Check the incident afterwards** to read the incident back and report its real status; an inconclusive answer is reported as `unknown` and never fails the run.

**Example workflow:**
```
Schedule (every 5 min)
  -> Check keeper health
  -> Condition: healthy?
       true  -> PagerDuty: Resolve Incident (alert opened by: Page on-call)
       false -> PagerDuty: Trigger Incident
```

## Send Change Event

Record a deploy, a config change or a migration on the service's timeline. Change events never page anyone; they appear next to the incidents they often explain.

**Inputs:** PagerDuty service, Summary, Source, Custom details.

**Outputs:** `delivered`, `message`, and `error` when the change event was not delivered and the node was told not to fail the run.

## Create Incident (REST)

Create an incident directly rather than through an alert. This is the only action that can override the escalation policy, set urgency or set a priority, and the only one that needs a write-capable credential plus a **From email** -- the login email of a real PagerDuty user, which PagerDuty attributes the incident to.

**Inputs:** PagerDuty service, Title, Details, Escalation policy (optional override), Urgency, Priority, Incident key, From email.

**Priority** is read from your account (P1, P2, and so on) and is a paid-plan feature -- an account without it shows nothing to pick. Only this action can set one: the Events API v2 payload has no priority field, so an alert raised by Trigger Incident takes its priority from your Event Orchestration rules instead. **Urgency** decides whether the incident notifies on-call at all; left at the service default, PagerDuty applies the service's urgency rule.

**Outputs:** `delivered`, `incidentId`, `incidentNumber`, `incidentUrl`, `status`, `priorityId`, `escalationPolicyFellBack`, and `error` when the incident was not created and the node was told not to fail the run.

Unlike the Events API dedup key, a repeated incident key is rejected by PagerDuty rather than merged, so leave it blank unless you are deliberately guarding against a double-create. If the escalation policy you chose has been deleted, the incident is still created on the service's own policy and the output says so; turn that fallback off to fail instead.

## When PagerDuty will not take the page

Every failure names the object it is about, and the ones that cannot succeed on a second attempt are not retried:

| What happened | What the node does |
|---------------|--------------------|
| Service deleted, or not visible to these credentials | Fails naming the service id. The node keeps the id rather than repointing at another service |
| Service disabled in PagerDuty | Fails. A disabled service accepts events and raises no incident, so the page would have gone nowhere |
| Service in a maintenance window | Delivers, and reports `suppressedByService` -- PagerDuty takes the event and raises no incident until the window ends |
| Service has no Events API v2 integration | Fails naming the service and the fix |
| Token revoked, or presented to the wrong region | Fails with a credential error. Test Connection tells you when the region checkbox is the cause |
| PagerDuty account lapsed or downgraded | Fails with PagerDuty's `402`: the plan does not allow the request |
| Rate limited, 5xx, network fault | Retried, twice by default, honouring the delay PagerDuty asks for |
| Payload rejected (`400`) | Fails immediately, quoting PagerDuty's own error. Usually a summary that templated to empty |

Because the trigger action reads the routing key from PagerDuty before it sends anything, a dead account or a dead credential fails on that read rather than firing an event nobody receives.

### Backup notification

Set **Backup connection** on the trigger action to an existing Discord, Slack or Telegram connection. When the event cannot be delivered after the retries, the same alert -- plus the reason PagerDuty refused it -- is posted there instead. The run is still marked failed: the backup is for the person who should be woken now, the failed run is for whoever reads history later.

Only connections that already exist in the organization are offered, so a workflow cannot point this at a new destination.

## Retries

Retries default to 2, where a chat integration defaults to 0. Every event this plugin sends carries a dedup key, so an event that arrives twice updates one alert instead of paging twice, which makes a retry safe. Connection failures and the statuses worth another try (408, 425, 429, 5xx) are retried; a 400 never is.
