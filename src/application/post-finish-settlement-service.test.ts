import { describe, expect, it, vi } from "vitest";
import {
  AnomalyStatus,
  AnomalyType,
  MatchStatus,
  SettlementStatus,
} from "../domain/enums.js";
import type { Anomaly, Match, MatchResult } from "../domain/types.js";
import { InMemoryRepository, type AppRepository } from "../infrastructure/repositories.js";
import { PostFinishSettlementService } from "./post-finish-settlement-service.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const MATCH_ID = "00000000-0000-4000-8000-000000000010";

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: "00000000-0000-4000-8000-000000000011",
    away_team_id: "00000000-0000-4000-8000-000000000012",
    kickoff_at: new Date("2026-08-08T06:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-08T05:50:00.000Z"),
    prediction_closed_at: new Date("2026-08-08T05:50:00.000Z"),
    period_anchor_at: new Date("2026-08-08T06:00:00.000Z"),
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Waiting,
    regular_home_score: 2,
    regular_away_score: 1,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 0,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: new Date(NOW.getTime() - 10 * 60 * 1000),
    settled_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeResult(): MatchResult {
  return {
    schema_version: 1,
    match_id: MATCH_ID,
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: NOW,
  };
}

function makeBlockingAnomaly(): Anomaly {
  return {
    schema_version: 1,
    anomaly_id: "00000000-0000-4000-8000-000000000020",
    anomaly_key: `${MATCH_ID}:${AnomalyType.FinishedNoScore}`,
    match_id: MATCH_ID,
    type: AnomalyType.FinishedNoScore,
    blocking: true,
    status: AnomalyStatus.Open,
    first_seen_at: NOW,
    last_seen_at: NOW,
    occurrence_count: 1,
    details: {},
    resolved_at: null,
    resolution: null,
  };
}

async function setup(matchOverrides: Partial<Match> = {}) {
  const repo = new InMemoryRepository();
  await repo.matches.insert(makeMatch(matchOverrides));
  await repo.matchResults.insert(makeResult());
  return repo;
}

describe("PostFinishSettlementService", () => {
  it("保护时间恰好到达且无 open blocking anomaly 时启动首次结算", async () => {
    const repo = await setup();

    const outcome = await new PostFinishSettlementService(repo).start(MATCH_ID, NOW);

    expect(outcome).toMatchObject({ kind: "started", settlement_created: true });
    expect(await repo.matches.findById(MATCH_ID)).toMatchObject({
      settlement_status: SettlementStatus.Settled,
      settled_result_version: 1,
    });
  });

  it("保护时间未到时不启动结算", async () => {
    const repo = await setup({
      finish_detected_at: new Date(NOW.getTime() - 10 * 60 * 1000 + 1),
    });

    await expect(new PostFinishSettlementService(repo).start(MATCH_ID, NOW)).resolves.toEqual({
      kind: "not_started",
      code: "SETTLEMENT_NOT_READY",
    });
    expect(await repo.settlements.findByStatus("pending")).toEqual([]);
  });

  it("存在 open blocking anomaly 时 Fail Closed，不创建 settlement", async () => {
    const repo = await setup();
    await repo.anomalies.insert(makeBlockingAnomaly());

    await expect(new PostFinishSettlementService(repo).start(MATCH_ID, NOW)).resolves.toEqual({
      kind: "not_started",
      code: "SETTLEMENT_NOT_READY",
    });
    expect(await repo.settlements.findByStatus("pending")).toEqual([]);
    expect((await repo.matches.findById(MATCH_ID))?.settlement_status).toBe(
      SettlementStatus.Waiting,
    );
  });

  it("无效 server_now 在读取异常前 Fail Closed", async () => {
    const repo = await setup();
    const findOpenBlockingByMatch = vi.fn(async () => []);
    const wrappedRepo = {
      anomalies: {
        ...repo.anomalies,
        findOpenBlockingByMatch,
      },
    } as unknown as AppRepository;

    await expect(
      new PostFinishSettlementService(wrappedRepo).start(MATCH_ID, new Date("invalid")),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    expect(findOpenBlockingByMatch).not.toHaveBeenCalled();
  });
});
