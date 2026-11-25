/**
 * 分享卡只读查询：从当前 prediction + match 事实计算，不保存 round 聚合。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isSupportedLeagueId,
  type SupportedLeagueId,
} from "../domain/config.js";
import {
  MatchScoreValue,
  MatchStatus,
  SettlementStatus,
  UserStatus,
  type MatchStatus as MatchStatusType,
  type Result,
} from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { assertPredictionInvariants } from "../domain/invariants.js";
import { formatSeasonLabel } from "../domain/season-label.js";
import { levelSeasonOf } from "../domain/time.js";
import type { Match, Prediction, Team } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { assertLeagueSeasonAttached } from "./league-season-validation.js";
import { fetchByIds } from "./match-identity.js";
import { toPublicSettlementStatus, type PublicSettlementStatus } from "./match-query.js";

export interface ShareCardQuery {
  league_id: SupportedLeagueId;
  season_id: string;
  round_id: string;
}

export interface ShareCardTeam {
  team_id: string;
  name: string;
  name_zh: string | null;
  logo_url: string | null;
}

export interface ShareCardMatchItem {
  match_id: string;
  home_team: ShareCardTeam;
  away_team: ShareCardTeam;
  kickoff_at: string;
  prediction_deadline_at: string | null;
  match_status: MatchStatusType;
  settlement_status: PublicSettlementStatus;
  is_prediction_closed: boolean;
  pred_home_score: number;
  pred_away_score: number;
  derived_result: Result;
  regular_home_score: number | null;
  regular_away_score: number | null;
  match_score: MatchScoreValue | null;
  wdl_hit: boolean | null;
  exact_hit: boolean | null;
}

export interface ShareCardData {
  user_id: string;
  display_name: string;
  favorite_team_id: string | null;
  /** 当前等级赛季的等级（不是历史轮次当时的等级）。 */
  season_level: number;
  league_id: SupportedLeagueId;
  /** 本次查询的比赛赛季。 */
  season_id: string;
  /** 由 formatSeasonLabel 生成的赛季展示文案。 */
  season_label: string;
  round_id: string;
  round_predictions: number;
  round_wdl_hits: number;
  round_exact_hits: number;
  round_score: number;
  /** 当前生涯积分。 */
  career_points: number;
  /** 当前等级赛季，取 levelSeasonOf(serverNow)。 */
  level_season_id: string;
  /** ISO 时间，等于 serverNow。 */
  generated_at: string;
  /** 该轮次内本人已提交、尚未形成有效结算的预测数量；取消/作废不计分项排除。 */
  pending_predictions: number;
  /** 确定性 HMAC 分享凭证；仅本人视角或持有效 share_token 查看活跃用户时返回。 */
  share_token: string | null;
  /** 该轮次单场预测真实明细；未持有效 token 查看他人或已注销用户时过滤未截止场次。 */
  matches: ShareCardMatchItem[];
}

export interface PublicShareCardOptions {
  shareToken?: string | null;
  viewerUserId?: string | null;
  serverNow?: Date;
}

const SHARE_CARD_QUERY_FIELDS = new Set(["league_id", "season_id", "round_id"]);
const ROUND_ID_PATTERN = /^\d{2}$/;
const SHARE_TOKEN_DOMAIN_PREFIX = "share-card:v1:";
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertShareCardQueryObject(input: unknown): asserts input is ShareCardQuery {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("分享卡查询参数必须为对象");
  }

  const query = input as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (!SHARE_CARD_QUERY_FIELDS.has(key)) {
      throw validationError("请求包含未定义字段", { field: key });
    }
  }
  if (typeof query.league_id !== "string" || !isSupportedLeagueId(query.league_id)) {
    throw validationError("league_id 必须是受支持的联赛", { field: "league_id" });
  }
  if (typeof query.season_id !== "string") {
    throw validationError("season_id 必须为字符串", { field: "season_id" });
  }
  if (typeof query.round_id !== "string" || !ROUND_ID_PATTERN.test(query.round_id)) {
    throw validationError("round_id 必须是两位数字串", { field: "round_id" });
  }
}

