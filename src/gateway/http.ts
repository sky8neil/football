import http from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { InMemoryRateLimiter } from "../api/v1/rate-limit.js";
import { makeRequestId, mapErrorToHttp } from "../api/v1/validation.js";
import { SessionService } from "../application/session.js";
import { MatchQueryService } from "../application/match-query.js";
import { validationError } from "../domain/errors.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { handleGatewayRequest } from "./assemble.js";
import {
  LOCAL_PUBLIC_SOURCE,
  loadGatewayRuntimeConfig,
  type GatewayRuntimeConfig,
} from "./config.js";
import { seedGatewayRepository, seedRankingLeaderboard } from "./seed.js";

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

export async function startGatewayServer(): Promise<http.Server> {
  let config: GatewayRuntimeConfig;
  try {
    config = loadGatewayRuntimeConfig(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid gateway config";
    console.error(message);
    process.exit(1);
  }

  if (config.public_source !== LOCAL_PUBLIC_SOURCE) {
    console.error("invalid public_source");
    process.exit(1);
  }

  const repo = new InMemoryRepository();
  await seedGatewayRepository(repo, new Date());
  await seedRankingLeaderboard(repo, new Date());
  const session = new SessionService(repo);
  const matches = new MatchQueryService(repo, config.match_cursor_secret);
  const rateLimiter = new InMemoryRateLimiter();

  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? "/", `http://${GATEWAY_LISTEN_HOST}`);
      const query = parseQuery(requestUrl.searchParams);
      try {
        let body: unknown = {};
        if ((req.method ?? "").toUpperCase() === "POST") {
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
        });
        writeJson(res, result.status, result.body);
      } catch (err) {
        const mapped = mapErrorToHttp(err, makeRequestId());
        writeJson(res, mapped.status, mapped.body);
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(GATEWAY_LISTEN_PORT, GATEWAY_LISTEN_HOST, () => {
      server.off("error", rejectListen);
      console.log(`listening ${GATEWAY_LISTEN_HOST}:${GATEWAY_LISTEN_PORT}`);
      resolveListen();
    });
  });

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
  void startGatewayServer();
}
