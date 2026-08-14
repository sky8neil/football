import { describe, expect, it } from "vitest";
import {
  AdminResultCorrectionService,
  type AdminResultCorrectionInput,
} from "./admin-result-correction.js";
import {
  AdminRole,
  AdminStatus,
  MatchStatus,
  ResultSource,
  SettlementStatus,
} from "../domain/enums.js";
import type { Admin, Match, MatchResult } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import type { AppRepository, UnitOfWork } from "../infrastructure/repositories.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    schema_version: 1,
    admin_id: "00000000-0000-4000-8000-000000000001",
    openid: "admin-openid",
    status: AdminStatus.Active,
    role: AdminRole.Admin,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: "00000000-0000-4000-8000-000000000010",
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "00000000-0000-4000-8000-000000000011",
    away_team_id: "00000000-0000-4000-8000-000000000012",
    kickoff_at: new Date("2026-08-08T06:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: null,
    prediction_closed_at: NOW,
    period_anchor_at: NOW,
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: ResultSource.Provider,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: NOW,
    settled_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: "00000000-0000-4000-8000-000000000010",
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: ResultSource.Provider,
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
    ...overrides,
  };
}

function correction(overrides: Partial<AdminResultCorrectionInput> = {}): AdminResultCorrectionInput {
  return {
    expected_result_version: 1,
    regular_home_score: 1,
    regular_away_score: 1,
    reason: "Provider 正式比分更正",
    ...overrides,
  };
}

