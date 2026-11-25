import { createHmac, timingSafeEqual } from "node:crypto";
import {
  FIXED_CONFIG_V1,
  findSupportedLeagueById,
  isSupportedLeagueId,
} from "../domain/config.js";
import { MatchStatus, SettlementStatus, UserStatus } from "../domain/enums.js";
import { conflictError, internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import type { Match, Team } from "../domain/types.js";
import type { AppRepository } from "../infrastructure/repositories.js";
import { assertLeagueSeasonAttached } from "./league-season-validation.js";
import { fetchByIds, resolveEffectiveMatchesByIds } from "./match-identity.js";
import { toPublicSettlementStatus, type PublicSettlementStatus } from "./match-query.js";

export interface PredictionDetailData {
  prediction_id: string;
  match_id: string;
  pred_home_score: number;
  pred_away_score: number;
  derived_result: "HOME" | "DRAW" | "AWAY";
  submitted_at: string;
  scoring_rule_version: string;
  match_status: "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "abandoned";
  settlement_status: PublicSettlementStatus;
  regular_home_score: number | null;
  regular_away_score: number | null;
  match_score: 0 | 3 | 12 | null;
  wdl_hit: boolean | null;
  exact_hit: boolean | null;
}

export interface PredictionHistoryQuery {
  league_id: string | null;
  season_id: string | null;
  limit: number;
  cursor: string | null;
}

export interface PredictionHistoryItem extends PredictionDetailData {
  league_id: string;
  season_id: string;
  round_id: string;
  home_team_id: string;
  away_team_id: string;
  home_team: { team_id: string; name: string; name_zh: string | null; logo_url: string | null };
  away_team: { team_id: string; name: string; name_zh: string | null; logo_url: string | null };
  kickoff_at: string;
}

export interface PredictionHistoryResult {
  items: PredictionHistoryItem[];
  has_more: boolean;
  next_cursor: string | null;
}

interface PredictionHistoryCursorPayload {
  version: 1;
  league_id: string | null;
  season_id: string | null;
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
  const leagueId = payload.league_id;
  const seasonId = payload.season_id;
  if (
    payload.version !== PREDICTION_HISTORY_CURSOR_VERSION ||
    (leagueId !== null && (typeof leagueId !== "string" || !isSupportedLeagueId(leagueId))) ||
    (seasonId !== null && typeof seasonId !== "string") ||
    typeof payload.submitted_at !== "string" ||
    !Number.isFinite(Date.parse(payload.submitted_at)) ||
    typeof payload.prediction_id !== "string" ||
    !isValidUuid(payload.prediction_id)
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return {
    version: PREDICTION_HISTORY_CURSOR_VERSION,
    league_id: leagueId as string | null,
    season_id: seasonId as string | null,
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
      league_id: payload.league_id,
      season_id: payload.season_id,
      submitted_at: payload.submitted_at,
      prediction_id: payload.prediction_id,
    };
  }
}

async function resolveEffectiveMatch(
  matches: AppRepository["matches"],
  matchId: string,
): Promise<Match | null> {
  let match = await matches.findById(matchId);
  const visited = new Set<string>();
  while (match !== null && match.superseded_by != null && !visited.has(match.match_id)) {
    visited.add(match.match_id);
    const next = await matches.findById(match.superseded_by);
    if (next === null) break;
    match = next;
  }
  return match;
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

    const match = await resolveEffectiveMatch(this.repo.matches, prediction.match_id);
    if (match === null) {
      throw internalError("prediction 缺少对应 match");
    }
    const hasFormalScore =
      match.regular_home_score !== null && match.regular_away_score !== null;
    const settled =
      hasFormalScore &&
      match.match_status !== MatchStatus.Cancelled &&
      match.settlement_status === SettlementStatus.Settled &&
      prediction.applied_result_version === match.result_version;

    return {
      prediction_id: prediction.prediction_id,
      match_id: match.match_id,
      pred_home_score: prediction.pred_home_score,
      pred_away_score: prediction.pred_away_score,
      derived_result: prediction.derived_result,
      submitted_at: prediction.submitted_at.toISOString(),
      scoring_rule_version: prediction.scoring_rule_version,
      match_status: match.match_status,
      settlement_status: toPublicSettlementStatus(match.settlement_status),
      regular_home_score: match.regular_home_score,
      regular_away_score: match.regular_away_score,
      match_score: settled ? prediction.match_score : null,
      wdl_hit: settled ? prediction.wdl_hit : null,
      exact_hit: settled ? prediction.exact_hit : null,
    };
  }
}

