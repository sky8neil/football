import { postSessionInit } from "../api/v1/session.js";
import { getMatch, getMatches } from "../api/v1/matches.js";
import { getMyPrediction, getMyPredictions, postPrediction } from "../api/v1/predictions.js";
import {
  deleteMyProfile,
  getMyProfile,
  getPublicProfile,
  patchMyProfile,
} from "../api/v1/profile.js";
import { getMyLevels } from "../api/v1/levels.js";
import { getMyUnlocks } from "../api/v1/unlocks.js";
import { getRankings } from "../api/v1/rankings.js";
import {
  getAdminAnomalies,
  postAdminRebuildRankings,
  postAdminRebuildUserStats,
  postAdminResultCorrection,
  postAdminRetrySettlement,
} from "../api/v1/admin.js";
import {
  createGroup,
  dissolveGroup,
  getGroup,
  getMyGroups,
  joinGroup,
  leaveGroup,
} from "../api/v1/groups.js";
import { getShareCardMe } from "../api/v1/share-card.js";
import { makeRequestId, mapErrorToHttp } from "../api/v1/validation.js";
import type { RateLimiter } from "../api/v1/rate-limit.js";
import type { SessionService } from "../application/session.js";
import type { MatchQueryService } from "../application/match-query.js";
import { PredictionHistoryQueryService } from "../application/prediction-query.js";
import { PredictionQueryService } from "../application/prediction-query.js";
import { PredictionService } from "../application/predictions.js";
import { ProfileQueryService } from "../application/profile.js";
import { ProfileMutationService } from "../application/profile-mutation.js";
import { LevelsQueryService } from "../application/levels.js";
import { UnlocksQueryService } from "../application/unlocks.js";
import { RankingQueryService } from "../application/ranking-query.js";
import { ShareCardQueryService } from "../application/share-card.js";
import { GroupsService } from "../application/groups.js";
import { AdminAnomaliesService } from "../application/admin-anomalies.js";
import { AdminResultCorrectionService } from "../application/admin-result-correction.js";
import { AdminRetrySettlementService } from "../application/admin-retry-settlement.js";
import { AdminRebuildUserStatsService } from "../application/admin-rebuild-user-stats.js";
import { AdminRebuildRankingsService } from "../application/admin-rebuild-rankings.js";
import { UserStatus } from "../domain/enums.js";
import { conflictError, validationError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { LOCAL_PUBLIC_SOURCE, type GatewayRuntimeConfig } from "./config.js";
import { resolveTrustedOpenid } from "./identity.js";

export interface GatewayRequestInput {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  server_now: Date;
  config: GatewayRuntimeConfig;
  /** 可选：运行时注入的可信 openid（云函数）；缺省回退 resolveTrustedOpenid(config)。 */
  trusted_openid?: string | null;
  /** 可选：外部注入的 request_id（云函数）；缺省由网关生成。 */
  request_id?: string;
  services: {
    session: Pick<SessionService, "init">;
    matches: Pick<MatchQueryService, "list" | "get">;
    predictions?: Pick<PredictionService, "submit"> &
      Partial<Pick<PredictionHistoryQueryService, "listMyPredictions">> &
      Partial<Pick<PredictionQueryService, "getMyPrediction">>;
    profile?: Pick<ProfileQueryService, "getMyProfile">;
    profileMutation?: Pick<ProfileMutationService, "updateMyProfile" | "deleteMyProfile">;
    levels?: Pick<LevelsQueryService, "getLevels">;
    unlocks?: Pick<UnlocksQueryService, "getUnlocks">;
    rankings?: Pick<RankingQueryService, "list">;
  };
  repo: AppRepository;
  rate_limiter: RateLimiter;
}

export interface GatewayResponse {
  status: number;
  body?: unknown;
}

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

function normalizePath(path: string): string {
  const queryIndex = path.indexOf("?");
  const withoutQuery = queryIndex === -1 ? path : path.slice(0, queryIndex);
  if (withoutQuery.length > 1) {
    return withoutQuery.replace(/\/+$/, "");
  }
  return withoutQuery;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveJsonObjectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isJsonObject(body)) {
    throw validationError("请求体必须为 JSON 对象");
  }
  return body;
}

