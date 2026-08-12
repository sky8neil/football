import { createHmac, timingSafeEqual } from "node:crypto";
import { FIXED_CONFIG_V1, MVP_SEASON } from "../domain/config.js";
import { UserStatus } from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import type { Match, Prediction } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";

export interface PredictionDetailData {
  prediction_id: string;
  match_id: string;
  pred_home_score: number;
  pred_away_score: number;
  derived_result: "HOME" | "DRAW" | "AWAY";
  submitted_at: string;
  scoring_rule_version: string;
  match_status: "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "abandoned";
  regular_home_score: number | null;
  regular_away_score: number | null;
  match_score: 0 | 3 | 12 | null;
  wdl_hit: boolean | null;
  exact_hit: boolean | null;
}

export interface PredictionHistoryQuery {
  season_id: string;
  limit: number;
  cursor: string | null;
}

export interface PredictionHistoryItem extends PredictionDetailData {
  league_id: string;
  season_id: string;
  round_id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_at: string;
}

export interface PredictionHistoryResult {
  items: PredictionHistoryItem[];
  has_more: boolean;
  next_cursor: string | null;
}

interface PredictionHistoryCursorPayload {
  version: 1;
  season_id: string;
  submitted_at: string;
  prediction_id: string;
}

const PREDICTION_HISTORY_CURSOR_VERSION = 1 as const;

function isOpaqueCursorShape(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parts = value.split(".");
  return (
    parts.length === 2 &&
    parts[0]!.length > 0 &&
    parts[1]!.length > 0 &&
    /^[A-Za-z0-9_-]+$/.test(parts[0]!) &&
    /^[A-Za-z0-9_-]+$/.test(parts[1]!)
  );
}

function parsePredictionHistoryCursor(value: unknown): PredictionHistoryCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== PREDICTION_HISTORY_CURSOR_VERSION ||
    typeof payload.season_id !== "string" ||
    typeof payload.submitted_at !== "string" ||
    !Number.isFinite(Date.parse(payload.submitted_at)) ||
    typeof payload.prediction_id !== "string" ||
    !isValidUuid(payload.prediction_id)
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return {
    version: PREDICTION_HISTORY_CURSOR_VERSION,
    season_id: payload.season_id,
    submitted_at: new Date(payload.submitted_at).toISOString(),
    prediction_id: payload.prediction_id,
  };
}

export class PredictionHistoryCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length === 0) {
      throw new Error("prediction history cursor secret must not be empty");
    }
  }

  encode(position: Omit<PredictionHistoryCursorPayload, "version">): string {
    const payload: PredictionHistoryCursorPayload = {
      version: PREDICTION_HISTORY_CURSOR_VERSION,
      ...position,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  decode(cursor: string): Omit<PredictionHistoryCursorPayload, "version"> {
    if (!isOpaqueCursorShape(cursor)) {
      throw validationError("cursor 格式无效", { field: "cursor" });
    }
    const [encoded, signature] = cursor.split(".") as [string, string];
    const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    const providedBytes = Buffer.from(signature, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (
      providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)
    ) {
      throw validationError("cursor 签名无效", { field: "cursor" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw validationError("cursor 内容无效", { field: "cursor" });
    }
    const payload = parsePredictionHistoryCursor(parsed);
    return {
      season_id: payload.season_id,
      submitted_at: payload.submitted_at,
      prediction_id: payload.prediction_id,
    };
  }
}

export class PredictionQueryService {
  constructor(
    private readonly repo: Pick<AppRepository, "users" | "predictions" | "matches">,
  ) {}

  async getMyPrediction(userId: string, predictionId: string): Promise<PredictionDetailData> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }
    if (!isValidUuid(predictionId)) {
      throw validationError("prediction_id 必须为 UUID v4", { field: "prediction_id" });
    }

    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_DELETED", "该账号已被注销");
    }

    const prediction = await this.repo.predictions.findById(predictionId);
    if (prediction === null || prediction.user_id !== userId) {
      throw notFoundError("PREDICTION");
    }

    const match = await this.repo.matches.findById(prediction.match_id);
    if (match === null) {
      throw internalError("prediction 缺少对应 match");
    }

    return {
      prediction_id: prediction.prediction_id,
      match_id: prediction.match_id,
      pred_home_score: prediction.pred_home_score,
      pred_away_score: prediction.pred_away_score,
      derived_result: prediction.derived_result,
      submitted_at: prediction.submitted_at.toISOString(),
      scoring_rule_version: prediction.scoring_rule_version,
      match_status: match.match_status,
      regular_home_score: match.regular_home_score,
      regular_away_score: match.regular_away_score,
      match_score: prediction.match_score,
      wdl_hit: prediction.wdl_hit,
      exact_hit: prediction.exact_hit,
    };
  }
}

