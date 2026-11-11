import { createServer } from "node:http";
import { SEMATTRS_HTTP_URL } from "@opentelemetry/semantic-conventions";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAttributesFromHeaders,
  createFetchAttributes,
  createFetchResponseAttributes,
  retry,
} from "./retry.js";

describe("retry fetch telemetry", () => {
  it("omits URL credentials, query parameters, and fragments", () => {
    const attributes = createFetchAttributes(
      "https://user:password@example.com/path?token=secret#fragment"
    );

    expect(attributes[SEMATTRS_HTTP_URL]).toBe("https://example.com/path");
  });

  it("records only explicitly allowed response headers", () => {
    const attributes = createAttributesFromHeaders(
      new Headers({
        authorization: "secret",
        "content-type": "application/json",
        "retry-after": "10",
        "set-cookie": "session=secret",
        "x-api-key": "secret",
        "x-ratelimit-remaining": "9",
      })
    );

    expect(attributes).toEqual({
      "http.response.header.content-type": "application/json",
      "http.response.header.retry-after": "10",
    });
  });

  it("keeps status and content length response diagnostics", () => {
    const attributes = createFetchResponseAttributes(
      new Response(null, {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "content-length": "123",
          "set-cookie": "session=secret",
        },
      })
    );

    expect(attributes).toMatchObject({
      "http.status_code": 429,
      "http.status_text": "Too Many Requests",
      "http.response_content_length": "123",
      "http.response.header.content-length": "123",
    });
    expect(attributes).not.toHaveProperty("http.response.header.set-cookie");
  });
});

describe("retry.fetch caller abort signal", () => {
  let requestCount = 0;
  let onRequest = () => {};
  let abortedAt = 0;
  let url = "";

  const server = createServer((_request, response) => {
    requestCount++;
    onRequest();
    setTimeout(() => response.end(), requestCount === 1 ? 500 : 0);
  });

  const fastTimeoutRetry = {
    timeout: { maxAttempts: 2, minTimeoutInMs: 1, maxTimeoutInMs: 1, randomize: false },
  };

  const abortOnFirstRequest = (reason?: unknown) => {
    const controller = new AbortController();
    onRequest = () => {
      abortedAt = Date.now();
      controller.abort(reason);
    };
    return controller.signal;
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    url = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requestCount = 0;
    onRequest = () => {};
  });

  // Catches: the caller's abort being retried as a timeout, so it waits out the backoff or resends.
  it("rejects with an AbortError, without a retry, when the caller aborts mid-request", async () => {
    const signal = abortOnFirstRequest();
    const slowTimeoutRetry = {
      timeout: { maxAttempts: 2, minTimeoutInMs: 4_000, maxTimeoutInMs: 4_000, randomize: false },
    };

    await expect(
      runInMockTaskContext(() => retry.fetch(url, { signal, retry: slowTimeoutRetry }))
    ).rejects.toHaveProperty("name", "AbortError");
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(requestCount).toBe(1);
  });

  // Catches: a Request input's own signal being dropped, or its abort reason being replaced.
  it("rejects with the abort reason when the signal of a Request input aborts", async () => {
    const reason = new Error("stopped by caller");
    const request = new Request(url, { signal: abortOnFirstRequest(reason) });

    await expect(
      runInMockTaskContext(() => retry.fetch(request, { retry: fastTimeoutRetry }))
    ).rejects.toBe(reason);
    expect(requestCount).toBe(1);
  });

  // Catches: the caller-abort check also stopping retries of retry.fetch's own timeoutInMs.
  it("still retries after its own timeoutInMs fires", async () => {
    const response = await runInMockTaskContext(() =>
      retry.fetch(url, { timeoutInMs: 250, retry: fastTimeoutRetry })
    );

    expect(response.status).toBe(200);
    expect(requestCount).toBe(2);
  });

  // Catches: an already aborted signal never firing its abort event, so the request goes out anyway.
  it("sends nothing and rejects with the abort reason when init.signal is already aborted", async () => {
    const reason = new Error("stopped by caller");

    await expect(
      runInMockTaskContext(() =>
        retry.fetch(url, { signal: AbortSignal.abort(reason), retry: fastTimeoutRetry })
      )
    ).rejects.toBe(reason);
    expect(requestCount).toBe(0);
  });
});
