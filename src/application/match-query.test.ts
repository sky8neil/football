import { describe, expect, it } from "vitest";
import { MatchStatus, UserStatus } from "../domain/enums.js";
import type { Match, Prediction, Team, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { newUuid } from "../domain/ids.js";
import { MatchQueryService } from "./match-query.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const DELETED_USER_ID = "00000000-0000-4000-8000-000000000002";
const HOME_TEAM_ID = "00000000-0000-4000-8000-000000000101";
const AWAY_TEAM_ID = "00000000-0000-4000-8000-000000000102";
const MATCH_A = "00000000-0000-4000-8000-000000000010";
const MATCH_B = "00000000-0000-4000-8000-000000000011";
const MATCH_C = "00000000-0000-4000-8000-000000000012";

function makeUser(userId: string, status: User["status"] = UserStatus.Active): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
    unionid: null,
    nickname: status === UserStatus.Active ? "Sky" : null,
    favorite_team_id: null,
    status,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: status === UserStatus.Deleted ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeTeam(teamId: string, name: string): Team {
  return {
    schema_version: 1,
    team_id: teamId,
    name,
    short_name: null,
    primary_color: null,
    secondary_color: null,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMatch(
  matchId: string,
  kickoffAt: Date,
  overrides: Partial<Match> = {},
): Match {
  const deadline = new Date(kickoffAt.getTime() - 10 * 60 * 1000);
  return {
    schema_version: 1,
    match_id: matchId,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: HOME_TEAM_ID,
    away_team_id: AWAY_TEAM_ID,
    kickoff_at: kickoffAt,
    kickoff_confirmed: true,
    prediction_deadline_at: deadline,
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: MatchStatus.Scheduled,
    settlement_status: "pending",
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makePrediction(matchId: string): Prediction {
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: USER_ID,
    match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 1,
    pred_away_score: 0,
    derived_result: "HOME",
    submitted_at: NOW,
    scoring_rule_version: "scoring_v1",
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

async function seedRepository() {
  const repo = new InMemoryRepository();
  await repo.users.insert(makeUser(USER_ID));
  await repo.users.insert(makeUser(DELETED_USER_ID, UserStatus.Deleted));
  await repo.teams.insert(makeTeam(HOME_TEAM_ID, "Arsenal"));
  await repo.teams.insert(makeTeam(AWAY_TEAM_ID, "Chelsea"));
  return repo;
}

describe("MatchQueryService", () => {
  it("uses the default window, sorts by kickoff then match_id, maps teams, and pages with a bound cursor", async () => {
    const repo = await seedRepository();
    await repo.matches.insert(makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z")));
    await repo.matches.insert(makeMatch(MATCH_C, new Date("2026-08-09T14:00:00.000Z")));
    await repo.matches.insert(makeMatch(MATCH_B, new Date("2026-08-09T14:00:00.000Z")));
    await repo.matches.insert(
      makeMatch("00000000-0000-4000-8000-000000000013", new Date("2026-08-08T10:00:00.000Z")),
    );

    const service = new MatchQueryService(repo, "test-match-cursor-secret");
    const first = await service.list({
      from: null,
      to: null,
      status: null,
      limit: 2,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: USER_ID,
    });

    expect(first.items.map((item) => item.match_id)).toEqual([MATCH_A, MATCH_B]);
    expect(first.items[0]).toMatchObject({
      league_id: "premier_league",
      season_id: "2026_2027",
      home_team: { team_id: HOME_TEAM_ID, name: "Arsenal" },
      away_team: { team_id: AWAY_TEAM_ID, name: "Chelsea" },
      can_predict: true,
      can_predict_reason: null,
      prediction_closed_at: null,
      regular_home_score: null,
      regular_away_score: null,
    });
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await service.list({
      from: null,
      to: null,
      status: null,
      limit: 2,
      cursor: first.next_cursor,
      server_now: new Date("2026-08-10T12:00:00.000Z"),
      authenticated_user_id: USER_ID,
    });
    expect(second.items.map((item) => item.match_id)).toEqual([MATCH_C]);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeNull();
  });

  it("returns the frozen can_predict reasons and filters by status/date", async () => {
    const repo = await seedRepository();
    const open = makeMatch("00000000-0000-4000-8000-000000000020", new Date("2026-08-09T13:00:00.000Z"));
    const unconfirmed = makeMatch(
      "00000000-0000-4000-8000-000000000021",
      new Date("2026-08-09T14:00:00.000Z"),
      { kickoff_confirmed: false, prediction_deadline_at: null },
    );
    const live = makeMatch(
      "00000000-0000-4000-8000-000000000022",
      new Date("2026-08-09T15:00:00.000Z"),
      { match_status: MatchStatus.Live, prediction_closed_at: NOW },
    );
    const postponed = makeMatch(
      "00000000-0000-4000-8000-000000000025",
      new Date("2026-08-09T12:30:00.000Z"),
      { match_status: MatchStatus.Postponed },
    );
    const closed = makeMatch(
      "00000000-0000-4000-8000-000000000023",
      new Date("2026-08-09T11:00:00.000Z"),
      {
        prediction_deadline_at: new Date("2026-08-09T10:50:00.000Z"),
        prediction_closed_at: new Date("2026-08-09T10:50:00.000Z"),
      },
    );
    const submitted = makeMatch(
      "00000000-0000-4000-8000-000000000024",
      new Date("2026-08-09T16:00:00.000Z"),
    );
    for (const match of [open, unconfirmed, live, closed, submitted, postponed]) {
      await repo.matches.insert(match);
    }
    await repo.predictions.insert(makePrediction(submitted.match_id));

    const result = await new MatchQueryService(repo, "test-match-cursor-secret").list({
      from: new Date("2026-08-09T10:00:00.000Z"),
      to: new Date("2026-08-09T17:00:00.000Z"),
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: USER_ID,
    });

    expect(new Map(result.items.map((item) => [item.match_id, item.can_predict_reason]))).toEqual(
      new Map([
        [open.match_id, null],
        [unconfirmed.match_id, "KICKOFF_UNCONFIRMED"],
        [live.match_id, "NOT_SCHEDULED"],
        [closed.match_id, "CLOSED"],
        [submitted.match_id, "ALREADY_SUBMITTED"],
        [postponed.match_id, "NOT_SCHEDULED"],
      ]),
    );

    const liveOnly = await new MatchQueryService(repo, "test-match-cursor-secret").list({
      from: null,
      to: null,
      status: MatchStatus.Live,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: null,
    });
    expect(liveOnly.items.map((item) => item.match_id)).toEqual([live.match_id]);
    expect(liveOnly.items[0]?.can_predict_reason).toBe("AUTH_REQUIRED");
  });

  it("uses USER_DELETED for a deleted optional auth context and rejects an overlong window or cursor conflict", async () => {
    const repo = await seedRepository();
    await repo.matches.insert(makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z")));
    await repo.matches.insert(makeMatch(MATCH_B, new Date("2026-08-09T14:00:00.000Z")));
    const service = new MatchQueryService(repo, "test-match-cursor-secret");

    const deleted = await service.list({
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: DELETED_USER_ID,
    });
    expect(deleted.items[0]?.can_predict_reason).toBe("USER_DELETED");

    await expect(service.list({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-04-02T00:00:00.000Z"),
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: null,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const page = await service.list({
      from: null,
      to: null,
      status: null,
      limit: 1,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: null,
    });
    await expect(service.list({
      from: new Date("2026-08-08T00:00:00.000Z"),
      to: null,
      status: null,
      limit: 1,
      cursor: page.next_cursor,
      server_now: NOW,
      authenticated_user_id: null,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns a single match with the authenticated user's prediction", async () => {
    const repo = await seedRepository();
    const match = makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z"));
    const prediction = makePrediction(match.match_id);
    await repo.matches.insert(match);
    await repo.predictions.insert(prediction);

    const result = await new MatchQueryService(repo, "test-match-cursor-secret").get(
      match.match_id,
      USER_ID,
      NOW,
    );

    expect(result).toMatchObject({
      match_id: match.match_id,
      home_team: { team_id: HOME_TEAM_ID, name: "Arsenal" },
      away_team: { team_id: AWAY_TEAM_ID, name: "Chelsea" },
      my_prediction: {
        prediction_id: prediction.prediction_id,
        pred_home_score: 1,
        pred_away_score: 0,
        derived_result: "HOME",
        submitted_at: NOW.toISOString(),
        match_score: null,
        wdl_hit: null,
        exact_hit: null,
      },
    });
    expect(result.my_prediction).not.toHaveProperty("idempotency_key");
  });
});
