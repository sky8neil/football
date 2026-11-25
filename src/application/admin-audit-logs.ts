import { createHmac, timingSafeEqual } from "node:crypto";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { AdminAuditAction, AdminAuditEntityType, SCHEMA_VERSION } from "../domain/enums.js";
import { internalError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import type { AdminAuditLog } from "../domain/types.js";
import type { AdminAuditLogPageQuery, AppRepository } from "../infrastructure/repositories.js";
import { isOpaqueCursorShape } from "./admin-anomalies.js";
import { AdminAuthorizationService } from "./admin.js";

export interface AdminAuditLogsQuery {
  action: AdminAuditAction | null;
  target_type: AdminAuditEntityType | null;
  target_id: string | null;
  limit: number;
  cursor: string | null;
  action_explicit?: boolean;
  target_type_explicit?: boolean;
  target_id_explicit?: boolean;
}

export interface AdminAuditLogsResult {
  items: AdminAuditLog[];
  next_cursor: string | null;
  has_more: boolean;
}

interface AuditLogCursorPayload {
  version: 1;
  action: AdminAuditAction | null;
  target_type: AdminAuditEntityType | null;
  target_id: string | null;
  created_at: string;
  audit_id: string;
}

const CURSOR_VERSION = 1 as const;
const VALID_ACTIONS = new Set<string>(Object.values(AdminAuditAction));
const VALID_ENTITY_TYPES = new Set<string>(Object.values(AdminAuditEntityType));

function isAuditAction(value: unknown): value is AdminAuditAction {
  return typeof value === "string" && VALID_ACTIONS.has(value);
}

function isAuditEntityType(value: unknown): value is AdminAuditEntityType {
  return typeof value === "string" && VALID_ENTITY_TYPES.has(value);
}

function parseOptionalAction(value: unknown): AdminAuditAction | null {
  if (value === undefined) return null;
  if (!isAuditAction(value)) {
    throw validationError("action 枚举值无效", { field: "action" });
  }
  return value;
}

function parseOptionalTargetType(value: unknown): AdminAuditEntityType | null {
  if (value === undefined) return null;
  if (!isAuditEntityType(value)) {
    throw validationError("target_type 枚举值无效", { field: "target_type" });
  }
  return value;
}

function parseOptionalTargetId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 128) {
    throw validationError("target_id 长度必须为 1..128", { field: "target_id" });
  }
  return value.trim();
}

function parseLimit(value: unknown): number {
  if (value === undefined) return FIXED_CONFIG_V1.API_DEFAULT_LIMIT;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > FIXED_CONFIG_V1.API_MAX_LIMIT) {
    throw validationError("limit 必须是 1..100 的整数", { field: "limit" });
  }
  return parsed;
}

export function validateAdminAuditLogsQueryValues(
  input: Record<string, unknown>,
): AdminAuditLogsQuery {
  const cursor = input.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || !isOpaqueCursorShape(cursor))) {
    throw validationError("cursor 格式无效", { field: "cursor" });
  }
  return {
    action: parseOptionalAction(input.action),
    target_type: parseOptionalTargetType(input.target_type),
    target_id: parseOptionalTargetId(input.target_id),
    limit: parseLimit(input.limit),
    cursor: cursor === undefined ? null : cursor,
  };
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw validationError("cursor 格式无效", { field: "cursor" });
  }
}

function parseCursorPayload(value: unknown): AuditLogCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const payload = value as Record<string, unknown>;
  const createdAt = payload.created_at;
  if (
    payload.version !== CURSOR_VERSION ||
    (payload.action !== null && !isAuditAction(payload.action)) ||
    (payload.target_type !== null && !isAuditEntityType(payload.target_type)) ||
    (payload.target_id !== null && (typeof payload.target_id !== "string" || payload.target_id.length === 0)) ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    typeof payload.audit_id !== "string" ||
    !isValidUuid(payload.audit_id)
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return {
    version: CURSOR_VERSION,
    action: payload.action as AdminAuditAction | null,
    target_type: payload.target_type as AdminAuditEntityType | null,
    target_id: payload.target_id as string | null,
    created_at: createdAt,
    audit_id: payload.audit_id,
  };
}

