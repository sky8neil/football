import { describe, expect, it } from "vitest";
import { LeagueId, LevelScope } from "./enums.js";
import {
  buildLevelInputs,
  evaluateLevel,
  formatSDisplay,
  replayLevel,
  sDisplayX100,
  type LevelEvalState,
  type LevelPredictionFact,
} from "./levels.js";
import { levelSeasonOf, nextMondayEvalAt } from "./time.js";

const RULE = "level_v3.0";
/** 保护期外：as_of 不小于该值，不累计保护。测试注入，不读 LEVEL_FIRST_EVAL_AS_OF。 */
const UNPROTECTED = new Date("2000-01-03T02:00:00.000Z");
/** 保护期内：as_of 早于该值。 */
const PROTECTED_UNTIL = new Date("2099-01-05T02:00:00.000Z");

const MONDAY_W1 = new Date("2026-08-03T02:00:00.000Z");
const MONDAY_W2 = new Date("2026-08-10T02:00:00.000Z");
const WED_AFTER_W2 = new Date("2026-08-12T09:00:00.000Z");

function baseState(
  level: number,
  below_count = 0,
  best_level = level,
): LevelEvalState {
  return { level, best_level, below_count };
}

function fact(opts: {
  matchId: string;
  anchor: Date;
  appliedAt: Date;
  score: number;
  leagueId?: string;
  items?: LevelPredictionFact["applied_items"];
}): LevelPredictionFact {
  return {
    prediction_id: `p-${opts.matchId}`,
    match_id: opts.matchId,
    league_id: opts.leagueId ?? LeagueId.PremierLeague,
    period_anchor_at: opts.anchor,
    applied_items:
      opts.items ??
      [
        {
          applied_at: opts.appliedAt,
          valid_prediction_delta: 1,
          source_result_version: 1,
          new_score: opts.score,
          score_delta: opts.score,
        },
      ],
  };
}

