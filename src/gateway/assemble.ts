import { postSessionInit } from "../api/v1/session.js";
import { getMatch, getMatches } from "../api/v1/matches.js";
import { getLeagueStatus } from "../api/v1/league-status.js";
import { getLeagueSeasons } from "../api/v1/league-seasons.js";
import { getPersonalLeagueSummary } from "../api/v1/personal-league-summary.js";
import { getMatchCrowd } from "../api/v1/crowd.js";
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
  getAdminMatchDetail,
  postAdminRebuildRankings,
  postAdminRebuildUserStats,
  postAdminResolveAnomaly,
  postAdminResultCorrection,
  postAdminRetrySettlement,
} from "../api/v1/admin.js";
import { getAdminAuditLogs } from "../api/v1/admin-audit-logs.js";
import { getAdminTeams, patchAdminTeam, postAdminTeamMapping } from "../api/v1/admin-teams.js";
import {
  createGroup,
  dissolveGroup,
  getGroup,
  getMyGroups,
  joinGroup,
  leaveGroup,
} from "../api/v1/groups.js";
import { getShareCardForUser, getShareCardMe } from "../api/v1/share-card.js";
import { assertUnknownFields, makeRequestId, mapErrorToHttp } from "../api/v1/validation.js";
import type { RateLimiter } from "../api/v1/rate-limit.js";
import type { SessionService } from "../application/session.js";
import type { MatchQueryService } from "../application/match-query.js";
import { LeagueStatusService } from "../application/league-status-service.js";
import { PersonalLeagueSummaryService } from "../application/personal-league-summary-service.js";
import { CrowdQueryService } from "../application/crowd-query.js";
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
import { AdminAuditLogsService } from "../application/admin-audit-logs.js";
import { AdminMatchDetailService } from "../application/admin-match-detail.js";
import { AdminResolveAnomalyService } from "../application/admin-resolve-anomaly.js";
import { AdminResultCorrectionService } from "../application/admin-result-correction.js";
import { AdminRetrySettlementService } from "../application/admin-retry-settlement.js";
import { AdminRebuildUserStatsService } from "../application/admin-rebuild-user-stats.js";
import { AdminRebuildRankingsService } from "../application/admin-rebuild-rankings.js";
import { AdminTeamsService } from "../application/admin-teams.js";
import { UserStatus } from "../domain/enums.js";
import { DomainError, conflictError, validationError } from "../domain/errors.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import {
  createInMemoryAdminConsumedJtiStore,
  type AdminConsumedJtiStore,
  type AuthSessionStore,
} from "../infrastructure/postgres-auth-sessions.js";
import {
  getAdminAuthMe,
  loginAdminSession,
  logoutAdminSession,
  validateAdminLoginPayload,
} from "./admin-auth.js";
import { issueWechatSession } from "./auth.js";
import type { GatewayRuntimeConfig } from "./config.js";
import { resolveRequestTrustedOpenid } from "./identity.js";
import type { WechatCode2SessionHttp } from "./wechat-login.js";