function assertPredictionHistoryQuery(input: PredictionHistoryQuery): void {
  if (
    input.season_id !== MVP_SEASON.season_id ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > FIXED_CONFIG_V1.API_MAX_LIMIT ||
    (input.cursor !== null && !isOpaqueCursorShape(input.cursor))
  ) {
    throw validationError("历史预测查询参数无效");
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw internalError(`prediction ${field} 非法`);
  }
}

/** 历史预测只读取用户自己的事实，并按提交时间稳定倒序分页。 */
export class PredictionHistoryQueryService {
  private readonly cursorCodec: PredictionHistoryCursorCodec;

  constructor(
    private readonly repo: Pick<AppRepository, "users" | "predictions" | "matches">,
    cursorSecret: string,
  ) {
    this.cursorCodec = new PredictionHistoryCursorCodec(cursorSecret);
  }

  async listMyPredictions(
    userId: string,
    input: PredictionHistoryQuery,
  ): Promise<PredictionHistoryResult> {
    if (!isValidUuid(userId)) {
      throw validationError("user_id 必须为 UUID v4", { field: "user_id" });
    }
    assertPredictionHistoryQuery(input);

    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_DELETED", "该账号已被注销");
    }

    const cursor = input.cursor === null ? null : this.cursorCodec.decode(input.cursor);
    if (cursor !== null && cursor.season_id !== input.season_id) {
      throw validationError("cursor 与当前 season_id 冲突", { field: "cursor" });
    }

    const facts: Array<{ prediction: Prediction; match: Match }> = [];
    for (const prediction of await this.repo.predictions.findByUser(userId)) {
      if (prediction.user_id !== userId) {
        throw internalError(`prediction 归属不一致（prediction_id=${prediction.prediction_id}）`);
      }
      assertValidDate(prediction.submitted_at, "submitted_at");
      const match = await this.repo.matches.findById(prediction.match_id);
      if (match === null) {
        throw internalError(`prediction 缺少对应 match（prediction_id=${prediction.prediction_id}）`);
      }
      if (match.league_id !== MVP_SEASON.league_id || match.season_id !== input.season_id) {
        continue;
      }
      assertValidDate(match.kickoff_at, "kickoff_at");
      facts.push({ prediction, match });
    }

    facts.sort((a, b) => {
      const submittedDifference = b.prediction.submitted_at.getTime() - a.prediction.submitted_at.getTime();
      if (submittedDifference !== 0) {
        return submittedDifference;
      }
      if (a.prediction.prediction_id === b.prediction.prediction_id) {
        return 0;
      }
      return a.prediction.prediction_id < b.prediction.prediction_id ? 1 : -1;
    });

    const cursorSubmittedAt = cursor === null ? null : Date.parse(cursor.submitted_at);
    const remaining = cursor === null
      ? facts
      : facts.filter(({ prediction }) =>
        prediction.submitted_at.getTime() < cursorSubmittedAt! ||
        prediction.submitted_at.getTime() === cursorSubmittedAt! &&
          prediction.prediction_id < cursor.prediction_id,
      );
    const page = remaining.slice(0, input.limit);
    const items: PredictionHistoryItem[] = page.map(({ prediction, match }) => ({
      prediction_id: prediction.prediction_id,
      match_id: prediction.match_id,
      league_id: match.league_id,
      season_id: match.season_id,
      round_id: match.round_id,
      home_team_id: match.home_team_id,
      away_team_id: match.away_team_id,
      kickoff_at: match.kickoff_at.toISOString(),
      pred_home_score: prediction.pred_home_score,
      pred_away_score: prediction.pred_away_score,
      derived_result: prediction.derived_result,
      submitted_at: prediction.submitted_at.toISOString(),
      scoring_rule_version: prediction.scoring_rule_version,
      match_status: match.match_status,
      regular_home_score: match.regular_home_score,
      regular_away_score: match.regular_away_score,
      match_score: prediction.match_score,
      wdl_hit: prediction.wdl_hit,
      exact_hit: prediction.exact_hit,
    }));

    const hasMore = remaining.length > input.limit;
    const last = page.at(-1);
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && last !== undefined
        ? this.cursorCodec.encode({
            season_id: input.season_id,
            submitted_at: last.prediction.submitted_at.toISOString(),
            prediction_id: last.prediction.prediction_id,
          })
        : null,
    };
  }
}