/** API 与 application 共用的显式 season/round 校验。 */
export function validateShareCardQueryValues(input: unknown): ShareCardQuery {
  assertShareCardQueryObject(input);
  return {
    league_id: input.league_id,
    season_id: input.season_id,
    round_id: input.round_id,
  };
}

function isValidMatchScore(value: Prediction["match_score"]): value is MatchScoreValue {
  return (
    value === MatchScoreValue.Miss ||
    value === MatchScoreValue.WdlHit ||
    value === MatchScoreValue.ExactHit
  );
}

function isCurrentSettledFact(prediction: Prediction, match: Match): boolean {
  const predictionCanonical = prediction.canonical_match_id ?? prediction.match_id;
  const matchCanonical = match.canonical_match_id ?? match.match_id;
  return (
    predictionCanonical === matchCanonical &&
    match.superseded_by == null &&
    match.match_status === MatchStatus.Finished &&
    match.settlement_status === SettlementStatus.Settled &&
    Number.isInteger(match.result_version) &&
    match.result_version >= 1 &&
    match.settled_result_version === match.result_version &&
    prediction.applied_result_version === match.settled_result_version &&
    isValidMatchScore(prediction.match_score) &&
    typeof prediction.wdl_hit === "boolean" &&
    typeof prediction.exact_hit === "boolean"
  );
}

function isPredictionClosed(match: Match, serverNow: Date): boolean {
  return (
    match.prediction_closed_at !== null ||
    (match.prediction_deadline_at !== null &&
      serverNow.getTime() >= match.prediction_deadline_at.getTime())
  );
}

function isClosedOrSettledMatch(match: Match, serverNow: Date): boolean {
  return (
    isPredictionClosed(match, serverNow) ||
    (match.match_status !== MatchStatus.Scheduled &&
      match.match_status !== MatchStatus.Postponed) ||
    match.settlement_status === SettlementStatus.Settled ||
    match.settlement_status === SettlementStatus.Voided
  );
}

function mapShareCardTeam(team: Team | undefined, teamId: string): ShareCardTeam {
  return {
    team_id: teamId,
    name: team?.name ?? "",
    name_zh:
      typeof team?.name_zh === "string" && team.name_zh.trim().length > 0
        ? team.name_zh.trim()
        : null,
    logo_url:
      typeof team?.logo_url === "string" && team.logo_url.trim().length > 0
        ? team.logo_url.trim()
        : null,
  };
}

interface SettledFact {
  prediction: Prediction;
  match: Match;
}

export class ShareCardQueryService {
  private readonly shareTokenSecret: string | null;

  constructor(
    private readonly repo: AppRepository,
    shareTokenSecret?: string,
  ) {
    if (shareTokenSecret !== undefined) {
      if (typeof shareTokenSecret !== "string" || shareTokenSecret.trim().length === 0) {
        throw new Error("share_token secret must not be empty");
      }
      this.shareTokenSecret = shareTokenSecret;
    } else {
      this.shareTokenSecret = null;
    }
  }

  generateShareToken(userId: string, query: ShareCardQuery): string | null {
    if (this.shareTokenSecret === null) {
      return null;
    }
    const payload = `${SHARE_TOKEN_DOMAIN_PREFIX}${userId}:${query.league_id}:${query.season_id}:${query.round_id}`;
    return createHmac("sha256", this.shareTokenSecret).update(payload).digest("base64url");
  }

