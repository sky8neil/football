import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { makeRequestId, mapErrorToHttp } from "../api/v1/validation.js";
import { SessionService } from "../application/session.js";
import { MatchQueryService } from "../application/match-query.js";
import { LeagueStatusService } from "../application/league-status-service.js";
import { validationError } from "../domain/errors.js";
import type { CloudBaseDb } from "../infrastructure/cloudbase-db.js";
import {
  createInMemoryAdminConsumedJtiStore,
  createInMemoryAuthSessionStore,
  type AdminConsumedJtiStore,
  type AuthSessionStore,
} from "../infrastructure/postgres-auth-sessions.js";
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
const GATEWAY_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_JSON_BODY_BYTES = 256 * 1024;
const ADMIN_STATIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../admin");
const ADMIN_MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const gatewayResourceClosers = new WeakMap<http.Server, () => Promise<void>>();
const gatewayShutdowns = new WeakMap<http.Server, Promise<void>>();

class GatewayHttpError extends Error {
  readonly status: number;
  readonly errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

function parseQuery(searchParams: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (!Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = value;
    }
  }
  return query;
}

function parseRequestUrl(raw: string | undefined): URL {
  try {
    return new URL(raw ?? "/", `http://${GATEWAY_LISTEN_HOST}`);
  } catch {
    throw new GatewayHttpError(400, "VALIDATION_ERROR", "请求 URL 非法");
  }
}

function declaredContentLength(req: http.IncomingMessage): number | undefined {
  const raw = headerFirstValue(req.headers["content-length"]);
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const declared = declaredContentLength(req);
  if (declared !== undefined && declared > MAX_JSON_BODY_BYTES) {
    throw new GatewayHttpError(413, "PAYLOAD_TOO_LARGE", "请求体超过 256KB 上限");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > MAX_JSON_BODY_BYTES) {
      throw new GatewayHttpError(413, "PAYLOAD_TOO_LARGE", "请求体超过 256KB 上限");
    }
    chunks.push(buffer);
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
  if (status === 204) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function tryServeAdminStatic(
  method: string,
  pathname: string,
  res: http.ServerResponse,
): Promise<boolean> {
  if (pathname === "/admin") {
    if (method !== "GET") {
      writeJson(res, 405, {
        code: "METHOD_NOT_ALLOWED",
        message: "方法不允许",
        request_id: makeRequestId(),
        details: null,
      });
      return true;
    }
    res.statusCode = 308;
    res.setHeader("Location", "/admin/");
    res.end();
    return true;
  }
  if (!pathname.startsWith("/admin/")) {
    return false;
  }
  if (method !== "GET") {
    writeJson(res, 405, {
      code: "METHOD_NOT_ALLOWED",
      message: "方法不允许",
      request_id: makeRequestId(),
      details: null,
    });
    return true;
  }
  const relative = pathname.slice("/admin/".length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    writeJson(res, 400, {
      code: "VALIDATION_ERROR",
      message: "请求路径非法",
      request_id: makeRequestId(),
      details: null,
    });
    return true;
  }
  const targetRel = decoded.length === 0 ? "index.html" : decoded;
  const resolved = resolve(ADMIN_STATIC_ROOT, targetRel);
  if (!resolved.startsWith(`${ADMIN_STATIC_ROOT}${sep}`)) {
    writeJson(res, 404, {
      code: "NOT_FOUND",
      message: "资源不存在",
      request_id: makeRequestId(),
      details: null,
    });
    return true;
  }
  const mime = ADMIN_MIME_TYPES[extname(resolved)];
  if (mime === undefined) {
    writeJson(res, 404, {
      code: "NOT_FOUND",
      message: "资源不存在",
      request_id: makeRequestId(),
      details: null,
    });
    return true;
  }
  try {
    const content = await readFile(resolved);
    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    res.end(content);
  } catch {
    writeJson(res, 404, {
      code: "NOT_FOUND",
      message: "资源不存在",
      request_id: makeRequestId(),
      details: null,
    });
  }
  return true;
}

function writeGatewayHttpError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  error: GatewayHttpError,
): void {
  const payload = JSON.stringify({
    code: error.errorCode,
    message: error.message,
    request_id: makeRequestId(),
    details: null,
  });
  if (error.status === 413) {
    const destroy = () => {
      if (req.destroyed) return;
      req.on("error", () => {});
      req.destroy();
    };
    res.once("finish", destroy);
    res.once("error", destroy);
    res.setHeader("Connection", "close");
  }
  res.statusCode = error.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function headerFirstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const first = raw.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/** 提取客户端 IP；仅在来自本机回环反代（如 Caddy）时采信转发头。 */
export function extractClientIp(req: http.IncomingMessage): string | undefined {
  const remote = req.socket?.remoteAddress?.trim();
  if (remote && isLoopbackAddress(remote)) {
    const forwarded = headerFirstValue(req.headers["x-real-ip"])
      ?? headerFirstValue(req.headers["x-forwarded-for"]);
    if (forwarded !== undefined) return forwarded;
  }
  return remote && remote.length > 0 ? remote : undefined;
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
  let adminConsumedJtis: AdminConsumedJtiStore | undefined;
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
      env: options.env ?? process.env,
      ...(options.wechat_http !== undefined ? { wechatHttp: options.wechat_http } : {}),
    });
    repo = runtime.repo;
    sessions = runtime.sessions;
    adminConsumedJtis = runtime.adminConsumedJtis;
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
    sessions = createInMemoryAuthSessionStore();
    adminConsumedJtis = createInMemoryAdminConsumedJtiStore();
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
  const leagueStatus = new LeagueStatusService(repo);
  const rateLimiter = new InMemoryRateLimiter();

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const requestUrl = parseRequestUrl(req.url);
        const query = parseQuery(requestUrl.searchParams);
        const method = (req.method ?? "").toUpperCase();
        if (method === "GET" && requestUrl.pathname === "/health") {
          const ok = await healthCheck();
          writeJson(res, ok ? 200 : 503, { ok });
          return;
        }
        if (await tryServeAdminStatic(method, requestUrl.pathname, res)) {
          return;
        }
        let body: unknown = {};
        if (["POST", "PATCH", "PUT"].includes(method)) {
          body = await readJsonBody(req);
        }
        const clientIp = extractClientIp(req);
        const result = await handleGatewayRequest({
          method: req.method ?? "",
          path: requestUrl.pathname,
          query,
          body,
          server_now: new Date(),
          config,
          services: { session, matches, league_status: leagueStatus },
          repo,
          rate_limiter: rateLimiter,
          ...(clientIp !== undefined ? { client_ip: clientIp } : {}),
          ...(req.headers.authorization !== undefined
            ? { authorization: req.headers.authorization }
            : {}),
          ...(sessions !== undefined ? { sessions } : {}),
          ...(adminConsumedJtis !== undefined ? { admin_consumed_jtis: adminConsumedJtis } : {}),
          ...(wechatHttp !== undefined ? { wechat_http: wechatHttp } : {}),
        });
        writeJson(res, result.status, result.body);
      } catch (err) {
        if (err instanceof GatewayHttpError) {
          writeGatewayHttpError(req, res, err);
          return;
        }
        const mapped = mapErrorToHttp(err, makeRequestId());
        writeJson(res, mapped.status, mapped.body);
      }
    })();
  });

  let closePromise: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = Promise.resolve()
      .then(() => closeHandle())
      .then(() => undefined, (err: unknown) => {
        const message = err instanceof Error ? err.message : "failed to close gateway resources";
        console.error(message);
        throw err instanceof Error ? err : new Error(message);
      });
    return closePromise;
  };
  gatewayResourceClosers.set(server, closeResources);
  server.on("close", () => {
    void closeResources().catch(() => undefined);
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
    await closeResources().catch(() => undefined);
    throw err;
  }

  return server;
}

