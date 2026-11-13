import http from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { makeRequestId, mapErrorToHttp } from "../api/v1/validation.js";
import { SessionService } from "../application/session.js";
import { MatchQueryService } from "../application/match-query.js";
import { validationError } from "../domain/errors.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import type { AuthSessionStore } from "../infrastructure/postgres-auth-sessions.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { createVpsRuntime } from "../runtime/vps-runtime.js";
import { createGatewayRepositoryHandle } from "./repository-factory.js";
import { handleGatewayRequest } from "./assemble.js";
import {
  LOCAL_PUBLIC_SOURCE,
  loadGatewayRuntimeConfig,
  type GatewayRuntimeConfig,
} from "./config.js";
import {
  getGatewaySeedScenario,
  seedGatewayRepository,
  seedRankingLeaderboard,
} from "./seed.js";
import type { WechatCode2SessionHttp } from "./wechat-login.js";

export const GATEWAY_LISTEN_HOST = "127.0.0.1";
export const GATEWAY_LISTEN_PORT = 8787;

function parseQuery(searchParams: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (!Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = value;
    }
  }
  return query;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw validationError("请求体必须为 JSON 对象");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw validationError("请求体必须为 JSON 对象");
  }
  return parsed;
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function startGatewayServer(options: {
  env?: Record<string, string | undefined>;
  cloudbase_db?: CloudBaseDb;
  port?: number;
  wechat_http?: WechatCode2SessionHttp;
} = {}): Promise<http.Server> {
  let config: GatewayRuntimeConfig;
  try {
    config = loadGatewayRuntimeConfig(options.env ?? process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid gateway config";
    console.error(message);
    process.exit(1);
  }

  if (config.public_source !== LOCAL_PUBLIC_SOURCE) {
    console.error("invalid public_source");
    process.exit(1);
  }

  let repo;
  let sessions: AuthSessionStore | undefined;
  let wechatHttp: WechatCode2SessionHttp | undefined;
  let healthCheck: () => Promise<boolean> = async () => true;
  let closeHandle: () => Promise<void>;

  if (config.repository_backend === "postgres") {
    if (config.postgres_repository === null) {
      console.error("PostgreSQL repository configuration is required");
      process.exit(1);
    }
    const runtime = createVpsRuntime({
      postgres: config.postgres_repository,
      ...(options.wechat_http !== undefined ? { wechatHttp: options.wechat_http } : {}),
    });
    repo = runtime.repo;
    sessions = runtime.sessions;
    wechatHttp = runtime.wechatHttp;
    healthCheck = () => runtime.healthCheck();
    closeHandle = () => runtime.close();
  } else {
    let handle;
    try {
      handle = createGatewayRepositoryHandle(config, options.cloudbase_db);
    } catch (err) {
      console.error(err instanceof Error ? err.message : "repository configuration failed");
      process.exit(1);
    }
    repo = handle.repo;
    closeHandle = () => handle.close();
    if (options.wechat_http !== undefined) {
      wechatHttp = options.wechat_http;
    }
  }
  if (repo instanceof InMemoryRepository) {
    const seedNow = new Date();
    const seedScenario = getGatewaySeedScenario(
      (options.env ?? process.env).FOOTBALL_SEED_SCENARIO,
    );
    await seedGatewayRepository(repo, seedNow);
    await seedRankingLeaderboard(
      repo,
      seedNow,
      seedScenario,
      config.mock_trusted_openid,
    );
  }
  const session = new SessionService(repo);
  const matches = new MatchQueryService(repo, config.match_cursor_secret);
  const rateLimiter = new InMemoryRateLimiter();

  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? "/", `http://${GATEWAY_LISTEN_HOST}`);
      const query = parseQuery(requestUrl.searchParams);
      const method = (req.method ?? "").toUpperCase();
      try {
        if (method === "GET" && requestUrl.pathname === "/health") {
          const ok = await healthCheck();
          writeJson(res, ok ? 200 : 503, { ok });
          return;
        }
        let body: unknown = {};
        if (["POST", "PATCH", "PUT"].includes(method)) {
          body = await readJsonBody(req);
        }
        const result = await handleGatewayRequest({
          method: req.method ?? "",
          path: requestUrl.pathname,
          query,
          body,
          server_now: new Date(),
          config,
          services: { session, matches },
          repo,
          rate_limiter: rateLimiter,
          ...(req.headers.authorization !== undefined
            ? { authorization: req.headers.authorization }
            : {}),
          ...(sessions !== undefined ? { sessions } : {}),
          ...(wechatHttp !== undefined ? { wechat_http: wechatHttp } : {}),
        });
        writeJson(res, result.status, result.body);
      } catch (err) {
        const mapped = mapErrorToHttp(err, makeRequestId());
        writeJson(res, mapped.status, mapped.body);
      }
    })();
  });

  let closed = false;
  const closeResources = async () => {
    if (closed) return;
    closed = true;
    await closeHandle();
  };
  server.on("close", () => {
    void closeResources();
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port ?? GATEWAY_LISTEN_PORT, GATEWAY_LISTEN_HOST, () => {
        server.off("error", rejectListen);
        const address = server.address();
        console.log(`listening ${GATEWAY_LISTEN_HOST}:${address && typeof address !== "string" ? address.port : options.port ?? GATEWAY_LISTEN_PORT}`);
        resolveListen();
      });
    });
  } catch (err) {
    await closeResources();
    throw err;
  }

  return server;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  void startGatewayServer().then((server) => {
    process.once("SIGTERM", () => {
      server.close();
    });
  });
}
