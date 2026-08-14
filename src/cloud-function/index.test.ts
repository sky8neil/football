import { describe, expect, it, vi } from "vitest";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { makeRequestId, mapErrorToHttp } from "../api/v1/validation.js";
import { MatchQueryService } from "../application/match-query.js";
import { SessionService } from "../application/session.js";
import {
  conflictError,
  DomainError,
  notFoundError,
  validationError,
} from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  handleGatewayRequest,
  type GatewayRequestInput,
  type GatewayResponse,
} from "../gateway/assemble.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "../gateway/config.js";
import {
  CLOUD_FUNCTION_ENV_KEYS,
  createCloudFunctionHandler,
  resolveCloudFunctionOpenid,
  type CloudFunctionHandlerDeps,
  type CloudFunctionLogEntry,
} from "./index.js";

const TEST_CURSOR_SECRET = "test-match-cursor-secret-b3";
const CONTEXT_OPENID = "wx-runtime-openid-b3";
const MOCK_OPENID = "mock-trusted-openid-b3";
const ATTACKER_OPENID = "attacker-client-openid";
const ATTACKER_USER_ID = "attacker-user-id";
const NOW = new Date("2026-08-09T12:00:00.000Z");

function makeConfig(
  overrides: Partial<GatewayRuntimeConfig> = {},
): GatewayRuntimeConfig {
  return {
    environment: "test",
    mock_trusted_openid: null,
    match_cursor_secret: TEST_CURSOR_SECRET,
    public_source: LOCAL_PUBLIC_SOURCE,
    ...overrides,
  };
}

function makeServices(config: GatewayRuntimeConfig = makeConfig()) {
  const repo = new InMemoryRepository();
  return {
    repo,
    rateLimiter: new InMemoryRateLimiter(),
    session: new SessionService(repo),
    matches: new MatchQueryService(repo, config.match_cursor_secret),
  };
}