export function shutdownGatewayServer(server: http.Server): Promise<void> {
  const existing = gatewayShutdowns.get(server);
  if (existing !== undefined) return existing;
  const pending = performGatewayShutdown(server);
  gatewayShutdowns.set(server, pending);
  return pending;
}

async function performGatewayShutdown(server: http.Server): Promise<void> {
  server.closeIdleConnections();
  try {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  } finally {
    const closeResources = gatewayResourceClosers.get(server);
    if (closeResources !== undefined) await closeResources();
  }
}

interface GatewayEntrypoint {
  start: () => Promise<http.Server>;
  shutdown: (server: http.Server) => Promise<void>;
  exit: (code: number) => void;
  onceSignal: (signal: NodeJS.Signals, listener: () => void) => void;
  logError: (message: string) => void;
  shutdownTimeoutMs: number;
}

export function runGatewayEntrypoint(deps: GatewayEntrypoint): void {
  let active: http.Server | undefined;
  let shutdownRequested = false;
  let shutdownStarted = false;

  const beginShutdown = (server: http.Server): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number, message?: string): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (message !== undefined) deps.logError(message);
      deps.exit(code);
    };
    timer = setTimeout(() => {
      finish(1, "gateway shutdown timed out");
    }, deps.shutdownTimeoutMs);
    void deps.shutdown(server).then(() => {
      finish(0);
    }, (err: unknown) => {
      finish(1, err instanceof Error ? err.message : "gateway shutdown failed");
    });
  };

  const onSignal = (): void => {
    shutdownRequested = true;
    if (active !== undefined) beginShutdown(active);
  };
  deps.onceSignal("SIGTERM", onSignal);
  deps.onceSignal("SIGINT", onSignal);

  void deps.start().then((server) => {
    active = server;
    if (shutdownRequested) beginShutdown(server);
  }).catch((err: unknown) => {
    deps.logError(err instanceof Error ? err.message : "gateway failed to start");
    deps.exit(1);
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  runGatewayEntrypoint({
    start: () => startGatewayServer(),
    shutdown: shutdownGatewayServer,
    exit: (code) => {
      process.exit(code);
    },
    onceSignal: (signal, listener) => {
      process.once(signal, listener);
    },
    logError: (message) => {
      console.error(message);
    },
    shutdownTimeoutMs: GATEWAY_SHUTDOWN_TIMEOUT_MS,
  });
}
