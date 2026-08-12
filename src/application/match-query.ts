import { createHmac, timingSafeEqual } from "node:crypto";
import { FIXED_CONFIG_V1, MVP_SEASON } from "../domain/config.js";
import { MatchStatus, UserStatus, type MatchStatus as MatchStatusValue } from "../domain/enums.js";
import {
  canSubmitPrediction,
  predictRejectReason,
  type PredictRejectReason,
} from "../domain/prediction-policy.js";
import { internalError, notFoundError, validationError } from "../domain/errors.js";
import { isValidUuid } from "../domain/ids.js";
import { addMinutes } from "../domain/time.js";
import type { Match, Prediction, Team, User } from "../domain/types.js";
import type { AppRepository, MatchRepository, TeamRepository } from "../infrastructure/repositories.js";

const MAX_QUERY_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
const CURSOR_VERSION = 1 as const;

export interface MatchListQuery {
  from: Date | null;
  to: Date | null;
  status: MatchStatusValue | null;
  limit: number;
  cursor: string | null;
  server_now: Date;
  authenticated_user_id: string | null | undefined;
}

export type CanPredictReason = PredictRejectReason;

export interface MatchListItem {
  match_id: string;
  league_id: string;
  season_id: string;
  round_id: string;
  home_team: {
    team_id: string;
    name: string;
  };
  away_team: {
    team_id: string;
    name: string;
  };
  kickoff_at: string;
  prediction_deadline_at: string | null;
  prediction_closed_at: string | null;
  match_status: MatchStatusValue;
  regular_home_score: number | null;
  regular_away_score: number | null;
  can_predict: boolean;
  can_predict_reason: CanPredictReason | null;
}

