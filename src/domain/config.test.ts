import { describe, expect, it } from "vitest";
import {
  activeSeasonIds,
  activeProviderSeasonRef,
  activeLeagueSeason,
  deriveSeasonId,
  FIXED_CONFIG_V1,
  LEVEL_ELIGIBLE_LEAGUES,
  leagueSeasonBounds,
  MVP_SEASON,
  RANKING_FIRST_PERIOD_KEY,
  seasonBounds,
  seasonStartYear,
  SUPPORTED_LEAGUES,
  previousLeagueSeasonId,
  providerSeasonRef,
  type SupportedLeague,
} from "./config.js";

describe("S0 固定配置 v2（规范 §3 / §1.4）", () => {
  it("删除月榜门槛与旧周榜 3 场门槛；新周榜门槛为 1", () => {
    expect(RANKING_FIRST_PERIOD_KEY).toBe("2026-W31");
    expect("GLOBAL_MONTH_MIN_PREDICTIONS" in FIXED_CONFIG_V1).toBe(false);
    expect("GLOBAL_WEEK_MIN_PREDICTIONS" in FIXED_CONFIG_V1).toBe(false);
    expect(FIXED_CONFIG_V1.WEEK_BOARD_MIN_VALID).toBe(1);
    expect(FIXED_CONFIG_V1.STRENGTH_BOARD_MIN_WINDOW_N).toBe(50);
    expect(FIXED_CONFIG_V1.RANKING_TOP_LIMIT).toBe(20);
    expect(FIXED_CONFIG_V1.RANKING_PAGE_SIZE).toBe(10);
    expect(FIXED_CONFIG_V1.RANKING_WEEK_WINDOW).toBe(4);
  });

  it("登记 level_v3.0 与六级阈值", () => {
    expect(FIXED_CONFIG_V1.LEVEL_RULE_VERSION).toBe("level_v3.0");
    expect(FIXED_CONFIG_V1.LEVEL_MIN).toBe(1);
    expect(FIXED_CONFIG_V1.LEVEL_MAX).toBe(6);
    expect(FIXED_CONFIG_V1.LEVEL_RATED_MIN_VALID).toBe(20);
    expect(FIXED_CONFIG_V1.LEVEL_PRIOR_WEIGHT_K).toBe(40);
    expect(FIXED_CONFIG_V1.LEVEL_PRIOR_MEAN_X100).toBe(170);
    expect(FIXED_CONFIG_V1.LEVEL_WINDOW_MAX_N).toBe(300);
    expect(FIXED_CONFIG_V1.LEVEL_WINDOW_MAX_DAYS).toBe(730);
    expect(FIXED_CONFIG_V1.LEVEL_PROMOTE_X100).toEqual({ 3: 180, 4: 195, 5: 215, 6: 235 });
    expect(FIXED_CONFIG_V1.LEVEL_HOLD_X100).toEqual({ 3: 170, 4: 185, 5: 205, 6: 225 });
    expect(FIXED_CONFIG_V1.LEVEL_B_POINTS).toEqual({ 3: 80, 4: 170, 5: 380, 6: 630 });
    expect(FIXED_CONFIG_V1.LEVEL_DEMOTE_CONSECUTIVE).toBe(2);
    expect(FIXED_CONFIG_V1.LEVEL_MAX_STEP_PER_WEEK).toBe(1);
    expect(FIXED_CONFIG_V1.LEVEL_PROTECTION_EVALS).toBe(13);
    expect(FIXED_CONFIG_V1.LEVEL_SEASON_BOUNDARY).toBe("07-01 00:00 Asia/Shanghai");
    expect(FIXED_CONFIG_V1.LEVEL_FIRST_EVAL_AS_OF).toBeNull();
  });

  it("SUPPORTED_LEAGUES 封闭六联赛，与 LEVEL_ELIGIBLE_LEAGUES 同源", () => {
    expect(SUPPORTED_LEAGUES).toHaveLength(6);
    expect(LEVEL_ELIGIBLE_LEAGUES).toBe(SUPPORTED_LEAGUES);
    expect(SUPPORTED_LEAGUES.map((row) => row.league_id)).toEqual([
      "premier_league",
      "la_liga",
      "serie_a",
      "bundesliga",
      "ligue_1",
      "chinese_super_league",
    ]);
    expect(SUPPORTED_LEAGUES[0]).toMatchObject({
      api_football_league_id: "39",
      api_football_season: "2026",
      season_id: "2026_2027",
      round_max: 38,
    });
    expect(SUPPORTED_LEAGUES[3]).toMatchObject({
      league_id: "bundesliga",
      api_football_league_id: "78",
      round_max: 34,
    });
    expect(SUPPORTED_LEAGUES[5]).toMatchObject({
      league_id: "chinese_super_league",
      api_football_league_id: "169",
      season_id: "2026",
      round_max: 30,
    });
    expect(MVP_SEASON.league_id).toBe("premier_league");
    expect(MVP_SEASON.season_id).toBe("2026_2027");
    expect(MVP_SEASON.api_football_league_id).toBe("39");
  });

  it("登记排行榜与群冻结常量", () => {
    expect(FIXED_CONFIG_V1.RANKING_BOARDS).toEqual(["week", "career", "strength", "season"]);
    expect(FIXED_CONFIG_V1.SEASON_BOARD_MIN_VALID).toBe(1);
    expect(FIXED_CONFIG_V1.SEASON_BOARD_MIN_SEASONS).toBe(2);
    expect(FIXED_CONFIG_V1.SEASON_BOARD_SNAPSHOT_MINUTES).toBe(60);
    expect(FIXED_CONFIG_V1.GROUP_MAX_MEMBERS).toBe(500);
    expect(FIXED_CONFIG_V1.USER_MAX_GROUPS_JOINED).toBe(20);
    expect(FIXED_CONFIG_V1.USER_MAX_GROUPS_OWNED).toBe(5);
    expect(FIXED_CONFIG_V1.GROUP_INVITE_CODE_LENGTH).toBe(8);
    expect(FIXED_CONFIG_V1.GROUP_INVITE_CODE_ALPHABET).toBe(
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    );
  });

  it("登记大家怎么选的门槛与百分比粒度", () => {
    expect(FIXED_CONFIG_V1.CROWD_MIN_PREDICTIONS).toBe(20);
    expect(FIXED_CONFIG_V1.CROWD_GRANULARITY_PERCENT).toBe(5);
  });
});