async function seedSettledMatch(
  repo: InMemoryRepository,
  matchOverrides: Partial<Match> = {},
): Promise<Match> {
  const match = makeMatch(matchOverrides);
  await repo.admins.insert(makeAdmin());
  await repo.matches.insert(match);
  await repo.matchResults.insert(makeResult({ match_id: match.match_id }));
  return match;
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

describe("AdminResultCorrectionService", () => {
  it("active admin 可修正赛果，并追加 immutable result、排队 correcting 和审计", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);
    const writes: Array<{
      kind: "update" | "updateSettlementStatus";
      value: Partial<Match>;
    }> = [];

    const outcome = await new AdminResultCorrectionService(withSettlementWriteGuard(repo, writes)).correct(
      "admin-openid",
      match.match_id,
      correction(),
      NOW,
    );

    expect(outcome).toMatchObject({
      admin_id: "00000000-0000-4000-8000-000000000001",
      result: {
        match_id: match.match_id,
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        source: ResultSource.Admin,
        admin_id: "00000000-0000-4000-8000-000000000001",
        reason: "Provider 正式比分更正",
      },
      match: {
        result_version: 2,
        regular_home_score: 1,
        regular_away_score: 1,
        result_source: ResultSource.Admin,
        settlement_status: SettlementStatus.Correcting,
      },
      audit_log: {
        admin_id: "00000000-0000-4000-8000-000000000001",
        action: "result_correction",
        entity_type: "match",
        entity_id: match.match_id,
        reason: "Provider 正式比分更正",
      },
    });

    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 1)).toMatchObject({
      regular_home_score: 2,
      regular_away_score: 1,
      source: ResultSource.Provider,
    });
    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 2)).toBe(
      outcome.result,
    );
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([
      outcome.audit_log,
    ]);
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "updateSettlementStatus",
          value: expect.objectContaining({
            settlement_status: SettlementStatus.Correcting,
          }),
        }),
      ]),
    );
  });

  it("v0 finished match 可由管理员写入首次正式结果并保持 waiting", async () => {
    const freshRepo = new InMemoryRepository();
    const freshMatch = makeMatch({
      result_version: 0,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Waiting,
      regular_home_score: null,
      regular_away_score: null,
      result_source: null,
    });
    await freshRepo.admins.insert(makeAdmin());
    await freshRepo.matches.insert(freshMatch);

    const outcome = await new AdminResultCorrectionService(freshRepo).correct(
      "admin-openid",
      freshMatch.match_id,
      correction({
        expected_result_version: 0,
        regular_home_score: 0,
        regular_away_score: 2,
      }),
      NOW,
    );

    expect(outcome.match).toMatchObject({
      result_version: 1,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Waiting,
    });
  });

  it("settling + settled_result_version=0：admin 修正比分成功，settlement_status 保持 settling", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo, {
      settlement_status: SettlementStatus.Settling,
      settled_result_version: 0,
      settled_at: null,
    });

    const outcome = await new AdminResultCorrectionService(repo).correct(
      "admin-openid",
      match.match_id,
      correction({ expected_result_version: 1, regular_home_score: 3, regular_away_score: 0 }),
      NOW,
    );

    expect(outcome.match).toMatchObject({
      result_version: 2,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Settling,
      regular_home_score: 3,
      regular_away_score: 0,
      result_source: ResultSource.Admin,
    });
    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 2)).toMatchObject({
      result_version: 2,
      regular_home_score: 3,
      regular_away_score: 0,
      source: ResultSource.Admin,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toHaveLength(1);
  });

  it("failed + settled_result_version=0：admin 修正比分成功，settlement_status 保持 failed", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo, {
      settlement_status: SettlementStatus.Failed,
      settled_result_version: 0,
      settled_at: null,
    });

    const outcome = await new AdminResultCorrectionService(repo).correct(
      "admin-openid",
      match.match_id,
      correction({ expected_result_version: 1, regular_home_score: 0, regular_away_score: 2 }),
      NOW,
    );

    expect(outcome.match).toMatchObject({
      result_version: 2,
      settled_result_version: 0,
      settlement_status: SettlementStatus.Failed,
      regular_home_score: 0,
      regular_away_score: 2,
    });
    expect(await repo.matchResults.findByMatchAndVersion(match.match_id, 2)).toMatchObject({
      result_version: 2,
      regular_home_score: 0,
      regular_away_score: 2,
    });
  });

  it("voided 状态：admin 修正被拒绝（MATCH_STATE_CONFLICT），不写结果与审计", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo, {
      settlement_status: SettlementStatus.Voided,
      settled_result_version: 0,
      settled_at: null,
    });

    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        match.match_id,
        correction(),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "MATCH_STATE_CONFLICT" });
    expect(await repo.matchResults.findLatestByMatch(match.match_id)).toMatchObject({
      result_version: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([]);
  });

  it("缺少可信身份、未知 admin 或 disabled admin 均拒绝", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);
    const service = new AdminResultCorrectionService(repo);

    await expect(service.correct(null, match.match_id, correction(), NOW)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(
      service.correct("unknown-openid", match.match_id, correction(), NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const disabledRepo = new InMemoryRepository();
    const disabledMatch = makeMatch();
    await disabledRepo.admins.insert(makeAdmin({ status: AdminStatus.Disabled }));
    await disabledRepo.matches.insert(disabledMatch);
    await disabledRepo.matchResults.insert(makeResult({ match_id: disabledMatch.match_id }));
    await expect(
      new AdminResultCorrectionService(disabledRepo).correct(
        "admin-openid",
        disabledMatch.match_id,
        correction(),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("expected_result_version 不匹配时 fail closed 且不写结果、比赛或审计", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);

    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        match.match_id,
        correction({ expected_result_version: 0 }),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "RESULT_VERSION_CONFLICT" });

    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(await repo.matchResults.findLatestByMatch(match.match_id)).toMatchObject({
      result_version: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([]);
  });

  it("无效 server_now 时 fail closed 且不写结果、比赛或审计", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);
    const invalidNow = new Date("invalid");

    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        match.match_id,
        correction(),
        invalidNow,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(await repo.matches.findById(match.match_id)).toEqual(match);
    expect(await repo.matchResults.findLatestByMatch(match.match_id)).toMatchObject({
      result_version: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([]);
  });

  it("新比分相同拒绝且保留旧版本", async () => {
    const repo = new InMemoryRepository();
    const match = await seedSettledMatch(repo);

    await expect(
      new AdminResultCorrectionService(repo).correct(
        "admin-openid",
        match.match_id,
        correction({ regular_home_score: 2, regular_away_score: 1 }),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "RESULT_UNCHANGED" });
    expect(await repo.matchResults.findLatestByMatch(match.match_id)).toMatchObject({
      result_version: 1,
    });
    expect(await repo.adminAuditLogs.findByEntity("match", match.match_id)).toEqual([]);
  });
});
