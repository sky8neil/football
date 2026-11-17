import { describe, expect, it, vi } from "vitest";
import { LeagueSeasonMaintenanceService } from "./league-season-maintenance.js";
import { ProviderTeamSyncService } from "./provider-team-sync.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { MatchStatus, SettlementStatus, SyncJobType } from "../domain/enums.js";
import type { Match } from "../domain/types.js";

const now = new Date("2026-05-01T00:00:00Z");
const later = new Date(now.getTime() + 60_000);
const makeMatch = (id: string, home: string, away: string, status: Match["match_status"] = MatchStatus.Finished): Match => ({
  schema_version: 1, match_id: id, canonical_match_id: id, superseded_by: null,
  league_id: "chinese_super_league", season_id: "2026", round_id: id, home_team_id: home, away_team_id: away,
  kickoff_at: now, kickoff_confirmed: true, prediction_deadline_at: now, prediction_closed_at: null, period_anchor_at: null,
  match_status: status, settlement_status: SettlementStatus.Pending, regular_home_score: null, regular_away_score: null,
  extra_home_score: null, extra_away_score: null, penalty_home_score: null, penalty_away_score: null,
  result_version: 0, settled_result_version: 0, result_source: null, scoring_rule_version: "scoring_v1",
  finish_detected_at: null, settled_at: null, created_at: now, updated_at: now,
});

const teamIds = Array.from({ length: 16 }, (_, index) => `team${index}`);

async function seedRoster(repo: InMemoryRepository) {
  await repo.seasonTeams.upsertMany(teamIds.map((teamId) => ({
    schema_version: 1, league_id: "chinese_super_league", season_id: "2026", team_id: teamId,
    source: "manual" as const, provider: null, provider_team_id: null, created_at: now, updated_at: now,
  })));
}

async function seedMatches(repo: InMemoryRepository, ids: string[], omit?: (home: string, away: string) => boolean) {
  for (const home of ids) {
    for (const away of ids) {
      if (home !== away && !omit?.(home, away)) await repo.matches.insert(makeMatch(`${home}-${away}`, home, away));
    }
  }
}

