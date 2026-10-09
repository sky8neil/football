import { describe, expect, it, vi } from "vitest";
import { CrowdQueryService } from "./crowd-query.js";
import { MatchStatus, UserStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, Prediction, User } from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { InMemoryRepository, type AppRepository } from "../infrastructure/repositories.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function makeUser(status: User["status"] = UserStatus.Active): User {
  return {
    schema_version: 1,
    user_id: newUuid(),
    openid: `openid_${newUuid()}`,
    unionid: null,
    nickname: "Tester",
    favorite_team_id: null,
    status,
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_last_scoring_match_at: null,
    career_level: 1,
    career_best_level: 1,
    career_level_state: defaultLevelState(),
    deleted_at: status === UserStatus.Deleted ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: newUuid(),
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: new Date("2026-08-09T12:10:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(NOW.getTime() - 1),
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
  } as Match;
}

function makePrediction(matchId: string, derivedResult: Prediction["derived_result"]): Prediction {
  const [pred_home_score, pred_away_score] =
    derivedResult === "HOME" ? [1, 0] : derivedResult === "DRAW" ? [1, 1] : [0, 1];
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: newUuid(),
    match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score,
    pred_away_score,
    derived_result: derivedResult,
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

function trackedRepo(repo: InMemoryRepository) {
  const count = vi.fn((matchId: string) =>
    repo.predictions.countByMatchGroupedByResult(matchId),
  );
  return {
    count,
    appRepo: {
      matches: repo.matches,
      users: repo.users,
      predictions: {
        ...repo.predictions,
        countByMatchGroupedByResult: count,
      },
    } as unknown as AppRepository,
  };
}

describe("CrowdQueryService", () => {
  it("returns only rounded percentages and constants for an available match", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    const user = makeUser();
    await repo.matches.insert(match);
    await repo.users.insert(user);
    for (const result of [
      ...Array.from({ length: 9 }, () => "HOME" as const),
      ...Array.from({ length: 5 }, () => "DRAW" as const),
      ...Array.from({ length: 6 }, () => "AWAY" as const),
    ]) {
      await repo.predictions.insert(makePrediction(match.match_id, result));
    }
    const service = new CrowdQueryService(repo);

    const result = await service.get({
      authenticated_user_id: user.user_id,
      match_id: match.match_id,
      server_now: NOW,
    });

    expect(result).toEqual({
      match_id: match.match_id,
      status: "available",
      distribution: { home: 45, draw: 25, away: 30 },
      granularity: 5,
      min_predictions: 20,
    });
    expect(JSON.stringify(result)).not.toMatch(/prediction_count|user_id|my_choice/);
  });

  it("does not read predictions before close or for unavailable matches", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser();
    await repo.users.insert(user);
    const { appRepo, count } = trackedRepo(repo);
    const service = new CrowdQueryService(appRepo);

    const openMatch = makeMatch({
      prediction_deadline_at: new Date(NOW.getTime() + 1),
    });
    await repo.matches.insert(openMatch);
    await expect(service.get({
      authenticated_user_id: user.user_id,
      match_id: openMatch.match_id,
      server_now: NOW,
    })).resolves.toMatchObject({ status: "not_closed", distribution: null });

    const postponedMatch = makeMatch({ match_status: MatchStatus.Postponed });
    await repo.matches.insert(postponedMatch);
    await expect(service.get({
      authenticated_user_id: user.user_id,
      match_id: postponedMatch.match_id,
      server_now: NOW,
    })).resolves.toMatchObject({ status: "unavailable", distribution: null });

    expect(count).not.toHaveBeenCalled();
  });

  it("returns insufficient without revealing the prediction count", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch();
    const user = makeUser();
    await repo.matches.insert(match);
    await repo.users.insert(user);
    await repo.predictions.insert(makePrediction(match.match_id, "HOME"));

    const result = await new CrowdQueryService(repo).get({
      authenticated_user_id: user.user_id,
      match_id: match.match_id,
      server_now: NOW,
    });

    expect(result).toEqual({
      match_id: match.match_id,
      status: "insufficient",
      distribution: null,
      granularity: 5,
      min_predictions: 20,
    });
  });

  it("requires an active requester and returns not-found for an unknown match", async () => {
    const repo = new InMemoryRepository();
    const activeUser = makeUser();
    const deletedUser = makeUser(UserStatus.Deleted);
    await repo.users.insert(activeUser);
    await repo.users.insert(deletedUser);
    const service = new CrowdQueryService(repo);

    await expect(service.get({
      authenticated_user_id: null,
      match_id: newUuid(),
      server_now: NOW,
    })).rejects.toMatchObject({ code: "MATCH_NOT_FOUND" });
    const match = makeMatch();
    await repo.matches.insert(match);
    await expect(service.get({
      authenticated_user_id: null,
      match_id: match.match_id,
      server_now: NOW,
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(service.get({
      authenticated_user_id: deletedUser.user_id,
      match_id: match.match_id,
      server_now: NOW,
    })).rejects.toMatchObject({ code: "USER_DELETED" });
  });
});
