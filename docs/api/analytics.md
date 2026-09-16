---
title: "Analytics API"
description: "KeeperHub Analytics API - monitor workflow performance, gas usage, and execution trends."
---

# Analytics API

The Analytics API provides insights into workflow and direct execution performance, gas usage, and execution trends across your organization.

## Authentication

All analytics routes accept either a session cookie or an organization API key (`Authorization: Bearer $KEEPERHUB_API_KEY`) except the two that are session-only:

- **`GET /api/analytics/summary`**, **`GET /api/analytics/time-series`**, **`GET /api/analytics/networks`**, **`GET /api/analytics/runs`**, and **`GET /api/analytics/spend-cap`** accept a `kh_` organization key with the `mcp:read` scope. A legacy key with no scope is admitted (an unscoped key means full access). A session caller carries no scope and is unaffected - the scope gate applies to key callers only.
- **`GET /api/analytics/stream`** is session-only: it is a server-sent-events feed consumed by a browser `EventSource`, which cannot send an `Authorization` header, so a key has no way to use it.
- **`GET /api/analytics/runs/{executionId}/steps`** is session-only: it reads the caller's organization from the session.

## Get Analytics Summary

```http
GET /api/analytics/summary
```

Returns aggregated analytics for the organization including run counts, success rates, and gas usage.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `range` | string | Time range: `24h`, `7d`, `30d`, `90d`, `custom` (default: `30d`) |
| `customStart` | string | ISO timestamp for custom range start |
| `customEnd` | string | ISO timestamp for custom range end |
| `projectId` | string | Restrict the figures to one workflow project |

### Response

```json
{
  "totalRuns": 1250,
  "successCount": 1180,
  "errorCount": 70,
  "cancelledCount": 0,
  "skippedCount": 0,
  "successRate": 0.944,
  "avgDurationMs": 2340,
  "totalGasWei": "15000000000000000",
  "sponsoredGasWei": "2000000000000000",
  "activeRuns": 3,
  "previousPeriod": {
    "totalRuns": 1180,
    "successCount": 1100,
    "errorCount": 80,
    "cancelledCount": 0,
    "skippedCount": 0,
    "avgDurationMs": 2510,
    "totalGasWei": "14000000000000000",
    "sponsoredGasWei": "1800000000000000"
  }
}
```

**Field Definitions**

| Field | Type | Description |
|-------|------|-------------|
| `totalRuns` | number | Combined count of workflow executions and direct executions |
| `successCount` | number | Runs that completed successfully |
| `errorCount` | number | Runs that failed |
| `cancelledCount` | number | Workflow runs that were cancelled |
| `skippedCount` | number | Workflow runs whose steps were skipped |
| `successRate` | number | Fraction of runs that succeeded, `0` to `1`, not a percentage. The dashboard renders it as a percentage by multiplying by 100 (`components/analytics/kpi-cards.tsx`), so a consumer that wants one has to do the same |
| `avgDurationMs` | number or null | Mean duration in milliseconds, or `null` when the window holds no completed run to average |
| `totalGasWei` | string | Every wei the runs burned over the range, sponsored gas included. A decimal string, because the figure overflows a JavaScript number |
| `sponsoredGasWei` | string | The sponsored portion of `totalGasWei`, read from the gas-credit ledger. A subset rather than a second figure: adding the two double counts, and the wallet-paid share is the subtraction |
| `activeRuns` | number | Runs in flight at the moment of the request, counted for the organization rather than the window |
| `previousPeriod` | object or null | The same counts over the window immediately before this one, so a caller can render deltas. It carries `totalRuns`, `successCount`, `errorCount`, `cancelledCount`, `skippedCount`, `avgDurationMs`, `totalGasWei` and `sponsoredGasWei`, and deliberately not `successRate` or `activeRuns`: derive the previous rate from its own `successCount / totalRuns` |

## Get Time Series Data

```http
GET /api/analytics/time-series
```

Returns time-bucketed run counts for charting execution volume over time.

Bucket width is chosen from the width of the window: 5 minutes up to 2 hours,
1 hour up to 2 days, 6 hours up to 14 days, and 1 day beyond that. Every bucket
in the window is returned, including the ones with no runs.

### Query Parameters

Same as the summary endpoint, plus:

| Parameter | Type | Description |
|-----------|------|-------------|
| `tz` | string | IANA time zone the buckets are truncated in, for example `Europe/Berlin` (default: `UTC`). An unrecognised value falls back to `UTC`. |

### Response

```json
{
  "intervalMs": 86400000,
  "buckets": [
    {
      "timestamp": "2024-01-01T00:00:00Z",
      "success": 40,
      "error": 2,
      "cancelled": 0,
      "skipped": 0,
      "pending": 0,
      "running": 0
    }
  ]
}
```

`timestamp` is the instant the bucket starts, so with `tz=Europe/Berlin` a daily
bucket starts at midnight Berlin time rather than midnight UTC.

## Get Network Breakdown

```http
GET /api/analytics/networks
```

Returns execution counts and gas usage grouped by blockchain network. Gas totals include both workflow executions and direct executions on each network.

### Query Parameters

Same as summary endpoint.

### Response

```json
{
  "networks": [
    {
      "network": "8453",
      "executionCount": 380,
      "successCount": 372,
      "errorCount": 8,
      "totalGasWei": "2500000000000000"
    }
  ]
}
```

`network` is the chain id as a string, not a name; the analytics dashboard maps it to a display name for the chart. `executionCount` counts settled runs only, so an in-flight execution does not appear here before it finishes.

## List Runs

```http
GET /api/analytics/runs
```

