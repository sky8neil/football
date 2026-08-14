import { describe, expect, it } from "vitest";
import {
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  Provider,
  SettlementStatus,
} from "../domain/enums.js";
import type {
  Match,
  MatchProviderMapping,
  Prediction,
  Team,
  TeamProviderMapping,
} from "../domain/types.js";
import { newUuid } from "../domain/ids.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";
import type { NormalizedFixture } from "../provider/fixture-mapper.js";
import { ProviderStatusSyncService } from "./provider-status-sync.js";

const FIRST_NOW = new Date("2026-08-09T00:00:00.000Z");
const SECOND_NOW = new Date("2026-08-09T00:03:00.000Z");
const MATCH_ID = "00000000-0000-4000-8000-000000000010";
const PROVIDER_MATCH_ID = "1100001";
const PROVIDER_HOME_TEAM_ID = "40";
const PROVIDER_AWAY_TEAM_ID = "41";
const CHANGED_PROVIDER_HOME_TEAM_ID = "42";
const CHANGED_PROVIDER_AWAY_TEAM_ID = "43";

function makeMatch(overrides: Partial<Match> = {}): Match {
  const kickoffAt = new Date("2026-08-09T01:00:00.000Z");
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: kickoffAt,
    kickoff_confirmed: true,
    prediction_deadline_at: new Date(kickoffAt.getTime() - 10 * 60 * 1000),
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
    created_at: FIRST_NOW,
    updated_at: FIRST_NOW,
    ...overrides,
  };
}

function makeMapping(): MatchProviderMapping {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    provider: Provider.ApiFootball,
    provider_match_id: PROVIDER_MATCH_ID,
    created_at: FIRST_NOW,
    updated_at: FIRST_NOW,
  };
}

function makeTeam(teamId: string): Team {
  return {
    schema_version: 1,
    team_id: teamId,
    name: `Team ${teamId}`,
    short_name: null,
    primary_color: null,
    secondary_color: null,
    status: "active",
    created_at: FIRST_NOW,
    updated_at: FIRST_NOW,
  };
}

function makeTeamMapping(teamId: string, providerTeamId: string): TeamProviderMapping {
  return {
    schema_version: 1,
    team_id: teamId,
    provider: Provider.ApiFootball,
    provider_team_id: providerTeamId,
    created_at: FIRST_NOW,
    updated_at: FIRST_NOW,
  };
}

function makePrediction(matchId: string): Prediction {
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: newUuid(),
    match_id: matchId,
    idempotency_key: newUuid(),
    pred_home_score: 1,
    pred_away_score: 0,
    derived_result: "HOME",
    submitted_at: FIRST_NOW,
    scoring_rule_version: "scoring_v1",
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: FIRST_NOW,
    updated_at: FIRST_NOW,
  };
}

function makeFixture(overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    providerMatchId: PROVIDER_MATCH_ID,
    leagueProviderId: "39",
    season: "2026",
    round: "Round 1",
    homeTeamProviderId: PROVIDER_HOME_TEAM_ID,
    awayTeamProviderId: PROVIDER_AWAY_TEAM_ID,
    kickoffAt: new Date("2026-08-09T01:00:00.000Z"),
    kickoffConfirmed: true,
    kickoffDeltaMs: 0,
    status: { kind: "live" },
    fulltime: null,
    rawStatus: "1H",
    ...overrides,
  };
}

function makePostponedFixture(
  overrides: Partial<NormalizedFixture> = {},
): NormalizedFixture {
  return {
    ...makeFixture(),
    status: { kind: "postponed" },
    rawStatus: "PST",
    ...overrides,
  };
}

function makeCancelledFixture(): NormalizedFixture {
  return {
    ...makeFixture(),
    status: { kind: "cancelled" },
    rawStatus: "CANC",
  };
}

function makeAbandonedFixture(): NormalizedFixture {
  return {
    ...makeFixture(),
    status: { kind: "abandoned" },
    rawStatus: "ABD",
  };
}

