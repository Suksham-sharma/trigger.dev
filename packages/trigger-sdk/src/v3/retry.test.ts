import { createServer, type IncomingHttpHeaders } from "node:http";
import { SEMATTRS_HTTP_URL } from "@opentelemetry/semantic-conventions";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAttributesFromHeaders,
  createFetchAttributes,
  createFetchResponseAttributes,
  retry,
} from "./retry.js";

describe("retry.fetch request forwarding", () => {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  let failuresBeforeSuccess = 0;
  let url = "";

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.statusCode = received.length <= failuresBeforeSuccess ? 500 : 200;
      response.end();
    });
  });

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
    received.length = 0;
    failuresBeforeSuccess = 0;
  });

  // Catches: a Request input losing its headers, and its consumed body breaking the retry.
  it("resends the headers and body of a POST Request input on every attempt", async () => {
    failuresBeforeSuccess = 1;
    const request = new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ id: 1 }),
    });

    const response = await runInMockTaskContext(() =>
      retry.fetch(request, {
        retry: {
          byStatus: {
            "500": {
              strategy: "backoff",
              maxAttempts: 2,
              minTimeoutInMs: 1,
              maxTimeoutInMs: 1,
              randomize: false,
            },
          },
        },
      })
    );

    const attempt = (retryCount: string) => ({
      headers: expect.objectContaining({
        authorization: "Bearer token",
        "content-type": "application/json",
        "x-retry-count": retryCount,
      }),
      body: '{"id":1}',
    });

    expect(response.status).toBe(200);
    expect(received).toEqual([attempt("1"), attempt("2")]);
  });

  // Catches: spreading a Headers instance into an object literal, which drops every header.
  it("sends headers passed in init as a Headers instance", async () => {
    await retry.fetch(url, { headers: new Headers({ authorization: "Bearer token" }) });

    expect(received[0]?.headers.authorization).toBe("Bearer token");
  });
});

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
