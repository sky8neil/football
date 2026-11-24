import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  PredictionHistoryQueryService,
  type PredictionHistoryItem,
  type PredictionHistoryQuery,
  type PredictionHistoryResult,
} from "../../application/prediction-query.js";
import { MatchStatus, UserStatus } from "../../domain/enums.js";
import { newUuid } from "../../domain/ids.js";
import { defaultLevelState, type Match, type Prediction, type Team, type User } from "../../domain/types.js";
import { InMemoryRepository } from "../../infrastructure/repositories.js";
import { getMyPredictions, validateMyPredictionsQuery } from "./predictions.js";
import { InMemoryRateLimiter } from "./rate-limit.js";

const ITEM: PredictionHistoryItem = {
  prediction_id: "00000000-0000-4000-8000-000000000020",
  match_id: "00000000-0000-4000-8000-000000000010",
  league_id: "premier_league",
  season_id: "2026_2027",
  round_id: "01",
  home_team_id: "00000000-0000-4000-8000-000000000011",
  away_team_id: "00000000-0000-4000-8000-000000000012",
  home_team: { team_id: "00000000-0000-4000-8000-000000000011", name: "Arsenal FC" },
  away_team: { team_id: "00000000-0000-4000-8000-000000000012", name: "Chelsea FC" },
  kickoff_at: "2026-08-08T14:00:00.000Z",
  pred_home_score: 2,
  pred_away_score: 1,
  derived_result: "HOME",
  submitted_at: "2026-08-08T12:00:00.000Z",
  scoring_rule_version: "scoring_v1",
  match_status: "finished",
  regular_home_score: 2,
  regular_away_score: 1,
  match_score: 12,
  wdl_hit: true,
  exact_hit: true,
};

const RESULT: PredictionHistoryResult = {
  items: [ITEM],
  has_more: false,
  next_cursor: null,
};