  verifyShareToken(userId: string, query: ShareCardQuery, token: unknown): boolean {
    if (this.shareTokenSecret === null) {
      return false;
    }
    if (typeof token !== "string" || token.length === 0 || !SHARE_TOKEN_PATTERN.test(token)) {
      return false;
    }
    const expected = this.generateShareToken(userId, query);
    if (expected === null) {
      return false;
    }
    const providedBytes = Buffer.from(token, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return (
      providedBytes.length === expectedBytes.length &&
      timingSafeEqual(providedBytes, expectedBytes)
    );
  }

  async getShareCard(
    userId: string,
    input: ShareCardQuery,
    serverNow: Date = new Date(),
  ): Promise<ShareCardData> {
    return this.buildShareCard(userId, input, serverNow, {
      mode: "me",
      shareToken: null,
      viewerUserId: userId,
    });
  }

  async getPublicShareCard(
    userId: string,
    input: ShareCardQuery,
    options: PublicShareCardOptions = {},
  ): Promise<ShareCardData> {
    const serverNow = options.serverNow ?? new Date();
    return this.buildShareCard(userId, input, serverNow, {
      mode: "public",
      shareToken: options.shareToken ?? null,
      viewerUserId: options.viewerUserId ?? null,
    });
  }

  private async buildShareCard(
    userId: string,
    input: ShareCardQuery,
    serverNow: Date,
    access: {
      mode: "me" | "public";
      shareToken: string | null;
      viewerUserId: string | null;
    },
  ): Promise<ShareCardData> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }
    const query = validateShareCardQueryValues(input);
    const catalogEntry = await assertLeagueSeasonAttached(this.repo, query.league_id, query.season_id);
    if (!catalogEntry.round_ids.includes(query.round_id)) {
      throw notFoundError("ROUND");
    }
    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    if (access.mode === "me") {
      if (user.status === UserStatus.Deleted) {
        throw conflictError("USER_DELETED", "用户已注销");
      }
      if (user.status !== UserStatus.Active) {
        throw conflictError("USER_NOT_ACTIVE", "用户不可访问个人私有接口");
      }
      if (user.nickname === null) {
        throw internalError("active 用户缺少 nickname");
      }
    } else {
      if (user.status !== UserStatus.Active && user.status !== UserStatus.Deleted) {
        throw conflictError("USER_NOT_ACTIVE", "用户不可访问个人私有接口");
      }
      if (user.status === UserStatus.Active && user.nickname === null) {
        throw internalError("active 用户缺少 nickname");
      }
    }

    const isDeleted = user.status === UserStatus.Deleted;
    const hasValidShareToken =
      access.mode === "public" &&
      !isDeleted &&
      this.verifyShareToken(userId, query, access.shareToken);
    const isOwner =
      access.mode === "me" ||
      (access.mode === "public" &&
        !isDeleted &&
        typeof access.viewerUserId === "string" &&
        access.viewerUserId === userId);
    const allowUnclosed = !isDeleted && (access.mode === "me" || hasValidShareToken || isOwner);
    const shareToken = allowUnclosed ? this.generateShareToken(userId, query) : null;

    const facts: SettledFact[] = [];
    let pendingPredictions = 0;
    const roundMatches = await this.repo.matches.findByLeagueSeasonRound(
      query.league_id,
      query.season_id,
      query.round_id,
    );
    const activeRoundMatches = roundMatches
      .filter((match) => match.superseded_by == null)
      .sort((left, right) => {
        const kickoffDiff = left.kickoff_at.getTime() - right.kickoff_at.getTime();
        if (kickoffDiff !== 0) {
          return kickoffDiff;
        }
        return left.match_id < right.match_id ? -1 : left.match_id > right.match_id ? 1 : 0;
      });
    const canonicalIds = activeRoundMatches.map((match) => match.canonical_match_id ?? match.match_id);
    const predictionsByCanonical = new Map<string, Prediction>();
    if (canonicalIds.length > 0) {
      if (typeof this.repo.predictions.findByUserAndCanonicalMatchIds === "function") {
        const predictions = await this.repo.predictions.findByUserAndCanonicalMatchIds(
          userId,
          canonicalIds,
        );
        for (const prediction of predictions) {
          predictionsByCanonical.set(prediction.canonical_match_id ?? prediction.match_id, prediction);
        }
      } else {
        for (const canonicalId of new Set(canonicalIds)) {
          const prediction = await this.repo.predictions.findByUserAndCanonicalMatch(
            userId,
            canonicalId,
          );
          if (prediction !== null) {
            predictionsByCanonical.set(canonicalId, prediction);
          }
        }
      }
    }