export interface MatchListResult {
  items: MatchListItem[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface MyMatchPrediction {
  prediction_id: string;
  pred_home_score: number;
  pred_away_score: number;
  derived_result: Prediction["derived_result"];
  submitted_at: string;
  match_score: Prediction["match_score"];
  wdl_hit: Prediction["wdl_hit"];
  exact_hit: Prediction["exact_hit"];
}

export interface MatchDetailResult extends MatchListItem {
  my_prediction: MyMatchPrediction | null;
}

interface MatchCursorPayload {
  version: 1;
  from: string;
  to: string;
  status: MatchStatusValue | null;
  kickoff_at: string;
  match_id: string;
}

function requireTeams(repo: Pick<AppRepository, "teams">): TeamRepository {
  if (repo.teams === undefined) {
    throw internalError("matches query 缺少 teams repository");
  }
  return repo.teams;
}

function requireMatches(repo: Pick<AppRepository, "matches">): MatchRepository {
  return repo.matches;
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw validationError(`${field} 必须是有效时间`, { field });
  }
}

function assertQuery(input: MatchListQuery): void {
  assertDate(input.server_now, "server_now");
  for (const [field, value] of [["from", input.from], ["to", input.to]] as const) {
    if (value !== null) {
      assertDate(value, field);
    }
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > FIXED_CONFIG_V1.API_MAX_LIMIT ||
    (input.status !== null && !Object.values(MatchStatus).includes(input.status))
  ) {
    throw validationError("比赛查询参数无效");
  }
}

function isCursorShape(value: unknown): value is string {
  return typeof value === "string" && value.length > 2 && value.split(".").length === 2;
}

function parseCursorDate(value: unknown, field: string): Date {
  if (typeof value !== "string") {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return date;
}

function parseCursorPayload(value: unknown): MatchCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const payload = value as Record<string, unknown>;
  const status = payload.status;
  if (
    payload.version !== CURSOR_VERSION ||
    (status !== null && !Object.values(MatchStatus).includes(status as MatchStatusValue)) ||
    typeof payload.match_id !== "string" ||
    !isValidUuid(payload.match_id) ||
    typeof payload.kickoff_at !== "string"
  ) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  const from = parseCursorDate(payload.from, "from");
  const to = parseCursorDate(payload.to, "to");
  const kickoffAt = parseCursorDate(payload.kickoff_at, "kickoff_at");
  if (from.getTime() >= to.getTime()) {
    throw validationError("cursor 内容无效", { field: "cursor" });
  }
  return {
    version: CURSOR_VERSION,
    from: from.toISOString(),
    to: to.toISOString(),
    status: status as MatchStatusValue | null,
    kickoff_at: kickoffAt.toISOString(),
    match_id: payload.match_id,
  };
}

export class MatchCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length === 0) {
      throw new Error("match cursor secret must not be empty");
    }
  }

  encode(position: Omit<MatchCursorPayload, "version">): string {
    const payload: MatchCursorPayload = { version: CURSOR_VERSION, ...position };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  decode(cursor: string): MatchCursorPayload {
    if (!isCursorShape(cursor)) {
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
    return parseCursorPayload(parsed);
  }
}

function resolveWindow(
  input: MatchListQuery,
  cursor: MatchCursorPayload | null,
): { from: Date; to: Date; status: MatchStatusValue | null } {
  const cursorFrom = cursor === null ? null : new Date(cursor.from);
  const cursorTo = cursor === null ? null : new Date(cursor.to);
  const from = input.from ?? cursorFrom ?? addMinutes(input.server_now, -24 * 60);
  const to = input.to ?? cursorTo ?? addMinutes(input.server_now, 30 * 24 * 60);
  const status = input.status ?? cursor?.status ?? null;

  if (cursor !== null) {
    if (input.from !== null && input.from.toISOString() !== cursor.from) {
      throw validationError("cursor 与当前 from 冲突", { field: "cursor" });
    }
    if (input.to !== null && input.to.toISOString() !== cursor.to) {
      throw validationError("cursor 与当前 to 冲突", { field: "cursor" });
    }
    if (input.status !== null && input.status !== cursor.status) {
      throw validationError("cursor 与当前 status 冲突", { field: "cursor" });
    }
  }
  if (from.getTime() >= to.getTime()) {
    throw validationError("from 必须早于 to", { field: "from" });
  }
  if (to.getTime() - from.getTime() > MAX_QUERY_RANGE_MS) {
    throw validationError("查询区间不得超过 90 天", { field: "to" });
  }
  return { from, to, status };
}

function validScore(value: number | null): boolean {
  return value === null || Number.isInteger(value) && value >= 0 && value <= 99;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function assertMatch(match: Match): void {
  if (
    !isValidUuid(match.match_id) ||
    !isValidUuid(match.home_team_id) ||
    !isValidUuid(match.away_team_id) ||
    !Object.values(MatchStatus).includes(match.match_status) ||
    !validDate(match.kickoff_at) ||
    (match.prediction_deadline_at !== null && !validDate(match.prediction_deadline_at)) ||
    (match.prediction_closed_at !== null && !validDate(match.prediction_closed_at)) ||
    !validScore(match.regular_home_score) ||
    !validScore(match.regular_away_score) ||
    (match.regular_home_score === null) !== (match.regular_away_score === null)
  ) {
    throw internalError(`match 文档数据非法（match_id=${match.match_id}）`);
  }
}

function mapTeam(team: Team | null, teamId: string): { team_id: string; name: string } {
  if (
    team === null ||
    team.team_id !== teamId ||
    typeof team.name !== "string" ||
    team.name.length === 0
  ) {
    throw internalError(`match 缺少球队资料（team_id=${teamId}）`);
  }
  return { team_id: team.team_id, name: team.name };
}

function mapMyPrediction(
  prediction: Prediction,
  userId: string,
  matchId: string,
): MyMatchPrediction {
  if (prediction.user_id !== userId || prediction.match_id !== matchId) {
    throw internalError(`prediction 归属不一致（prediction_id=${prediction.prediction_id}）`);
  }
  return {
    prediction_id: prediction.prediction_id,
    pred_home_score: prediction.pred_home_score,
    pred_away_score: prediction.pred_away_score,
    derived_result: prediction.derived_result,
    submitted_at: prediction.submitted_at.toISOString(),
    match_score: prediction.match_score,
    wdl_hit: prediction.wdl_hit,
    exact_hit: prediction.exact_hit,
  };
}

function toItem(
  match: Match,
  homeTeam: Team | null,
  awayTeam: Team | null,
  user: User | null,
  existingPrediction: { prediction_id: string } | null,
  serverNow: Date,
): MatchListItem {
  assertMatch(match);
  const reason = predictRejectReason({ user, match, existingPrediction, serverNow });
  const canPredict = user !== null && canSubmitPrediction(user, match, existingPrediction, serverNow);
  if ((reason === null) !== canPredict) {
    throw internalError(`match 可预测状态不一致（match_id=${match.match_id}）`);
  }
  return {
    match_id: match.match_id,
    league_id: match.league_id,
    season_id: match.season_id,
    round_id: match.round_id,
    home_team: mapTeam(homeTeam, match.home_team_id),
    away_team: mapTeam(awayTeam, match.away_team_id),
    kickoff_at: match.kickoff_at.toISOString(),
    prediction_deadline_at: match.prediction_deadline_at?.toISOString() ?? null,
    prediction_closed_at: match.prediction_closed_at?.toISOString() ?? null,
    match_status: match.match_status,
    regular_home_score: match.regular_home_score,
    regular_away_score: match.regular_away_score,
    can_predict: canPredict,
    can_predict_reason: reason,
  };
}

export class MatchQueryService {
  private readonly cursorCodec: MatchCursorCodec;

  constructor(
    private readonly repo: Pick<AppRepository, "matches" | "teams" | "users" | "predictions">,
    cursorSecret: string,
  ) {
    this.cursorCodec = new MatchCursorCodec(cursorSecret);
  }

  async list(input: MatchListQuery): Promise<MatchListResult> {
    assertQuery(input);
    const cursor = input.cursor === null ? null : this.cursorCodec.decode(input.cursor);
    const window = resolveWindow(input, cursor);
    const userId = input.authenticated_user_id ?? null;
    let user: User | null = null;
    if (userId !== null) {
      if (!isValidUuid(userId)) {
        throw validationError("authenticated_user_id 必须为 UUID v4", {
          field: "authenticated_user_id",
        });
      }
      user = await this.repo.users.findById(userId);
    }

    const loadedMatches = await requireMatches(this.repo).findBySeason(MVP_SEASON.season_id);
    for (const match of loadedMatches) {
      assertMatch(match);
    }
    const matches = loadedMatches
      .filter((match) => match.league_id === MVP_SEASON.league_id)
      .filter((match) => window.status === null || match.match_status === window.status)
      .filter((match) => match.kickoff_at.getTime() >= window.from.getTime())
      .filter((match) => match.kickoff_at.getTime() < window.to.getTime())
      .sort((a, b) => {
        const kickoffDifference = a.kickoff_at.getTime() - b.kickoff_at.getTime();
        if (kickoffDifference !== 0) {
          return kickoffDifference;
        }
        return a.match_id < b.match_id ? -1 : a.match_id > b.match_id ? 1 : 0;
      });

    const remaining = cursor === null
      ? matches
      : matches.filter((match) =>
        match.kickoff_at.toISOString() > cursor.kickoff_at ||
        match.kickoff_at.toISOString() === cursor.kickoff_at && match.match_id > cursor.match_id,
      );
    const page = remaining.slice(0, input.limit);
    const teams = requireTeams(this.repo);
    const items: MatchListItem[] = [];
    for (const match of page) {
      const homeTeam = await teams.findById(match.home_team_id);
      const awayTeam = await teams.findById(match.away_team_id);
      const prediction = user === null || user.status === UserStatus.Deleted
        ? null
        : await this.repo.predictions.findByUserAndMatch(user.user_id, match.match_id);
      items.push(toItem(match, homeTeam, awayTeam, user, prediction, input.server_now));
    }

    const hasMore = remaining.length > input.limit;
    const last = page.at(-1);
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && last !== undefined
        ? this.cursorCodec.encode({
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            status: window.status,
            kickoff_at: last.kickoff_at.toISOString(),
            match_id: last.match_id,
          })
        : null,
    };
  }

  async get(
    matchId: string,
    authenticatedUserId: string | null | undefined,
    serverNow: Date,
  ): Promise<MatchDetailResult> {
    if (!isValidUuid(matchId)) {
      throw validationError("match_id 必须为 UUID v4", { field: "match_id" });
    }
    assertDate(serverNow, "server_now");

    const match = await this.repo.matches.findById(matchId);
    if (
      match === null ||
      match.league_id !== MVP_SEASON.league_id ||
      match.season_id !== MVP_SEASON.season_id
    ) {
      throw notFoundError("MATCH");
    }
    assertMatch(match);

    let user: User | null = null;
    if (authenticatedUserId !== null && authenticatedUserId !== undefined) {
      if (!isValidUuid(authenticatedUserId)) {
        throw validationError("authenticated_user_id 必须为 UUID v4", {
          field: "authenticated_user_id",
        });
      }
      user = await this.repo.users.findById(authenticatedUserId);
    }

    const teams = requireTeams(this.repo);
    const homeTeam = await teams.findById(match.home_team_id);
    const awayTeam = await teams.findById(match.away_team_id);
    const prediction =
      user === null || user.status === UserStatus.Deleted
        ? null
        : await this.repo.predictions.findByUserAndMatch(user.user_id, match.match_id);

    return {
      ...toItem(match, homeTeam, awayTeam, user, prediction, serverNow),
      my_prediction:
        prediction === null || user === null
          ? null
          : mapMyPrediction(prediction, user.user_id, match.match_id),
    };
  }
}
