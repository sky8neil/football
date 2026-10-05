/**
 * 分享卡只读查询：从当前 prediction + match 事实计算，不保存 round 聚合。
 */
import {
  findSupportedLeagueById,
  isSupportedLeagueId,
  type SupportedLeagueId,
} from "../domain/config.js";
import { MatchScoreValue, MatchStatus, SettlementStatus, UserStatus } from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { assertPredictionInvariants } from "../domain/invariants.js";
import { levelSeasonOf } from "../domain/time.js";
import type { Match, Prediction } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface ShareCardQuery {
  league_id: SupportedLeagueId;
  season_id: string;
  round_id: string;
}

export interface ShareCardData {
  user_id: string;
  display_name: string;
  favorite_team_id: string | null;
  season_level: number;
  league_id: SupportedLeagueId;
  round_id: string;
  round_predictions: number;
  round_wdl_hits: number;
  round_exact_hits: number;
  round_score: number;
  career_points: number;
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
  const league = findSupportedLeagueById(query.league_id);
  if (league === undefined) {
    throw validationError("league_id 必须是受支持的联赛", { field: "league_id" });
  }
  if (typeof query.season_id !== "string" || query.season_id !== league.season_id) {
    throw validationError("season_id 必须匹配该联赛当前登记赛季", { field: "season_id" });
  }
  if (
    typeof query.round_id !== "string" ||
    !ROUND_ID_PATTERN.test(query.round_id) ||
    Number(query.round_id) < 1 ||
    Number(query.round_id) > league.round_max
  ) {
    throw validationError("round_id 超出该联赛轮次范围", { field: "round_id" });
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
  return (
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

  async getShareCard(userId: string, input: ShareCardQuery): Promise<ShareCardData> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }
    const query = validateShareCardQueryValues(input);
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
    const roundMatches = await this.repo.matches.findByLeagueSeasonRound(
      query.league_id,
      query.season_id,
      query.round_id,
    );
    for (const match of roundMatches) {
      const prediction = await this.repo.predictions.findByUserAndMatch(userId, match.match_id);
      if (prediction === null) {
        continue;
      }
      if (isCurrentSettledFact(prediction, match)) {
        assertPredictionInvariants(prediction);
        facts.push({ prediction, match });
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

    return {
      user_id: user.user_id,
      display_name: user.nickname,
      favorite_team_id: user.favorite_team_id,
      season_level: (await this.repo.userSeasonStats?.findByUserAndSeason(
        user.user_id,
        levelSeasonOf(new Date()),
      ))?.level ?? 1,
      league_id: query.league_id,
      round_id: query.round_id,
      round_predictions: roundPredictions,
      round_wdl_hits: roundWdlHits,
      round_exact_hits: roundExactHits,
      round_score: roundScore,
      career_points: user.career_points,
    };
  }

  get(userId: string, input: ShareCardQuery): Promise<ShareCardData> {
    return this.getShareCard(userId, input);
  }
}