describe("L. 等级 v2（规范 44-L / 17.5–17.9）", () => {
  it("L89 n=0 => s 精确等于 170/100；判定式无除零", () => {
    expect(sDisplayX100(0, 0)).toBe(170);
    expect(formatSDisplay(0, 0)).toBe("1.70");
    const next = evaluateLevel(
      baseState(1),
      { n: 0, S: 0, b_points: 0, valid_total: 0 },
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    expect(next.level).toBe(1);
    expect(next.below_count).toBe(0);
  });

  it("L90 有效预测 15 场全中（S=180）=> Lv1（未评级）", () => {
    const appliedAt = new Date("2026-08-02T12:00:00.000Z");
    const facts = Array.from({ length: 15 }, (_, i) =>
      fact({
        matchId: `m${String(i).padStart(3, "0")}`,
        anchor: new Date(appliedAt.getTime() - i * 86400000),
        appliedAt,
        score: 12,
      }),
    );
    const inputs = buildLevelInputs(facts, LevelScope.Career, MONDAY_W1);
    expect(inputs.n).toBe(15);
    expect(inputs.S).toBe(180);
    expect(inputs.valid_total).toBe(15);
    const next = evaluateLevel(
      baseState(1),
      inputs,
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    expect(next.level).toBe(1);
    expect(next.best_level).toBe(1);
  });

  it("L93 S+68 与 (n+40) 使 s=1.7999… => 不升 Lv3（交叉乘法），展示 \"1.79\"", () => {
    const n = 9960;
    const S = 17931;
    expect(100 * (S + 68)).toBe(1_799_900);
    expect(180 * (n + 40)).toBe(1_800_000);
    expect(100 * (S + 68)).toBeLessThan(180 * (n + 40));
    expect(sDisplayX100(S, n)).toBe(179);
    expect(formatSDisplay(S, n)).toBe("1.79");
    const next = evaluateLevel(
      baseState(2),
      { n, S, b_points: 80_000, valid_total: n },
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    expect(next.level).toBe(2);
  });

  it("L94 400 场场均 1.5 分时窗口 S=450，持续评估仍为 Lv2", () => {
    const facts = Array.from({ length: 400 }, (_, index) => {
      const anchor = new Date(MONDAY_W1.getTime() - (index + 1) * 86400000);
      return fact({
        matchId: `avg15-${String(index).padStart(3, "0")}`,
        anchor,
        appliedAt: new Date(anchor.getTime() + 60_000),
        score: index < 150 || (index >= 300 && index < 350) ? 3 : 0,
      });
    });
    let state = baseState(2);

    for (let week = 0; week < 10; week += 1) {
      const asOf = new Date(MONDAY_W1.getTime() + week * 7 * 86400000);
      const inputs = buildLevelInputs(facts, LevelScope.Career, asOf);
      expect(inputs).toMatchObject({ n: 300, S: 450, b_points: 600, valid_total: 400 });
      expect(formatSDisplay(inputs.S, inputs.n)).toBe("1.52");
      state = evaluateLevel(state, inputs, RULE, asOf, UNPROTECTED);
    }

    expect(state.level).toBe(2);
  });

  it("L95 60 场 S=156、B=156、s=2.24 时最高停在 Lv3", () => {
    const inputs = { n: 60, S: 156, b_points: 156, valid_total: 60 };
    expect(formatSDisplay(inputs.S, inputs.n)).toBe("2.24");

    const next = evaluateLevel(baseState(3), inputs, RULE, MONDAY_W1, UNPROTECTED);

    expect(next.level).toBe(3);
  });

  it("L96 只过 A（s 达标）不过 B（积分不达标）=> 不升；降级计数清零", () => {
    const n = 300;
    const S = 600;
    expect(100 * (S + 68)).toBeGreaterThanOrEqual(195 * (n + 40));
    const next = evaluateLevel(
      baseState(3, 1),
      { n, S, b_points: 169, valid_total: 300 },
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    expect(next.level).toBe(3);
    expect(next.below_count).toBe(0);
  });

  it("L97 只过 B 不过 A => 停在当前级", () => {
    const n = 300;
    const S = 510;
    expect(100 * (S + 68)).toBeLessThan(195 * (n + 40));
    expect(100 * (S + 68)).toBeGreaterThanOrEqual(170 * (n + 40));
    const next = evaluateLevel(
      baseState(3, 1),
      { n, S, b_points: 200, valid_total: 300 },
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    expect(next.level).toBe(3);
    expect(next.below_count).toBe(0);
  });

  it("L98 Lv4，s 低于 1.85 一次后回升 => 不降，计数清零", () => {
    const n = 300;
    const below = evaluateLevel(
      baseState(4),
      { n, S: 500, b_points: 400, valid_total: 300 },
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    expect(below.level).toBe(4);
    expect(below.below_count).toBe(1);
    const recovered = evaluateLevel(
      below,
      { n, S: 600, b_points: 400, valid_total: 300 },
      RULE,
      MONDAY_W2,
      UNPROTECTED,
    );
    expect(recovered.level).toBe(4);
    expect(recovered.below_count).toBe(0);
    expect(recovered.best_level).toBe(4);
  });

  it("L99 Lv4，连续 2 周低于 1.85（保护期外）=> 第 2 周降为 Lv3，计数清零", () => {
    const n = 300;
    const inputs = { n, S: 500, b_points: 400, valid_total: 300 };
    const w1 = evaluateLevel(
      baseState(4),
      inputs,
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    expect(w1.level).toBe(4);
    expect(w1.below_count).toBe(1);
    const w2 = evaluateLevel(w1, inputs, RULE, MONDAY_W2, UNPROTECTED);
    expect(w2.level).toBe(3);
    expect(w2.below_count).toBe(0);
    expect(w2.best_level).toBe(4);
  });

  it("L100 同上但在保护期内 => 不降，计数不累加", () => {
    const n = 300;
    const inputs = { n, S: 500, b_points: 400, valid_total: 300 };
    const w1 = evaluateLevel(
      baseState(4),
      inputs,
      RULE,
      MONDAY_W1,
      PROTECTED_UNTIL,
    );
    expect(w1.level).toBe(4);
    expect(w1.below_count).toBe(0);
    const w2 = evaluateLevel(w1, inputs, RULE, MONDAY_W2, PROTECTED_UNTIL);
    expect(w2.level).toBe(4);
    expect(w2.below_count).toBe(0);
    expect(w2.best_level).toBe(4);
  });

  it("L101 Lv2，s=1.0 持续 10 周 => 仍 Lv2", () => {
    const n = 40;
    const S = 12;
    expect(100 * (S + 68)).toBe(100 * (n + 40));
    let state = baseState(2);
    for (let i = 0; i < 10; i += 1) {
      const asOf = new Date(MONDAY_W1.getTime() + i * 7 * 86400000);
      state = evaluateLevel(
        state,
        { n, S, b_points: 12, valid_total: 40 },
        RULE,
        asOf,
        UNPROTECTED,
      );
    }
    expect(state.level).toBe(2);
    expect(state.below_count).toBe(0);
    expect(state.best_level).toBe(2);
  });

  it("L108 窗口：310 场中最早 10 场被剔除；anchor 早于 730 天者被剔除 => n、S 正确", () => {
    const asOf = MONDAY_W1;
    const facts: LevelPredictionFact[] = [];
    for (let i = 0; i < 310; i += 1) {
      const anchor = new Date(asOf.getTime() - (i + 1) * 3600000);
      facts.push(
        fact({
          matchId: `r${String(i).padStart(4, "0")}`,
          anchor,
          appliedAt: new Date(anchor.getTime() + 60000),
          score: 3,
        }),
      );
    }
    for (let i = 0; i < 5; i += 1) {
      const anchor = new Date(
        asOf.getTime() - (730 * 86400000 + (i + 1) * 86400000),
      );
      facts.push(
        fact({
          matchId: `old${i}`,
          anchor,
          appliedAt: new Date(anchor.getTime() + 60000),
          score: 12,
        }),
      );
    }
    const exact730 = new Date(asOf.getTime() - 730 * 86400000);
    facts.push(
      fact({
        matchId: "eq730",
        anchor: exact730,
        appliedAt: new Date(exact730.getTime() + 60000),
        score: 12,
      }),
    );
    const inputs = buildLevelInputs(facts, LevelScope.Career, asOf);
    expect(inputs.n).toBe(300);
    expect(inputs.S).toBe(900);
    expect(inputs.valid_total).toBe(316);

    const sameAnchor = new Date("2026-08-01T12:00:00.000Z");
    const tie = buildLevelInputs(
      [
        fact({
          matchId: "b",
          anchor: sameAnchor,
          appliedAt: new Date("2026-08-01T14:00:00.000Z"),
          score: 12,
        }),
        fact({
          matchId: "a",
          anchor: sameAnchor,
          appliedAt: new Date("2026-08-01T14:00:00.000Z"),
          score: 3,
        }),
      ],
      LevelScope.Career,
      asOf,
    );
    expect(tie.n).toBe(2);
    expect(tie.S).toBe(15);
  });

  it("L109 等级赛季边界：6/30 23:59 北京 anchor 归属旧等级赛季，season 窗口剔除", () => {
    const june30 = new Date("2026-06-30T15:59:00.000Z");
    const july1 = new Date("2026-06-30T16:00:00.000Z");
    expect(levelSeasonOf(june30)).toBe("2025_2026");
    expect(levelSeasonOf(july1)).toBe("2026_2027");
    const appliedAt = new Date("2026-07-02T01:00:00.000Z");
    const asOf = new Date("2026-07-06T02:00:00.000Z");
    const facts = [
      fact({ matchId: "old-season", anchor: june30, appliedAt, score: 12 }),
      fact({ matchId: "new-season", anchor: july1, appliedAt, score: 3 }),
    ];
    const season = buildLevelInputs(
      facts,
      LevelScope.Season,
      asOf,
      "2026_2027",
    );
    expect(season.n).toBe(1);
    expect(season.S).toBe(3);
    expect(season.valid_total).toBe(1);
    const career = buildLevelInputs(facts, LevelScope.Career, asOf);
    expect(career.n).toBe(2);
    expect(career.S).toBe(15);
  });

  it("Lv1 满 20 场有效预测升 Lv2，一次最多一级", () => {
    const next = evaluateLevel(
      baseState(1),
      { n: 60, S: 720, b_points: 720, valid_total: 60 },
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    expect(next.level).toBe(2);
    expect(next.below_count).toBe(0);
  });

  it("未知 rule_version 失败关闭", () => {
    expect(() =>
      evaluateLevel(
        baseState(1),
        { n: 0, S: 0, b_points: 0, valid_total: 0 },
        "level_v9.9",
        MONDAY_W1,
        UNPROTECTED,
      ),
    ).toThrow(/未知 level_rule_version/);
  });

  it("L107 全量 replay 与逐周线上状态一致，correction 以 week_base 改判", () => {
    expect(nextMondayEvalAt(new Date("2026-08-02T16:00:00.000Z")).toISOString()).toBe(
      MONDAY_W1.toISOString(),
    );
    const firstApplied = new Date("2026-08-01T12:00:00.000Z");
    const facts: LevelPredictionFact[] = Array.from({ length: 20 }, (_, i) =>
      fact({
        matchId: `rw${String(i).padStart(2, "0")}`,
        anchor: new Date(firstApplied.getTime() - i * 3600000),
        appliedAt: firstApplied,
        score: 12,
        items: [
          {
            applied_at: firstApplied,
            valid_prediction_delta: 1,
            source_result_version: 1,
            new_score: 12,
            score_delta: 12,
          },
          {
            applied_at: new Date("2026-08-12T08:00:00.000Z"),
            valid_prediction_delta: 0,
            source_result_version: 2,
            new_score: 0,
            score_delta: -12,
          },
        ],
      }),
    );
    const afterW2 = replayLevel({
      scope: LevelScope.Career,
      facts,
      firstEvalAsOf: MONDAY_W1,
      untilAsOf: MONDAY_W2,
      correctionSettledAts: [],
      ruleVersion: RULE,
      protectionEndAsOf: UNPROTECTED,
    });
    const onlineW1 = evaluateLevel(
      baseState(1),
      buildLevelInputs(facts, LevelScope.Career, MONDAY_W1),
      RULE,
      MONDAY_W1,
      UNPROTECTED,
    );
    const onlineW2 = evaluateLevel(
      onlineW1,
      buildLevelInputs(facts, LevelScope.Career, MONDAY_W2),
      RULE,
      MONDAY_W2,
      UNPROTECTED,
    );
    expect(afterW2.level).toBe(3);
    expect(afterW2.best_level).toBe(3);
    expect(afterW2).toMatchObject(onlineW2);

    const afterCorr = replayLevel({
      scope: LevelScope.Career,
      facts,
      firstEvalAsOf: MONDAY_W1,
      untilAsOf: WED_AFTER_W2,
      correctionSettledAts: [WED_AFTER_W2],
      ruleVersion: RULE,
      protectionEndAsOf: UNPROTECTED,
    });
    expect(afterCorr.level).toBe(2);
    expect(afterCorr.best_level).toBe(3);
    expect(afterCorr.below_count).toBe(0);
  });

  it("Q1 没有首次评估时不产生事件并保留缓存等级", () => {
    const initial = baseState(3, 1, 5);
    const replayed = replayLevel({
      scope: LevelScope.Career,
      facts: [],
      firstEvalAsOf: null,
      untilAsOf: WED_AFTER_W2,
      correctionSettledAts: [WED_AFTER_W2],
      ruleVersion: RULE,
      protectionEndAsOf: null,
      initialState: initial,
    });

    expect(replayed).toMatchObject(initial);
    expect(replayed.last_eval_as_of).toBeNull();
  });

  it("applied_at >= as_of 的 item 不进窗口；取 as_of 前最大 source_result_version 的 new_score", () => {
    const asOf = MONDAY_W1;
    const inputs = buildLevelInputs(
      [
        fact({
          matchId: "late",
          anchor: new Date("2026-08-02T12:00:00.000Z"),
          appliedAt: asOf,
          score: 12,
        }),
        fact({
          matchId: "corr",
          anchor: new Date("2026-08-01T12:00:00.000Z"),
          appliedAt: new Date("2026-08-01T18:00:00.000Z"),
          score: 3,
          items: [
            {
              applied_at: new Date("2026-08-01T18:00:00.000Z"),
              valid_prediction_delta: 1,
              source_result_version: 1,
              new_score: 3,
              score_delta: 3,
            },
            {
              applied_at: new Date("2026-08-03T03:00:00.000Z"),
              valid_prediction_delta: 0,
              source_result_version: 2,
              new_score: 12,
              score_delta: 9,
            },
          ],
        }),
      ],
      LevelScope.Career,
      asOf,
    );
    expect(inputs.n).toBe(1);
    expect(inputs.S).toBe(3);
    expect(inputs.b_points).toBe(3);
    expect(inputs.valid_total).toBe(1);
  });
});
