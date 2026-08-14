/**
 * 微信云函数入口（薄网关）。
 *
 * 待真环境部署验证（无微信云开发环境；OPENID 注入为生产路径，
 * 本地以注入 fake context 验证）。
 *
 * 不 import 微信云开发 SDK。context 使用注入的 CloudFunctionContextLike。
 * 身份只来自 resolveOpenid(context, config)；永不读 event.body / query
 * 中的 openid / user_id。
 *
 * 冻结的 handleGatewayRequest 通过 resolveTrustedOpenid(config) 取身份
 * （prod 恒为 null）。本入口把运行时 OPENID 通过 GatewayRequestInput.trusted_openid
 * 显式注入，不再改动 config.environment，避免 prod→dev 降级；生产身份仍只认
 * context.OPENID。
 */
import { makeRequestId, mapErrorToHttp } from "../api/v1/validation.js";
import { DomainError } from "../domain/errors.js";
import type {
  GatewayRequestInput,
  GatewayResponse,
} from "../gateway/assemble.js";
import type { GatewayRuntimeConfig } from "../gateway/config.js";
import { resolveTrustedOpenid } from "../gateway/identity.js";

/** 规划级环境键名，无密钥值。与 GatewayRuntimeConfig / B1 / B5 对齐。 */
export const CLOUD_FUNCTION_ENV_KEYS = {
  environment: "FOOTBALL_ENVIRONMENT",
  match_cursor_secret: "FOOTBALL_MATCH_CURSOR_SECRET",
  mock_trusted_openid: "FOOTBALL_MOCK_TRUSTED_OPENID",
  cloud_environment_id: "FOOTBALL_CLOUD_ENVIRONMENT_ID",
  resource_namespace: "FOOTBALL_RESOURCE_NAMESPACE",
} as const;

export interface CloudFunctionContextLike {
  OPENID?: string | null | undefined;
}

export interface CloudFunctionEvent {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface CloudFunctionLogEntry {
  request_id: string;
  method: string;
  path: string;
  status: number;
  code?: string;
}

export interface CloudFunctionHandlerDeps {
  assemble: (input: GatewayRequestInput) => Promise<GatewayResponse>;
  config: GatewayRuntimeConfig;
  services: GatewayRequestInput["services"];
  repo: GatewayRequestInput["repo"];
  rate_limiter: GatewayRequestInput["rate_limiter"];
  serverNow?: () => Date;
  log?: (entry: CloudFunctionLogEntry) => void;
  resolveOpenid?: (
    context: CloudFunctionContextLike,
    config: GatewayRuntimeConfig,
  ) => string | null;
}

function normalizeOpenid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 默认身份解析：prod 只认 context.OPENID；dev/test 优先 mock，
 * 无 mock 时回退 context.OPENID。不读客户端字段。
 */
export function resolveCloudFunctionOpenid(
  context: CloudFunctionContextLike,
  config: GatewayRuntimeConfig,
): string | null {
  const contextOpenid = normalizeOpenid(context.OPENID);
  if (config.environment === "prod") {
    return contextOpenid;
  }
  return resolveTrustedOpenid(config) ?? contextOpenid;
}

function readMethod(event: CloudFunctionEvent): string {
  return typeof event.method === "string" ? event.method : "";
}

function readPath(event: CloudFunctionEvent): string {
  return typeof event.path === "string" ? event.path : "";
}

function readQuery(event: CloudFunctionEvent): Record<string, string> {
  const query = event.query;
  if (query === undefined || query === null || typeof query !== "object" || Array.isArray(query)) {
    return {};
  }
  return { ...query };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseCode(body: unknown): string | undefined {
  if (!isJsonObject(body)) {
    return undefined;
  }
  return typeof body.code === "string" ? body.code : undefined;
}

function responseRequestId(body: unknown): string | undefined {
  if (!isJsonObject(body)) {
    return undefined;
  }
  return typeof body.request_id === "string" && body.request_id.length > 0
    ? body.request_id
    : undefined;
}

function withRequestId(body: unknown, requestId: string): unknown {
  if (!isJsonObject(body)) {
    return { request_id: requestId };
  }
  if (responseRequestId(body) !== undefined) {
    return body;
  }
  return { ...body, request_id: requestId };
}

function logEntry(
  requestId: string,
  method: string,
  path: string,
  status: number,
  code: string | undefined,
): CloudFunctionLogEntry {
  if (code === undefined) {
    return { request_id: requestId, method, path, status };
  }
  return { request_id: requestId, method, path, status, code };
}

export function createCloudFunctionHandler(
  deps: CloudFunctionHandlerDeps,
): (
  event: CloudFunctionEvent,
  context: CloudFunctionContextLike,
) => Promise<{ result: GatewayResponse }> {
  const resolveOpenid = deps.resolveOpenid ?? resolveCloudFunctionOpenid;
  const serverNow = deps.serverNow ?? (() => new Date());

  return async (event, context) => {
    const requestId = makeRequestId();
    const method = readMethod(event);
    const path = readPath(event);
    const trustedOpenid = resolveOpenid(context, deps.config);

    try {
      const assembled = await deps.assemble({
        method,
        path,
        query: readQuery(event),
        body: event.body,
        server_now: serverNow(),
        config: deps.config,
        trusted_openid: trustedOpenid,
        request_id: requestId,
        services: deps.services,
        repo: deps.repo,
        rate_limiter: deps.rate_limiter,
      });
      const body = withRequestId(assembled.body, requestId);
      const envelopeRequestId = responseRequestId(body) ?? requestId;
      const result: GatewayResponse = { status: assembled.status, body };
      deps.log?.(
        logEntry(
          envelopeRequestId,
          method,
          path,
          result.status,
          responseCode(body),
        ),
      );
      return { result };
    } catch (err) {
      if (err instanceof DomainError) {
        const mapped = mapErrorToHttp(err, requestId);
        deps.log?.(
          logEntry(requestId, method, path, mapped.status, mapped.body.code),
        );
        return { result: mapped };
      }
      deps.log?.(logEntry(requestId, method, path, 500, "INTERNAL_ERROR"));
      throw err;
    }
  };
}
