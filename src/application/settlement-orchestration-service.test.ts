import { describe, expect, it } from "vitest";
import {
  MatchScoreValue,
  MatchStatus,
  PeriodType,
  Result,
  SettlementDocStatus,
  SettlementItemStatus,
  SettlementPhase,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type {
  Match,
  MatchResult,
  Prediction,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  User,
} from "../domain/types.js";
import { InMemoryRepository, type AppRepository, type UnitOfWork } from "../infrastructure/repositories.js";
import { SettlementOrchestrationService } from "./settlement-orchestration-service.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const ANCHOR = new Date("2026-08-08T14:00:00.000Z");
const RULE = "scoring_v1";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: "u1",
    openid: "openid_u1",
    unionid: null,
    nickname: "User",
    favorite_team_id: null,
    status: "active",
    career_points: 12,
    career_valid_predictions: 1,
    career_wdl_hits: 1,
    career_exact_hits: 1,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: "m1",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "team_home",
    away_team_id: "team_away",
    kickoff_at: ANCHOR,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(ANCHOR.getTime() - 600_000),
    prediction_closed_at: new Date(ANCHOR.getTime() - 600_000),
    period_anchor_at: ANCHOR,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Correcting,
    regular_home_score: 1,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 3,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: RULE,
    finish_detected_at: new Date(NOW.getTime() - 600_000),
    settled_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    schema_version: 1,
    prediction_id: "p1",
    user_id: "u1",
    match_id: "m1",
    idempotency_key: newUuid(),
    pred_home_score: 2,
    pred_away_score: 1,
    derived_result: Result.Home,
    submitted_at: NOW,
    scoring_rule_version: RULE,
    match_score: MatchScoreValue.ExactHit,
    wdl_hit: true,
    exact_hit: true,
    applied_result_version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: "m1",
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
    ...overrides,
  };
}

