import { describe, expect, it, vi } from "vitest";
import { activeLeagueSeason, SUPPORTED_LEAGUES } from "../domain/config.js";
import { MatchStatus, SettlementStatus, SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProviderReconcileService } from "./provider-reconcile.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function makeMatch(matchId: string, overrides: Partial<Match> = {}): Match {
  const match: Match = {
    schema_version: 1,
    match_id: matchId,
    canonical_match_id: matchId,
    superseded_by: null,
    league_id: "premier_league",
    season_id: activeLeagueSeason(SUPPORTED_LEAGUES[0]!, NOW).season_id,
    round_id: "01",
    home_team_id: "home",
    away_team_id: "away",
    kickoff_at: new Date("2026-08-08T10:00:00.000Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-08T09:50:00.000Z"),
    prediction_closed_at: new Date("2026-08-08T09:50:00.000Z"),
    period_anchor_at: new Date("2026-08-08T10:00:00.000Z"),
    match_status: MatchStatus.Finished,
    settlement_status: SettlementStatus.Settled,
    regular_home_score: 1,
    regular_away_score: 0,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 1,
    settled_result_version: 1,
    result_source: "provider",
    scoring_rule_version: "scoring_v1",
    finish_detected_at: new Date("2026-08-08T12:00:00.000Z"),
    settled_at: new Date("2026-08-08T12:10:00.000Z"),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  return match;
}

describe("ProviderReconcileService", () => {
  it("charges fixture requests to provider_reconcile", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeMatch("match"));
    const getFixturesFromSource = vi.fn(async () => []);
    const service = new ProviderReconcileService(repo, { getFixturesFromSource });

    await service.run(NOW);

    expect(getFixturesFromSource).toHaveBeenCalledWith("of", expect.objectContaining({ jobType: SyncJobType.ProviderReconcile }));
  });

  it("does not query a superseded match as a reconcile candidate", async () => {
    const repo = new InMemoryRepository();
    const old = makeMatch("old-match");
    const current = makeMatch("current-match", {
      kickoff_at: new Date("2026-08-10T10:00:00.000Z"),
      prediction_deadline_at: new Date("2026-08-10T09:50:00.000Z"),
      prediction_closed_at: null,
      period_anchor_at: null,
      match_status: MatchStatus.Scheduled,
      settlement_status: SettlementStatus.Pending,
      regular_home_score: null,
      regular_away_score: null,
      result_version: 0,
      settled_result_version: 0,
      result_source: null,
      finish_detected_at: null,
      settled_at: null,
    });
    await repo.matches.insert(old);
    await repo.matches.insert(current);
    await repo.matches.update({ ...old, canonical_match_id: current.match_id });
    await repo.matches.update({
      ...old,
      canonical_match_id: current.match_id,
      superseded_by: current.match_id,
    });

    const getFixturesFromSource = vi.fn(async () => []);
    const service = new ProviderReconcileService(repo, { getFixturesFromSource });

    await service.run(NOW);

    expect(getFixturesFromSource).not.toHaveBeenCalled();
  });
});
