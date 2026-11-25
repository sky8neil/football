import { describe, expect, it, vi } from "vitest";
import { activeLeagueSeason, SUPPORTED_LEAGUES } from "../domain/config.js";
import { MatchStatus, SettlementStatus, SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { ProviderReconcileService } from "./provider-reconcile.js";
import { ProviderBudgetDeniedError } from "../provider/budget.js";
import type { ApiFootballFixture } from "../provider/types.js";

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

function fixture(id: string, match: Match, provider: ApiFootballFixture["provider"] = "openfoot"): ApiFootballFixture {
  return {
    provider,
    fixture: { id, date: match.kickoff_at.toISOString(), timestamp: match.kickoff_at.getTime() / 1000, status: { short: "FT" } },
    league: { id: "comp_premier_league_eng", season: "2026" },
    teams: { home: { id: "home" }, away: { id: "away" } },
    score: { fulltime: { home: 1, away: 0 } },
  };
}

async function mapFixture(repo: InMemoryRepository, match: Match, id: string) {
  await repo.matchProviderMappings.insert({ schema_version: 1, match_id: match.match_id, provider: "openfoot", provider_match_id: id, created_at: NOW, updated_at: NOW });
}

describe("ProviderReconcileService", () => {
  it("continues historical pending work after budget exhaustion and never repeats completed work", async () => {
    const repo = new InMemoryRepository();
    const older = makeMatch("older", { kickoff_at: new Date("2026-08-07T10:00:00Z") });
    const newer = makeMatch("newer");
    await repo.matches.insert(older);
    await repo.matches.insert(newer);
    await mapFixture(repo, older, "older-external");
    await mapFixture(repo, newer, "newer-external");
    await repo.providerReconcileTodos.upsert({ todo_id: "old-todo", match_id: older.match_id, canonical_match_id: older.match_id, league_id: older.league_id, season_id: older.season_id, source_id: "of", target_result_version: 1, kickoff_at: older.kickoff_at, status: "pending", attempts: 0, last_error_code: null, last_attempt_at: null, completed_at: null, created_at: NOW, updated_at: NOW, schema_version: 1 });
    const getFixturesFromSource = vi.fn()
      .mockResolvedValueOnce([fixture("older-external", older)])
      .mockRejectedValueOnce(new ProviderBudgetDeniedError("day_limit"))
      .mockResolvedValueOnce([fixture("newer-external", newer)]);
    const service = new ProviderReconcileService(repo, { getFixturesFromSource });
    await service.run(NOW);
    expect((await repo.providerReconcileTodos.findPending(10)).map((todo) => todo.match_id)).toEqual(["newer"]);
    await service.run(new Date("2026-08-10T12:00:00Z"));
    expect(await repo.providerReconcileTodos.findPending(10)).toEqual([]);
    await service.run(new Date("2026-08-10T13:00:00Z"));
    expect(getFixturesFromSource).toHaveBeenCalledTimes(3);
  });

  it.each(["missing", "unmapped", "primary"])("keeps %s observations pending and increments attempts across runs", async (kind) => {
    const repo = new InMemoryRepository();
    const match = makeMatch("match");
    await repo.matches.insert(match);
    const fixtures = kind === "missing" ? [] : [fixture("unmapped", match, kind === "primary" ? "football_data" : "openfoot")];
    if (kind === "primary") {
      fixtures[0]!.league = { id: "PL", season: "2026", round: "1" };
      await repo.matchProviderMappings.insert({ schema_version: 1, match_id: match.match_id, provider: "football_data", provider_match_id: "unmapped", created_at: NOW, updated_at: NOW });
    }
    const service = new ProviderReconcileService(repo, { getFixturesFromSource: vi.fn(async () => fixtures) });
    await service.run(NOW);
    await service.run(NOW);
    const todos = await repo.providerReconcileTodos.findPending(10);
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ attempts: 2, status: "pending", last_error_code: expect.any(String) });
  });

  it("does not skip a fresh observation after existing two-source agreement", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch("match", { compared_providers: ["football_data", "openfoot"] });
    await repo.matches.insert(match);
    await mapFixture(repo, match, "external");
    const getFixturesFromSource = vi.fn(async () => [fixture("external", match)]);
    const service = new ProviderReconcileService(repo, { getFixturesFromSource });
    await service.run(NOW);
    await service.run(NOW);
    expect(getFixturesFromSource).toHaveBeenCalledTimes(1);
    expect(await repo.providerReconcileTodos.findPending(10)).toEqual([]);
  });

  it("generates work for yesterday even when the competitive season differs from the calendar season", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch("postponed", { season_id: "2025_2026" });
    await repo.matches.insert(match);
    const getFixturesFromSource = vi.fn(async () => []);
    await new ProviderReconcileService(repo, { getFixturesFromSource }).run(NOW);
    expect((await repo.providerReconcileTodos.findPending(10))[0]).toMatchObject({ match_id: "postponed", season_id: "2025_2026", attempts: 1 });
    expect(getFixturesFromSource).toHaveBeenCalledWith("of", expect.objectContaining({ season: "2025" }));
  });

  it("generates work from the finish day so late-recovered matches enter reconcile", async () => {
    const repo = new InMemoryRepository();
    const late = makeMatch("late-recovered", {
      kickoff_at: new Date("2026-08-01T10:00:00.000Z"),
      finish_detected_at: new Date("2026-08-08T20:00:00.000Z"),
    });
    const stale = makeMatch("stale-old", {
      kickoff_at: new Date("2026-08-04T10:00:00.000Z"),
      finish_detected_at: new Date("2026-08-04T12:00:00.000Z"),
    });
    await repo.matches.insert(late);
    await repo.matches.insert(stale);
    await new ProviderReconcileService(repo, { getFixturesFromSource: vi.fn(async () => []) }).run(NOW);
    expect((await repo.providerReconcileTodos.findPending(10)).map((todo) => todo.match_id)).toEqual(["late-recovered"]);
  });

  it("maps an old season using the todo season even if kickoff is years later", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch("old-season", { season_id: "2023_2024" });
    await repo.matches.insert(match);
    for (const team of ["home", "away"]) await repo.teamProviderMappings.insert({ schema_version: 1, team_id: team, provider: "openfoot", provider_team_id: team, created_at: NOW, updated_at: NOW });
    const observed = fixture("old-fixture", match);
    observed.league.season = "2023/24";
    const getFixturesFromSource = vi.fn(async () => [observed]);
    await new ProviderReconcileService(repo, { getFixturesFromSource }).run(NOW);
    expect(getFixturesFromSource).toHaveBeenCalledWith("of", expect.objectContaining({ season: "2023", seasonId: "2023_2024" }));
    expect(await repo.providerReconcileTodos.findPending(10)).toEqual([]);
    expect(await repo.matchProviderMappings.findByProviderAndExternalId("openfoot", "old-fixture")).toMatchObject({ match_id: "old-season" });
  });

  it("completes only observed matches in a shared response and retains conflicts", async () => {
    const repo = new InMemoryRepository();
    const first = makeMatch("first");
    const second = makeMatch("second");
    await repo.matches.insert(first);
    await repo.matches.insert(second);
    await mapFixture(repo, first, "first-external");
    const observed = fixture("first-external", first);
    observed.score = { fulltime: { home: 2, away: 0 } };
    const outcome = await new ProviderReconcileService(repo, { getFixturesFromSource: vi.fn(async () => [observed]) }).run(NOW);
    expect(outcome).toMatchObject({ items_read: 1, conflicts: 1 });
    expect((await repo.providerReconcileTodos.findPending(10)).map((todo) => todo.match_id)).toEqual(["second"]);
    expect(await repo.providerSnapshots.findByEntity("match", first.match_id)).toEqual(expect.arrayContaining([expect.objectContaining({ event_type: "provider_conflict" })]));
    expect((await repo.providerReconcileTodos.findPending(10))[0]).toMatchObject({ attempts: 1, last_error_code: expect.any(String) });
  });

  it("records request failures and keeps Chinese Super League work on sportapi", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeMatch("china", { league_id: "chinese_super_league", season_id: "2026" }));
    const getFixturesFromSource = vi.fn(async () => { throw new Error("offline"); });
    await new ProviderReconcileService(repo, { getFixturesFromSource }).run(NOW);
    expect(getFixturesFromSource).toHaveBeenCalledWith("sp", expect.objectContaining({ jobType: SyncJobType.ProviderReconcile }));
    expect(await repo.providerReconcileTodos.findPending(10)).toEqual([expect.objectContaining({ match_id: "china", source_id: "sp", attempts: 1, last_error_code: "PROVIDER_REQUEST_FAILED" })]);
  });
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

  it("回溯最近 3 天未建档已完赛场次、解析旧 M_old 副源映射，并按期续租分布式锁 (A-S3-04, A-S3-10)", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const repo = new InMemoryRepository();
      // 3 天前（2026-08-06）应入账，4 天前（2026-08-05）超过 3 天窗口不入账
      const threeDaysAgo = makeMatch("three-days-ago", {
        kickoff_at: new Date("2026-08-06T10:00:00.000Z"),
        finish_detected_at: new Date("2026-08-06T12:00:00.000Z"),
      });
      const fourDaysAgo = makeMatch("four-days-ago", {
        kickoff_at: new Date("2026-08-05T10:00:00.000Z"),
        finish_detected_at: new Date("2026-08-05T12:00:00.000Z"),
      });
      await repo.matches.insert(threeDaysAgo);
      await repo.matches.insert(fourDaysAgo);

      // M_old 被 M_new 取代，openfoot 映射仍指 M_old -> reconcile 应解析到 M_new 完成对账
      const oldMatch = makeMatch("old-for-reconcile", {
        kickoff_at: new Date("2026-08-08T10:00:00.000Z"),
        finish_detected_at: new Date("2026-08-08T12:00:00.000Z"),
      });
      const newMatch = makeMatch("new-for-reconcile", {
        kickoff_at: new Date("2026-08-08T10:00:00.000Z"),
        finish_detected_at: new Date("2026-08-08T12:00:00.000Z"),
      });
      await repo.matches.insert(newMatch);
      await repo.matches.insert(oldMatch);
      await repo.matches.update({ ...oldMatch, canonical_match_id: newMatch.match_id, superseded_by: newMatch.match_id });
      await mapFixture(repo, oldMatch, "of-mapped-to-old");

      const jobLocks = repo.jobLocks;
      const renewSpy = vi.spyOn(jobLocks, "renew");
      Object.defineProperty(repo, "jobLocks", { get: () => jobLocks });
      const getFixturesFromSource = vi.fn(async (_source: string, query: { dateFrom?: string }) => {
        if (query.dateFrom === "2026-08-08") {
          await vi.advanceTimersByTimeAsync(5 * 60_000);
          return [fixture("of-mapped-to-old", newMatch)];
        }
        return [];
      });
      const outcome = await new ProviderReconcileService(repo, { getFixturesFromSource }).run(NOW);
      expect(outcome).toMatchObject({ kind: "completed", items_read: 1, conflicts: 0 });
      expect(renewSpy).toHaveBeenCalled();
      expect((await repo.providerReconcileTodos.findPending(10)).map((todo) => todo.match_id))
        .toEqual(["three-days-ago"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
