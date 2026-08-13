import { createHmac, timingSafeEqual } from "node:crypto";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { AnomalyStatus, AnomalyType, SCHEMA_VERSION } from "../domain/enums.js";
import { internalError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import type { Anomaly } from "../domain/types.js";
import type { AdminAnomalyPageQuery, AppRepository } from "../infrastructure/repositories.js";
import { AdminAuthorizationService } from "./admin.js";

export interface AdminAnomaliesQuery {
  status: AnomalyStatus | null;
  blocking: boolean | null;
  limit: number;
  cursor: string | null;
  /** API 层用于区分“未传”与显式传入 null；直接调用方默认按值判断。 */
  status_explicit?: boolean;
  blocking_explicit?: boolean;
}

export interface AdminAnomaliesResult {
  items: Anomaly[];
  next_cursor: string | null;
  has_more: boolean;
}

interface AnomalyCursorPayload {
  version: 1;
  status: AnomalyStatus | null;
  blocking: boolean | null;
  last_seen_at: string;
  anomaly_id: string;
}

const CURSOR_VERSION = 1 as const;

function isAnomalyStatus(value: unknown): value is AnomalyStatus {
  return value === AnomalyStatus.Open || value === AnomalyStatus.Resolved;
}

function parseOptionalStatus(value: unknown): AnomalyStatus | null {
  if (value === undefined) {
    return null;
  }
  if (!isAnomalyStatus(value)) {
    throw validationError("status 必须是 open 或 resolved", { field: "status" });
  }
  return value;
}

function parseOptionalBlocking(value: unknown): boolean | null {
  if (value === undefined) {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw validationError("blocking 必须是 true 或 false", { field: "blocking" });
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return FIXED_CONFIG_V1.API_DEFAULT_LIMIT;
  }
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > FIXED_CONFIG_V1.API_MAX_LIMIT
  ) {
    throw validationError("limit 必须是 1..100 的整数", { field: "limit" });
  }
  return parsed;
}

/** API 与 application 共用的异常查询值校验；未知字段由 API 层处理。 */
export function validateAdminAnomaliesQueryValues(
  input: Record<string, unknown>,
): AdminAnomaliesQuery {
  const cursor = input.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || !isOpaqueCursorShape(cursor))
  ) {
    throw validationError("cursor 格式无效", { field: "cursor" });
  }
  return {
    status: parseOptionalStatus(input.status),
    blocking: parseOptionalBlocking(input.blocking),
    limit: parseLimit(input.limit),
    cursor: cursor === undefined ? null : cursor,
  };
}

export function isOpaqueCursorShape(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 2 &&
    parts[0]!.length > 0 &&
    parts[1]!.length > 0 &&
    /^[A-Za-z0-9_-]+$/.test(parts[0]!) &&
    /^[A-Za-z0-9_-]+$/.test(parts[1]!)
  );
}

function parseCursorPayload(value: unknown): AnomalyCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const payload = value as Record<string, unknown>;
  const lastSeenAt = payload.last_seen_at;
  if (
    payload.version !== CURSOR_VERSION ||
    !isAnomalyStatus(payload.status) && payload.status !== null ||
    typeof payload.blocking !== "boolean" && payload.blocking !== null ||
    typeof lastSeenAt !== "string" ||
    !Number.isFinite(Date.parse(lastSeenAt)) ||
    typeof payload.anomaly_id !== "string" ||
    !isValidUuid(payload.anomaly_id)
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return {
    version: CURSOR_VERSION,
    status: payload.status as AnomalyStatus | null,
    blocking: payload.blocking as boolean | null,
    last_seen_at: lastSeenAt,
    anomaly_id: payload.anomaly_id,
  };
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw validationError("cursor 格式无效", { field: "cursor" });
  }
}

