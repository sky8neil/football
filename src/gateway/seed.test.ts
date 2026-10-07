import { describe, expect, it } from "vitest";
import { RankingBoard, RankingScope } from "../domain/enums.js";
import { RankingQueryService } from "../application/ranking-query.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import {
  getGatewaySeedScenario,
  seedGatewayRepository,
  seedRankingLeaderboard,
  type GatewaySeedScenario,
} from "./seed.js";

const NOW = new Date("2026-10-06T04:00:00.000Z");
const TRUSTED_OPENID = "local-seed-openid";
const CURSOR_SECRET = "seed-test-cursor-secret";

async function seeded(scenario: GatewaySeedScenario) {
  const repo = new InMemoryRepository();
  await seedGatewayRepository(repo, NOW);
  await seedRankingLeaderboard(repo, NOW, scenario, TRUSTED_OPENID);
  const user = await repo.users.findByOpenid(TRUSTED_OPENID);
  return { repo, user };
}

function query(repo: InMemoryRepository, userId?: string) {
  return new RankingQueryService(repo, CURSOR_SECRET).list({
    board: RankingBoard.Season,
    period_key: null,
    scope: RankingScope.Global,
    group_id: null,
    limit: 20,
    cursor: null,
    server_now: NOW,
    ...(userId === undefined ? {} : { authenticated_user_id: userId }),
  });
}

describe("local gateway seed scenarios", () => {
  it("defaults to normal and rejects unknown scenario names", () => {
    expect(getGatewaySeedScenario(undefined)).toBe("normal");
    expect(getGatewaySeedScenario("thin2")).toBe("thin2");
    expect(() => getGatewaySeedScenario("thin3")).toThrow("FOOTBALL_SEED_SCENARIO");
  });

  it("normal seeds more than 20 ranked users, two seasons, and a group", async () => {
    const { repo, user } = await seeded("normal");
    expect(user).not.toBeNull();
    const rows = await repo.rankings.findByPeriod("week", "2026-W41");
    expect(rows).toHaveLength(24);
    const stats = await repo.userSeasonStats.findByUser(user!.user_id);
    expect(stats.map((row) => row.level_season_id).sort()).toEqual(["2025_2026", "2026_2027"]);
    const memberships = await repo.groupMembers.findByUser(user!.user_id);
    expect(memberships).toHaveLength(1);
    expect((await query(repo, user!.user_id)).entry_count).toBe(24);
  });

  it("seeds a selectable fixture for every league shown on the mini program home page", async () => {
    const { repo } = await seeded("normal");
    const appLeagues = [
      ["premier_league", "2026_2027"],
      ["la_liga", "2026_2027"],
      ["ligue_1", "2026_2027"],
      ["chinese_super_league", "2026"],
    ] as const;

    for (const [leagueId, seasonId] of appLeagues) {
      const fixtures = await repo.matches.findByLeagueSeasonRound(leagueId, seasonId, "01");
      expect(fixtures.some((match) => match.match_status === "scheduled")).toBe(true);
    }
  });

  it("empty and thin scenarios seed the requested week board size", async () => {
    for (const [scenario, count] of [["empty", 0], ["thin1", 1], ["thin2", 2], ["thin5", 5]] as const) {
      const { repo } = await seeded(scenario);
      expect(await repo.rankings.findByPeriod("week", "2026-W41")).toHaveLength(count);
    }
  });

  it("no-group leaves ranked users available without memberships", async () => {
    const { repo, user } = await seeded("no-group");
    expect(await repo.groups.findByOwner(user!.user_id)).toHaveLength(0);
    expect(await repo.groupMembers.findByUser(user!.user_id)).toHaveLength(0);
    expect(await repo.rankings.findByPeriod("week", "2026-W41")).toHaveLength(24);
  });

  it("first-season marks the user ineligible for the season board", async () => {
    const { repo, user } = await seeded("first-season");
    const result = await query(repo, user!.user_id);
    expect(result.me).toEqual({ status: "not_eligible", seasons_participated: 1 });
    expect(result.available_boards).not.toContain(RankingBoard.Season);
  });

  it("new-season exposes the previous season as provisional", async () => {
    const { repo, user } = await seeded("new-season");
    const result = await query(repo, user!.user_id);
    expect(result).toMatchObject({
      level_season_id: "2025_2026",
      is_provisional: true,
      entry_count: 24,
    });
  });

  it("predictions-long seeds history across at least eight weeks", async () => {
    const { repo, user } = await seeded("predictions-long");
    const predictions = await repo.predictions.findByUser(user!.user_id);
    const kickoffs = await Promise.all(predictions.map(async (prediction) => {
      const match = await repo.matches.findById(prediction.match_id);
      return match!.kickoff_at.getTime();
    }));
    expect(predictions).toHaveLength(12);
    expect(Math.max(...kickoffs) - Math.min(...kickoffs)).toBeGreaterThanOrEqual(8 * 7 * 24 * 60 * 60 * 1000);
  });
});