const NOW = new Date("2026-08-11T00:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const HOME_TEAM_ID = "00000000-0000-4000-8000-000000000031";
const AWAY_TEAM_ID = "00000000-0000-4000-8000-000000000032";

function makeUser(userId = USER_ID): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `prediction-list-user-${userId}`,
    unionid: null,
    nickname: "Sky",
    favorite_team_id: null,
    status: UserStatus.Active,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeTeam(teamId: string, name: string): Team {
  return {
    schema_version: 1,
    team_id: teamId,
    league_id: "premier_league",
    name,
    short_name: null,
    primary_color: null,
    secondary_color: null,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMatch(matchId: string, overrides: Partial<Match> = {}): Match {
  const canonicalMatchIdentity = overrides.match_id ?? matchId;
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: new Date("2026-08-08T14:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-08T13:50:00.000Z"),
    prediction_closed_at: new Date("2026-08-08T13:50:00.000Z"),
    period_anchor_at: new Date("2026-08-08T14:00:00.000Z"),
    match_status: MatchStatus.Finished,
    settlement_status: "settled",
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: new Date("2026-08-08T16:00:00.000Z"),
    settled_at: new Date("2026-08-08T16:20:00.000Z"),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makePrediction(predictionId: string, matchId: string, submittedAt: string): Prediction {
  return {
    schema_version: 1,
    prediction_id: predictionId,
    user_id: USER_ID,
    match_id: matchId,
    canonical_match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: "HOME",
    submitted_at: new Date(submittedAt),
    scoring_rule_version: "scoring_v1",
    match_score: 12,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function setupHistoryRepo(): Promise<InMemoryRepository> {
  const repo = new InMemoryRepository();
  await repo.users.insert(makeUser());
  await repo.teams.insert(makeTeam(HOME_TEAM_ID, "Arsenal FC"));
  await repo.teams.insert(makeTeam(AWAY_TEAM_ID, "Chelsea FC"));
  await repo.matches.insert(makeMatch("00000000-0000-4000-8000-000000000010", {
    home_team_id: HOME_TEAM_ID,
    away_team_id: AWAY_TEAM_ID,
  }));
  await repo.matches.insert(makeMatch("00000000-0000-4000-8000-000000000012", {
    home_team_id: HOME_TEAM_ID,
    away_team_id: AWAY_TEAM_ID,
    season_id: "2025_2026",
  }));
  await repo.predictions.insert(makePrediction(
    "00000000-0000-4000-8000-000000000020",
    "00000000-0000-4000-8000-000000000010",
    "2026-08-08T13:00:00.000Z",
  ));
  await repo.predictions.insert(makePrediction(
    "00000000-0000-4000-8000-000000000022",
    "00000000-0000-4000-8000-000000000012",
    "2026-08-08T14:00:00.000Z",
  ));
  return repo;
}

describe("GET /v1/predictions/me", () => {
  it("校验 league_id/season_id、limit、cursor；缺省全部联赛", () => {
    expect(validateMyPredictionsQuery({})).toEqual({
      league_id: null,
      season_id: null,
      limit: 20,
      cursor: null,
    });
    expect(validateMyPredictionsQuery({
      league_id: "la_liga",
      season_id: "2026_2027",
      limit: "2",
      cursor: "opaque",
    })).toEqual({
      league_id: "la_liga",
      season_id: "2026_2027",
      limit: 2,
      cursor: "opaque",
    });
    for (const query of [
      { season_id: "2026_2027" },
      { league_id: "eredivisie" },
      { season_id: null },
      { limit: "0" },
      { limit: "101" },
      { limit: 2 },
      { cursor: null },
      { extra: "x" },
    ]) {
      expect(() => validateMyPredictionsQuery(query)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
    }
  });

  it("API 层只校验参数形态，不按赛季白名单拦截", () => {
    expect(validateMyPredictionsQuery({
      league_id: "premier_league",
      season_id: "2026_2027",
    }, NOW).season_id).toBe("2026_2027");
    expect(validateMyPredictionsQuery({
      league_id: "premier_league",
      season_id: "2025_2026",
    }, NOW).season_id).toBe("2025_2026");
    expect(validateMyPredictionsQuery({
      league_id: "premier_league",
      season_id: "2024_2025",
    }, NOW).season_id).toBe("2024_2025");
    expect(validateMyPredictionsQuery({
      league_id: "premier_league",
      season_id: "2025_2026",
    }).season_id).toBe("2025_2026");
    expect(() => validateMyPredictionsQuery({
      season_id: "2026_2027",
    })).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field: "season_id" },
    }));
    expect(() => validateMyPredictionsQuery({
      league_id: "eredivisie",
      season_id: "2026_2027",
    })).toThrowError(expect.objectContaining({
      code: "VALIDATION_ERROR",
      details: { field: "league_id" },
    }));
  });

  it("已接入的历史赛季能正常返回", async () => {
    const service = new PredictionHistoryQueryService(await setupHistoryRepo(), "prediction-list-secret");
    await expect(getMyPredictions(service, {
      authenticated_user_id: USER_ID,
      query: { league_id: "premier_league", season_id: "2025_2026" },
      server_now: NOW,
      request_id: "request-predictions-attached-season",
    })).resolves.toMatchObject({
      status: 200,
      body: {
        data: {
          items: [expect.objectContaining({
            prediction_id: "00000000-0000-4000-8000-000000000022",
            season_id: "2025_2026",
            match_id: "00000000-0000-4000-8000-000000000012",
            home_team: { team_id: HOME_TEAM_ID, name: "Arsenal FC" },
            away_team: { team_id: AWAY_TEAM_ID, name: "Chelsea FC" },
          })],
        },
      },
    });
  });

  it("未接入赛季由 service 层拒绝，details 为 NOT_ATTACHED", async () => {
    const service = new PredictionHistoryQueryService(await setupHistoryRepo(), "prediction-list-secret");
    await expect(getMyPredictions(service, {
      authenticated_user_id: USER_ID,
      query: { league_id: "premier_league", season_id: "2023_2024" },
      server_now: NOW,
      request_id: "request-predictions-unattached-season",
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "season_id", reason: "NOT_ATTACHED" },
    });
  });

  it("要求登录并返回分页成功 envelope", async () => {
    const list = async (
      userId: string,
      query: PredictionHistoryQuery,
    ): Promise<PredictionHistoryResult> => {
      expect(userId).toBe("00000000-0000-4000-8000-000000000001");
      expect(query).toEqual({ league_id: null, season_id: null, limit: 20, cursor: null });
      return RESULT;
    };

    await expect(getMyPredictions({ listMyPredictions: list }, {
      authenticated_user_id: "00000000-0000-4000-8000-000000000001",
      query: {},
      server_now: NOW,
      request_id: "request-predictions-list-1",
    })).resolves.toEqual({
      status: 200,
      body: {
        data: { items: [ITEM], page: { next_cursor: null, has_more: false } },
        request_id: "request-predictions-list-1",
      },
    });

    await expect(getMyPredictions({ listMyPredictions: list }, {
      query: {},
      server_now: NOW,
      request_id: "request-predictions-list-2",
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("handler 只输出冻结 item 字段，不泄漏 application 内部字段", async () => {
    const itemWithInternalField = {
      ...ITEM,
      internal_only: "must-not-be-public",
    } as PredictionHistoryItem;

    const response = await getMyPredictions({
      listMyPredictions: async () => ({
        items: [itemWithInternalField],
        has_more: false,
        next_cursor: null,
      }),
    }, {
      authenticated_user_id: "00000000-0000-4000-8000-000000000001",
      query: {},
      server_now: NOW,
      request_id: "request-predictions-list-contract-1",
    });

    expect(response.body.data.items).toEqual([ITEM]);
    expect(response.body.data.items[0]).not.toHaveProperty("internal_only");
  });

  it("limits authenticated history reads to 120 requests per minute", async () => {
    const rateLimiter = new InMemoryRateLimiter();
    const input = {
      authenticated_user_id: "00000000-0000-4000-8000-000000000001",
      query: {},
      server_now: NOW,
      request_id: "request-predictions-list-rate-limit",
      rate_limiter: rateLimiter,
    } as never;

    const list = async (): Promise<PredictionHistoryResult> => RESULT;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(getMyPredictions({ listMyPredictions: list }, input)).resolves.toBeDefined();
    }

    await expect(getMyPredictions({ listMyPredictions: list }, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("声明历史预测列表 OpenAPI contract", async () => {
    const specification = await readFile(new URL("./openapi.yaml", import.meta.url), "utf8");
    expect(specification).toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?PredictionHistoryEnvelope/,
    );
    expect(specification).toMatch(
      /    PredictionHistoryData:[\s\S]*?required: \[items, page\]/,
    );
    expect(specification).toMatch(
      /    PredictionHistoryItem:[\s\S]*?required: \[prediction_id, match_id, league_id, season_id, round_id, home_team_id, away_team_id, home_team, away_team, kickoff_at, pred_home_score, pred_away_score, derived_result, submitted_at, scoring_rule_version, match_status, regular_home_score, regular_away_score, match_score, wdl_hit, exact_hit\]/,
    );
    expect(specification).toMatch(
      /    PredictionHistoryItem:[\s\S]*?home_team:\n          \$ref: '#\/components\/schemas\/MatchTeam'[\s\S]*?away_team:\n          \$ref: '#\/components\/schemas\/MatchTeam'/,
    );
    expect(specification).toMatch(
      /    PredictionHistoryItem:[\s\S]*?regular_home_score:[\s\S]*?type: integer[\s\S]*?nullable: true[\s\S]*?regular_away_score:[\s\S]*?type: integer[\s\S]*?nullable: true[\s\S]*?match_score:[\s\S]*?nullable: true[\s\S]*?wdl_hit:[\s\S]*?type: boolean[\s\S]*?nullable: true[\s\S]*?exact_hit:[\s\S]*?type: boolean[\s\S]*?nullable: true/,
    );
    expect(specification).toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?submitted_at DESC、prediction_id DESC[\s\S]*?base64url \+ HMAC opaque[\s\S]*?正式比分缺失时，[\s\S]*?均为 null/,
    );
    expect(specification).toMatch(
      /        - name: season_id\n          in: query\n          required: false\n          schema:\n            type: string\n          description: 仅可与 league_id 同时提供；须为该联赛已接入的赛季（见 GET \/v1\/league-seasons），历史赛季同样可查/,
    );
    expect(specification).not.toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?        - name: season_id\n          in: query\n          required: false\n          schema:\n            type: string\n            enum: \[2026_2027, '2026'\]/,
    );
    expect(specification).toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?'429':[\s\S]*?RateLimited/,
    );
    expect(specification).toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?'409':[\s\S]*?PredictionHistoryConflict/,
    );
    expect(specification).toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?'404':[\s\S]*?PredictionHistoryNotFound/,
    );
    expect(specification).toMatch(
      /  \/predictions\/me:\n    get:[\s\S]*?'500':[\s\S]*?InternalError/,
    );
    expect(specification).toMatch(
      /    PredictionHistoryConflict:\n      description: "409 .*USER_DELETED/,
    );
    expect(specification).toMatch(
      /    PredictionHistoryNotFound:\n      description: 404 USER_NOT_FOUND/,
    );
  });
});
