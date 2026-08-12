/**
 * 分享卡只读查询：从当前 prediction + match 事实计算，不保存 round 聚合。
 */
import { MVP_SEASON } from "../domain/config.js";
import { LevelScope, MatchScoreValue, MatchStatus, SettlementStatus, UserStatus } from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { assertPredictionInvariants } from "../domain/invariants.js";
import { calculateLevel } from "../domain/levels.js";
import type { Match, Prediction } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface ShareCardQuery {
  season_id: string;
  round_id: string;
}

export interface ShareCardData {
  user_id: string;
  display_name: string;
  favorite_team_id: string | null;
  season_level: number;
  round_id: string;
  round_predictions: number;
  round_wdl_hits: number;
  round_exact_hits: number;
  round_score: number;
  career_points: number;
}

const SHARE_CARD_QUERY_FIELDS = new Set(["season_id", "round_id"]);
const ROUND_ID_PATTERN = /^(?:0[1-9]|[12][0-9]|3[0-8])$/;

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
  if (typeof query.season_id !== "string" || query.season_id !== MVP_SEASON.season_id) {
    throw validationError("season_id 必须是已知赛季", { field: "season_id" });
  }
  if (typeof query.round_id !== "string" || !ROUND_ID_PATTERN.test(query.round_id)) {
    throw validationError("round_id 必须是 01..38 的字符串", { field: "round_id" });
  }
}

/** API 与 application 共用的显式 season/round 校验。 */
export function validateShareCardQueryValues(input: unknown): ShareCardQuery {
  assertShareCardQueryObject(input);
  return {
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
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_NOT_ACTIVE", "用户不可访问个人私有接口");
    }
    if (user.nickname === null) {
      throw internalError("active 用户缺少 nickname");
    }

    const facts: SettledFact[] = [];
    const predictions = await this.repo.predictions.findByUser(userId);
    for (const prediction of predictions) {
      const match = await this.repo.matches.findById(prediction.match_id);
      if (match === null) {
        throw internalError(
          `prediction 缺少 match（prediction_id=${prediction.prediction_id}）`,
        );
      }
      if (isCurrentSettledFact(prediction, match)) {
        assertPredictionInvariants(prediction);
        facts.push({ prediction, match });
      }
    }

    let seasonValidPredictions = 0;
    let seasonWdlHits = 0;
    let careerPoints = 0;
    let roundPredictions = 0;
    let roundWdlHits = 0;
    let roundExactHits = 0;
    let roundScore = 0;

    for (const fact of facts) {
      const { prediction, match } = fact;
      const score = prediction.match_score as MatchScoreValue;
      careerPoints += score;

      if (match.season_id !== query.season_id) {
        continue;
      }

      seasonValidPredictions += 1;
      seasonWdlHits += prediction.wdl_hit ? 1 : 0;

      if (match.round_id !== query.round_id) {
        continue;
      }

      roundPredictions += 1;
      roundWdlHits += prediction.wdl_hit ? 1 : 0;
      roundExactHits += prediction.exact_hit ? 1 : 0;
      roundScore += score;
    }

    return {
      user_id: user.user_id,
      display_name: user.nickname,
      favorite_team_id: user.favorite_team_id,
      season_level: calculateLevel(
        LevelScope.Season,
        seasonValidPredictions,
        seasonWdlHits,
      ),
      round_id: query.round_id,
      round_predictions: roundPredictions,
      round_wdl_hits: roundWdlHits,
      round_exact_hits: roundExactHits,
      round_score: roundScore,
      career_points: careerPoints,
    };
  }

  get(userId: string, input: ShareCardQuery): Promise<ShareCardData> {
    return this.getShareCard(userId, input);
  }
}
