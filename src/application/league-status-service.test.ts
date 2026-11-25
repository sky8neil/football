import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LEAGUES } from "../domain/config.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { LeagueStatusService } from "./league-status-service.js";
import { match, now, season } from "./league-summary-fixtures.test-helper.js";

describe("LeagueStatusService", () => {
  it("returns six leagues in configured order and an empty break", async () => {
    const result = await new LeagueStatusService(new InMemoryRepository()).list(now);
    expect(result.map((item) => item.league_id)).toEqual(SUPPORTED_LEAGUES.map((league) => league.league_id));
    expect(result[0]).toMatchObject({ phase: "break", active_season_id: null, next_matchday: null });
  });
  it("selects live matches and ignores superseded records", async () => {
    const repo = new InMemoryRepository();
    await repo.leagueSeasons.insert(season("2025_2026"));
    await repo.matches.insert(match("live", { match_status: "live", kickoff_at: new Date("2026-04-30T12:00:00Z") }));
    expect((await new LeagueStatusService(repo).list(now))[0]).toMatchObject({ phase: "in_season", has_live_match: true });
    await repo.matches.insert(match("replacement", { canonical_match_id: "live", match_status: "finished" }));
    await repo.matches.update(match("live", { match_status: "live", superseded_by: "replacement" }));
    expect((await new LeagueStatusService(repo).list(now))[0]).toMatchObject({ phase: "break", has_live_match: false });
  });
  it("includes a scheduled match exactly 14 days away", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(match("boundary", { match_status: "scheduled", kickoff_at: new Date(now.getTime() + 14 * 86_400_000) }));
    expect((await new LeagueStatusService(repo).list(now))[0]).toMatchObject({ phase: "in_season" });
  });
  it("uses a temporary open season and converts UTC kickoff to Beijing date", async () => {
    const repo = new InMemoryRepository();
    await repo.matches.insert(match("future", { season_id: "2030_2031", match_status: "scheduled", kickoff_at: new Date("2026-05-01T22:30:00Z") }));
    expect((await new LeagueStatusService(repo).list(now))[0]).toMatchObject({
      phase: "in_season", active_season_id: "2030_2031", next_kickoff_at: "2026-05-01T22:30:00.000Z",
      next_matchday: { date: "2026-05-02", kickoff_at: "2026-05-01T22:30:00.000Z" },
    });
    expect(await repo.leagueSeasons.findByLeague("premier_league")).toEqual([]);
  });
  it("distinguishes a break from completed and between seasons", async () => {
    const repo = new InMemoryRepository();
    await repo.leagueSeasons.insert(season("2025_2026"));
    await repo.matches.insert(match("late", { match_status: "scheduled", kickoff_at: new Date("2026-06-01T12:00:00Z") }));
    const service = new LeagueStatusService(repo, { cacheTtlMs: 0 });
    expect((await service.list(now))[0]).toMatchObject({ phase: "break", next_kickoff_at: "2026-06-01T12:00:00.000Z" });
    await repo.matches.update(match("late"));
    await repo.leagueSeasons.update(season("2025_2026", "completed"));
    expect((await service.list(now))[0]).toMatchObject({ phase: "completed" });
    await repo.matches.insert(match("next", { season_id: "2026_2027", match_status: "scheduled", kickoff_at: new Date("2026-08-01T12:00:00Z") }));
    expect((await service.list(now))[0]).toMatchObject({ phase: "between_seasons", active_season_id: "2025_2026", next_season_kickoff_at: "2026-08-01T12:00:00.000Z" });
  });

  it("[A-S7-08] avoids unbounded findByLeague scans and only loads bounded recent seasons via findByLeagueSeason", async () => {
    const repo = new InMemoryRepository();
    for (const sId of ["2021_2022", "2022_2023", "2023_2024", "2024_2025", "2025_2026"]) {
      await repo.leagueSeasons.insert(season(sId, "completed"));
      await repo.matches.insert(match(`m-${sId}`, { season_id: sId }));
    }
    const matchesPort = repo.matches;
    const findByLeagueSpy = vi.spyOn(matchesPort, "findByLeague");
    const findByLeagueSeasonSpy = vi.spyOn(matchesPort, "findByLeagueSeason");
    vi.spyOn(repo, "matches", "get").mockReturnValue(matchesPort);

    const result = await new LeagueStatusService(repo, { cacheTtlMs: 0 }).list(now);
    expect(result[0]).toMatchObject({ phase: "completed", active_season_id: "2025_2026" });
    expect(findByLeagueSpy).not.toHaveBeenCalled();

    const queriedEplSeasons = findByLeagueSeasonSpy.mock.calls
      .filter(([leagueId]) => leagueId === "premier_league")
      .map(([, seasonId]) => seasonId);
    expect(queriedEplSeasons).toContain("2025_2026");
    expect(queriedEplSeasons).not.toContain("2021_2022");
    expect(queriedEplSeasons).not.toContain("2022_2023");
  });

  it("[A-S7-08] caches league status within TTL and refreshes once TTL elapses", async () => {
    const repo = new InMemoryRepository();
    await repo.leagueSeasons.insert(season("2025_2026", "open"));
    await repo.matches.insert(match("m1", { match_status: "scheduled", kickoff_at: new Date("2026-06-01T12:00:00Z") }));
    const matchesPort = repo.matches;
    const findByLeagueSeasonSpy = vi.spyOn(matchesPort, "findByLeagueSeason");
    vi.spyOn(repo, "matches", "get").mockReturnValue(matchesPort);
    const service = new LeagueStatusService(repo, { cacheTtlMs: 15_000 });

    const first = await service.list(now);
    expect(first[0]?.phase).toBe("break");
    const firstCalls = findByLeagueSeasonSpy.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    // Mutate DB while within TTL -> still serves cached result without DB queries
    await repo.leagueSeasons.update(season("2025_2026", "completed"));
    const second = await service.list(new Date(now.getTime() + 10_000));
    expect(second[0]?.phase).toBe("break");
    expect(findByLeagueSeasonSpy.mock.calls.length).toBe(firstCalls);

    // Concurrent calls share in-flight load after expiry
    const tExpired = new Date(now.getTime() + 15_000);
    const [a, b] = await Promise.all([service.list(tExpired), service.list(tExpired)]);
    expect(a[0]?.phase).toBe("completed");
    expect(b[0]?.phase).toBe("completed");
    expect(findByLeagueSeasonSpy.mock.calls.length).toBe(firstCalls * 2);
  });
});
