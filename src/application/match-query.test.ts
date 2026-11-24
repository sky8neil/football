import { describe, expect, it, vi } from "vitest";
import { MatchStatus, SettlementStatus, UserStatus } from "../domain/enums.js";
import type { Match, Prediction, Team, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { newUuid } from "../domain/ids.js";
import { MatchQueryService } from "./match-query.js";
import { defaultLevelState } from "../domain/types.js";

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
    career_last_scoring_match_at: null,
    career_level_state: defaultLevelState(),
    deleted_at: status === UserStatus.Deleted ? NOW : null,
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

function makeMatch(
  matchId: string,
  kickoffAt: Date,
  overrides: Partial<Match> = {},
): Match {
  const deadline = new Date(kickoffAt.getTime() - 10 * 60 * 1000);
  const canonicalMatchIdentity = overrides.match_id ?? (matchId);
  return {
    schema_version: 1,
    match_id: canonicalMatchIdentity,
    canonical_match_id: overrides.canonical_match_id ?? canonicalMatchIdentity,
    superseded_by: overrides.superseded_by ?? null,
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
    canonical_match_id: matchId,
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

    for (const query of [
      { from: new Date("2026-01-01T00:00:00.000Z"), to: null },
      { from: null, to: new Date("2026-12-01T00:00:00.000Z") },
    ]) {
      await expect(service.list({
        ...query,
        status: null,
        limit: 20,
        cursor: null,
        server_now: NOW,
        authenticated_user_id: null,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }

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

  it("league_id 缺省返回全部联赛，指定联赛只返回该联赛", async () => {
    const repo = await seedRepository();
    await repo.matches.insert(makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z")));
    await repo.matches.insert(makeMatch(MATCH_B, new Date("2026-08-09T14:00:00.000Z"), {
      league_id: "la_liga",
    }));
    await repo.matches.insert(makeMatch(MATCH_C, new Date("2026-08-09T15:00:00.000Z"), {
      league_id: "chinese_super_league",
      season_id: "2026",
    }));
    const service = new MatchQueryService(repo, "test-match-cursor-secret");
    const query = {
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: null,
    };

    const all = await service.list(query);
    expect(all.items.map((item) => item.match_id)).toEqual([MATCH_A, MATCH_B, MATCH_C]);

    const laLiga = await service.list({ ...query, league_id: "la_liga" });
    expect(laLiga.items.map((item) => item.match_id)).toEqual([MATCH_B]);
    expect(laLiga.items[0]?.league_id).toBe("la_liga");
  });

  it("非法 league_id 返回 VALIDATION_ERROR", async () => {
    const repo = await seedRepository();
    await expect(new MatchQueryService(repo, "test-match-cursor-secret").list({
      from: null,
      to: null,
      status: null,
      league_id: "eredivisie",
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: null,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("[Slice 2] server_now = 2027-03-15T12:00:00Z 时能查到中超 season_id = '2027' 的比赛", async () => {
    const repo = await seedRepository();
    const serverNow = new Date("2027-03-15T12:00:00.000Z");
    await repo.matches.insert(makeMatch(MATCH_A, new Date("2027-03-16T11:30:00.000Z"), {
      league_id: "chinese_super_league",
      season_id: "2027",
    }));
    const service = new MatchQueryService(repo, "test-match-cursor-secret");
    const result = await service.list({
      from: null,
      to: null,
      status: null,
      league_id: "chinese_super_league",
      limit: 20,
      cursor: null,
      server_now: serverNow,
      authenticated_user_id: null,
    });
    expect(result.items.map((item) => ({ match_id: item.match_id, season_id: item.season_id }))).toEqual([
      { match_id: MATCH_A, season_id: "2027" },
    ]);
  });

  it("[Slice 2] server_now = 2027-08-15T12:00:00Z 时能查到英超 season_id = '2027_2028' 的比赛", async () => {
    const repo = await seedRepository();
    const serverNow = new Date("2027-08-15T12:00:00.000Z");
    await repo.matches.insert(makeMatch(MATCH_B, new Date("2027-08-16T14:00:00.000Z"), {
      league_id: "premier_league",
      season_id: "2027_2028",
    }));
    const service = new MatchQueryService(repo, "test-match-cursor-secret");
    const result = await service.list({
      from: null,
      to: null,
      status: null,
      league_id: "premier_league",
      limit: 20,
      cursor: null,
      server_now: serverNow,
      authenticated_user_id: null,
    });
    expect(result.items.map((item) => ({ match_id: item.match_id, season_id: item.season_id }))).toEqual([
      { match_id: MATCH_B, season_id: "2027_2028" },
    ]);
  });

  it("[Slice 4] MatchQueryService.list 优先调用 findBySeasonInWindow 下推时间窗，不再调用 findBySeason", async () => {
    const repo = await seedRepository();
    await repo.matches.insert(makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z")));
    const baseMatches = repo.matches;
    const findBySeasonCalls: string[] = [];
    const findBySeasonInWindowCalls: Array<{ seasonId: string; from: Date; to: Date }> = [];
    const trackedRepo = {
      ...repo,
      matches: {
        ...baseMatches,
        findBySeason: async (seasonId: string) => {
          findBySeasonCalls.push(seasonId);
          return baseMatches.findBySeason(seasonId);
        },
        findBySeasonInWindow: async (seasonId: string, from: Date, to: Date) => {
          findBySeasonInWindowCalls.push({ seasonId, from, to });
          return baseMatches.findBySeasonInWindow!(seasonId, from, to);
        },
      },
      teams: repo.teams,
      users: repo.users,
      predictions: repo.predictions,
    };
    const service = new MatchQueryService(trackedRepo, "test-match-cursor-secret");
    const result = await service.list({
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: null,
    });
    expect(result.items.map((item) => item.match_id)).toEqual([MATCH_A]);
    expect(findBySeasonCalls).toEqual([]);
    expect(findBySeasonInWindowCalls.length).toBeGreaterThan(0);
  });

  it("lists settlement_status and my_prediction for signed-in users, and null predictions for guests", async () => {
    const repo = await seedRepository();
    const open = makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z"));
    const submitted = makeMatch(MATCH_B, new Date("2026-08-09T14:00:00.000Z"));
    await repo.matches.insert(open);
    await repo.matches.insert(submitted);
    const prediction = makePrediction(submitted.match_id);
    await repo.predictions.insert(prediction);
    const service = new MatchQueryService(repo, "test-match-cursor-secret");
    const query = {
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
    };

    const signedIn = await service.list({ ...query, authenticated_user_id: USER_ID });
    expect(signedIn.items).toHaveLength(2);
    for (const item of signedIn.items) {
      expect(item.settlement_status).toBe("not_ready");
      expect(item).toHaveProperty("my_prediction");
      expect(item).toHaveProperty("is_prediction_closed");
    }
    expect(signedIn.items.find((item) => item.match_id === open.match_id)?.my_prediction).toBeNull();
    expect(signedIn.items.find((item) => item.match_id === submitted.match_id)?.my_prediction).toEqual({
      prediction_id: prediction.prediction_id,
      pred_home_score: 1,
      pred_away_score: 0,
      derived_result: "HOME",
      submitted_at: NOW.toISOString(),
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
    });

    const guest = await service.list({ ...query, authenticated_user_id: null });
    expect(guest.items).toHaveLength(2);
    for (const item of guest.items) {
      expect(item.settlement_status).toBe("not_ready");
      expect(item.my_prediction).toBeNull();
    }
  });

  it("sets is_prediction_closed when closed_at is set or the deadline has passed", async () => {
    const repo = await seedRepository();
    const open = makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z"));
    const closedAt = makeMatch(MATCH_B, new Date("2026-08-09T14:00:00.000Z"), {
      prediction_closed_at: NOW,
    });
    const deadlinePassed = makeMatch(MATCH_C, new Date("2026-08-09T15:00:00.000Z"), {
      prediction_deadline_at: new Date("2026-08-09T11:50:00.000Z"),
      prediction_closed_at: null,
    });
    await repo.matches.insert(open);
    await repo.matches.insert(closedAt);
    await repo.matches.insert(deadlinePassed);
    const service = new MatchQueryService(repo, "test-match-cursor-secret");

    expect((await service.get(open.match_id, USER_ID, NOW)).is_prediction_closed).toBe(false);
    expect((await service.get(closedAt.match_id, USER_ID, NOW)).is_prediction_closed).toBe(true);
    expect((await service.get(deadlinePassed.match_id, USER_ID, NOW)).is_prediction_closed).toBe(true);
  });

  it("keeps ALREADY_SUBMITTED ahead of CLOSED after the deadline", async () => {
    const repo = await seedRepository();
    const match = makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z"), {
      prediction_deadline_at: new Date("2026-08-09T11:50:00.000Z"),
      prediction_closed_at: null,
    });
    await repo.matches.insert(match);
    await repo.predictions.insert(makePrediction(match.match_id));

    const result = await new MatchQueryService(repo, "test-match-cursor-secret").get(
      match.match_id,
      USER_ID,
      NOW,
    );
    expect(result.can_predict).toBe(false);
    expect(result.can_predict_reason).toBe("ALREADY_SUBMITTED");
    expect(result.is_prediction_closed).toBe(true);
    expect(result.my_prediction).not.toBeNull();
  });

  it("loads page predictions in one batch instead of N+1", async () => {
    const repo = await seedRepository();
    await repo.matches.insert(makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z")));
    await repo.matches.insert(makeMatch(MATCH_B, new Date("2026-08-09T14:00:00.000Z")));
    await repo.predictions.insert(makePrediction(MATCH_A));
    const findByUserAndCanonicalMatch = vi.fn(repo.predictions.findByUserAndCanonicalMatch);
    const findByUserAndCanonicalMatchIds = vi.fn(repo.predictions.findByUserAndCanonicalMatchIds);
    const trackedRepo = {
      ...repo,
      matches: repo.matches,
      teams: repo.teams,
      users: repo.users,
      predictions: {
        ...repo.predictions,
        findByUserAndCanonicalMatch,
        findByUserAndCanonicalMatchIds,
      },
    };
    const service = new MatchQueryService(trackedRepo, "test-match-cursor-secret");
    const result = await service.list({
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: USER_ID,
    });
    expect(result.items).toHaveLength(2);
    expect(findByUserAndCanonicalMatch).toHaveBeenCalledTimes(0);
    expect(findByUserAndCanonicalMatchIds).toHaveBeenCalledTimes(1);
    expect(findByUserAndCanonicalMatchIds).toHaveBeenCalledWith(USER_ID, [MATCH_A, MATCH_B]);
  });

  it("lists my_prediction by canonical identity even when prediction.match_id differs", async () => {
    const repo = await seedRepository();
    const listed = makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z"));
    const prediction = {
      ...makePrediction(MATCH_B),
      match_id: MATCH_B,
      canonical_match_id: MATCH_A,
    };
    await repo.matches.insert(listed);
    await repo.predictions.insert(prediction);
    const service = new MatchQueryService(repo, "test-match-cursor-secret");
    const listedItem = (await service.list({
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: USER_ID,
    })).items[0];
    const detail = await service.get(MATCH_A, USER_ID, NOW);
    expect(listedItem?.my_prediction).toEqual(detail.my_prediction);
    expect(listedItem?.my_prediction?.prediction_id).toBe(prediction.prediction_id);
    expect(listedItem?.can_predict_reason).toBe("ALREADY_SUBMITTED");
    expect(detail.can_predict_reason).toBe("ALREADY_SUBMITTED");
  });

  it("queries upcoming-season matches within window before UTC Jul 1 / Jan 1 rollover and narrows to requested league", async () => {
    const repo = await seedRepository();
    const plNextSeason = makeMatch(MATCH_A, new Date("2027-07-10T14:00:00.000Z"), {
      league_id: "premier_league",
      season_id: "2027_2028",
    });
    const cslNextSeason = makeMatch(MATCH_B, new Date("2028-01-10T11:30:00.000Z"), {
      league_id: "chinese_super_league",
      season_id: "2028",
    });
    await repo.matches.insert(plNextSeason);
    await repo.matches.insert(cslNextSeason);

    const baseMatches = repo.matches;
    const calledSeasons: string[] = [];
    const service = new MatchQueryService({
      ...repo,
      matches: {
        ...baseMatches,
        findBySeason: async (seasonId) => {
          calledSeasons.push(seasonId);
          return baseMatches.findBySeason(seasonId);
        },
        findBySeasonInWindow: async (seasonId, from, to) => {
          calledSeasons.push(seasonId);
          return baseMatches.findBySeasonInWindow!(seasonId, from, to);
        },
      },
      teams: repo.teams,
      users: repo.users,
      predictions: repo.predictions,
    }, "test-match-cursor-secret");

    const juneResult = await service.list({
      from: null,
      to: null,
      status: null,
      league_id: "premier_league",
      limit: 20,
      cursor: null,
      server_now: new Date("2027-06-15T12:00:00.000Z"),
      authenticated_user_id: USER_ID,
    });
    expect(juneResult.items.map((item) => item.match_id)).toEqual([MATCH_A]);
    expect(calledSeasons).toContain("2027_2028");
    expect(calledSeasons).not.toContain("2027");

    calledSeasons.length = 0;
    const decResult = await service.list({
      from: null,
      to: null,
      status: null,
      league_id: "chinese_super_league",
      limit: 20,
      cursor: null,
      server_now: new Date("2027-12-15T12:00:00.000Z"),
      authenticated_user_id: USER_ID,
    });
    expect(decResult.items.map((item) => item.match_id)).toEqual([MATCH_B]);
    expect(calledSeasons).toContain("2028");
    expect(calledSeasons).not.toContain("2027_2028");
  });

  it("get reads latest settled state and my_prediction score from superseded match chain while keeping can_predict=false", async () => {
    const repo = await seedRepository();
    const mOld = makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z"), {
      match_status: MatchStatus.Scheduled,
      superseded_by: null,
      settlement_status: SettlementStatus.Pending,
      result_version: 0,
    });
    const mNew = makeMatch(MATCH_B, new Date("2026-08-10T13:00:00.000Z"), {
      canonical_match_id: MATCH_A,
      superseded_by: null,
      match_status: MatchStatus.Finished,
      regular_home_score: 2,
      regular_away_score: 1,
      settlement_status: SettlementStatus.Settled,
      result_version: 1,
      settled_result_version: 1,
    });
    const prediction: Prediction = {
      ...makePrediction(MATCH_A),
      canonical_match_id: MATCH_A,
      pred_home_score: 2,
      pred_away_score: 1,
      applied_result_version: 1,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    };
    await repo.matches.insert(mOld);
    await repo.matches.insert(mNew);
    await repo.matches.update({
      ...mOld,
      match_status: MatchStatus.Postponed,
      superseded_by: MATCH_B,
      updated_at: new Date("2026-08-09T13:05:00.000Z"),
    });
    await repo.predictions.insert(prediction);

    const detail = await new MatchQueryService(repo, "test-match-cursor-secret").get(
      MATCH_A,
      USER_ID,
      NOW,
    );
    expect(detail.match_id).toBe(MATCH_A);
    expect(detail.match_status).toBe(MatchStatus.Finished);
    expect(detail.settlement_status).toBe("settled");
    expect(detail.regular_home_score).toBe(2);
    expect(detail.regular_away_score).toBe(1);
    expect(detail.can_predict).toBe(false);
    expect(detail.can_predict_reason).toBe("ALREADY_SUBMITTED");
    expect(detail.my_prediction).toMatchObject({
      prediction_id: prediction.prediction_id,
      match_score: 12,
      wdl_hit: true,
      exact_hit: true,
    });

    const anonDetail = await new MatchQueryService(repo, "test-match-cursor-secret").get(
      MATCH_A,
      null,
      new Date("2026-08-09T12:00:00.000Z"),
    );
    expect(anonDetail.can_predict).toBe(false);
    expect(anonDetail.can_predict_reason).toBe("AUTH_REQUIRED");

    const openEffective = makeMatch("00000000-0000-4000-8000-0000000000c1", new Date("2026-08-12T14:00:00.000Z"), {
      canonical_match_id: "00000000-0000-4000-8000-0000000000c2",
    });
    const closedOld = makeMatch("00000000-0000-4000-8000-0000000000c2", new Date("2026-08-12T14:00:00.000Z"));
    await repo.matches.insert(openEffective);
    await repo.matches.insert(closedOld);
    await repo.matches.update({
      ...closedOld,
      match_status: MatchStatus.Postponed,
      superseded_by: openEffective.match_id,
      updated_at: NOW,
    });
    const otherUserDetail = await new MatchQueryService(repo, "test-match-cursor-secret").get(
      closedOld.match_id,
      USER_ID,
      NOW,
    );
    expect(otherUserDetail.can_predict).toBe(false);
    expect(otherUserDetail.can_predict_reason).toBe("NOT_SCHEDULED");
  });

  it("[Slice 3.3] list fetches page teams in one teams.findByIds batch instead of N+1 findById calls", async () => {
    const repo = await seedRepository();
    await repo.matches.insert(makeMatch(MATCH_A, new Date("2026-08-09T13:00:00.000Z")));
    await repo.matches.insert(makeMatch(MATCH_B, new Date("2026-08-09T14:00:00.000Z")));
    const teams = repo.teams;
    const findByIdSpy = vi.spyOn(teams, "findById");
    const findByIdsSpy = vi.fn(teams.findByIds!);
    teams.findByIds = findByIdsSpy;
    const repoProxy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "teams") return teams;
        return Reflect.get(target, prop, receiver);
      },
    });
    const service = new MatchQueryService(repoProxy, "test-match-cursor-secret");
    const result = await service.list({
      from: null,
      to: null,
      status: null,
      limit: 20,
      cursor: null,
      server_now: NOW,
      authenticated_user_id: null,
    });
    expect(result.items).toHaveLength(2);
    expect(findByIdsSpy).toHaveBeenCalledTimes(1);
    expect(findByIdSpy).not.toHaveBeenCalled();
  });
});