function makeSettlement(overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: "s1",
    match_id: "m1",
    result_version: 1,
    rule_version: RULE,
    status: SettlementDocStatus.Settled,
    phase: SettlementPhase.Done,
    is_correction: false,
    started_at: NOW,
    settled_at: NOW,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeItem(overrides: Partial<SettlementItem> = {}): SettlementItem {
  return {
    schema_version: 1,
    settlement_id: "s1",
    prediction_id: "p1",
    user_id: "u1",
    old_score: MatchScoreValue.Miss,
    new_score: MatchScoreValue.ExactHit,
    score_delta: 12,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: true,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: SettlementItemStatus.Applied,
    applied_at: NOW,
    attempt_count: 1,
    last_error_code: null,
    last_error_message: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function seedAppliedV1Caches(repo: InMemoryRepository, userId: string, seasonId: string) {
  await repo.userSeasonStats.insert({
    schema_version: 1,
    user_id: userId,
    season_id: seasonId,
    points: 12,
    valid_predictions: 1,
    wdl_hits: 1,
    exact_hits: 1,
    level: 1,
    best_level: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  for (const periodType of [PeriodType.Week, PeriodType.Month]) {
    await repo.rankings.insert({
      schema_version: 1,
      period_type: periodType,
      period_key: periodType === PeriodType.Week ? "2026-W32" : "2026-08",
      user_id: userId,
      period_score: 12,
      valid_predictions: 1,
      wdl_hits: 1,
      exact_hits: 1,
      last_scoring_match_at: ANCHOR,
      global_rank: null,
      is_final: false,
      created_at: NOW,
      updated_at: NOW,
    } satisfies RankingEntry);
  }
}

async function seedQueuedCorrections() {
  const repo = new InMemoryRepository();
  const user = makeUser();
  const match = makeMatch();
  const prediction = makePrediction();
  await repo.users.insert(user);
  await repo.matches.insert(match);
  await repo.predictions.insert(prediction);
  await repo.matchResults.insert(
    makeResult({
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
    }),
  );
  await repo.matchResults.insert(
    makeResult({
      result_version: 2,
      regular_home_score: 3,
      regular_away_score: 1,
    }),
  );
  await repo.matchResults.insert(
    makeResult({
      result_version: 3,
      regular_home_score: 1,
      regular_away_score: 1,
    }),
  );
  await repo.settlements.insert(makeSettlement());
  await repo.settlementItems.insert(makeItem());
  await seedAppliedV1Caches(repo, user.user_id, match.season_id);
  return { repo, user, match, prediction };
}

describe("SettlementOrchestrationService 第 15.9 节 correction 队列推进", () => {
  it("startFirst finalize 期间出现更高 result_version：settling→correcting 后自动推进 correction 队列到 settled", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Waiting,
      result_version: 1,
      settled_result_version: 0,
      settled_at: null,
    });
    await repo.matches.insert(match);
    await repo.matchResults.insert(
      makeResult({ result_version: 1, regular_home_score: 2, regular_away_score: 1 }),
    );

    const guardedRepo = Object.create(repo) as AppRepository;
    Object.defineProperty(guardedRepo, "withTransaction", {
      value: (fn: (tx: UnitOfWork) => Promise<unknown>) =>
        repo.withTransaction(async (tx) => {
          let matchReadCount = 0;
          return fn({
            users: tx.users,
            deletedOpenidMappings: tx.deletedOpenidMappings,
            matches: {
              ...tx.matches,
              findById: async (mid: string) => {
                matchReadCount += 1;
                const found = await tx.matches.findById(mid);
                if (found !== null && found.result_version === 1 && matchReadCount === 2) {
                  await tx.matchResults.insert(
                    makeResult({ result_version: 2, regular_home_score: 3, regular_away_score: 1 }),
                  );
                  await tx.matches.update({
                    ...found,
                    result_version: 2,
                    regular_home_score: 3,
                    regular_away_score: 1,
                    updated_at: NOW,
                  });
                  return {
                    ...found,
                    result_version: 2,
                    regular_home_score: 3,
                    regular_away_score: 1,
                    updated_at: NOW,
                  };
                }
                return found;
              },
            },
            predictions: tx.predictions,
            matchResults: tx.matchResults,
            settlements: tx.settlements,
            settlementItems: tx.settlementItems,
            unlocks: tx.unlocks,
          });
        }),
    });

    const service = new SettlementOrchestrationService(guardedRepo);
    const outcome = await service.startFirst(match.match_id, NOW, false);

    expect(outcome).toMatchObject({ kind: "started" });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      result_version: 2,
      settled_result_version: 2,
      settlement_status: SettlementStatus.Settled,
    });
    expect(
      await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 2, RULE),
    ).toMatchObject({ status: SettlementDocStatus.Settled, is_correction: true });
  });

  it("correct 后若仍有更高 result_version，自动顺序处理到 settled，禁止停留在中间版本", async () => {
    const { repo, match, user } = await seedQueuedCorrections();
    const service = new SettlementOrchestrationService(repo);

    const outcome = await service.correct(match.match_id, NOW);

    expect(outcome).toMatchObject({
      kind: "settled",
      target_result_version: 3,
    });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      settled_result_version: 3,
      settlement_status: SettlementStatus.Settled,
    });
    expect(
      await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 2, RULE),
    ).toMatchObject({
      status: SettlementDocStatus.Settled,
      is_correction: true,
    });
    expect(
      await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 3, RULE),
    ).toMatchObject({
      status: SettlementDocStatus.Settled,
      is_correction: true,
    });
    // v1 exact(12) -> v2 home wdl(3) -> v3 miss(0)
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_points: 0,
      career_valid_predictions: 1,
      career_wdl_hits: 0,
      career_exact_hits: 0,
    });
    expect(await repo.predictions.findById("p1")).toMatchObject({
      applied_result_version: 3,
      match_score: MatchScoreValue.Miss,
      wdl_hit: false,
      exact_hit: false,
    });
  });

  it("retry 成功后若 match 进入 correcting，继续按最小未处理版本推进 correction", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
    });
    const match = makeMatch({
      settlement_status: SettlementStatus.Failed,
      result_version: 2,
      settled_result_version: 0,
      regular_home_score: 3,
      regular_away_score: 1,
      settled_at: null,
    });
    const prediction = makePrediction({
      match_score: null,
      wdl_hit: null,
      exact_hit: null,
      applied_result_version: 0,
    });
    const failedV1 = makeSettlement({
      settlement_id: "s1",
      result_version: 1,
      status: SettlementDocStatus.Failed,
      phase: SettlementPhase.ApplyItems,
      is_correction: false,
      settled_at: null,
      attempt_count: 1,
      last_error_code: "WORKER",
      last_error_message: "boom",
    });
    await repo.users.insert(user);
    await repo.matches.insert(match);
    await repo.predictions.insert(prediction);
    await repo.matchResults.insert(
      makeResult({
        result_version: 1,
        regular_home_score: 2,
        regular_away_score: 1,
      }),
    );
    await repo.matchResults.insert(
      makeResult({
        result_version: 2,
        regular_home_score: 3,
        regular_away_score: 1,
      }),
    );
    await repo.settlements.insert(failedV1);
    await repo.settlementItems.insert(
      makeItem({
        settlement_id: failedV1.settlement_id,
        old_score: MatchScoreValue.Miss,
        new_score: MatchScoreValue.ExactHit,
        score_delta: 12,
        old_wdl_hit: false,
        new_wdl_hit: true,
        old_exact_hit: false,
        new_exact_hit: true,
        valid_prediction_delta: 1,
        source_result_version: 1,
        status: SettlementItemStatus.Pending,
        applied_at: null,
        attempt_count: 1,
        last_error_code: "WORKER",
        last_error_message: "boom",
      }),
    );

    const service = new SettlementOrchestrationService(repo);
    const outcome = await service.retry(failedV1.settlement_id, NOW);

    expect(outcome).toMatchObject({ kind: "settled" });
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      settled_result_version: 2,
      settlement_status: SettlementStatus.Settled,
    });
    expect(
      await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 1, RULE),
    ).toMatchObject({ status: SettlementDocStatus.Settled, is_correction: false });
    expect(
      await repo.settlements.findByMatchAndVersionAndRule(match.match_id, 2, RULE),
    ).toMatchObject({ status: SettlementDocStatus.Settled, is_correction: true });
    // first v1 exact 12, then v2 wdl 3 => career 3
    expect(await repo.users.findById(user.user_id)).toMatchObject({
      career_points: 3,
      career_valid_predictions: 1,
      career_wdl_hits: 1,
      career_exact_hits: 0,
    });
    expect(await repo.predictions.findById("p1")).toMatchObject({
      applied_result_version: 2,
      match_score: MatchScoreValue.WdlHit,
    });
  });
});