describe("league season maintenance", () => {
  it("does nothing on an empty database and requires the repositories", async () => {
    const repo = new InMemoryRepository();
    expect(await new LeagueSeasonMaintenanceService(repo).run(now)).toEqual({ seasons_checked: 6, completed: 0, reopened: 0 });
    await expect(new LeagueSeasonMaintenanceService({ ...repo, matches: repo.matches } as never).run(now)).rejects.toThrow("league season repositories unavailable");
  });
  it("leaves an empty roster uninitialized and logs the number of effective matches without writing teams", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeMatch("1", "a", "b", MatchStatus.Scheduled));
    const findMatches = repo.matches.findBySeason.bind(repo.matches);
    vi.spyOn(repo.matches, "findBySeason").mockImplementation(async (seasonId) => [
      ...await findMatches(seasonId),
      ...(seasonId === "2026" ? [{ ...makeMatch("old", "c", "d"), superseded_by: "1" }] : []),
    ]);
    const writeTeams = vi.spyOn(repo.seasonTeams, "upsertMany");
    const log = vi.fn();
    const service = new LeagueSeasonMaintenanceService(repo, log);
    expect(await service.run(now)).toEqual({ seasons_checked: 6, completed: 0, reopened: 0 });
    const season = await repo.leagueSeasons.findByKey("chinese_super_league", "2026");
    expect(season).toMatchObject({ format: { team_count: 16, round_count: 30 }, schedule_status: "uninitialized", completion_status: "open", ended_at: null, updated_at: now });
    expect(writeTeams).not.toHaveBeenCalled();
    expect(await repo.seasonTeams.findByLeagueSeason("chinese_super_league", "2026")).toEqual([]);
    expect(log.mock.calls.filter(([event]) => event.event === "league_season_roster_missing" && event.league_id === "chinese_super_league")).toEqual([
      [{ event: "league_season_roster_missing", league_id: "chinese_super_league", season_id: "2026", matches: 1 }],
    ]);
    expect(await service.run(later)).toEqual({ seasons_checked: 6, completed: 0, reopened: 0 });
    expect((await repo.leagueSeasons.findByKey("chinese_super_league", "2026"))?.updated_at).toEqual(now);
  });
  it("locks and completes a complete roster with all matches finished", async () => {
    const repo = new InMemoryRepository();
    await seedRoster(repo);
    await seedMatches(repo, teamIds);
    const writeTeams = vi.spyOn(repo.seasonTeams, "upsertMany");
    expect((await new LeagueSeasonMaintenanceService(repo).run(now)).completed).toBe(1);
    expect(await repo.leagueSeasons.findByKey("chinese_super_league", "2026")).toMatchObject({ schedule_status: "locked", completion_status: "completed", completion_confirmed_at: now });
    expect(writeTeams).not.toHaveBeenCalled();
  });
  it("keeps a complete roster partial and open when a fixture is missing", async () => {
    const repo = new InMemoryRepository();
    await seedRoster(repo);
    await seedMatches(repo, teamIds, (home, away) => home === "team0" && away === "team1");
    await new LeagueSeasonMaintenanceService(repo).run(now);
    expect(await repo.leagueSeasons.findByKey("chinese_super_league", "2026")).toMatchObject({ schedule_status: "partial", completion_status: "open" });
  });
  it("keeps a roster partial when one team has no matches all season", async () => {
    const repo = new InMemoryRepository();
    await seedRoster(repo);
    await seedMatches(repo, [...teamIds.slice(0, 15), "outside-roster"]);
    const writeTeams = vi.spyOn(repo.seasonTeams, "upsertMany");
    await new LeagueSeasonMaintenanceService(repo).run(now);
    expect(await repo.leagueSeasons.findByKey("chinese_super_league", "2026")).toMatchObject({ schedule_status: "partial", completion_status: "open" });
    expect(writeTeams).not.toHaveBeenCalled();
    expect(await repo.seasonTeams.findByLeagueSeason("chinese_super_league", "2026")).toHaveLength(16);
  });
  it("locks using the target season roster written by team sync", async () => {
    const repo = new InMemoryRepository();
    const getTeams = vi.fn(async () => teamIds.map((teamId, index) => ({ team: { id: index + 1, name: teamId } })));
    await new ProviderTeamSyncService(repo, { getTeams }).sync(now, SyncJobType.FutureSchedule, ["chinese_super_league"], { chinese_super_league: "2026" });
    const roster = await repo.seasonTeams.findByLeagueSeason("chinese_super_league", "2026");
    expect(roster).toHaveLength(16);
    expect(roster.every((team) => team.source === "map_teams" && team.season_id === "2026")).toBe(true);
    await seedMatches(repo, roster.map((team) => team.team_id));
    const writeTeams = vi.spyOn(repo.seasonTeams, "upsertMany");
    await new LeagueSeasonMaintenanceService(repo).run(now);
    expect(await repo.leagueSeasons.findByKey("chinese_super_league", "2026")).toMatchObject({ schedule_status: "locked", completion_status: "completed", completion_confirmed_at: now });
    expect(writeTeams).not.toHaveBeenCalled();
  });
  it("reopens a completed season for an additional match and completes it again", async () => {
    const repo = new InMemoryRepository();
    await seedRoster(repo);
    for (let home = 0; home < 16; home++) {
      for (let away = 0; away < 16; away++) {
        if (home !== away) await repo.matches.insert(makeMatch(`${home}-${away}`, `team${home}`, `team${away}`));
      }
    }
    const log = vi.fn();
    const service = new LeagueSeasonMaintenanceService(repo, log);
    expect((await service.run(now)).completed).toBe(1);
    const extra = makeMatch("extra", "team0", "team1", MatchStatus.Postponed);
    await repo.matches.insert(extra);
    expect((await service.run(later)).reopened).toBe(1);
    expect(await repo.leagueSeasons.findByKey("chinese_super_league", "2026")).toMatchObject({ completion_status: "open", completion_confirmed_at: now, reopened_at: later, reopen_count: 1, ended_at: null });
    await repo.matches.update({ ...extra, match_status: MatchStatus.Finished });
    expect((await service.run(new Date(later.getTime() + 60_000))).completed).toBe(1);
    expect(await repo.leagueSeasons.findByKey("chinese_super_league", "2026")).toMatchObject({ completion_status: "completed", completion_confirmed_at: now, reopened_at: later, reopen_count: 1, ended_at: null });
    expect(log.mock.calls.filter(([event]) => event.event === "league_season_transition").map(([event]) => [event.from, event.to])).toEqual([["open", "completed"], ["completed", "open"], ["open", "completed"]]);
  });
  it("honors manual confirmation without reopening or changing the actual end date", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeMatch("1", "a", "b", MatchStatus.Scheduled));
    const service = new LeagueSeasonMaintenanceService(repo);
    await service.run(now);
    const previous = (await repo.leagueSeasons.findByKey("chinese_super_league", "2026"))!;
    await repo.leagueSeasons.update({ ...previous, ended_at: now, manual_override: { confirmed_by: "admin", confirmed_at: now, evidence: "official" } });
    expect((await service.run(later)).completed).toBe(1);
    expect(await repo.leagueSeasons.findByKey("chinese_super_league", "2026")).toMatchObject({ completion_status: "completed", completion_confirmed_at: now, ended_at: now, reopen_count: 0, reopened_at: null });
    expect((await service.run(new Date(later.getTime() + 60_000))).reopened).toBe(0);
  });
});
