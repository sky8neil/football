import { AnomalyStatus } from "../../domain/enums.js";
import type { Anomaly } from "../../domain/types.js";
import {
  AdminAnomaliesService,
  validateAdminAnomaliesQueryValues,
  type AdminAnomaliesQuery,
} from "../../application/admin-anomalies.js";
import { assertUnknownFields } from "./validation.js";
import {
  defaultApiRateLimiter,
  type RateLimiter,
} from "./rate-limit.js";

const ADMIN_ANOMALIES_QUERY_FIELDS = new Set([
  "status",
  "blocking",
  "limit",
  "cursor",
]);

export interface AdminAnomalyResponse {
  anomaly_id: string;
  anomaly_key: string;
  match_id: string;
  type: Anomaly["type"];
  blocking: boolean;
  status: AnomalyStatus;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  details: Record<string, unknown>;
  resolved_at: string | null;
  resolution: string | null;
}

export interface GetAdminAnomaliesInput {
  trusted_openid?: string | null;
  query: Record<string, unknown>;
  server_now: Date;
  request_id: string;
  rate_limiter?: RateLimiter;
}

export interface GetAdminAnomaliesSuccessResponse {
  status: 200;
  body: {
    data: {
      items: AdminAnomalyResponse[];
      page: {
        next_cursor: string | null;
        has_more: boolean;
      };
    };
    request_id: string;
  };
}

export function validateAdminAnomaliesQuery(
  query: Record<string, unknown>,
): AdminAnomaliesQuery {
  assertUnknownFields(query, ADMIN_ANOMALIES_QUERY_FIELDS);
  return validateAdminAnomaliesQueryValues(query);
}

function mapAnomaly(anomaly: Anomaly): AdminAnomalyResponse {
  return {
    anomaly_id: anomaly.anomaly_id,
    anomaly_key: anomaly.anomaly_key,
    match_id: anomaly.match_id,
    type: anomaly.type,
    blocking: anomaly.blocking,
    status: anomaly.status,
    first_seen_at: anomaly.first_seen_at.toISOString(),
    last_seen_at: anomaly.last_seen_at.toISOString(),
    occurrence_count: anomaly.occurrence_count,
    details: anomaly.details,
    resolved_at: anomaly.resolved_at?.toISOString() ?? null,
    resolution: anomaly.resolution,
  };
}

export async function getAdminAnomalies(
  service: AdminAnomaliesService,
  input: GetAdminAnomaliesInput,
): Promise<GetAdminAnomaliesSuccessResponse> {
  const query = validateAdminAnomaliesQuery(input.query);
  if (typeof input.trusted_openid === "string" && input.trusted_openid.length > 0) {
    (input.rate_limiter ?? defaultApiRateLimiter).check(
      "admin_apis",
      input.trusted_openid,
      input.server_now,
    );
  }
  const hasQueryValue = (field: string): boolean =>
    Object.prototype.hasOwnProperty.call(input.query, field) &&
    input.query[field] !== undefined;
  const result = await service.list(input.trusted_openid, {
    ...query,
    status_explicit: hasQueryValue("status"),
    blocking_explicit: hasQueryValue("blocking"),
  });
  return {
    status: 200,
    body: {
      data: {
        items: result.items.map(mapAnomaly),
        page: {
          next_cursor: result.next_cursor,
          has_more: result.has_more,
        },
      },
      request_id: input.request_id,
    },
  };
}