    const visibleMatchPredictions: Array<{ match: Match; prediction: Prediction; settled: boolean }> = [];
    const teamIds: string[] = [];
    for (const match of activeRoundMatches) {
      const prediction = predictionsByCanonical.get(match.canonical_match_id ?? match.match_id) ?? null;
      if (prediction === null) {
        continue;
      }
      const isFactValid = isCurrentSettledFact(prediction, match);
      if (isFactValid) {
        assertPredictionInvariants(prediction);
      }
      const hasFormalScore =
        match.regular_home_score !== null && match.regular_away_score !== null;
      const settled = hasFormalScore && isFactValid;
      if (settled) {
        facts.push({ prediction, match });
      }
      if (!allowUnclosed && !isClosedOrSettledMatch(match, serverNow)) {
        continue;
      }
      if (
        !settled &&
        match.match_status !== MatchStatus.Cancelled &&
        match.settlement_status !== SettlementStatus.Voided
      ) {
        pendingPredictions += 1;
      }
      visibleMatchPredictions.push({ match, prediction, settled });
      teamIds.push(match.home_team_id, match.away_team_id);
    }

    const teamsById =
      this.repo.teams === undefined || teamIds.length === 0
        ? new Map<string, Team>()
        : await fetchByIds(this.repo.teams, teamIds);

    const matches: ShareCardMatchItem[] = visibleMatchPredictions.map(({ match, prediction, settled }) => ({
      match_id: match.match_id,
      home_team: mapShareCardTeam(teamsById.get(match.home_team_id), match.home_team_id),
      away_team: mapShareCardTeam(teamsById.get(match.away_team_id), match.away_team_id),
      kickoff_at: match.kickoff_at.toISOString(),
      prediction_deadline_at: match.prediction_deadline_at?.toISOString() ?? null,
      match_status: match.match_status,
      settlement_status: toPublicSettlementStatus(match.settlement_status),
      is_prediction_closed: isPredictionClosed(match, serverNow),
      pred_home_score: prediction.pred_home_score,
      pred_away_score: prediction.pred_away_score,
      derived_result: prediction.derived_result,
      regular_home_score: match.regular_home_score,
      regular_away_score: match.regular_away_score,
      match_score: settled ? prediction.match_score : null,
      wdl_hit: settled ? prediction.wdl_hit : null,
      exact_hit: settled ? prediction.exact_hit : null,
    }));

    let roundPredictions = 0;
    let roundWdlHits = 0;
    let roundExactHits = 0;
    let roundScore = 0;

    for (const fact of facts) {
      const { prediction } = fact;
      const score = prediction.match_score as MatchScoreValue;

      roundPredictions += 1;
      roundWdlHits += prediction.wdl_hit ? 1 : 0;
      roundExactHits += prediction.exact_hit ? 1 : 0;
      roundScore += score;
    }

    const levelSeasonId = levelSeasonOf(serverNow);
    return {
      user_id: user.user_id,
      display_name: isDeleted ? "已注销用户" : user.nickname!,
      favorite_team_id: isDeleted ? null : user.favorite_team_id,
      // season_level：当前等级赛季的等级（不是历史轮次当时的等级）
      season_level: (await this.repo.userSeasonStats?.findByUserAndSeason(
        user.user_id,
        levelSeasonId,
      ))?.level ?? 1,
      league_id: query.league_id,
      season_id: query.season_id,
      season_label: formatSeasonLabel(query.season_id),
      round_id: query.round_id,
      round_predictions: roundPredictions,
      round_wdl_hits: roundWdlHits,
      round_exact_hits: roundExactHits,
      round_score: roundScore,
      // career_points：当前生涯积分
      career_points: user.career_points,
      level_season_id: levelSeasonId,
      generated_at: serverNow.toISOString(),
      pending_predictions: pendingPredictions,
      share_token: shareToken,
      matches,
    };
  }

  get(userId: string, input: ShareCardQuery, serverNow: Date = new Date()): Promise<ShareCardData> {
    return this.getShareCard(userId, input, serverNow);
  }
}