/** 身份四态解析：anonymous / unregistered / deleted / active（§49.1 + §4.5.1）。 */
export type ResolvedIdentity =
  | { kind: "anonymous" }
  | { kind: "unregistered"; openid: string }
  | { kind: "deleted"; openid: string; user_id: string }
  | { kind: "active"; openid: string; user_id: string };

/**
 * D-P1 方案 B 固定解析顺序（§4.5.1，命中即停）：
 * 1. 无可信 openid → anonymous；
 * 2. users 命中 active → active（永远优先于任何 mapping）；
 * 3. 无 active，但 deleted_openid_mappings 命中 original_openid → deleted（携带旧 user_id）；
 * 4. 均无 → unregistered。
 * 防御：若迁移前脏数据使 users.openid 仍为原 openid 且 status=deleted，也解析为 deleted，
 * 但这不是新写入模型（迁移会修复为墓碑 + mapping）。
 */
export async function resolveIdentity(
  trustedOpenid: string | null,
  repo: AppRepository,
): Promise<ResolvedIdentity> {
  if (trustedOpenid === null) {
    return { kind: "anonymous" };
  }
  const user = await repo.users.findByOpenid(trustedOpenid);
  if (user !== null) {
    if (user.status === UserStatus.Active) {
      return { kind: "active", openid: trustedOpenid, user_id: user.user_id };
    }
    // 防御：迁移前脏数据（users.openid 仍为原 openid 且 status=deleted）。
    return { kind: "deleted", openid: trustedOpenid, user_id: user.user_id };
  }
  const mapping = await repo.deletedOpenidMappings.findByOriginalOpenid(trustedOpenid);
  if (mapping !== null) {
    return { kind: "deleted", openid: trustedOpenid, user_id: mapping.deleted_user_id };
  }
  return { kind: "unregistered", openid: trustedOpenid };
}

/** Auth 读路径：deleted 在网关直接 409；anonymous/unregistered 交给 handler 401。 */
function authenticatedReadUserId(identity: ResolvedIdentity): string | null {
  if (identity.kind === "deleted") {
    throw conflictError("USER_DELETED", "该账号已被注销");
  }
  if (identity.kind === "active") {
    return identity.user_id;
  }
  return null;
}

/**
 * POST /v1/predictions 写路径：deleted 放行 user_id 到 service，
 * 使 §8.6 同 key+同 payload 重放可达（非重放由 service 抛 USER_DELETED）。
 * anonymous/unregistered → null，由 handler 抛 401。
 */
function writePredictionUserId(identity: ResolvedIdentity): string | null {
  if (identity.kind === "active" || identity.kind === "deleted") {
    return identity.user_id;
  }
  return null;
}

/** 公开读（matches/rankings）：deleted 也传 user_id 使 can_predict_reason=USER_DELETED。 */
function publicReadUserId(identity: ResolvedIdentity): string | null {
  if (identity.kind === "active" || identity.kind === "deleted") {
    return identity.user_id;
  }
  return null;
}

function matchIdFromPath(path: string): string | null {
  const prefix = "/v1/matches/";
  if (!path.startsWith(prefix)) {
    return null;
  }
  const matchId = path.slice(prefix.length);
  if (matchId.length === 0 || matchId.includes("/")) {
    return null;
  }
  return matchId;
}

function singlePathParameter(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) {
    return null;
  }
  const value = path.slice(prefix.length);
  return value.length === 0 || value.includes("/") ? null : value;
}

function responseCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "code" in body) {
    const code = (body as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function logGateway(
  requestId: string,
  path: string,
  status: number,
  code: string | undefined,
): void {
  if (code === undefined) {
    console.log(`${requestId} ${path} ${status}`);
    return;
  }
  console.log(`${requestId} ${path} ${status} ${code}`);
}

export async function handleGatewayRequest(
  input: GatewayRequestInput,
): Promise<GatewayResponse> {
  const requestId = input.request_id ?? makeRequestId();
  const path = normalizePath(input.path);
  const method = normalizeMethod(input.method);
  try {
    const trustedOpenid =
      input.trusted_openid !== undefined
        ? input.trusted_openid
        : resolveTrustedOpenid(input.config);

    if (method === "POST" && path === "/v1/session/init") {
      const body = resolveJsonObjectBody(input.body);
      const result = await postSessionInit(input.services.session, {
        trusted_openid: trustedOpenid,
        body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/matches") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const result = await getMatches(input.services.matches, {
        authenticated_user_id: publicReadUserId(identity),
        public_source: input.config.public_source,
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const matchId = matchIdFromPath(path);
    if (method === "GET" && matchId !== null) {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const result = await getMatch(input.services.matches, {
        authenticated_user_id: publicReadUserId(identity),
        public_source: input.config.public_source,
        match_id: matchId,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "POST" && path === "/v1/predictions") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const body = resolveJsonObjectBody(input.body);
      const predictions =
        input.services.predictions ?? new PredictionService(input.repo);
      const result = await postPrediction(predictions, {
        authenticated_user_id: writePredictionUserId(identity),
        body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const predictionId = singlePathParameter(path, "/v1/predictions/me/");
    if (method === "GET" && predictionId !== null) {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const provided = input.services.predictions;
      const predictions = provided?.getMyPrediction !== undefined
        ? { getMyPrediction: provided.getMyPrediction.bind(provided) }
        : new PredictionQueryService(input.repo);
      const result = await getMyPrediction(predictions, {
        authenticated_user_id: authenticatedReadUserId(identity),
        prediction_id: predictionId,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/predictions/me") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const provided = input.services.predictions;
      const predictions =
        provided !== undefined && provided.listMyPredictions !== undefined
          ? { listMyPredictions: provided.listMyPredictions.bind(provided) }
          : new PredictionHistoryQueryService(
              input.repo,
              input.config.match_cursor_secret,
            );
      const result = await getMyPredictions(predictions, {
        authenticated_user_id: authenticatedReadUserId(identity),
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/profile/me") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const profile =
        input.services.profile ?? new ProfileQueryService(input.repo);
      const result = await getMyProfile(profile, {
        authenticated_user_id: authenticatedReadUserId(identity),
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "PATCH" && path === "/v1/profile/me") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const body = resolveJsonObjectBody(input.body);
      const profileMutation =
        input.services.profileMutation ?? new ProfileMutationService(input.repo);
      const result = await patchMyProfile(profileMutation, {
        authenticated_user_id: authenticatedReadUserId(identity),
        body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "DELETE" && path === "/v1/profile/me") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const profileMutation =
        input.services.profileMutation ?? new ProfileMutationService(input.repo);
      const result = await deleteMyProfile(profileMutation, {
        authenticated_user_id: authenticatedReadUserId(identity),
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const publicProfileUserId = singlePathParameter(path, "/v1/profiles/");
    if (method === "GET" && publicProfileUserId !== null) {
      const profile = new ProfileQueryService(input.repo);
      const result = await getPublicProfile(profile, {
        user_id: publicProfileUserId,
        public_source: input.config.public_source,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/levels/me") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const levels =
        input.services.levels ?? new LevelsQueryService(input.repo);
      const result = await getMyLevels(levels, {
        authenticated_user_id: authenticatedReadUserId(identity),
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/unlocks/me") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const unlocks =
        input.services.unlocks ?? new UnlocksQueryService(input.repo);
      const result = await getMyUnlocks(unlocks, {
        authenticated_user_id: authenticatedReadUserId(identity),
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/rankings") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const rankings =
        input.services.rankings ??
        new RankingQueryService(input.repo, input.config.match_cursor_secret);
      const result = await getRankings(rankings, {
        authenticated_user_id: publicReadUserId(identity),
        public_source: LOCAL_PUBLIC_SOURCE,
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/share-card/me") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const shareCard = new ShareCardQueryService(input.repo);
      const result = await getShareCardMe(shareCard, {
        authenticated_user_id: authenticatedReadUserId(identity),
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/admin/anomalies") {
      const result = await getAdminAnomalies(
        new AdminAnomaliesService(input.repo, input.config.match_cursor_secret),
        {
          trusted_openid: trustedOpenid,
          query: input.query,
          server_now: input.server_now,
          request_id: requestId,
          rate_limiter: input.rate_limiter,
        },
      );
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const resultCorrectionMatchId = path.match(
      /^\/v1\/admin\/matches\/([^/]+)\/result-corrections$/,
    )?.[1];
    if (method === "POST" && resultCorrectionMatchId !== undefined) {
      const result = await postAdminResultCorrection(new AdminResultCorrectionService(input.repo), {
        trusted_openid: trustedOpenid,
        match_id: resultCorrectionMatchId,
        body: input.body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const retrySettlementMatchId = path.match(
      /^\/v1\/admin\/matches\/([^/]+)\/retry-settlement$/,
    )?.[1];
    if (method === "POST" && retrySettlementMatchId !== undefined) {
      const result = await postAdminRetrySettlement(new AdminRetrySettlementService(input.repo), {
        trusted_openid: trustedOpenid,
        match_id: retrySettlementMatchId,
        body: input.body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const rebuildUserId = singlePathParameter(path, "/v1/admin/rebuild/users/");
    if (method === "POST" && rebuildUserId !== null) {
      const result = await postAdminRebuildUserStats(new AdminRebuildUserStatsService(input.repo), {
        trusted_openid: trustedOpenid,
        user_id: rebuildUserId,
        body: input.body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "POST" && path === "/v1/admin/rebuild/rankings") {
      const result = await postAdminRebuildRankings(new AdminRebuildRankingsService(input.repo), {
        trusted_openid: trustedOpenid,
        body: input.body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const groups = new GroupsService(input.repo, {
      cursorSecret: input.config.match_cursor_secret,
    });
    if (method === "POST" && path === "/v1/groups") {
      const result = await createGroup(groups, {
        authenticated_user_id: authenticatedReadUserId(await resolveIdentity(trustedOpenid, input.repo)),
        body: resolveJsonObjectBody(input.body),
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "POST" && path === "/v1/groups/join") {
      const result = await joinGroup(groups, {
        authenticated_user_id: authenticatedReadUserId(await resolveIdentity(trustedOpenid, input.repo)),
        body: resolveJsonObjectBody(input.body),
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "POST") {
      const groupId = path.match(/^\/v1\/groups\/([^/]+)\/leave$/)?.[1];
      if (groupId !== undefined) {
        const result = await leaveGroup(groups, {
          authenticated_user_id: authenticatedReadUserId(await resolveIdentity(trustedOpenid, input.repo)),
          group_id: groupId,
          server_now: input.server_now,
          request_id: requestId,
          rate_limiter: input.rate_limiter,
        });
        logGateway(requestId, path, result.status, undefined);
        return result;
      }
    }

    const groupId = singlePathParameter(path, "/v1/groups/");
    if (method === "GET" && path === "/v1/groups/me") {
      const result = await getMyGroups(groups, {
        authenticated_user_id: authenticatedReadUserId(await resolveIdentity(trustedOpenid, input.repo)),
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && groupId !== null) {
      const result = await getGroup(groups, {
        authenticated_user_id: authenticatedReadUserId(await resolveIdentity(trustedOpenid, input.repo)),
        group_id: groupId,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "DELETE" && groupId !== null) {
      const result = await dissolveGroup(groups, {
        authenticated_user_id: authenticatedReadUserId(await resolveIdentity(trustedOpenid, input.repo)),
        group_id: groupId,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    throw validationError("不支持的请求");
  } catch (err) {
    const mapped = mapErrorToHttp(err, requestId);
    logGateway(requestId, path, mapped.status, mapped.body.code);
    return mapped;
  }
}