async function assertPredictionHistoryQuery(
  repo: Pick<AppRepository, "matches">,
  input: PredictionHistoryQuery,
  cursor: Omit<PredictionHistoryCursorPayload, "version"> | null,
): Promise<void> {
  const leagueId = input.league_id ?? cursor?.league_id ?? null;
  const seasonId = input.season_id ?? cursor?.season_id ?? null;
  if (seasonId !== null && leagueId === null) {
    throw validationError("历史预测查询参数无效");
  }
  if (seasonId !== null && leagueId !== null) {
    await assertLeagueSeasonAttached(repo, leagueId, seasonId);
  } else if (leagueId !== null && !isSupportedLeagueId(leagueId)) {
    throw validationError("历史预测查询参数无效");
  }
  if (
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
    private readonly repo: Pick<AppRepository, "users" | "predictions" | "matches"> & {
      teams?: AppRepository["teams"];
    },
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
    const cursor = input.cursor === null ? null : this.cursorCodec.decode(input.cursor);
    await assertPredictionHistoryQuery(this.repo, input, cursor);

    const user = await this.repo.users.findById(userId);
    if (user === null) {
      throw notFoundError("USER");
    }
    if (user.status !== UserStatus.Active) {
      throw conflictError("USER_DELETED", "该账号已被注销");
    }

    if (cursor !== null) {
      if (input.league_id != null && cursor.league_id !== input.league_id) {
        throw validationError("cursor 与当前 league_id 冲突", { field: "cursor" });
      }
      if (input.season_id != null && cursor.season_id !== input.season_id) {
        throw validationError("cursor 与当前 season_id 冲突", { field: "cursor" });
      }
    }
    const resolvedLeagueId = input.league_id ?? cursor?.league_id ?? null;
    const resolvedSeasonId = input.season_id ?? cursor?.season_id ?? null;

    const historyParams = {
      user_id: userId,
      league_id: resolvedLeagueId,
      season_id: resolvedSeasonId,
      cursor: cursor === null ? null : { submitted_at: new Date(cursor.submitted_at), prediction_id: cursor.prediction_id },
      limit: input.limit + 1,
    };
    const resumePage = this.repo.predictions.findHistoryPageWithScanResume === undefined
      ? null
      : await this.repo.predictions.findHistoryPageWithScanResume(historyParams);
    const rows = resumePage === null
      ? await this.repo.predictions.findHistoryPage(historyParams)
      : resumePage.predictions;
    const hasMore = rows.length > input.limit
      || (resumePage !== null && !resumePage.exhausted && resumePage.resume_cursor !== null);
    const page = rows.slice(0, input.limit);

    const effectiveMatches = await resolveEffectiveMatchesByIds(
      this.repo.matches,
      page.map((prediction) => prediction.match_id),
    );
    const teamIds: string[] = [];
    for (const prediction of page) {
      const match = effectiveMatches.get(prediction.match_id);
      if (match !== undefined) {
        teamIds.push(match.home_team_id, match.away_team_id);
      }
    }
    const teamsById = this.repo.teams === undefined
      ? new Map<string, Team>()
      : await fetchByIds(this.repo.teams, teamIds);
    const items: PredictionHistoryItem[] = [];
    for (const prediction of page) {
      if (prediction.user_id !== userId) {
        throw internalError(`prediction 归属不一致（prediction_id=${prediction.prediction_id}）`);
      }
      assertValidDate(prediction.submitted_at, "submitted_at");
      const match = effectiveMatches.get(prediction.match_id) ?? null;
      if (match === null) {
        throw internalError(`prediction 缺少对应 match（prediction_id=${prediction.prediction_id}）`);
      }
      if (findSupportedLeagueById(match.league_id) === undefined) {
        continue;
      }
      assertValidDate(match.kickoff_at, "kickoff_at");
      const hasFormalScore =
        match.regular_home_score !== null && match.regular_away_score !== null;
      const settled =
        hasFormalScore &&
        match.match_status !== MatchStatus.Cancelled &&
        match.settlement_status === SettlementStatus.Settled &&
        prediction.applied_result_version === match.result_version;
      const homeTeam = teamsById.get(match.home_team_id);
      const awayTeam = teamsById.get(match.away_team_id);
      items.push({
        prediction_id: prediction.prediction_id,
        match_id: match.match_id,
        league_id: match.league_id,
        season_id: match.season_id,
        round_id: match.round_id,
        home_team_id: match.home_team_id,
        away_team_id: match.away_team_id,
        home_team: {
          team_id: match.home_team_id,
          name: homeTeam?.name ?? "",
          name_zh: typeof homeTeam?.name_zh === "string" && homeTeam.name_zh.trim().length > 0
            ? homeTeam.name_zh.trim()
            : null,
          logo_url: typeof homeTeam?.logo_url === "string" && homeTeam.logo_url.trim().length > 0
            ? homeTeam.logo_url.trim()
            : null,
        },
        away_team: {
          team_id: match.away_team_id,
          name: awayTeam?.name ?? "",
          name_zh: typeof awayTeam?.name_zh === "string" && awayTeam.name_zh.trim().length > 0
            ? awayTeam.name_zh.trim()
            : null,
          logo_url: typeof awayTeam?.logo_url === "string" && awayTeam.logo_url.trim().length > 0
            ? awayTeam.logo_url.trim()
            : null,
        },
        kickoff_at: match.kickoff_at.toISOString(),
        pred_home_score: prediction.pred_home_score,
        pred_away_score: prediction.pred_away_score,
        derived_result: prediction.derived_result,
        submitted_at: prediction.submitted_at.toISOString(),
        scoring_rule_version: prediction.scoring_rule_version,
        match_status: match.match_status,
        settlement_status: toPublicSettlementStatus(match.settlement_status),
        regular_home_score: match.regular_home_score,
        regular_away_score: match.regular_away_score,
        match_score: settled ? prediction.match_score : null,
        wdl_hit: settled ? prediction.wdl_hit : null,
        exact_hit: settled ? prediction.exact_hit : null,
      });
    }

    const last = page.at(-1);
    const resumeCursor = rows.length > input.limit
      ? (last === undefined ? null : {
          submitted_at: last.submitted_at,
          prediction_id: last.prediction_id,
        })
      : resumePage?.resume_cursor ?? null;
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && resumeCursor !== null
        ? this.cursorCodec.encode({
            league_id: resolvedLeagueId,
            season_id: resolvedSeasonId,
            submitted_at: resumeCursor.submitted_at.toISOString(),
            prediction_id: resumeCursor.prediction_id,
          })
        : null,
    };
  }
}