export class AnomalyCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length === 0) {
      throw new Error("anomaly cursor secret must not be empty");
    }
  }

  encode(position: {
    status: AnomalyStatus | null;
    blocking: boolean | null;
    last_seen_at: Date;
    anomaly_id: string;
  }): string {
    const payload: AnomalyCursorPayload = {
      version: CURSOR_VERSION,
      status: position.status,
      blocking: position.blocking,
      last_seen_at: position.last_seen_at.toISOString(),
      anomaly_id: position.anomaly_id,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  decode(cursor: string): {
    status: AnomalyStatus | null;
    blocking: boolean | null;
    last_seen_at: Date;
    anomaly_id: string;
  } {
    if (!isOpaqueCursorShape(cursor)) {
      throw validationError("cursor 格式无效", { field: "cursor" });
    }
    const [encodedPayload, encodedSignature] = cursor.split(".") as [string, string];
    const expectedSignature = createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest("base64url");
    const provided = Buffer.from(encodedSignature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw validationError("cursor 签名无效", { field: "cursor" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeBase64Url(encodedPayload));
    } catch {
      throw validationError("cursor 内容无效", { field: "cursor" });
    }
    const payload = parseCursorPayload(parsed);
    const lastSeenAt = new Date(payload.last_seen_at);
    return {
      status: payload.status,
      blocking: payload.blocking,
      last_seen_at: lastSeenAt,
      anomaly_id: payload.anomaly_id,
    };
  }
}

function assertQuery(input: AdminAnomaliesQuery): void {
  if (
    !isAnomalyStatus(input.status) && input.status !== null ||
    typeof input.blocking !== "boolean" && input.blocking !== null ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > FIXED_CONFIG_V1.API_MAX_LIMIT ||
    input.cursor !== null && !isOpaqueCursorShape(input.cursor) ||
    input.status_explicit !== undefined && typeof input.status_explicit !== "boolean" ||
    input.blocking_explicit !== undefined && typeof input.blocking_explicit !== "boolean"
  ) {
    throw validationError("异常查询参数无效");
  }
}

function isAnomalyType(value: unknown): value is Anomaly["type"] {
  return Object.values(AnomalyType).includes(value as Anomaly["type"]);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function assertAnomalyFact(anomaly: Anomaly): void {
  const validDetails =
    typeof anomaly.details === "object" && anomaly.details !== null && !Array.isArray(anomaly.details);
  const validResolution =
    anomaly.status === AnomalyStatus.Open
      ? anomaly.resolved_at === null && anomaly.resolution === null
      : isValidDate(anomaly.resolved_at) &&
        typeof anomaly.resolution === "string" &&
        anomaly.resolution.length > 0;

  if (
    anomaly.schema_version !== SCHEMA_VERSION ||
    !isValidUuid(anomaly.anomaly_id) ||
    !isValidUuid(anomaly.match_id) ||
    anomaly.anomaly_key !== `${anomaly.match_id}:${anomaly.type}` ||
    !isAnomalyType(anomaly.type) ||
    typeof anomaly.blocking !== "boolean" ||
    !isAnomalyStatus(anomaly.status) ||
    !isValidDate(anomaly.first_seen_at) ||
    !isValidDate(anomaly.last_seen_at) ||
    !Number.isSafeInteger(anomaly.occurrence_count) ||
    anomaly.occurrence_count < 1 ||
    !validDetails ||
    !validResolution
  ) {
    throw internalError("anomaly 事实数据不一致");
  }
}

export class AdminAnomaliesService {
  private readonly authorization = new AdminAuthorizationService();
  private readonly cursorCodec: AnomalyCursorCodec;

  constructor(
    private readonly repo: AppRepository,
    cursorSecret: string,
  ) {
    this.cursorCodec = new AnomalyCursorCodec(cursorSecret);
  }

  async list(
    trustedOpenid: string | null | undefined,
    input: AdminAnomaliesQuery,
  ): Promise<AdminAnomaliesResult> {
    assertQuery(input);
    await this.authorization.requireActiveAdmin(this.repo, trustedOpenid);
    if (this.repo.anomalies === undefined) {
      throw internalError("anomalies repository port 未配置");
    }

    const position = input.cursor === null ? null : this.cursorCodec.decode(input.cursor);
    const statusExplicit = input.status_explicit ?? input.status !== null;
    const blockingExplicit = input.blocking_explicit ?? input.blocking !== null;
    if (
      position !== null &&
      (statusExplicit && position.status !== input.status ||
        blockingExplicit && position.blocking !== input.blocking)
    ) {
      throw validationError("cursor 与当前筛选条件冲突", { field: "cursor" });
    }

    const status = position !== null && !statusExplicit ? position.status : input.status;
    const blocking = position !== null && !blockingExplicit ? position.blocking : input.blocking;

    const pageQuery: AdminAnomalyPageQuery = {
      status,
      blocking,
      after:
        position === null
          ? null
          : {
              last_seen_at: position.last_seen_at,
              anomaly_id: position.anomaly_id,
            },
      limit: input.limit,
    };
    const page = await this.repo.anomalies.findPage(pageQuery);
    for (const anomaly of page.items) {
      assertAnomalyFact(anomaly);
    }
    const lastItem = page.items.at(-1);
    if (page.has_more && lastItem === undefined) {
      throw internalError("anomaly 分页事实数据不一致");
    }
    return {
      items: page.items,
      has_more: page.has_more,
      next_cursor:
        page.has_more && lastItem !== undefined
          ? this.cursorCodec.encode({
              status,
              blocking,
              last_seen_at: lastItem.last_seen_at,
              anomaly_id: lastItem.anomaly_id,
            })
          : null,
    };
  }
}