describe("赛季自动推导", () => {
  const crossYearLeague = SUPPORTED_LEAGUES[0];
  const naturalYearLeague = SUPPORTED_LEAGUES[5];

  it("按 UTC 七月边界推导跨年联赛赛季", () => {
    const cases = [
      ["2026-06-30T23:59:59.999Z", "2025_2026"],
      ["2026-07-01T00:00:00.000Z", "2026_2027"],
      ["2027-06-30T23:59:59.999Z", "2026_2027"],
      ["2027-07-01T00:00:00.000Z", "2027_2028"],
    ] as const;

    for (const [now, seasonId] of cases) {
      expect(deriveSeasonId(crossYearLeague, new Date(now))).toBe(seasonId);
    }
  });

  it("按 UTC 元旦边界推导自然年联赛赛季", () => {
    const cases = [
      ["2026-12-31T23:59:59.999Z", "2026"],
      ["2027-01-01T00:00:00.000Z", "2027"],
    ] as const;

    for (const [now, seasonId] of cases) {
      expect(deriveSeasonId(naturalYearLeague, new Date(now))).toBe(seasonId);
    }
  });

  it("推导赛季参数并保留 null provider 键", () => {
    const crossYear = activeLeagueSeason(crossYearLeague, new Date("2026-09-01T00:00:00.000Z"));
    expect(crossYear).toMatchObject({
      season_id: "2026_2027",
      api_football_season: "2026",
      source_season_ref: "2026",
      provider_season_refs: {
        of: "2026/27",
        fd: null,
      },
    });

    const naturalYear = activeLeagueSeason(
      naturalYearLeague,
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(naturalYear).toMatchObject({
      season_id: "2026",
      api_football_season: "2026",
      source_season_ref: "2026",
      provider_season_refs: {
        of: "2026",
        fd: null,
      },
    });
  });

  it("2026-11-15 推导值与所有联赛当前静态赛季字段一致", () => {
    const now = new Date("2026-11-15T00:00:00.000Z");

    for (const league of SUPPORTED_LEAGUES) {
      const active = activeLeagueSeason(league, now);
      expect(active).toEqual({
        season_id: league.season_id,
        api_football_season: league.api_football_season,
        source_season_ref: league.source_season_ref,
        provider_season_refs: league.provider_season_refs,
      });
      expect(activeProviderSeasonRef(league, "of", now)).toBe(providerSeasonRef(league, "of"));
    }
  });

  it("换季后推导 2027/28 跨年赛季与 2027 自然年赛季", () => {
    const now = new Date("2027-07-02T00:00:00.000Z");
    const crossYearLeagues = SUPPORTED_LEAGUES.filter((league) => league.season_id.includes("_"));
    const naturalYearLeagues = SUPPORTED_LEAGUES.filter((league) => !league.season_id.includes("_"));

    for (const league of crossYearLeagues) {
      expect(activeLeagueSeason(league, now).season_id).toBe("2027_2028");
      expect(activeProviderSeasonRef(league, "of", now)).toBe("2027/28");
    }
    for (const league of naturalYearLeagues) {
      expect(activeLeagueSeason(league, now).season_id).toBe("2027");
    }
  });

  it("读路径赛季集合包含当前与上一赛季，支持跨年和自然年联赛", () => {
    const now = new Date("2026-08-11T00:00:00.000Z");

    expect(previousLeagueSeasonId(crossYearLeague, now)).toBe("2025_2026");
    expect(activeSeasonIds(crossYearLeague, now)).toEqual(["2026_2027", "2025_2026"]);
    expect(previousLeagueSeasonId(naturalYearLeague, now)).toBe("2025");
    expect(activeSeasonIds(naturalYearLeague, now)).toEqual(["2026", "2025"]);
  });

  it("无法解析赛季形态时只返回静态登记赛季", () => {
    const unparseableLeague = {
      ...crossYearLeague,
      season_id: "cup_season",
    } as unknown as SupportedLeague;
    const now = new Date("2026-08-11T00:00:00.000Z");

    expect(previousLeagueSeasonId(unparseableLeague, now)).toBeNull();
    expect(activeSeasonIds(unparseableLeague, now)).toEqual(["cup_season"]);
  });

  it("seasonBounds 与联赛已登记窗口返回相同毫秒", () => {
    const season = seasonBounds("2026_2027");
    const league = leagueSeasonBounds(crossYearLeague);
    expect(season).not.toBeNull();
    expect(league).not.toBeNull();
    expect(season?.start.getTime()).toBe(league?.start.getTime());
    expect(season?.end.getTime()).toBe(league?.end.getTime());
  });

  it("解析跨年、自然年和无效赛季标识的起始年", () => {
    expect(seasonStartYear("2026_2027")).toBe(2026);
    expect(seasonStartYear("2026")).toBe(2026);
    expect(seasonStartYear("abc")).toBeNull();
  });
});
