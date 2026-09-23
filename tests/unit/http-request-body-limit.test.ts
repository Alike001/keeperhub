import { beforeEach, describe, expect, it, vi } from "vitest";

// The HTTP Request step stops reading a response body at the stored-output
// limit. A body it could not store is failed, never retried and never
// soft-failed into a null-data success.

vi.mock("server-only", () => ({}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(),
  assertUrlIsPublic: vi.fn(() => Promise.resolve()),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { safeFetch } from "@/lib/safe-fetch";
import { httpRequest } from "@/lib/workflow/nodes/http-request/perform";
import { MAX_STORED_OUTPUT_BYTES } from "@/lib/workflow/output-limits";

const mockedSafeFetch = vi.mocked(safeFetch);

const CHUNK = new TextEncoder().encode("x".repeat(64 * 1024));

function streamOf(chunkCount: number, onCancel?: () => void): ReadableStream {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(CHUNK);
    },
    cancel() {
      onCancel?.();
    },
  });
}

function response(
  body: BodyInit | null,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const input = { endpoint: "https://api.example.com/data", httpMethod: "GET" };

describe("HTTP Request body limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a body within the limit as before", async () => {
    mockedSafeFetch.mockResolvedValue(
      response(JSON.stringify({ count: 3, results: [1, 2, 3] }))
    );
    const result = await httpRequest(input);
    expect(result).toEqual({
      success: true,
      data: { count: 3, results: [1, 2, 3] },
      status: 200,
    });
  });

  it("refuses a declared Content-Length above the limit without reading", async () => {
    let cancelled = false;
    mockedSafeFetch.mockResolvedValue(
      response(
        streamOf(1000, () => {
          cancelled = true;
        }),
        {
          headers: { "content-length": String(MAX_STORED_OUTPUT_BYTES + 1) },
        }
      )
    );
    const result = await httpRequest(input);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(
      /response body of 1\.0 MiB exceeds the 1\.0 MiB limit/
    );
    expect(cancelled).toBe(true);
  });

  it("stops a chunked body as soon as it crosses the limit", async () => {
    let cancelled = false;
    // 64 KiB chunks: the 17th crosses 1 MiB. 100 chunks are on offer.
    mockedSafeFetch.mockResolvedValue(
      response(
        streamOf(100, () => {
          cancelled = true;
        })
      )
    );
    const result = await httpRequest(input);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain(
      "exceeds the 1.0 MiB limit for step output"
    );
    expect(cancelled).toBe(true);
  });

  it("neither retries nor soft-fails an oversized body", async () => {
    mockedSafeFetch.mockImplementation(() =>
      Promise.resolve(response(streamOf(100)))
    );
    const result = await httpRequest({
      ...input,
      failOnError: false,
      retryAttempts: 3,
    });
    expect(result.success).toBe(false);
    expect(mockedSafeFetch).toHaveBeenCalledTimes(1);
  });

  it("withholds an oversized error body instead of embedding it", async () => {
    mockedSafeFetch.mockResolvedValue(response(streamOf(100), { status: 500 }));
    const result = await httpRequest(input);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(
      /status 500: response body of .* withheld/
    );
  });
});