async function setup(match = makeMatch()) {
  const repo = new InMemoryRepository();
  await repo.matches.insert(match);
  await repo.matchProviderMappings.insert(makeMapping());
  return { repo, match };
}

function withSettlementWriteGuard(
  repo: InMemoryRepository,
  writes: Array<{ kind: "update" | "updateSettlementStatus"; value: Partial<Match> }>,
): AppRepository {
  const guardedRepo = Object.create(repo) as AppRepository;
  Object.defineProperty(guardedRepo, "withTransaction", {
    value: <T>(fn: (tx: UnitOfWork) => Promise<T>) =>
      repo.withTransaction((tx) =>
        {
          const guardedTx = Object.create(tx) as UnitOfWork;
          Object.defineProperty(guardedTx, "matches", {
            value: {
              ...tx.matches,
              update: async (updated: Match) => {
                const current = await tx.matches.findById(updated.match_id);
                if (current !== null && current.settlement_status !== updated.settlement_status) {
                  throw new Error("raw settlement_status update");
                }
                writes.push({ kind: "update", value: updated });
                return tx.matches.update(updated);
              },
              updateSettlementStatus: async (
                matchId: string,
                status: Match["settlement_status"],
                updatedAt: Date,
              ) => {
                writes.push({
                  kind: "updateSettlementStatus",
                  value: { match_id: matchId, settlement_status: status, updated_at: updatedAt },
                });
                return tx.matches.updateSettlementStatus(matchId, status, updatedAt);
              },
            },
          });
          return fn(guardedTx);
        },
      ),
  });
  return guardedRepo;
}