export class AuditLogCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length === 0) {
      throw new Error("audit log cursor secret must not be empty");
    }
  }

  encode(position: {
    action: AdminAuditAction | null;
    target_type: AdminAuditEntityType | null;
    target_id: string | null;
    created_at: Date;
    audit_id: string;
  }): string {
    const payload: AuditLogCursorPayload = {
      version: CURSOR_VERSION,
      action: position.action,
      target_type: position.target_type,
      target_id: position.target_id,
      created_at: position.created_at.toISOString(),
      audit_id: position.audit_id,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encodedPayload).digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  decode(cursor: string): {
    action: AdminAuditAction | null;
    target_type: AdminAuditEntityType | null;
    target_id: string | null;
    created_at: Date;
    audit_id: string;
  } {
    if (!isOpaqueCursorShape(cursor)) {
      throw validationError("cursor 格式无效", { field: "cursor" });
    }
    const [encodedPayload, encodedSignature] = cursor.split(".") as [string, string];
    const expectedSignature = createHmac("sha256", this.secret).update(encodedPayload).digest("base64url");
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
    return {
      action: payload.action,
      target_type: payload.target_type,
      target_id: payload.target_id,
      created_at: new Date(payload.created_at),
      audit_id: payload.audit_id,
    };
  }
}

function assertQuery(input: AdminAuditLogsQuery): void {
  if (
    (input.action !== null && !isAuditAction(input.action)) ||
    (input.target_type !== null && !isAuditEntityType(input.target_type)) ||
    (input.target_id !== null && (typeof input.target_id !== "string" || input.target_id.trim().length === 0)) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > FIXED_CONFIG_V1.API_MAX_LIMIT ||
    (input.cursor !== null && !isOpaqueCursorShape(input.cursor))
  ) {
    throw validationError("审计日志查询参数无效");
  }
}

function assertAuditLogFact(log: AdminAuditLog): void {
  if (
    log.schema_version !== SCHEMA_VERSION ||
    !isValidUuid(log.audit_id) ||
    !isValidUuid(log.admin_id) ||
    !isAuditAction(log.action) ||
    !isAuditEntityType(log.entity_type) ||
    typeof log.entity_id !== "string" ||
    log.entity_id.length === 0 ||
    typeof log.reason !== "string" ||
    log.reason.length === 0 ||
    !(log.created_at instanceof Date) ||
    !Number.isFinite(log.created_at.getTime())
  ) {
    throw internalError("admin_audit_log 事实数据不一致");
  }
}

export class AdminAuditLogsService {
  private readonly authorization = new AdminAuthorizationService();
  private readonly cursorCodec: AuditLogCursorCodec;

  constructor(
    private readonly repo: AppRepository,
    cursorSecret: string,
  ) {
    this.cursorCodec = new AuditLogCursorCodec(cursorSecret);
  }

  authorizeAdmin(trustedOpenid: string): Promise<void> {
    return this.authorization.authorizeAdmin(this.repo, trustedOpenid);
  }

  async list(
    trustedOpenid: string | null | undefined,
    input: AdminAuditLogsQuery,
  ): Promise<AdminAuditLogsResult> {
    assertQuery(input);
    await this.authorization.requireActiveAdmin(this.repo, trustedOpenid);
    if (this.repo.adminAuditLogs === undefined || this.repo.adminAuditLogs.findPage === undefined) {
      throw internalError("admin_audit_logs repository findPage port 未配置");
    }

    const position = input.cursor === null ? null : this.cursorCodec.decode(input.cursor);
    const actionExplicit = input.action_explicit ?? input.action !== null;
    const targetTypeExplicit = input.target_type_explicit ?? input.target_type !== null;
    const targetIdExplicit = input.target_id_explicit ?? input.target_id !== null;
    if (
      position !== null &&
      ((actionExplicit && position.action !== input.action) ||
        (targetTypeExplicit && position.target_type !== input.target_type) ||
        (targetIdExplicit && position.target_id !== input.target_id))
    ) {
      throw validationError("cursor 与当前筛选条件冲突", { field: "cursor" });
    }

    const action = position !== null && !actionExplicit ? position.action : input.action;
    const targetType = position !== null && !targetTypeExplicit ? position.target_type : input.target_type;
    const targetId = position !== null && !targetIdExplicit ? position.target_id : input.target_id;

    const pageQuery: AdminAuditLogPageQuery = {
      action,
      entity_type: targetType,
      entity_id: targetId,
      after: position === null ? null : { created_at: position.created_at, audit_id: position.audit_id },
      limit: input.limit,
    };
    const page = await this.repo.adminAuditLogs.findPage(pageQuery);
    for (const log of page.items) {
      assertAuditLogFact(log);
    }

    const last = page.items.at(-1);
    const nextCursor = page.has_more && last !== undefined
      ? this.cursorCodec.encode({
          action,
          target_type: targetType,
          target_id: targetId,
          created_at: last.created_at,
          audit_id: last.audit_id,
        })
      : null;

    return {
      items: page.items,
      next_cursor: nextCursor,
      has_more: page.has_more,
    };
  }
}
