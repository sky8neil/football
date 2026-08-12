/**
 * 第 44 节 C. 延期验收矩阵（C17-C22）。
 * C23 已在 provider-status-sync 覆盖。
 */
import { describe, expect, it } from "vitest";
import {
  MatchStatus,
  PeriodType,
  Provider,
  SettlementStatus,
} from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import { calculatePeriodKey } from "../domain/time.js";
import type { Match, MatchProviderMapping, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { NormalizedFixture } from "../provider/fixture-mapper.js";
import { canSubmitPrediction } from "../domain/prediction-policy.js";
import { PredictionService } from "./predictions.js";
import { ProviderResultSyncService } from "./provider-result-sync.js";
import { ProviderStatusSyncService } from "./provider-status-sync.js";

const MATCH_ID = "00000000-0000-4000-8000-0000000000c1";
const PROVIDER_MATCH_ID = "44000017";
const ORIGINAL_KICKOFF = new Date("2026-08-10T12:00:00.000Z"); // 2026-W33 / 2026-08
const ORIGINAL_DEADLINE = new Date(ORIGINAL_KICKOFF.getTime() - 10 * 60 * 1000);
const BEFORE_DEADLINE = new Date(ORIGINAL_DEADLINE.getTime() - 60_000);
const AFTER_DEADLINE = new Date(ORIGINAL_DEADLINE.getTime() + 60_000);
const CROSS_WEEK_KICKOFF = new Date("2026-08-17T12:00:00.000Z"); // 2026-W34
const CROSS_MONTH_KICKOFF = new Date("2026-09-01T12:00:00.000Z"); // 2026-09

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: newUuid(),
    openid: `openid_${newUuid()}`,
    unionid: null,
    nickname: "Ace",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: BEFORE_DEADLINE,
    updated_at: BEFORE_DEADLINE,
    ...overrides,
  } as User;
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: ORIGINAL_KICKOFF,
    kickoff_confirmed: true,
    prediction_deadline_at: ORIGINAL_DEADLINE,
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: MatchStatus.Scheduled,
    settlement_status: SettlementStatus.Pending,
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
    created_at: BEFORE_DEADLINE,
    updated_at: BEFORE_DEADLINE,
    ...overrides,
  };
}

function makeMapping(): MatchProviderMapping {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    provider: Provider.ApiFootball,
    provider_match_id: PROVIDER_MATCH_ID,
    created_at: BEFORE_DEADLINE,
    updated_at: BEFORE_DEADLINE,
  };
}

function makeFixture(overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    providerMatchId: PROVIDER_MATCH_ID,
    leagueProviderId: "39",
    season: "2026",
    round: "Round 1",
    homeTeamProviderId: "40",
    awayTeamProviderId: "41",
    kickoffAt: ORIGINAL_KICKOFF,
    kickoffConfirmed: true,
    kickoffDeltaMs: 0,
    status: { kind: "postponed" },
    fulltime: null,
    rawStatus: "PST",
    ...overrides,
  };
}

async function setup(match = makeMatch()) {
  const repo = new InMemoryRepository();
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert(makeMapping());
  return { repo, match, status: new ProviderStatusSyncService(repo), result: new ProviderResultSyncService(repo) };
}

