/**
 * 分享卡只读查询：从当前 prediction + match 事实计算，不保存 round 聚合。
 */
import {
  isSupportedLeagueId,
  type SupportedLeagueId,
} from "../domain/config.js";
import { MatchScoreValue, MatchStatus, SettlementStatus, UserStatus } from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { assertPredictionInvariants } from "../domain/invariants.js";
import { formatSeasonLabel } from "../domain/season-label.js";
import { levelSeasonOf } from "../domain/time.js";
import type { Match, Prediction } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { assertLeagueSeasonAttached } from "./league-season-validation.js";

export interface ShareCardQuery {
  league_id: SupportedLeagueId;
  season_id: string;
  round_id: string;
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
}

const SHARE_CARD_QUERY_FIELDS = new Set(["league_id", "season_id", "round_id"]);
const ROUND_ID_PATTERN = /^\d{2}$/;

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

interface SettledFact {
  prediction: Prediction;
  match: Match;
}

export class ShareCardQueryService {
  constructor(private readonly repo: AppRepository) {}

  async getShareCard(userId: string, input: ShareCardQuery, serverNow: Date = new Date()): Promise<ShareCardData> {
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
    if (user.status === UserStatus.Deleted) {
      throw conflictError("USER_DELETED", "用户已注销");
    }
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_NOT_ACTIVE", "用户不可访问个人私有接口");
    }
    if (user.nickname === null) {
      throw internalError("active 用户缺少 nickname");
    }

    const facts: SettledFact[] = [];
    let pendingPredictions = 0;
    const roundMatches = await this.repo.matches.findByLeagueSeasonRound(
      query.league_id,
      query.season_id,
      query.round_id,
    );
    for (const match of roundMatches) {
      if (match.superseded_by != null) {
        continue;
      }
      const prediction = await this.repo.predictions.findByUserAndCanonicalMatch(
        userId,
        match.canonical_match_id ?? match.match_id,
      );
      if (prediction === null) {
        continue;
      }
      if (isCurrentSettledFact(prediction, match)) {
        assertPredictionInvariants(prediction);
        facts.push({ prediction, match });
        continue;
      }
      if (
        match.match_status !== MatchStatus.Cancelled &&
        match.settlement_status !== SettlementStatus.Voided
      ) {
        pendingPredictions += 1;
      }
    }

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
      display_name: user.nickname,
      favorite_team_id: user.favorite_team_id,
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
    };
  }

  get(userId: string, input: ShareCardQuery, serverNow: Date = new Date()): Promise<ShareCardData> {
    return this.getShareCard(userId, input, serverNow);
  }
}
