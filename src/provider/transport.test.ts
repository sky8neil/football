import { describe, expect, it } from "vitest";
import { DomainError } from "../domain/errors.js";
import {
  ApiFootballClient,
  API_FOOTBALL_BASE_URL,
  ProviderDataError,
  ProviderError,
  ProviderHttpError,
  ProviderQuotaExceededError,
} from "./http.js";
import { FetchProviderHttpClient } from "./transport.js";
import type { ApiFootballFixture } from "./types.js";

const TEST_API_KEY = "test-api-key-not-real";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function createRecordingFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createClient(
  fetchImpl: typeof fetch,
  options: { baseUrl?: string; timeoutMs?: number } = {},
): FetchProviderHttpClient {
  return new FetchProviderHttpClient({
    apiKey: TEST_API_KEY,
    fetchImpl,
    ...options,
  });
}

function sampleFixture(): ApiFootballFixture {
  return {
    fixture: {
      id: 1100001,
      date: "2026-08-08T14:00:00Z",
      timestamp: 1783586400,
      status: { short: "NS" },
    },
    league: { id: 39, season: "2026", round: "Round 1" },
    teams: { home: { id: 40 }, away: { id: 41 } },
  };
}

function fixturesEnvelope(response: ApiFootballFixture[]) {
  return {
    get: "fixtures",
    errors: [],
    results: response.length,
    paging: { current: 1, total: 1 },
    response,
  };
}

function expectPlainTransportError(err: unknown): asserts err is Error {
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ProviderError);
  expect(err).not.toBeInstanceOf(DomainError);
  expect(String(err)).not.toContain(TEST_API_KEY);
}