describe("C. 延期（规范 44-C）", () => {
  it("C17 截止前延期，未提交用户在重新 scheduled 后可预测", async () => {
    const { repo, status } = await setup();
    const user = makeUser();
    await repo.users.insert(user);
    const predictions = new PredictionService(repo);

    await status.applyPostponedFixture(
      makeFixture({ kickoffAt: CROSS_WEEK_KICKOFF, kickoffConfirmed: true }),
      { case: "C17-postponed" },
      BEFORE_DEADLINE,
    );
    let match = await repo.matches.findById(MATCH_ID);
    expect(match).toMatchObject({
      match_status: MatchStatus.Postponed,
      prediction_closed_at: null,
      period_anchor_at: null,
    });
    expect(canSubmitPrediction(user, match!, null, BEFORE_DEADLINE)).toBe(false);

    await status.applyScheduledFixture(
      makeFixture({
        status: { kind: MatchStatus.Scheduled, kickoffConfirmed: true },
        rawStatus: "NS",
        kickoffAt: CROSS_WEEK_KICKOFF,
        kickoffConfirmed: true,
      }),
      { case: "C17-rescheduled" },
      BEFORE_DEADLINE,
    );
    match = await repo.matches.findById(MATCH_ID);
    expect(match).toMatchObject({
      match_status: MatchStatus.Scheduled,
      kickoff_at: CROSS_WEEK_KICKOFF,
      prediction_closed_at: null,
      period_anchor_at: null,
    });
    expect(match!.prediction_deadline_at?.getTime()).toBe(
      CROSS_WEEK_KICKOFF.getTime() - 10 * 60 * 1000,
    );
    expect(canSubmitPrediction(user, match!, null, BEFORE_DEADLINE)).toBe(true);

    const submitted = await predictions.submit(
      user.user_id,
      {
        idempotency_key: newUuid(),
        match_id: MATCH_ID,
        home_score: 2,
        away_score: 1,
      },
      BEFORE_DEADLINE,
    );
    expect(submitted.created).toBe(true);
  });

  it("C18 截止前延期，已有用户预测保留且不可改", async () => {
    const { repo, status } = await setup();
    const user = makeUser();
    await repo.users.insert(user);
    const predictions = new PredictionService(repo);
    const key = newUuid();
    const first = await predictions.submit(
      user.user_id,
      {
        idempotency_key: key,
        match_id: MATCH_ID,
        home_score: 1,
        away_score: 0,
      },
      BEFORE_DEADLINE,
    );

    await status.applyPostponedFixture(
      makeFixture({ kickoffAt: CROSS_WEEK_KICKOFF }),
      { case: "C18" },
      BEFORE_DEADLINE,
    );
    await status.applyScheduledFixture(
      makeFixture({
        status: { kind: MatchStatus.Scheduled, kickoffConfirmed: true },
        rawStatus: "NS",
        kickoffAt: CROSS_WEEK_KICKOFF,
      }),
      { case: "C18-reschedule" },
      BEFORE_DEADLINE,
    );

    const stored = await repo.predictions.findById(first.prediction.prediction_id);
    expect(stored).toMatchObject({
      prediction_id: first.prediction.prediction_id,
      pred_home_score: 1,
      pred_away_score: 0,
    });

    await expect(
      predictions.submit(
        user.user_id,
        {
          idempotency_key: newUuid(),
          match_id: MATCH_ID,
          home_score: 3,
          away_score: 3,
        },
        BEFORE_DEADLINE,
      ),
    ).rejects.toMatchObject({ code: "PREDICTION_ALREADY_SUBMITTED" });

    const replay = await predictions.submit(
      user.user_id,
      {
        idempotency_key: key,
        match_id: MATCH_ID,
        home_score: 1,
        away_score: 0,
      },
      BEFORE_DEADLINE,
    );
    expect(replay.created).toBe(false);
    expect(replay.prediction.pred_home_score).toBe(1);
  });

  it("C19 截止后才发现延期，先按旧 deadline 永久关闭", async () => {
    const { repo, status } = await setup();

    await status.applyPostponedFixture(
      makeFixture({ kickoffAt: CROSS_WEEK_KICKOFF }),
      { case: "C19" },
      AFTER_DEADLINE,
    );

    const match = await repo.matches.findById(MATCH_ID);
    expect(match).toMatchObject({
      match_status: MatchStatus.Postponed,
      prediction_closed_at: ORIGINAL_DEADLINE,
      prediction_deadline_at: ORIGINAL_DEADLINE,
      period_anchor_at: null,
    });
  });

  it("C20 截止后延期到未来一个月也不得重新开放", async () => {
    const { repo, status } = await setup();
    const user = makeUser();
    await repo.users.insert(user);

    await status.applyPostponedFixture(
      makeFixture({ kickoffAt: CROSS_MONTH_KICKOFF }),
      { case: "C20-postponed" },
      AFTER_DEADLINE,
    );
    await status.applyScheduledFixture(
      makeFixture({
        status: { kind: MatchStatus.Scheduled, kickoffConfirmed: true },
        rawStatus: "NS",
        kickoffAt: CROSS_MONTH_KICKOFF,
      }),
      { case: "C20-reschedule" },
      AFTER_DEADLINE,
    );

    const match = await repo.matches.findById(MATCH_ID);
    expect(match).toMatchObject({
      match_status: MatchStatus.Scheduled,
      kickoff_at: CROSS_MONTH_KICKOFF,
      prediction_closed_at: ORIGINAL_DEADLINE,
      prediction_deadline_at: ORIGINAL_DEADLINE,
    });
    expect(canSubmitPrediction(user, match!, null, AFTER_DEADLINE)).toBe(false);
    expect(
      canSubmitPrediction(
        user,
        match!,
        null,
        new Date(CROSS_MONTH_KICKOFF.getTime() - 30 * 60 * 1000),
      ),
    ).toBe(false);
  });

  it("C21 延期跨周，未开赛 anchor 为空，最终归延期后新周", async () => {
    const { repo, status, result } = await setup();

    expect(calculatePeriodKey(PeriodType.Week, ORIGINAL_KICKOFF)).toBe("2026-W33");
    expect(calculatePeriodKey(PeriodType.Week, CROSS_WEEK_KICKOFF)).toBe("2026-W34");

    await status.applyPostponedFixture(
      makeFixture({ kickoffAt: CROSS_WEEK_KICKOFF }),
      { case: "C21-postponed" },
      BEFORE_DEADLINE,
    );
    let match = await repo.matches.findById(MATCH_ID);
    expect(match?.period_anchor_at).toBeNull();

    await status.applyScheduledFixture(
      makeFixture({
        status: { kind: MatchStatus.Scheduled, kickoffConfirmed: true },
        rawStatus: "NS",
        kickoffAt: CROSS_WEEK_KICKOFF,
      }),
      { case: "C21-reschedule" },
      BEFORE_DEADLINE,
    );
    match = await repo.matches.findById(MATCH_ID);
    expect(match?.period_anchor_at).toBeNull();
    expect(match?.kickoff_at).toEqual(CROSS_WEEK_KICKOFF);

    await result.applyFinishedFixture(
      {
        providerMatchId: PROVIDER_MATCH_ID,
        status: { kind: "finished" },
        fulltime: { home: 2, away: 1 },
        rawStatus: "FT",
      },
      { case: "C21-finished" },
      new Date(CROSS_WEEK_KICKOFF.getTime() + 2 * 60 * 60 * 1000),
    );

    match = await repo.matches.findById(MATCH_ID);
    expect(match?.period_anchor_at).toEqual(CROSS_WEEK_KICKOFF);
    expect(calculatePeriodKey(PeriodType.Week, match!.period_anchor_at!)).toBe("2026-W34");
  });

  it("C22 延期跨月，最终归延期后新月", async () => {
    const { repo, status, result } = await setup();

    expect(calculatePeriodKey(PeriodType.Month, ORIGINAL_KICKOFF)).toBe("2026-08");
    expect(calculatePeriodKey(PeriodType.Month, CROSS_MONTH_KICKOFF)).toBe("2026-09");

    await status.applyPostponedFixture(
      makeFixture({ kickoffAt: CROSS_MONTH_KICKOFF }),
      { case: "C22-postponed" },
      BEFORE_DEADLINE,
    );
    await status.applyScheduledFixture(
      makeFixture({
        status: { kind: MatchStatus.Scheduled, kickoffConfirmed: true },
        rawStatus: "NS",
        kickoffAt: CROSS_MONTH_KICKOFF,
      }),
      { case: "C22-reschedule" },
      BEFORE_DEADLINE,
    );

    let match = await repo.matches.findById(MATCH_ID);
    expect(match?.period_anchor_at).toBeNull();
    expect(match?.kickoff_at).toEqual(CROSS_MONTH_KICKOFF);

    await result.applyFinishedFixture(
      {
        providerMatchId: PROVIDER_MATCH_ID,
        status: { kind: "finished" },
        fulltime: { home: 0, away: 0 },
        rawStatus: "FT",
      },
      { case: "C22-finished" },
      new Date(CROSS_MONTH_KICKOFF.getTime() + 2 * 60 * 60 * 1000),
    );

    match = await repo.matches.findById(MATCH_ID);
    expect(match?.period_anchor_at).toEqual(CROSS_MONTH_KICKOFF);
    expect(calculatePeriodKey(PeriodType.Month, match!.period_anchor_at!)).toBe("2026-09");
  });
});
