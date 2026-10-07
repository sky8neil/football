import { describe, expect, it } from "vitest";
import {
  FIXED_CONFIG_V1,
  LEVEL_ELIGIBLE_LEAGUES,
  MVP_SEASON,
  RANKING_FIRST_PERIOD_KEY,
  SUPPORTED_LEAGUES,
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
});