export interface GatewayRequestInput {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  server_now: Date;
  config: GatewayRuntimeConfig;
  /** 可选：运行时注入的可信 openid（云函数）；缺省回退 HTTP Bearer 或 mock。 */
  trusted_openid?: string | null;
  /** 可选：客户端 IP，用于匿名公开读限流隔离；缺省回退 public_source。 */
  client_ip?: string;
  /** 可选：外部注入的 request_id（云函数）；缺省由网关生成。 */
  request_id?: string;
  authorization?: unknown;
  sessions?: AuthSessionStore;
  admin_consumed_jtis?: AdminConsumedJtiStore | Map<string, number>;
  wechat_http?: WechatCode2SessionHttp;
  services: {
    session: Pick<SessionService, "init">;
    matches: Pick<MatchQueryService, "list" | "get">;
    league_status?: Pick<LeagueStatusService, "list">;
    personal_league_summary?: Pick<PersonalLeagueSummaryService, "get">;
    crowd?: Pick<CrowdQueryService, "get">;
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

/** 公开读限流分桶键：优先按已解析用户隔离，其次按客户端 IP，无来源信息时兼容回落配置常量。 */
function resolvePublicReadRateKey(
  identity: ResolvedIdentity,
  clientIp: string | undefined,
  fallbackPublicSource: string,
): string {
  if (identity.kind === "active" || identity.kind === "deleted") {
    return `user:${identity.user_id}`;
  }
  if (typeof clientIp === "string" && clientIp.trim().length > 0) {
    return `ip:${clientIp.trim()}`;
  }
  if (identity.kind === "unregistered") {
    return `openid:${identity.openid}`;
  }
  return fallbackPublicSource;
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

function matchCrowdIdFromPath(path: string): string | null {
  const prefix = "/v1/matches/";
  const suffix = "/crowd";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    return null;
  }
  const matchId = path.slice(prefix.length, -suffix.length);
  return matchId.length === 0 || matchId.includes("/") ? null : matchId;
}

function singlePathParameter(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) {
    return null;
  }
  const value = path.slice(prefix.length);
  return value.length === 0 || value.includes("/") ? null : value;
}

const EXACT_ALLOWED_METHODS: Readonly<Record<string, readonly string[]>> = {
  "/v1/auth/wechat": ["POST"],
  "/v1/session/init": ["POST"],
  "/v1/matches": ["GET"],
  "/v1/leagues/status": ["GET"],
  "/v1/league-seasons": ["GET"],
  "/v1/predictions": ["POST"],
  "/v1/predictions/summary": ["GET"],
  "/v1/predictions/me": ["GET"],
  "/v1/profile/me": ["GET", "POST", "PATCH", "DELETE"],
  "/v1/levels/me": ["GET"],
  "/v1/unlocks/me": ["GET"],
  "/v1/rankings": ["GET"],
  "/v1/share-card/me": ["GET"],
  "/v1/admin/auth/login": ["POST"],
  "/v1/admin/auth/me": ["GET"],
  "/v1/admin/auth/logout": ["POST"],
  "/v1/admin/anomalies": ["GET"],
  "/v1/admin/audit-logs": ["GET"],
  "/v1/admin/teams": ["GET"],
  "/v1/admin/rebuild/rankings": ["POST"],
  "/v1/groups": ["POST"],
  "/v1/groups/join": ["POST"],
  "/v1/groups/me": ["GET"],
};

function allowedMethods(path: string): readonly string[] | null {
  const exact = EXACT_ALLOWED_METHODS[path];
  if (exact !== undefined) {
    return exact;
  }
  if (matchCrowdIdFromPath(path) !== null) {
    return ["GET"];
  }
  if (matchIdFromPath(path) !== null) {
    return ["GET"];
  }
  if (singlePathParameter(path, "/v1/predictions/me/") !== null) {
    return ["GET"];
  }
  if (singlePathParameter(path, "/v1/profiles/") !== null) {
    return ["GET"];
  }
  if (singlePathParameter(path, "/v1/share-card/") !== null) {
    return ["GET"];
  }
  if (/^\/v1\/admin\/anomalies\/[^/]+\/resolve$/.test(path)) {
    return ["POST"];
  }
  if (/^\/v1\/admin\/teams\/[^/]+\/mappings$/.test(path)) {
    return ["POST"];
  }
  if (singlePathParameter(path, "/v1/admin/teams/") !== null) {
    return ["PATCH"];
  }
  if (/^\/v1\/admin\/matches\/[^/]+\/result-corrections$/.test(path)) {
    return ["POST"];
  }
  if (/^\/v1\/admin\/matches\/[^/]+\/retry-settlement$/.test(path)) {
    return ["POST"];
  }
  if (singlePathParameter(path, "/v1/admin/matches/") !== null) {
    return ["GET"];
  }
  if (singlePathParameter(path, "/v1/admin/rebuild/users/") !== null) {
    return ["POST"];
  }
  if (/^\/v1\/groups\/[^/]+\/leave$/.test(path)) {
    return ["POST"];
  }
  if (singlePathParameter(path, "/v1/groups/") !== null) {
    return ["GET", "DELETE"];
  }
  return null;
}

function assertMethodAllowed(path: string, method: string): void {
  const allowed = allowedMethods(path);
  if (allowed !== null && !allowed.includes(method)) {
    throw conflictError("METHOD_NOT_ALLOWED", "方法不允许");
  }
}

const WECHAT_LOGIN_CODE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertWechatLoginCode(code: unknown): string {
  if (typeof code !== "string" || !WECHAT_LOGIN_CODE_PATTERN.test(code)) {
    throw validationError("code 格式无效", { field: "code" });
  }
  return code;
}

function resolveAnonymousIpRateKey(clientIp: string | undefined, fallback: string): string {
  if (typeof clientIp === "string" && clientIp.trim().length > 0) {
    return `ip:${clientIp.trim()}`;
  }
  return fallback;
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

const DEFAULT_ADMIN_CONSUMED_JTIS = createInMemoryAdminConsumedJtiStore();

export async function handleGatewayRequest(
  input: GatewayRequestInput,
): Promise<GatewayResponse> {
  const requestId = input.request_id ?? makeRequestId();
  const path = normalizePath(input.path);
  const method = normalizeMethod(input.method);
  try {
    assertMethodAllowed(path, method);
    if (method === "POST" && path === "/v1/admin/auth/login") {
      assertUnknownFields(input.query, new Set());
      const body = resolveJsonObjectBody(input.body);
      const credential = validateAdminLoginPayload(body);
      const sessions = input.sessions;
      if (sessions === undefined) {
        throw conflictError("UNAUTHORIZED", "需要重新登录");
      }
      await input.rate_limiter.check(
        "admin_login",
        resolveAnonymousIpRateKey(input.client_ip, input.config.public_source),
        input.server_now,
      );
      const issued = await loginAdminSession({
        credential,
        config: input.config,
        repo: input.repo,
        sessions,
        now: input.server_now,
        consumedJtis: input.admin_consumed_jtis ?? DEFAULT_ADMIN_CONSUMED_JTIS,
      });
      logGateway(requestId, path, 200, undefined);
      return {
        status: 200,
        body: { data: issued, request_id: requestId },
      };
    }

    if (method === "POST" && path === "/v1/auth/wechat") {
      assertUnknownFields(input.query, new Set());
      const body = resolveJsonObjectBody(input.body);
      assertUnknownFields(body, new Set(["code"]));
      const code = assertWechatLoginCode(body.code);
      const auth = input.config.vps_auth;
      const sessions = input.sessions;
      const wechatHttp = input.wechat_http;
      if (auth === null || sessions === undefined || wechatHttp === undefined) {
        throw conflictError("UNAUTHORIZED", "需要重新登录");
      }
      await input.rate_limiter.check(
        "wechat_login",
        resolveAnonymousIpRateKey(input.client_ip, input.config.public_source),
        input.server_now,
      );
      const issued = await issueWechatSession({
        code,
        auth,
        http: wechatHttp,
        sessions,
        now: input.server_now,
      });
      logGateway(requestId, path, 200, undefined);
      return {
        status: 200,
        body: { data: issued, request_id: requestId },
      };
    }

    const trustedOpenid = await resolveRequestTrustedOpenid({
      config: input.config,
      now: input.server_now,
      ...(input.trusted_openid !== undefined ? { trusted_openid: input.trusted_openid } : {}),
      ...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
      ...(input.sessions !== undefined ? { sessions: input.sessions } : {}),
    });

    if (method === "POST" && path === "/v1/session/init") {
      assertUnknownFields(input.query, new Set());
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
        public_source: resolvePublicReadRateKey(identity, input.client_ip, input.config.public_source),
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/leagues/status") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const result = await getLeagueStatus(input.services.league_status ?? new LeagueStatusService(input.repo), {
        authenticated_user_id: publicReadUserId(identity),
        public_source: resolvePublicReadRateKey(identity, input.client_ip, input.config.public_source),
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (path === "/v1/league-seasons") {
      if (method !== "GET") {
        throw conflictError("METHOD_NOT_ALLOWED", "方法不允许");
      }
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      await input.rate_limiter.check(
        "public_reads",
        resolvePublicReadRateKey(identity, input.client_ip, input.config.public_source),
        input.server_now,
      );
      const result = await getLeagueSeasons(input.repo, {
        query: input.query,
        request_id: requestId,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const crowdMatchId = matchCrowdIdFromPath(path);
    if (method === "GET" && crowdMatchId !== null) {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const crowd = input.services.crowd ?? new CrowdQueryService(input.repo);
      const result = await getMatchCrowd(crowd, {
        authenticated_user_id: authenticatedReadUserId(identity),
        match_id: crowdMatchId,
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
      assertUnknownFields(input.query, new Set());
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const result = await getMatch(input.services.matches, {
        authenticated_user_id: publicReadUserId(identity),
        public_source: resolvePublicReadRateKey(identity, input.client_ip, input.config.public_source),
        match_id: matchId,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "POST" && path === "/v1/predictions") {
      assertUnknownFields(input.query, new Set());
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

    if (method === "GET" && path === "/v1/predictions/summary") {
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const result = await getPersonalLeagueSummary(input.services.personal_league_summary ?? new PersonalLeagueSummaryService(input.repo), {
        authenticated_user_id: authenticatedReadUserId(identity),
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const predictionId = singlePathParameter(path, "/v1/predictions/me/");
    if (method === "GET" && predictionId !== null) {
      assertUnknownFields(input.query, new Set());
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const provided = input.services.predictions;
      const predictions = provided?.getMyPrediction !== undefined
        ? { getMyPrediction: provided.getMyPrediction.bind(provided) }
        : new PredictionQueryService(input.repo);
      const result = await getMyPrediction(predictions, {
        authenticated_user_id: authenticatedReadUserId(identity),
        prediction_id: predictionId,
        query: input.query,
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
      assertUnknownFields(input.query, new Set());
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

    // POST is the WeChat-compatible alias; both methods use the same validation and auth.
    if ((method === "PATCH" || method === "POST") && path === "/v1/profile/me") {
      assertUnknownFields(input.query, new Set());
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
      assertUnknownFields(input.query, new Set());
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const profileMutation = input.services.profileMutation ??
        new ProfileMutationService(
          input.repo,
          input.sessions !== undefined ? { authSessions: input.sessions } : {},
        );
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
      assertUnknownFields(input.query, new Set());
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      const profile = new ProfileQueryService(input.repo);
      const result = await getPublicProfile(profile, {
        user_id: publicProfileUserId,
        public_source: resolvePublicReadRateKey(identity, input.client_ip, input.config.public_source),
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/levels/me") {
      assertUnknownFields(input.query, new Set());
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
        new RankingQueryService(input.repo, input.config.match_cursor_secret, {
          firstPeriodKey: input.config.ranking_first_period_key,
        });
      const result = await getRankings(rankings, {
        authenticated_user_id: authenticatedReadUserId(identity),
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
      const shareCard = new ShareCardQueryService(input.repo, input.config.match_cursor_secret);
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

    const shareCardUserId = singlePathParameter(path, "/v1/share-card/");
    if (shareCardUserId !== null) {
      if (method !== "GET") {
        throw conflictError("METHOD_NOT_ALLOWED", "方法不允许");
      }
      const identity = await resolveIdentity(trustedOpenid, input.repo);
      await input.rate_limiter.check(
        "public_reads",
        resolvePublicReadRateKey(identity, input.client_ip, input.config.public_source),
        input.server_now,
      );
      const result = await getShareCardForUser(
        new ShareCardQueryService(input.repo, input.config.match_cursor_secret),
        {
          user_id: shareCardUserId,
          authenticated_user_id: identity.kind === "active" ? identity.user_id : null,
          query: input.query,
          server_now: input.server_now,
          request_id: requestId,
        },
      );
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/admin/auth/me") {
      assertUnknownFields(input.query, new Set());
      const me = await getAdminAuthMe({
        repo: input.repo,
        trusted_openid: trustedOpenid,
      });
      await input.rate_limiter.check("admin_apis", trustedOpenid!, input.server_now);
      logGateway(requestId, path, 200, undefined);
      return {
        status: 200,
        body: { data: me, request_id: requestId },
      };
    }

    if (method === "POST" && path === "/v1/admin/auth/logout") {
      assertUnknownFields(input.query, new Set());
      assertUnknownFields(resolveJsonObjectBody(input.body), new Set());
      if (typeof trustedOpenid === "string" && trustedOpenid.length > 0) {
        await input.rate_limiter.check("admin_apis", trustedOpenid, input.server_now);
      }
      await logoutAdminSession({
        authorization: input.authorization,
        sessions: input.sessions,
        now: input.server_now,
      });
      logGateway(requestId, path, 204, undefined);
      return { status: 204 };
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

    const resolveAnomalyId = path.match(
      /^\/v1\/admin\/anomalies\/([^/]+)\/resolve$/,
    )?.[1];
    if (method === "POST" && resolveAnomalyId !== undefined) {
      const result = await postAdminResolveAnomaly(new AdminResolveAnomalyService(input.repo), {
        trusted_openid: trustedOpenid,
        anomaly_id: resolveAnomalyId,
        query: input.query,
        body: input.body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "GET" && path === "/v1/admin/audit-logs") {
      const result = await getAdminAuditLogs(
        new AdminAuditLogsService(input.repo, input.config.match_cursor_secret),
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

    if (method === "GET" && path === "/v1/admin/teams") {
      const result = await getAdminTeams(new AdminTeamsService(input.repo), {
        trusted_openid: trustedOpenid,
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const mappingTeamId = path.match(/^\/v1\/admin\/teams\/([^/]+)\/mappings$/)?.[1];
    if (method === "POST" && mappingTeamId !== undefined) {
      const result = await postAdminTeamMapping(new AdminTeamsService(input.repo), {
        trusted_openid: trustedOpenid,
        team_id: mappingTeamId,
        query: input.query,
        body: input.body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const updateTeamId = singlePathParameter(path, "/v1/admin/teams/");
    if (method === "PATCH" && updateTeamId !== null) {
      const result = await patchAdminTeam(new AdminTeamsService(input.repo), {
        trusted_openid: trustedOpenid,
        team_id: updateTeamId,
        query: input.query,
        body: input.body,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const detailMatchId = singlePathParameter(path, "/v1/admin/matches/");
    if (method === "GET" && detailMatchId !== null) {
      const result = await getAdminMatchDetail(new AdminMatchDetailService(input.repo), {
        trusted_openid: trustedOpenid,
        match_id: detailMatchId,
        query: input.query,
        server_now: input.server_now,
        request_id: requestId,
        rate_limiter: input.rate_limiter,
      });
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
        query: input.query,
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
      const result = await postAdminRetrySettlement(
        new AdminRetrySettlementService(input.repo, undefined, input.config.level_first_eval_as_of ?? null),
        {
          trusted_openid: trustedOpenid,
          match_id: retrySettlementMatchId,
          query: input.query,
          body: input.body,
          server_now: input.server_now,
          request_id: requestId,
          rate_limiter: input.rate_limiter,
        },
      );
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    const rebuildUserId = singlePathParameter(path, "/v1/admin/rebuild/users/");
    if (method === "POST" && rebuildUserId !== null) {
      const result = await postAdminRebuildUserStats(
        new AdminRebuildUserStatsService(input.repo, input.config.level_first_eval_as_of ?? null),
        {
          trusted_openid: trustedOpenid,
          user_id: rebuildUserId,
          query: input.query,
          body: input.body,
          server_now: input.server_now,
          request_id: requestId,
          rate_limiter: input.rate_limiter,
        },
      );
      logGateway(requestId, path, result.status, undefined);
      return result;
    }

    if (method === "POST" && path === "/v1/admin/rebuild/rankings") {
      const result = await postAdminRebuildRankings(new AdminRebuildRankingsService(input.repo), {
        trusted_openid: trustedOpenid,
        query: input.query,
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
      assertUnknownFields(input.query, new Set());
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
      assertUnknownFields(input.query, new Set());
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
        assertUnknownFields(input.query, new Set());
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
      assertUnknownFields(input.query, new Set());
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
      assertUnknownFields(input.query, new Set());
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
    if (mapped.status === 500) {
      console.error({
        request_id: requestId,
        path,
        message: err instanceof Error ? err.message : String(err),
        details: err instanceof DomainError ? err.details : null,
      });
    }
    logGateway(requestId, path, mapped.status, mapped.body.code);
    return mapped;
  }
}
