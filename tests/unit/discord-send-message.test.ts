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

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

// Discord egress routes through safeFetch (the SSRF guard). Mock it so the
// test asserts on what URL/options the step hands to it, without real network.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

// The retry loop waits between attempts. Resolve immediately and record the
// requested waits so the tests stay instant and can assert on the backoff.
const { sleep } = vi.hoisted(() => ({
  sleep: vi.fn((_ms: number) => Promise.resolve()),
}));
vi.mock("@/lib/sleep", () => ({ sleep }));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { sendDiscordMessageStep } from "@/plugins/discord/steps/send-message";

const WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";

function runStep(
  webhookUrl: string,
  extra: { retryAttempts?: number | string; retryDelay?: number | string } = {}
) {
  mockFetchCredentials.mockResolvedValue({ webhookUrl });
  return sendDiscordMessageStep({
    integrationId: "int-1",
    discordMessage: "hello",
    ...extra,
  });
}

function mockResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  };
}

describe("discord send-message webhook URL validation", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
    safeFetch.mockResolvedValue({ ok: true, status: 204 });
  });

  // The old check used `webhookUrl.includes("discord.com/api/webhooks/")`,
  // which a URL carrying that string in its PATH satisfies while pointing the
  // host at an internal address. These must be rejected before any egress.
  const bypassUrls = [
    "http://169.254.169.254/discord.com/api/webhooks/123/abc",
    "https://10.0.0.1/discord.com/api/webhooks/123/abc",
    "https://evil.example/discord.com/api/webhooks/123/abc",
  ];

  for (const url of bypassUrls) {
    it(`rejects an off-host URL with the webhook path in its path: ${url}`, async () => {
      const result = await runStep(url);
      expect(result).toEqual({
        success: false,
        error: "Invalid Discord webhook URL format",
        errorClass: ExecutionErrorType.USER,
      });
      expect(safeFetch).not.toHaveBeenCalled();
    });
  }

  it("rejects a non-https discord URL", async () => {
    const result = await runStep("http://discord.com/api/webhooks/123/abc");
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("rejects a wrong-path discord URL", async () => {
    const result = await runStep("https://discord.com/api/users/@me");
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("accepts a valid discord.com webhook and routes it through safeFetch", async () => {
    const result = await runStep("https://discord.com/api/webhooks/123/abc");

    expect(result).toEqual({ success: true, messageId: "sent" });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, options] = safeFetch.mock.calls[0] as [
      string,
      { plugin?: string; method?: string },
    ];
    expect(url).toBe("https://discord.com/api/webhooks/123/abc");
    expect(options.plugin).toBe("discord");
    expect(options.method).toBe("POST");
  });

  it("accepts a discord subdomain webhook host (canary)", async () => {
    const result = await runStep(
      "https://canary.discord.com/api/webhooks/123/abc"
    );
    expect(result.success).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});

describe("discord send-message retries", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
    sleep.mockClear();
  });

  it("retries a 429 after the wait Discord reports in the body", async () => {
    safeFetch
      .mockResolvedValueOnce(
        mockResponse(429, {
          message: "You are being rate limited.",
          retry_after: 1.5,
        })
      )
      .mockResolvedValueOnce(mockResponse(204));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result).toEqual({ success: true, messageId: "sent" });
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("falls back to the Retry-After header when the 429 body has no retry_after", async () => {
    safeFetch
      .mockResolvedValueOnce(mockResponse(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(mockResponse(204));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result.success).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("caps a long rate-limit wait so the step does not hang", async () => {
    safeFetch
      .mockResolvedValueOnce(mockResponse(429, { retry_after: 120 }))
      .mockResolvedValueOnce(mockResponse(204));

    await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(sleep).toHaveBeenCalledWith(15_000);
  });

  it("retries 5xx with linear backoff and reports EXTERNAL when exhausted", async () => {
    safeFetch.mockResolvedValue(mockResponse(502, { message: "Bad gateway" }));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 3 });

    expect(result).toEqual({
      success: false,
      error: "Bad gateway",
      errorClass: ExecutionErrorType.EXTERNAL,
    });
    // One attempt plus three retries, one second base delay by default.
    expect(safeFetch).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000, 3000]);
  });

  it("retries a network error and succeeds on a later attempt", async () => {
    safeFetch
      .mockRejectedValueOnce(new Error("connect ECONNRESET"))
      .mockResolvedValueOnce(mockResponse(200, { id: "msg-1" }));

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 1 });

    expect(result).toEqual({ success: true, messageId: "msg-1" });
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient 4xx", async () => {
    safeFetch.mockResolvedValue(
      mockResponse(400, {
        message: "Cannot send an empty message",
        code: 50_006,
      })
    );

    const result = await runStep(WEBHOOK_URL, { retryAttempts: 3 });

    expect(result).toEqual({
      success: false,
      error: "Cannot send an empty message",
      errorClass: ExecutionErrorType.USER,
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honours a retry count and delay set from the editor as strings", async () => {
    safeFetch.mockResolvedValue(mockResponse(503));

    const result = await runStep(WEBHOOK_URL, {
      retryAttempts: "1",
      retryDelay: "5",
    });

    expect(result.success).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("sends exactly once by default, even on a 429", async () => {
    safeFetch.mockResolvedValue(mockResponse(429, { retry_after: 1 }));

    const result = await runStep(WEBHOOK_URL);

    expect(result.success).toBe(false);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range retry count to the maximum", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: 99, retryDelay: 0 });

    // One attempt plus the maximum of five retries.
    expect(safeFetch).toHaveBeenCalledTimes(6);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("clamps the retry delay to 15 seconds", async () => {
    safeFetch.mockResolvedValue(mockResponse(500));

    await runStep(WEBHOOK_URL, { retryAttempts: 1, retryDelay: 60 });

    expect(sleep).toHaveBeenCalledWith(15_000);
  });
});
