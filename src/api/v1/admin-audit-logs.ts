import { conflictError } from "../../domain/errors.js";
import type { AdminAuditAction, AdminAuditEntityType } from "../../domain/enums.js";
import type { AdminAuditLog } from "../../domain/types.js";
import {
  AdminAuditLogsService,
  validateAdminAuditLogsQueryValues,
  type AdminAuditLogsQuery,
} from "../../application/admin-audit-logs.js";
import { assertUnknownFields } from "./validation.js";
import { defaultApiRateLimiter, type RateLimiter } from "./rate-limit.js";

const ADMIN_AUDIT_LOGS_QUERY_FIELDS = new Set([
  "action",
  "target_type",
  "target_id",
  "limit",
  "cursor",
]);

export interface AdminAuditLogResponse {
  audit_id: string;
  admin_id: string;
  action: AdminAuditAction;
  target_type: AdminAuditEntityType;
  target_id: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string;
  created_at: string;
}

export interface GetAdminAuditLogsInput {
  trusted_openid?: string | null;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetAdminAuditLogsSuccessResponse {
  status: 200;
  body: {
    data: {
      items: AdminAuditLogResponse[];
      page: {
        next_cursor: string | null;
        has_more: boolean;
      };
    };
    request_id: string;
  };
}

export function validateAdminAuditLogsQuery(
  query: Record<string, unknown>,
): AdminAuditLogsQuery {
  assertUnknownFields(query, ADMIN_AUDIT_LOGS_QUERY_FIELDS);
  return validateAdminAuditLogsQueryValues(query);
}

async function preflightAdminAuditLogs(
  service: Pick<AdminAuditLogsService, "authorizeAdmin">,
  value: string | null | undefined,
): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw conflictError("UNAUTHORIZED", "需要可信管理员身份");
  }
  await service.authorizeAdmin(value);
  return value;
}

function mapAuditLog(log: AdminAuditLog): AdminAuditLogResponse {
  return {
    audit_id: log.audit_id,
    admin_id: log.admin_id,
    action: log.action,
    target_type: log.entity_type,
    target_id: log.entity_id,
    old_value: log.old_value,
    new_value: log.new_value,
    reason: log.reason,
    created_at: log.created_at.toISOString(),
  };
}

export async function getAdminAuditLogs(
  service: AdminAuditLogsService,
  input: GetAdminAuditLogsInput,
): Promise<GetAdminAuditLogsSuccessResponse> {
  const query = validateAdminAuditLogsQuery(input.query);
  const trustedOpenid = await preflightAdminAuditLogs(service, input.trusted_openid);
  await (input.rate_limiter ?? defaultApiRateLimiter).check(
    "admin_apis",
    trustedOpenid,
    input.server_now,
  );
  const hasQueryValue = (field: string): boolean =>
    Object.prototype.hasOwnProperty.call(input.query, field) &&
    input.query[field] !== undefined;
  const result = await service.list(trustedOpenid, {
    ...query,
    action_explicit: hasQueryValue("action"),
    target_type_explicit: hasQueryValue("target_type"),
    target_id_explicit: hasQueryValue("target_id"),
  });
  return {
    status: 200,
    body: {
      data: {
        items: result.items.map(mapAuditLog),
        page: {
          next_cursor: result.next_cursor,
          has_more: result.has_more,
        },
      },
      request_id: input.request_id,
    },
  };
}