describe("ProviderStatusSyncService", () => {
  it("无效 server_now 在 scheduled 状态同步前 Fail Closed", async () => {
    const { repo, match } = await setup();
    const invalidNow = new Date(Number.NaN);

    await expect(
      new ProviderStatusSyncService(repo).applyScheduledFixture(
        makeFixture({
          kickoffAt: new Date("2026-08-09T02:00:00.000Z"),
          status: { kind: MatchStatus.Scheduled, kickoffConfirmed: true },
          rawStatus: "NS",
        }),
        { provider: "fixture" },
        invalidNow,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toEqual(match);
  });

  it("scheduled 响应缺少 kickoff 时保持已有可信字段并返回可计数失败", async () => {
    const { repo, match } = await setup();
    const incompleteFixture = makeFixture({
      kickoffAt: null,
      kickoffConfirmed: false,
      status: { kind: MatchStatus.Scheduled, kickoffConfirmed: false },
      rawStatus: "TBD",
    });

    await expect(
      new ProviderStatusSyncService(repo).applyScheduledFixture(
        incompleteFixture,
        { fixture: { id: Number(PROVIDER_MATCH_ID), status: "TBD" } },
        FIRST_NOW,
      ),
    ).resolves.toEqual({
      kind: "failed",
      match_id: MATCH_ID,
      match_status: MatchStatus.Scheduled,
      anomaly_types: [AnomalyType.ProviderDataInvalid],
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toEqual(match);
    await expect(repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.ProviderDataInvalid}`))
      .resolves.toMatchObject({
        status: AnomalyStatus.Open,
        blocking: false,
        details: {
          provider_match_id: PROVIDER_MATCH_ID,
          provider_status: "TBD",
          field: "kickoff",
        },
      });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        event_type: "provider_error",
        payload: { fixture: { id: Number(PROVIDER_MATCH_ID), status: "TBD" } },
      }),
    ]);
  });

  it("scheduled 观察更新未开赛比赛的 kickoff、确认标记和 prediction deadline", async () => {
    const { repo, match } = await setup();
    const kickoffAt = new Date("2026-08-09T02:00:00.000Z");

    await expect(
      new ProviderStatusSyncService(repo).applyScheduledFixture(
        makeFixture({
          kickoffAt,
          kickoffConfirmed: true,
          status: { kind: "scheduled", kickoffConfirmed: true },
          rawStatus: "NS",
        }),
        { provider: "fixture" },
        FIRST_NOW,
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Scheduled,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      ...match,
      kickoff_at: kickoffAt,
      kickoff_confirmed: true,
      prediction_deadline_at: new Date("2026-08-09T01:50:00.000Z"),
      prediction_closed_at: null,
      match_status: MatchStatus.Scheduled,
      updated_at: FIRST_NOW,
    });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        event_type: "kickoff_changed",
        payload: { provider: "fixture" },
      }),
    ]);
  });

  it("延期后重新 scheduled 时保留已关闭的旧 deadline", async () => {
    const oldDeadline = new Date("2026-08-09T00:50:00.000Z");
    const { repo } = await setup(
      makeMatch({
        match_status: MatchStatus.Postponed,
        prediction_deadline_at: oldDeadline,
        prediction_closed_at: oldDeadline,
      }),
    );
    const kickoffAt = new Date("2026-08-09T03:00:00.000Z");

    await expect(
      new ProviderStatusSyncService(repo).applyScheduledFixture(
        makeFixture({
          kickoffAt,
          status: { kind: "scheduled", kickoffConfirmed: true },
          rawStatus: "NS",
        }),
        {},
        new Date("2026-08-09T02:00:00.000Z"),
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Scheduled,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      kickoff_at: kickoffAt,
      match_status: MatchStatus.Scheduled,
      prediction_deadline_at: oldDeadline,
      prediction_closed_at: oldDeadline,
    });
  });

  it("延期信息在旧 deadline 之后到达时先关闭旧 deadline 再更新 kickoff", async () => {
    const oldDeadline = new Date("2026-08-09T00:50:00.000Z");
    const { repo } = await setup(
      makeMatch({
        prediction_deadline_at: oldDeadline,
        prediction_closed_at: null,
      }),
    );
    const kickoffAt = new Date("2026-08-09T03:00:00.000Z");

    await expect(
      new ProviderStatusSyncService(repo).applyScheduledFixture(
        makeFixture({
          kickoffAt,
          status: { kind: "scheduled", kickoffConfirmed: true },
          rawStatus: "NS",
        }),
        {},
        new Date("2026-08-09T01:00:00.000Z"),
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Scheduled,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      kickoff_at: kickoffAt,
      prediction_deadline_at: oldDeadline,
      prediction_closed_at: oldDeadline,
    });
  });

  it("period anchor 已冻结后收到 kickoff 变化时保持事实并记录 blocking conflict", async () => {
    const anchor = new Date("2026-08-09T01:00:00.000Z");
    const { repo, match } = await setup(
      makeMatch({
        match_status: MatchStatus.Live,
        period_anchor_at: anchor,
        kickoff_at: anchor,
      }),
    );
    const changedKickoff = new Date("2026-08-09T02:00:00.000Z");

    await expect(
      new ProviderStatusSyncService(repo).applyLiveFixture(
        makeFixture({ kickoffAt: changedKickoff }),
        { provider: "fixture", changed_kickoff: true },
        SECOND_NOW,
      ),
    ).resolves.toEqual({
      kind: "conflict",
      match_id: MATCH_ID,
      match_status: MatchStatus.Live,
      anomaly_type: AnomalyType.KickoffChangeAfterAnchor,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toEqual(match);
    await expect(repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.KickoffChangeAfterAnchor}`))
      .resolves.toMatchObject({
        blocking: true,
        status: AnomalyStatus.Open,
        details: expect.objectContaining({
          current_match_status: MatchStatus.Live,
          provider_kickoff_at: changedKickoff.toISOString(),
        }),
      });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        event_type: "provider_conflict",
        payload: { provider: "fixture", changed_kickoff: true },
      }),
    ]);
  });

  it("scheduled 的 period anchor 冻结后 kickoff 变化也使用专用 anomaly", async () => {
    const anchor = new Date("2026-08-09T01:00:00.000Z");
    const { repo, match } = await setup(
      makeMatch({
        period_anchor_at: anchor,
        kickoff_at: anchor,
      }),
    );
    const changedKickoff = new Date("2026-08-09T02:00:00.000Z");

    await expect(
      new ProviderStatusSyncService(repo).applyScheduledFixture(
        makeFixture({
          kickoffAt: changedKickoff,
          status: { kind: MatchStatus.Scheduled, kickoffConfirmed: true },
        }),
        { provider: "fixture", changed_kickoff: true },
        SECOND_NOW,
      ),
    ).resolves.toEqual({
      kind: "conflict",
      match_id: MATCH_ID,
      match_status: MatchStatus.Scheduled,
      anomaly_type: AnomalyType.KickoffChangeAfterAnchor,
    });

    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.KickoffChangeAfterAnchor}`),
    ).resolves.toMatchObject({ blocking: true, status: AnomalyStatus.Open });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toEqual(match);
  });

  it("scheduled 且无 prediction 时允许按 Provider mapping 更新主客队", async () => {
    const { repo, match } = await setup();
    const nextHomeTeamId = newUuid();
    const nextAwayTeamId = newUuid();
    await repo.teams.insert(makeTeam(nextHomeTeamId));
    await repo.teams.insert(makeTeam(nextAwayTeamId));
    await repo.teamProviderMappings.insert(
      makeTeamMapping(nextHomeTeamId, CHANGED_PROVIDER_HOME_TEAM_ID),
    );
    await repo.teamProviderMappings.insert(
      makeTeamMapping(nextAwayTeamId, CHANGED_PROVIDER_AWAY_TEAM_ID),
    );

    await expect(
      new ProviderStatusSyncService(repo).applyTeamChange(
        makeFixture({
          homeTeamProviderId: CHANGED_PROVIDER_HOME_TEAM_ID,
          awayTeamProviderId: CHANGED_PROVIDER_AWAY_TEAM_ID,
          status: { kind: "scheduled", kickoffConfirmed: true },
          rawStatus: "NS",
        }),
        { provider: "fixture" },
        FIRST_NOW,
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      home_team_id: nextHomeTeamId,
      away_team_id: nextAwayTeamId,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      ...match,
      home_team_id: nextHomeTeamId,
      away_team_id: nextAwayTeamId,
      updated_at: FIRST_NOW,
    });
  });

  it("存在 prediction 时拒绝覆盖主客队并记录 blocking anomaly 与冲突快照", async () => {
    const { repo, match } = await setup();
    const nextHomeTeamId = newUuid();
    const nextAwayTeamId = newUuid();
    await repo.teams.insert(makeTeam(nextHomeTeamId));
    await repo.teams.insert(makeTeam(nextAwayTeamId));
    await repo.teamProviderMappings.insert(
      makeTeamMapping(nextHomeTeamId, CHANGED_PROVIDER_HOME_TEAM_ID),
    );
    await repo.teamProviderMappings.insert(
      makeTeamMapping(nextAwayTeamId, CHANGED_PROVIDER_AWAY_TEAM_ID),
    );
    await repo.predictions.insert(makePrediction(MATCH_ID));

    await expect(
      new ProviderStatusSyncService(repo).applyTeamChange(
        makeFixture({
          homeTeamProviderId: CHANGED_PROVIDER_HOME_TEAM_ID,
          awayTeamProviderId: CHANGED_PROVIDER_AWAY_TEAM_ID,
        }),
        { provider: "fixture", changed: true },
        FIRST_NOW,
      ),
    ).resolves.toEqual({
      kind: "conflict",
      match_id: MATCH_ID,
      match_status: MatchStatus.Scheduled,
      anomaly_type: AnomalyType.TeamChangeAfterPrediction,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toEqual(match);
    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.TeamChangeAfterPrediction}`),
    ).resolves.toMatchObject({
      blocking: true,
      status: AnomalyStatus.Open,
      details: {
        provider_home_team_id: CHANGED_PROVIDER_HOME_TEAM_ID,
        provider_away_team_id: CHANGED_PROVIDER_AWAY_TEAM_ID,
        current_home_team_id: match.home_team_id,
        current_away_team_id: match.away_team_id,
      },
    });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        event_type: "provider_conflict",
        payload: { provider: "fixture", changed: true },
      }),
    ]);
  });

  it("已开赛时即使没有 prediction 也拒绝覆盖主客队", async () => {
    const { repo } = await setup(makeMatch({ match_status: MatchStatus.Live }));
    const nextHomeTeamId = newUuid();
    const nextAwayTeamId = newUuid();
    await repo.teams.insert(makeTeam(nextHomeTeamId));
    await repo.teams.insert(makeTeam(nextAwayTeamId));
    await repo.teamProviderMappings.insert(
      makeTeamMapping(nextHomeTeamId, CHANGED_PROVIDER_HOME_TEAM_ID),
    );
    await repo.teamProviderMappings.insert(
      makeTeamMapping(nextAwayTeamId, CHANGED_PROVIDER_AWAY_TEAM_ID),
    );

    await expect(
      new ProviderStatusSyncService(repo).applyTeamChange(
        makeFixture({
          homeTeamProviderId: CHANGED_PROVIDER_HOME_TEAM_ID,
          awayTeamProviderId: CHANGED_PROVIDER_AWAY_TEAM_ID,
        }),
        {},
        FIRST_NOW,
      ),
    ).resolves.toMatchObject({
      kind: "conflict",
      anomaly_type: AnomalyType.TeamChangeAfterPrediction,
    });
  });

  it("截止前 scheduled -> postponed 时保留未关闭状态和原 deadline", async () => {
    const { repo, match } = await setup();
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyPostponedFixture(makePostponedFixture(), { provider: "fixture" }, FIRST_NOW),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Postponed,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      ...match,
      match_status: MatchStatus.Postponed,
      prediction_deadline_at: match.prediction_deadline_at,
      prediction_closed_at: null,
      period_anchor_at: null,
      updated_at: FIRST_NOW,
    });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        event_type: "status_changed",
        payload: { provider: "fixture" },
      }),
    ]);
  });

  it("延期时 anchor 未冻结且仍未关闭，可更新 kickoff 与新的 prediction deadline", async () => {
    const { repo } = await setup();
    const postponedKickoff = new Date("2026-08-09T03:00:00.000Z");

    await expect(
      new ProviderStatusSyncService(repo).applyPostponedFixture(
        makePostponedFixture({ kickoffAt: postponedKickoff }),
        { provider: "fixture", postponed: true },
        FIRST_NOW,
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Postponed,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      kickoff_at: postponedKickoff,
      kickoff_confirmed: true,
      prediction_deadline_at: new Date("2026-08-09T02:50:00.000Z"),
      prediction_closed_at: null,
      period_anchor_at: null,
      match_status: MatchStatus.Postponed,
    });
  });

  it("49.4 已 postponed 未关闭时，重复 postponed 观察不得因旧 deadline 自动写 closed_at", async () => {
    const oldDeadline = new Date("2026-08-09T00:50:00.000Z");
    const { repo } = await setup(
      makeMatch({
        match_status: MatchStatus.Postponed,
        prediction_deadline_at: oldDeadline,
        prediction_closed_at: null,
      }),
    );
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyPostponedFixture(
        makePostponedFixture(),
        { repeated: true },
        new Date("2026-08-09T01:05:00.000Z"),
      ),
    ).resolves.toEqual({
      kind: "unchanged",
      match_id: MATCH_ID,
      match_status: MatchStatus.Postponed,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Postponed,
      prediction_deadline_at: oldDeadline,
      prediction_closed_at: null,
    });
  });

  it("截止后 scheduled -> postponed 时先永久关闭旧 deadline，重复观察保持幂等", async () => {
    const { repo, match } = await setup();
    const service = new ProviderStatusSyncService(repo);
    const afterDeadline = new Date("2026-08-09T00:55:00.000Z");

    await expect(
      service.applyPostponedFixture(makePostponedFixture(), {}, afterDeadline),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Postponed,
    });
    await expect(
      service.applyPostponedFixture(
        makePostponedFixture(),
        { repeated: true },
        new Date("2026-08-09T01:05:00.000Z"),
      ),
    ).resolves.toEqual({
      kind: "unchanged",
      match_id: MATCH_ID,
      match_status: MatchStatus.Postponed,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Postponed,
      prediction_deadline_at: match.prediction_deadline_at,
      prediction_closed_at: match.prediction_deadline_at,
      updated_at: afterDeadline,
    });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toHaveLength(1);
  });

  it("scheduled -> live 时冻结首次周期锚点并永久关闭预测", async () => {
    const { repo, match } = await setup();
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyLiveFixture(makeFixture(), { provider: "fixture" }, FIRST_NOW),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Live,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      ...match,
      match_status: MatchStatus.Live,
      period_anchor_at: match.kickoff_at,
      prediction_closed_at: FIRST_NOW,
      updated_at: FIRST_NOW,
    });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        entity_id: MATCH_ID,
        provider_entity_id: PROVIDER_MATCH_ID,
        event_type: "status_changed",
        payload: { provider: "fixture" },
      }),
    ]);
  });

  it("首次 live 观察时在 anchor 冻结前采用 Provider kickoff", async () => {
    const { repo, match } = await setup();
    const providerKickoff = new Date("2026-08-09T01:30:00.000Z");

    await expect(
      new ProviderStatusSyncService(repo).applyLiveFixture(
        makeFixture({ kickoffAt: providerKickoff }),
        { provider: "fixture", kickoff_changed: true },
        FIRST_NOW,
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Live,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      kickoff_at: providerKickoff,
      prediction_deadline_at: new Date("2026-08-09T01:20:00.000Z"),
      period_anchor_at: providerKickoff,
      match_status: MatchStatus.Live,
      prediction_closed_at: FIRST_NOW,
    });
  });

  it("重复 live 是幂等 update，不创建第二个状态快照", async () => {
    const { repo } = await setup();
    const service = new ProviderStatusSyncService(repo);
    const fixture = makeFixture();

    await service.applyLiveFixture(fixture, {}, FIRST_NOW);
    await expect(service.applyLiveFixture(fixture, {}, SECOND_NOW)).resolves.toEqual({
      kind: "unchanged",
      match_id: MATCH_ID,
      match_status: MatchStatus.Live,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Live,
      period_anchor_at: new Date("2026-08-09T01:00:00.000Z"),
      prediction_closed_at: FIRST_NOW,
      updated_at: FIRST_NOW,
    });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toHaveLength(1);
  });

  it("scheduled -> cancelled 时作废结算且重复观察幂等", async () => {
    const { repo, match } = await setup();
    const service = new ProviderStatusSyncService(repo);
    const fixture = makeCancelledFixture();

    await expect(
      service.applyCancelledFixture(fixture, { provider: "fixture" }, FIRST_NOW),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Cancelled,
    });
    await expect(
      service.applyCancelledFixture(fixture, { repeated: true }, SECOND_NOW),
    ).resolves.toEqual({
      kind: "unchanged",
      match_id: MATCH_ID,
      match_status: MatchStatus.Cancelled,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      ...match,
      match_status: MatchStatus.Cancelled,
      settlement_status: SettlementStatus.Voided,
      updated_at: FIRST_NOW,
    });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        event_type: "status_changed",
        payload: { provider: "fixture" },
      }),
    ]);
  });

  it("scheduled -> cancelled 的 settlement_status 变化必须经过既有 transition repository 入口", async () => {
    const { repo } = await setup();
    const writes: Array<{
      kind: "update" | "updateSettlementStatus";
      value: Partial<Match>;
    }> = [];

    await expect(
      new ProviderStatusSyncService(withSettlementWriteGuard(repo, writes)).applyCancelledFixture(
        makeCancelledFixture(),
        { provider: "fixture" },
        FIRST_NOW,
      ),
    ).resolves.toMatchObject({ kind: "applied", match_status: MatchStatus.Cancelled });

    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "updateSettlementStatus",
          value: expect.objectContaining({
            settlement_status: SettlementStatus.Voided,
          }),
        }),
      ]),
    );
  });

  it("settling 结算中的比赛收到 cancelled 时进入 voided（49.15 例外边）", async () => {
    const { repo } = await setup(
      makeMatch({
        match_status: MatchStatus.Postponed,
        settlement_status: SettlementStatus.Settling,
        prediction_closed_at: FIRST_NOW,
        period_anchor_at: new Date("2026-08-09T01:00:00.000Z"),
      }),
    );
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyCancelledFixture(
        makeCancelledFixture(),
        { provider: "fixture", settlement: "settling" },
        SECOND_NOW,
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Cancelled,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Cancelled,
      settlement_status: SettlementStatus.Voided,
    });
    await expect(
      repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.ProviderStateConflict}`),
    ).resolves.toBeNull();
  });

  it("failed 结算失败重试中的比赛收到 cancelled 时进入 voided（49.15 例外边）", async () => {
    const { repo } = await setup(
      makeMatch({
        match_status: MatchStatus.Scheduled,
        settlement_status: SettlementStatus.Failed,
        prediction_closed_at: FIRST_NOW,
        period_anchor_at: new Date("2026-08-09T01:00:00.000Z"),
      }),
    );
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyCancelledFixture(
        makeCancelledFixture(),
        { provider: "fixture", settlement: "failed" },
        SECOND_NOW,
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Cancelled,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      match_status: MatchStatus.Cancelled,
      settlement_status: SettlementStatus.Voided,
    });
  });

  it("correcting 已结算修正中的比赛收到 cancelled 时保留现状并记录 blocking anomaly", async () => {
    const correcting = makeMatch({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Correcting,
      settled_result_version: 1,
      result_version: 1,
      regular_home_score: 2,
      regular_away_score: 1,
      result_source: "provider",
      prediction_closed_at: FIRST_NOW,
      period_anchor_at: new Date("2026-08-09T01:00:00.000Z"),
      finish_detected_at: FIRST_NOW,
      settled_at: FIRST_NOW,
    });
    const { repo } = await setup(correcting);
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyCancelledFixture(
        makeCancelledFixture(),
        { status: "CANC", settlement: "correcting" },
        SECOND_NOW,
      ),
    ).resolves.toEqual({
      kind: "conflict",
      match_id: MATCH_ID,
      match_status: MatchStatus.Finished,
      anomaly_type: AnomalyType.ProviderStateConflict,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toEqual(correcting);
    await expect(repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.ProviderStateConflict}`))
      .resolves.toMatchObject({
        blocking: true,
        status: AnomalyStatus.Open,
      });
  });

  it("scheduled -> abandoned 时保留 pending 结算，不写正式结果", async () => {
    const { repo, match } = await setup();
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyAbandonedFixture(
        makeAbandonedFixture(),
        { provider: "fixture" },
        FIRST_NOW,
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Abandoned,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      ...match,
      match_status: MatchStatus.Abandoned,
      settlement_status: SettlementStatus.Pending,
      result_version: 0,
      regular_home_score: null,
      regular_away_score: null,
      prediction_closed_at: null,
    });
    await expect(repo.matchResults.findLatestByMatch(MATCH_ID)).resolves.toBeNull();
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        event_type: "status_changed",
        payload: { provider: "fixture" },
      }),
    ]);
  });

  it("已 settled 比赛收到 cancelled 时保留历史结算并记录 blocking anomaly", async () => {
    const settled = makeMatch({
      match_status: MatchStatus.Finished,
      settlement_status: SettlementStatus.Settled,
      settled_result_version: 1,
      result_version: 1,
      prediction_closed_at: FIRST_NOW,
      period_anchor_at: FIRST_NOW,
    });
    const { repo } = await setup(settled);
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyCancelledFixture(makeCancelledFixture(), { status: "CANC" }, SECOND_NOW),
    ).resolves.toEqual({
      kind: "conflict",
      match_id: MATCH_ID,
      match_status: MatchStatus.Finished,
      anomaly_type: AnomalyType.ProviderStateConflict,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toEqual(settled);
    await expect(repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.ProviderStateConflict}`))
      .resolves.toMatchObject({
        blocking: true,
        status: AnomalyStatus.Open,
      });
  });

  it("C23/5.3 Provider 后续 round 冲突时保留原 round_id 并记录 anomaly", async () => {
    const { repo, match } = await setup();
    const service = new ProviderStatusSyncService(repo);

    await expect(
      service.applyScheduledFixture(
        makeFixture({
          round: "Regular Season - 12",
          kickoffAt: new Date("2026-08-09T02:00:00.000Z"),
          kickoffConfirmed: true,
          status: { kind: MatchStatus.Scheduled, kickoffConfirmed: true },
          rawStatus: "NS",
        }),
        { provider: "fixture", note: "round-conflict" },
        FIRST_NOW,
      ),
    ).resolves.toEqual({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Scheduled,
    });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      round_id: "01",
      kickoff_at: new Date("2026-08-09T02:00:00.000Z"),
      prediction_deadline_at: new Date("2026-08-09T01:50:00.000Z"),
      match_status: MatchStatus.Scheduled,
    });
    await expect(repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.ProviderDataInvalid}`))
      .resolves.toMatchObject({
        status: AnomalyStatus.Open,
        blocking: false,
        details: expect.objectContaining({
          field: "round_id",
          current_round_id: "01",
          provider_round_id: "12",
          provider_round: "Regular Season - 12",
        }),
      });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "provider_conflict",
          payload: { provider: "fixture", note: "round-conflict" },
        }),
      ]),
    );
    // 延期路径同样不得改 round_id
    await expect(
      service.applyPostponedFixture(
        makePostponedFixture({
          round: "Regular Season - 12",
          kickoffAt: new Date("2026-08-16T03:00:00.000Z"),
        }),
        { provider: "fixture", note: "round-conflict-postponed" },
        SECOND_NOW,
      ),
    ).resolves.toMatchObject({
      kind: "applied",
      match_id: MATCH_ID,
      match_status: MatchStatus.Postponed,
    });
    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject({
      round_id: match.round_id,
      match_status: MatchStatus.Postponed,
      kickoff_at: new Date("2026-08-16T03:00:00.000Z"),
    });
  });

  it("finished -> live 不回退状态，并保存 blocking anomaly 与冲突快照", async () => {
    const finished = makeMatch({
      match_status: MatchStatus.Finished,
      prediction_closed_at: FIRST_NOW,
      period_anchor_at: new Date("2026-08-09T01:00:00.000Z"),
      settlement_status: SettlementStatus.Waiting,
    });
    const { repo } = await setup(finished);
    const service = new ProviderStatusSyncService(repo);

    await expect(service.applyLiveFixture(makeFixture(), { status: "1H" }, SECOND_NOW))
      .resolves.toEqual({
        kind: "conflict",
        match_id: MATCH_ID,
        match_status: MatchStatus.Finished,
        anomaly_type: AnomalyType.ProviderStateConflict,
      });

    await expect(repo.matches.findById(MATCH_ID)).resolves.toMatchObject(finished);
    await expect(repo.anomalies.findByKey(`${MATCH_ID}:${AnomalyType.ProviderStateConflict}`))
      .resolves.toMatchObject({
        status: AnomalyStatus.Open,
        blocking: true,
        details: {
          provider_match_id: PROVIDER_MATCH_ID,
          provider_status: "1H",
          current_match_status: MatchStatus.Finished,
        },
      });
    await expect(repo.providerSnapshots.findByEntity("match", MATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        event_type: "provider_conflict",
        payload: { status: "1H" },
      }),
    ]);
  });
});
