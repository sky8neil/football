import { describe, expect, it, vi } from "vitest";
import { LeagueSeasonMaintenanceService } from "./league-season-maintenance.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { MatchStatus, SettlementStatus } from "../domain/enums.js";
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

describe("league season maintenance", () => {
  it("does nothing on an empty database and requires the repositories", async () => {
    const repo = new InMemoryRepository();
    expect(await new LeagueSeasonMaintenanceService(repo).run(now)).toEqual({ seasons_checked: 6, completed: 0, reopened: 0, teams_written: 0 });
    await expect(new LeagueSeasonMaintenanceService({ ...repo, matches: repo.matches } as never).run(now)).rejects.toThrow("league season repositories unavailable");
  });
  it("creates the season, persists teams and leaves unchanged status timestamps on later ticks", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(makeMatch("1", "a", "b", MatchStatus.Scheduled));
    const service = new LeagueSeasonMaintenanceService(repo);
    expect(await service.run(now)).toEqual({ seasons_checked: 6, completed: 0, reopened: 0, teams_written: 2 });
    const season = await repo.leagueSeasons.findByKey("chinese_super_league", "2026");
    expect(season).toMatchObject({ format: { team_count: 16, round_count: 30 }, schedule_status: "partial", completion_status: "open", ended_at: null, updated_at: now });
    expect(await service.run(later)).toEqual({ seasons_checked: 6, completed: 0, reopened: 0, teams_written: 0 });
    expect((await repo.leagueSeasons.findByKey("chinese_super_league", "2026"))?.updated_at).toEqual(now);
    expect(await repo.seasonTeams.findByLeagueSeason("chinese_super_league", "2026")).toEqual(expect.arrayContaining([
      expect.objectContaining({ team_id: "a", source: "schedule", provider: null, provider_team_id: null, created_at: now, updated_at: now }),
    ]));
  });
  it("reopens a completed season for an additional match and completes it again", async () => {
    const repo = new InMemoryRepository();
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
    expect(log.mock.calls.map(([event]) => [event.from, event.to])).toEqual([["open", "completed"], ["completed", "open"], ["open", "completed"]]);
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