describe("FetchProviderHttpClient", () => {
  it("拼接 path 并把 query 全部编码进 URLSearchParams", async () => {
    const { fetchImpl, calls } = createRecordingFetch(() => jsonResponse(200, { ok: true }));
    const client = createClient(fetchImpl);

    await client.getJson("fixtures", {
      from: "2026-08-08",
      to: "2026-09-08",
      league: "39",
      season: "2026",
      round: "Regular Season - 1",
      weird: "a&b=c",
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${API_FOOTBALL_BASE_URL}/fixtures`);
    expect(url.searchParams.get("from")).toBe("2026-08-08");
    expect(url.searchParams.get("to")).toBe("2026-09-08");
    expect(url.searchParams.get("league")).toBe("39");
    expect(url.searchParams.get("season")).toBe("2026");
    expect(url.searchParams.get("round")).toBe("Regular Season - 1");
    expect(url.searchParams.get("weird")).toBe("a&b=c");
    expect(url.search).toContain("Regular+Season+-+1");
    expect(url.search).toContain("a%26b%3Dc");
  });

  it("发送 x-apisports-key 与 Accept: application/json", async () => {
    const { fetchImpl, calls } = createRecordingFetch(() => jsonResponse(200, { ok: true }));
    const client = createClient(fetchImpl);

    await client.getJson("status", {});

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-apisports-key")).toBe(TEST_API_KEY);
    expect(headers.get("Accept")).toBe("application/json");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("2xx 解析并返回 JSON 对象", async () => {
    const payload = { get: "status", errors: [], results: 0, response: [] };
    const { fetchImpl } = createRecordingFetch(() => jsonResponse(200, payload));
    const client = createClient(fetchImpl);

    await expect(client.getJson("status", {})).resolves.toEqual(payload);
  });

  it("2xx 但 body 非法 JSON → ProviderDataError", async () => {
    const { fetchImpl } = createRecordingFetch(
      () => new Response("not-json{", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = createClient(fetchImpl);

    await expect(client.getJson("fixtures", {})).rejects.toBeInstanceOf(ProviderDataError);
  });

  it("2xx 但 body 非对象 → ProviderDataError", async () => {
    const { fetchImpl } = createRecordingFetch(() => jsonResponse(200, ["not-an-object"]));
    const client = createClient(fetchImpl);

    await expect(client.getJson("fixtures", {})).rejects.toBeInstanceOf(ProviderDataError);
  });

  it("429 → ProviderQuotaExceededError（非 ProviderHttpError）", async () => {
    const { fetchImpl } = createRecordingFetch(
      () => new Response("quota", { status: 429, statusText: "Too Many Requests" }),
    );
    const client = createClient(fetchImpl);

    const err = await client.getJson("fixtures", {}).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderQuotaExceededError);
    expect(err).not.toBeInstanceOf(ProviderHttpError);
    expect(err).toMatchObject({ resetAt: null });
    expect(String(err)).not.toContain(TEST_API_KEY);
  });

  it("429 可读 reset header 为 resetAt", async () => {
    const resetUnix = 1_783_586_400;
    const { fetchImpl } = createRecordingFetch(() =>
      new Response("quota", {
        status: 429,
        headers: { "x-ratelimit-requests-reset": String(resetUnix) },
      }),
    );
    const client = createClient(fetchImpl);

    const err = await client.getJson("fixtures", {}).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderQuotaExceededError);
    expect((err as ProviderQuotaExceededError).resetAt?.getTime()).toBe(resetUnix * 1000);
  });

  it("408 → ProviderHttpError status=408（§49.13 retry 集合）", async () => {
    const { fetchImpl } = createRecordingFetch(
      () => new Response("timeout", { status: 408, statusText: "Request Timeout" }),
    );
    const client = createClient(fetchImpl);

    const err = await client.getJson("fixtures", {}).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 408, code: "PROVIDER_HTTP_408" });
  });

  it("500/502 → ProviderHttpError status>=500（§49.13 retry 集合）", async () => {
    for (const status of [500, 502]) {
      const { fetchImpl } = createRecordingFetch(
        () => new Response("upstream", { status, statusText: "Server Error" }),
      );
      const client = createClient(fetchImpl);
      const err = await client.getJson("fixtures", {}).catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(ProviderHttpError);
      expect(err).toMatchObject({ status });
      expect((err as ProviderHttpError).status).toBeGreaterThanOrEqual(500);
    }
  });

  it("其他 4xx（403）→ ProviderHttpError status=403（不 retry 集合，仅分类）", async () => {
    const { fetchImpl } = createRecordingFetch(
      () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    const client = createClient(fetchImpl);

    const err = await client.getJson("fixtures", {}).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err).toMatchObject({ status: 403, code: "PROVIDER_HTTP_403" });
  });

  it("超时 AbortError → 普通 Error（非 ProviderError/DomainError）且带 cause", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    const { fetchImpl } = createRecordingFetch(() => {
      throw abort;
    });
    const client = createClient(fetchImpl);

    const err = await client.getJson("fixtures", {}).catch((caught: unknown) => caught);
    expectPlainTransportError(err);
    expect(err.message).toMatch(/provider timeout/i);
    expect(err.cause).toBe(abort);
  });

  it("触发 signal abort → 普通 Error 且 instanceof ProviderError === false", async () => {
    const { fetchImpl } = createRecordingFetch((_url, init) => {
      const signal = init?.signal;
      if (signal == null) {
        throw new Error("missing abort signal");
      }
      if (signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });
    const client = createClient(fetchImpl, { timeoutMs: 1 });

    const err = await client.getJson("fixtures", {}).catch((caught: unknown) => caught);
    expectPlainTransportError(err);
    expect(err instanceof ProviderError).toBe(false);
    expect(err instanceof DomainError).toBe(false);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).name).toBe("AbortError");
  });

  it("网络失败 TypeError('fetch failed') → 普通 Error 非 ProviderError", async () => {
    const network = new TypeError("fetch failed");
    const { fetchImpl } = createRecordingFetch(() => {
      throw network;
    });
    const client = createClient(fetchImpl);

    const err = await client.getJson("fixtures", {}).catch((caught: unknown) => caught);
    expectPlainTransportError(err);
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/provider network/i);
    expect(err.cause).toBe(network);
  });

  it("原始 payload 保留 paging/errors，传输层不裁剪", async () => {
    const payload = {
      get: "fixtures",
      parameters: { league: "39" },
      errors: [],
      results: 0,
      paging: { current: 2, total: 4 },
      response: [],
    };
    const { fetchImpl } = createRecordingFetch(() => jsonResponse(200, payload));
    const client = createClient(fetchImpl);

    const result = await client.getJson("fixtures", { page: "2" });
    expect(result).toEqual(payload);
    expect(result).toMatchObject({
      paging: { current: 2, total: 4 },
      errors: [],
    });
  });

  it("与 ApiFootballClient 集成：fake envelope 端到端返回 fixture 数组", async () => {
    const fixture = sampleFixture();
    const { fetchImpl, calls } = createRecordingFetch(() =>
      jsonResponse(200, fixturesEnvelope([fixture])),
    );
    const http = createClient(fetchImpl);
    const client = new ApiFootballClient(http);

    const result = await client.getFixtures({
      dateFrom: "2026-08-08",
      dateTo: "2026-09-08",
      leagueId: "39",
      season: "2026",
    });

    expect(result).toEqual([fixture]);
    expect(result[0]?.fixture.id).toBe(1100001);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${API_FOOTBALL_BASE_URL}/fixtures`);
    expect(url.searchParams.get("from")).toBe("2026-08-08");
    expect(url.searchParams.get("to")).toBe("2026-09-08");
    expect(url.searchParams.get("league")).toBe("39");
    expect(url.searchParams.get("season")).toBe("2026");
    expect(url.searchParams.get("timezone")).toBe("UTC");
  });
});