Returns a unified list of both workflow executions and direct executions with pagination.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `range` | string | Time range filter (same as summary) |
| `customStart` | string | ISO timestamp for custom range start |
| `customEnd` | string | ISO timestamp for custom range end |
| `status` | string | Filter by status: `pending`, `running`, `success`, `error` |
| `source` | string | Filter by source: `workflow`, `direct` |
| `limit` | number | Results per page (default: 50) |
| `cursor` | string | Pagination cursor from previous response |
| `page` | number | One-based page number, an alternative to `cursor`. Values below 1 are clamped to 1 |
| `projectId` | string | Restrict the listing to one workflow project |

### Response

```json
{
  "runs": [
    {
      "id": "hjsuassmcb19zvfpzi38r",
      "source": "workflow",
      "status": "success",
      "startedAt": "2024-01-01T00:00:00Z",
      "completedAt": "2024-01-01T00:00:05Z",
      "durationMs": 5000,
      "workflowId": "y3y0xneior3njl90uoyih",
      "workflowName": "Monitor ETH Balance",
      "directType": null,
      "network": "8453",
      "networks": ["8453"],
      "gasNetworks": ["8453"],
      "gasCostWei": "21000000000000",
      "gasUsedWei": "21000000000000",
      "transactionHashes": [
        {
          "hash": "0x...",
          "nodeId": "n1",
          "nodeName": "Write Contract",
          "chainId": 8453,
          "network": "8453",
          "iterationIndex": null,
          "verified": true,
          "receiptStatus": "success",
          "blockNumber": 19000000,
          "gasUsed": "21000000000000",
          "verifiedAt": "2024-01-01T00:00:06Z"
        }
      ],
      "totalSteps": 3,
      "completedSteps": 3,
      "error": null,
      "errorCode": null,
      "errorType": null,
      "errorCategory": null
    }
  ],
  "nextCursor": null,
  "total": 1250,
  "page": 1,
  "pageSize": 50,
  "stepLogRetentionCutoff": "2024-01-01T00:00:00Z"
}
```

`startedAt`, not `createdAt`: a run is dated from when it started, and a run that
has not finished carries `completedAt: null` and `durationMs: null`. `directType`
is set on direct executions (`transfer`, `contract_call`, and so on) and `null`
on workflow runs, where `source`, `workflowId` and `workflowName` carry the
identity instead.

`transactionHashes` is an array on both sources, one entry per on-chain write in
submission order, with a direct execution surfacing its single hash as a
one-element array so both render through the same code. Each entry carries the
receipt verification KeeperHub performed independently (`verified`,
`receiptStatus`, `blockNumber`, `gasUsed`, `verifiedAt`), which is the part a
caller cannot reconstruct from the chain alone. An empty array means the run
produced no on-chain write, or finalized before the column was backfilled.

`networks` is every chain the run's steps targeted, including read-only steps;
`gasNetworks` is the subset its gas landed on. A multi-chain run can therefore
have a longer `networks` than `gasNetworks`, which is why `network` and the gas
figures are only meaningful together when that list holds one entry.

`stepLogRetentionCutoff` is optional and appears when the organization's step
logs have been aged out: a run older than the instant it names is listed with its
status and duration but has no steps behind it, rather than being blank for the
same reason a run that recorded nothing is.

## Get Run Step Logs

```http
GET /api/analytics/runs/{executionId}/steps
```

Returns the step log for one execution, in the order the steps ran.

### Response

A bare array, with no envelope:

```json
[
  {
    "id": "st_hjsuassmcb19zvfpzi",
    "nodeId": "node_1",
    "nodeName": "Trigger",
    "nodeType": "trigger/manual",
    "status": "success",
    "startedAt": "2024-01-01T00:00:00Z",
    "completedAt": "2024-01-01T00:00:00.120Z",
    "durationMs": 120,
    "error": null,
    "iterationIndex": null,
    "forEachNodeId": null,
    "network": null,
    "gasCostWei": null,
    "sponsored": false
  }
]
```

A step's input and output are not part of this response: the log carries what the
run did (`nodeName`, `nodeType`, `status`, timings, `error`) and the on-chain
detail where there was a write (`network`, `gasCostWei`, `sponsored`). Read a
step's own data from the execution's stored output if you need it.

`iterationIndex` and `forEachNodeId` are set on steps inside a For Each body, and
`null` elsewhere. An empty array is the expected answer for a run whose step logs
retention has taken, which the runs listing reports through
`stepLogRetentionCutoff`.

## Get Spend Cap Data

```http
GET /api/analytics/spend-cap
```

Returns current spending status against the daily spending caps.

`dailyCapWei` and `dailySolanaCapLamports` report what the organization configured, and are `null` when it configured nothing. That is not the same as being uncapped: the `effective*` fields carry the figure enforcement actually applies, which is the platform default whenever `usingDefault*` is true. Plan against the effective figures.

### Response

```json
{
  "dailyCapWei": null,
  "dailyUsedWei": "25000000000000000",
  "dailySolanaCapLamports": null,
  "dailySolanaUsedLamports": "0",
  "effectiveDailyCapWei": "20000000000000000",
  "effectiveDailySolanaCapLamports": "500000000",
  "usingDefaultDailyCap": true,
  "usingDefaultDailySolanaCap": true
}
```

## Stream Analytics (SSE)

```http
GET /api/analytics/stream
```

Server-Sent Events endpoint for real-time analytics updates.

### Query Parameters

Same as summary endpoint.

### Event Format

```
data: {"type":"summary","data":{...}}

data: {"type":"summary","data":{...}}
```

The stream sends updated summary data every 2 seconds when changes are detected, with automatic reconnection and heartbeat support.
