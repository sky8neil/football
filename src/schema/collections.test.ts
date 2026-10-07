import { describe, expect, it } from "vitest";
import { COLLECTION_DEFINITIONS } from "./collections.js";

function collection(name: string) {
  const found = COLLECTION_DEFINITIONS.find((item) => item.collection === name);
  expect(found).toBeDefined();
  return found!;
}

describe("S0 Collection schema（规范 §21）", () => {
  it("users 等级 1..6，并含生涯榜键与 level_state", () => {
    const fields = collection("users").fields;
    expect(fields.career_level?.min).toBe(1);
    expect(fields.career_level?.max).toBe(6);
    expect(fields.career_best_level?.max).toBe(6);
    expect(fields.career_last_scoring_match_at?.type).toBe("date");
    expect(fields.career_last_scoring_match_at?.nullable).toBe(true);
    expect(fields.career_level_state?.type).toBe("object");
    expect(fields.career_level_state?.fields?.below_count).toMatchObject({
      type: "int",
      min: 0,
      max: 1,
      default: 0,
    });
    expect(fields.career_level_state?.fields?.last_eval_n).toMatchObject({
      min: 0,
      max: 300,
      default: 0,
    });
    expect(fields.career_level_state?.fields?.last_eval_score_sum).toMatchObject({
      min: 0,
      default: 0,
    });
  });

  it("user_season_stats 使用 level_season_id，等级 1..6", () => {
    const def = collection("user_season_stats");
    expect(def.fields.season_id).toBeUndefined();
    expect(def.fields.level_season_id?.type).toBe("string");
    expect(def.fields.level?.max).toBe(6);
    expect(def.fields.best_level?.max).toBe(6);
    expect(def.fields.last_scoring_match_at).toMatchObject({ type: "date", nullable: true });
    expect(def.fields.level_state?.type).toBe("object");
    expect(def.fields.is_level_frozen?.type).toBe("bool");
  });

  it("board_snapshots 支持 season 快照与终榜", () => {
    const fields = collection("board_snapshots").fields;
    expect(fields.board?.enum).toEqual(["career", "strength", "season"]);
    expect(fields.level_season_id).toMatchObject({ type: "string", nullable: true });
    expect(fields.is_final).toMatchObject({ type: "bool", required: true, default: false });
    expect(fields.season_points).toMatchObject({ type: "int", nullable: true });
  });

  it("teams.league_id 与 matches.league_id 为六联赛封闭枚举", () => {
    const six = [
      "premier_league",
      "la_liga",
      "serie_a",
      "bundesliga",
      "ligue_1",
      "chinese_super_league",
    ];
    expect(collection("teams").fields.league_id?.enum).toEqual(six);
    expect(collection("matches").fields.league_id?.enum).toEqual(six);
    expect(collection("matches").fields.league_id?.immutable).toBe(true);
    expect(collection("matches").fields.season_id?.immutable).toBe(true);
    expect(collection("matches").fields.season_id?.default).toBeUndefined();
  });

  it("rankings.period_type 仅 week", () => {
    expect(collection("rankings").fields.period_type?.enum).toEqual(["week"]);
  });

  it("level_history 改为 v3 截面字段，reason 三值", () => {
    const fields = collection("level_history").fields;
    expect(fields.season_id).toBeUndefined();
    expect(fields.wdl_hits).toBeUndefined();
    expect(fields.valid_predictions).toBeUndefined();
    expect(fields.level_season_id?.nullable).toBe(true);
    expect(fields.level_season_id?.required).toBe(true);
    expect(fields.eval_as_of?.type).toBe("date");
    expect(fields.window_n?.type).toBe("int");
    expect(fields.window_score_sum?.type).toBe("int");
    expect(fields.b_points?.type).toBe("int");
    expect(fields.level_rule_version?.type).toBe("string");
    expect(fields.settlement_id?.nullable).toBe(true);
    expect(fields.settlement_id?.required).toBe(true);
    expect(fields.from_level?.max).toBe(6);
    expect(fields.to_level?.max).toBe(6);
    expect(fields.reason?.enum).toEqual(["weekly_eval", "correction_reeval", "rebuild"]);
  });

  it("新增 board_snapshots / groups / group_members，sync_logs 包含赛季快照任务", () => {
    expect(collection("board_snapshots").fields.board?.enum).toEqual([
      "career",
      "strength",
      "season",
    ]);
    expect(collection("board_snapshots").fields.snapshot_kind?.enum).toEqual(["head"]);
    expect(collection("groups").fields.invite_code?.unique).toBe(true);
    expect(collection("groups").fields.status?.enum).toEqual(["active", "dissolved"]);
    expect(collection("group_members").fields.status?.enum).toEqual(["active", "left"]);
    expect(collection("sync_logs").fields.job_type?.enum).toEqual([
      "future_schedule",
      "full_schedule_verify",
      "near_match",
      "live_match",
      "post_finish_verify",
      "period_finalize",
      "daily_consistency",
      "weekly_level_eval",
      "level_correction_reeval",
      "board_snapshot_career",
      "board_snapshot_strength",
      "board_snapshot_season",
      "board_snapshot_season_final",
    ]);
  });
});