function createHandler(
  options: {
    assemble?: CloudFunctionHandlerDeps["assemble"];
    config?: GatewayRuntimeConfig;
    serverNow?: () => Date;
    log?: (entry: CloudFunctionLogEntry) => void;
    resolveOpenid?: CloudFunctionHandlerDeps["resolveOpenid"];
    services?: ReturnType<typeof makeServices>;
  } = {},
) {
  const config = options.config ?? makeConfig();
  const services = options.services ?? makeServices(config);
  const calls: GatewayRequestInput[] = [];
  const assemble =
    options.assemble ??
    (async (): Promise<GatewayResponse> => ({
      status: 200,
      body: { data: { ok: true }, request_id: makeRequestId() },
    }));
  const capturingAssemble: CloudFunctionHandlerDeps["assemble"] = async (
    input,
  ) => {
    calls.push(input);
    return assemble(input);
  };
  return {
    handler: createCloudFunctionHandler({
      assemble: capturingAssemble,
      config,
      services: { session: services.session, matches: services.matches },
      repo: services.repo,
      rate_limiter: services.rateLimiter,
      ...(options.serverNow !== undefined ? { serverNow: options.serverNow } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
      ...(options.resolveOpenid !== undefined
        ? { resolveOpenid: options.resolveOpenid }
        : {}),
    }),
    calls,
    services,
    config,
  };
}

function realAssemble(
  options: {
    config?: GatewayRuntimeConfig;
    serverNow?: () => Date;
    log?: (entry: CloudFunctionLogEntry) => void;
    services?: ReturnType<typeof makeServices>;
  } = {},
) {
  return createHandler({
    assemble: handleGatewayRequest,
    ...options,
  });
}

describe("CLOUD_FUNCTION_ENV_KEYS", () => {
  it("exports planning-level key names only", () => {
    expect(CLOUD_FUNCTION_ENV_KEYS).toEqual({
      environment: "FOOTBALL_ENVIRONMENT",
      match_cursor_secret: "FOOTBALL_MATCH_CURSOR_SECRET",
      mock_trusted_openid: "FOOTBALL_MOCK_TRUSTED_OPENID",
      cloud_environment_id: "FOOTBALL_CLOUD_ENVIRONMENT_ID",
      resource_namespace: "FOOTBALL_RESOURCE_NAMESPACE",
    });
  });
});

describe("resolveCloudFunctionOpenid", () => {
  it("uses only context.OPENID in prod and ignores mock_trusted_openid", () => {
    const prod = makeConfig({
      environment: "prod",
      mock_trusted_openid: MOCK_OPENID,
    });
    expect(
      resolveCloudFunctionOpenid({ OPENID: CONTEXT_OPENID }, prod),
    ).toBe(CONTEXT_OPENID);
    expect(resolveCloudFunctionOpenid({}, prod)).toBeNull();
    expect(resolveCloudFunctionOpenid({ OPENID: null }, prod)).toBeNull();
    expect(resolveCloudFunctionOpenid({ OPENID: "" }, prod)).toBeNull();
    expect(resolveCloudFunctionOpenid({ OPENID: "   " }, prod)).toBeNull();
  });

  it("prefers mock in dev/test and falls back to context.OPENID", () => {
    expect(
      resolveCloudFunctionOpenid(
        { OPENID: CONTEXT_OPENID },
        makeConfig({ environment: "dev", mock_trusted_openid: MOCK_OPENID }),
      ),
    ).toBe(MOCK_OPENID);
    expect(
      resolveCloudFunctionOpenid(
        { OPENID: CONTEXT_OPENID },
        makeConfig({ environment: "test", mock_trusted_openid: null }),
      ),
    ).toBe(CONTEXT_OPENID);
    expect(
      resolveCloudFunctionOpenid(
        {},
        makeConfig({ environment: "test", mock_trusted_openid: "" }),
      ),
    ).toBeNull();
  });
});

describe("createCloudFunctionHandler identity", () => {
  it("forwards prod context.OPENID so the Auth path is reachable", async () => {
    const { handler, calls, services } = realAssemble({
      config: makeConfig({ environment: "prod", mock_trusted_openid: MOCK_OPENID }),
    });

    const response = await handler(
      { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } },
      { OPENID: CONTEXT_OPENID },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.trusted_openid).toBe(CONTEXT_OPENID);
    expect(calls[0]!.config.environment).toBe("prod");
    expect(calls[0]!.config.mock_trusted_openid).toBe(MOCK_OPENID);
    expect(response.result.status).toBe(201);
    expect(response.result.body).toEqual({
      data: expect.objectContaining({
        nickname: "Sky",
        status: "active",
      }),
      request_id: expect.any(String),
    });
    const created = await services.repo.users.findByOpenid(CONTEXT_OPENID);
    expect(created).not.toBeNull();
    expect(await services.repo.users.findByOpenid(MOCK_OPENID)).toBeNull();
  });

  it("passes null identity in prod without OPENID and Auth returns 401 UNAUTHORIZED", async () => {
    const { handler, calls, services } = realAssemble({
      config: makeConfig({ environment: "prod", mock_trusted_openid: MOCK_OPENID }),
    });

    const response = await handler(
      { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } },
      {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.trusted_openid).toBeNull();
    expect(calls[0]!.config.environment).toBe("prod");
    expect(calls[0]!.config.mock_trusted_openid).toBe(MOCK_OPENID);
    expect(response.result.status).toBe(401);
    expect(response.result.body).toEqual(expect.objectContaining({
      code: "UNAUTHORIZED",
      request_id: expect.any(String),
    }));
    expect(await services.repo.users.findAll()).toEqual([]);
  });

  it("uses mock_trusted_openid in test and ignores a different context.OPENID", async () => {
    const { handler, calls, services } = realAssemble({
      config: makeConfig({
        environment: "test",
        mock_trusted_openid: MOCK_OPENID,
      }),
    });

    const response = await handler(
      { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } },
      { OPENID: CONTEXT_OPENID },
    );

    expect(calls[0]!.trusted_openid).toBe(MOCK_OPENID);
    expect(response.result.status).toBe(201);
    expect(await services.repo.users.findByOpenid(MOCK_OPENID)).not.toBeNull();
    expect(await services.repo.users.findByOpenid(CONTEXT_OPENID)).toBeNull();
  });

  it("falls back to context.OPENID in dev when mock is absent", async () => {
    const { handler, calls } = realAssemble({
      config: makeConfig({ environment: "dev", mock_trusted_openid: null }),
    });

    const response = await handler(
      { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } },
      { OPENID: CONTEXT_OPENID },
    );

    expect(calls[0]!.trusted_openid).toBe(CONTEXT_OPENID);
    expect(response.result.status).toBe(201);
  });

  it("does not take identity from event.body or query", async () => {
    const resolveOpenid = vi.fn(resolveCloudFunctionOpenid);
    const { handler, calls } = createHandler({
      config: makeConfig({ environment: "prod" }),
      resolveOpenid,
    });

    await handler(
      {
        method: "POST",
        path: "/v1/session/init",
        query: { openid: ATTACKER_OPENID, user_id: ATTACKER_USER_ID },
        body: { nickname: "Sky", openid: ATTACKER_OPENID, user_id: ATTACKER_USER_ID },
      },
      { OPENID: CONTEXT_OPENID },
    );

    expect(resolveOpenid).toHaveBeenCalledTimes(1);
    expect(resolveOpenid.mock.calls[0]?.[0]).toEqual({ OPENID: CONTEXT_OPENID });
    expect(calls[0]!.trusted_openid).toBe(CONTEXT_OPENID);
    expect(calls[0]!.body).toEqual({
      nickname: "Sky",
      openid: ATTACKER_OPENID,
      user_id: ATTACKER_USER_ID,
    });
    expect(calls[0]!.query).toEqual({
      openid: ATTACKER_OPENID,
      user_id: ATTACKER_USER_ID,
    });
  });

  it("still rejects a client-supplied openid at the session handler (422)", async () => {
    const { handler, services } = realAssemble({
      config: makeConfig({ environment: "prod" }),
    });

    const response = await handler(
      {
        method: "POST",
        path: "/v1/session/init",
        body: { nickname: "Sky", openid: ATTACKER_OPENID },
      },
      { OPENID: CONTEXT_OPENID },
    );

    expect(response.result.status).toBe(422);
    expect(response.result.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
    expect(await services.repo.users.findAll()).toEqual([]);
  });
});

describe("createCloudFunctionHandler request_id and envelope", () => {
  it("returns a unique request_id on each invocation", async () => {
    const { handler } = createHandler();
    const first = await handler(
      { method: "GET", path: "/v1/matches" },
      { OPENID: CONTEXT_OPENID },
    );
    const second = await handler(
      { method: "GET", path: "/v1/matches" },
      { OPENID: CONTEXT_OPENID },
    );
    const firstId = (first.result.body as { request_id: string }).request_id;
    const secondId = (second.result.body as { request_id: string }).request_id;
    expect(isValidUuid(firstId)).toBe(true);
    expect(isValidUuid(secondId)).toBe(true);
    expect(firstId).not.toBe(secondId);
  });

  it("P2-2：把同一 request_id 注入 assemble，日志与 envelope 同 id", async () => {
    const { handler, calls } = realAssemble();
    const response = await handler(
      { method: "GET", path: "/v1/matches" },
      { OPENID: CONTEXT_OPENID },
    );
    const envelopeId = (response.result.body as { request_id: string }).request_id;
    expect(calls[0]!.request_id).toBe(envelopeId);
    expect(isValidUuid(envelopeId)).toBe(true);
  });

  it("stamps request_id when assemble omits it", async () => {
    const { handler } = createHandler({
      assemble: async () => ({ status: 200, body: { data: { ok: true } } }),
    });
    const response = await handler(
      { method: "GET", path: "/v1/matches" },
      {},
    );
    expect(response.result.body).toEqual({
      data: { ok: true },
      request_id: expect.any(String),
    });
  });

  it("maps a thrown DomainError through mapErrorToHttp", async () => {
    const requestId = "will-be-replaced";
    const thrown = conflictError("UNAUTHORIZED", "需要可信微信身份");
    const { handler } = createHandler({
      assemble: async () => {
        throw thrown;
      },
    });

    const response = await handler(
      { method: "POST", path: "/v1/session/init", body: { nickname: "Sky" } },
      {},
    );
    const mapped = mapErrorToHttp(thrown, requestId);
    expect(response.result.status).toBe(mapped.status);
    expect(response.result.body).toEqual(expect.objectContaining({
      code: mapped.body.code,
      message: mapped.body.message,
      details: mapped.body.details,
      request_id: expect.any(String),
    }));
    expect(response.result.status).toBe(401);
    expect((response.result.body as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("maps *_NOT_FOUND to the same 404 envelope as the API layer", async () => {
    const thrown = notFoundError("MATCH");
    const { handler } = createHandler({
      assemble: async () => {
        throw thrown;
      },
    });
    const response = await handler(
      { method: "GET", path: "/v1/matches/missing" },
      { OPENID: CONTEXT_OPENID },
    );
    const mapped = mapErrorToHttp(thrown, "req");
    expect(response.result.status).toBe(404);
    expect(response.result.body).toEqual(expect.objectContaining({
      code: mapped.body.code,
      message: mapped.body.message,
      details: mapped.body.details,
    }));
    expect((response.result.body as { code: string }).code).toBe("MATCH_NOT_FOUND");
  });

  it("returns the same unknown-path envelope as handleGatewayRequest (422)", async () => {
    const { handler } = realAssemble();
    const viaCloud = await handler(
      { method: "GET", path: "/v1/unknown" },
      {},
    );
    const viaAssemble = await handleGatewayRequest({
      method: "GET",
      path: "/v1/unknown",
      query: {},
      body: undefined,
      server_now: NOW,
      config: makeConfig(),
      services: {
        session: new SessionService(new InMemoryRepository()),
        matches: new MatchQueryService(new InMemoryRepository(), TEST_CURSOR_SECRET),
      },
      repo: new InMemoryRepository(),
      rate_limiter: new InMemoryRateLimiter(),
    });
    expect(viaCloud.result.status).toBe(viaAssemble.status);
    expect(viaCloud.result.status).toBe(422);
    expect(viaCloud.result.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
      request_id: expect.any(String),
    }));
    expect(viaAssemble.body).toEqual(expect.objectContaining({
      code: "VALIDATION_ERROR",
    }));
  });

  it("rethrows unknown errors after a failed log so the platform can retry", async () => {
    const logs: CloudFunctionLogEntry[] = [];
    const boom = new Error("disk exploded");
    const { handler } = createHandler({
      assemble: async () => {
        throw boom;
      },
      log: (entry) => {
        logs.push(entry);
      },
    });

    await expect(
      handler({ method: "GET", path: "/v1/matches" }, {}),
    ).rejects.toBe(boom);
    expect(logs).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/v1/matches",
        status: 500,
        code: "INTERNAL_ERROR",
        request_id: expect.any(String),
      }),
    ]);
  });

  it("maps a thrown VALIDATION_ERROR the same way as mapErrorToHttp", async () => {
    const thrown = validationError("不支持的请求");
    const { handler } = createHandler({
      assemble: async () => {
        throw thrown;
      },
    });
    const response = await handler({ method: "GET", path: "/nope" }, {});
    expect(response.result).toEqual(expect.objectContaining({
      status: 422,
      body: expect.objectContaining({
        code: "VALIDATION_ERROR",
        message: "不支持的请求",
        details: null,
        request_id: expect.any(String),
      }),
    }));
    expect(thrown).toBeInstanceOf(DomainError);
  });
});

describe("createCloudFunctionHandler log and server_now", () => {
  it("logs only request_id/method/path/status/code and never OPENID or body", async () => {
    const logs: CloudFunctionLogEntry[] = [];
    const { handler } = realAssemble({
      config: makeConfig({ environment: "prod" }),
      log: (entry) => {
        logs.push(entry);
      },
    });

    await handler(
      {
        method: "POST",
        path: "/v1/session/init",
        body: {
          nickname: "Sky",
          openid: ATTACKER_OPENID,
          password: "super-secret-credential",
        },
      },
      { OPENID: CONTEXT_OPENID },
    );

    expect(logs).toHaveLength(1);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(CONTEXT_OPENID);
    expect(serialized).not.toContain(ATTACKER_OPENID);
    expect(serialized).not.toContain("super-secret-credential");
    expect(serialized).not.toContain("Sky");
    expect(logs[0]).toEqual({
      request_id: expect.any(String),
      method: "POST",
      path: "/v1/session/init",
      status: 422,
      code: "VALIDATION_ERROR",
    });
  });

  it("passes the injected serverNow() to assemble", async () => {
    const { handler, calls } = createHandler({
      serverNow: () => NOW,
    });
    await handler({ method: "GET", path: "/v1/matches" }, {});
    expect(calls[0]!.server_now).toBe(NOW);
  });

  it("returns GET /v1/matches 200 with request_id from the frozen assemble", async () => {
    const { handler } = realAssemble({
      config: makeConfig({ environment: "prod" }),
    });
    const response = await handler(
      { method: "GET", path: "/v1/matches" },
      {},
    );
    expect(response.result.status).toBe(200);
    expect(response.result.body).toEqual({
      data: {
        items: [],
        page: { next_cursor: null, has_more: false },
      },
      request_id: expect.any(String),
    });
  });
});
