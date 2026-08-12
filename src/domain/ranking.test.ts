import { describe, expect, it } from "vitest";
import {
  compareRankingEntry,
  isRankEligible,
  lastScoringForPeriodScore,
  rankForPosition,
  type RankingComparable,
} from "./ranking.js";

function entry(overrides: Partial<RankingComparable> = {}): RankingComparable {
  return {
    period_score: 0,
    valid_predictions: 3,
    wdl_hits: 0,
    exact_hits: 0,
    last_scoring_match_at: null,
    user_id: "u",
    ...overrides,
  };
}

const t = (iso: string): Date => new Date(iso);

describe("K. 排行榜（规范 44-K）", () => {
  it("K78 1 场有 rankings 文档但 global_rank=null", () => {
    expect(rankForPosition(1, 1)).toBeNull();
    expect(isRankEligible(1)).toBe(false);
  });

  it("K79 2 场 global_rank=null", () => {
    expect(rankForPosition(2, 2)).toBeNull();
    expect(isRankEligible(2)).toBe(false);
  });

  it("K80 3 场开始进入全局榜", () => {
    expect(rankForPosition(3, 1)).toBe(1);
    expect(rankForPosition(3, 7)).toBe(7);
    expect(isRankEligible(3)).toBe(true);
  });

  it("K81 period_score 高者优先", () => {
    const a = entry({ period_score: 12, valid_predictions: 3, wdl_hits: 1 });
    const b = entry({ period_score: 3, valid_predictions: 3, wdl_hits: 1 });
    expect(compareRankingEntry(a, b)).toBeLessThan(0);
    expect(compareRankingEntry(b, a)).toBeGreaterThan(0);
  });

  it("K82 同分准确率高者优先", () => {
    const a = entry({ period_score: 12, valid_predictions: 2, wdl_hits: 2 }); // 100%
    const b = entry({ period_score: 12, valid_predictions: 3, wdl_hits: 2 }); // 66.7%
    expect(compareRankingEntry(a, b)).toBeLessThan(0);
  });

  it("K83 准确率用精确分数比较，不受显示四舍五入影响", () => {
    // 6/10 = 60.0%，299/500 = 59.8%（均显示 60.0%）
    const a = entry({ period_score: 12, valid_predictions: 10, wdl_hits: 6, exact_hits: 1 });
    const b = entry({ period_score: 12, valid_predictions: 500, wdl_hits: 299, exact_hits: 2 });
    expect(a.wdl_hits * b.valid_predictions).toBeGreaterThan(
      b.wdl_hits * a.valid_predictions,
    );
    expect(compareRankingEntry(a, b)).toBeLessThan(0);
  });

  it("K84 再同 exact_hits 高者优先", () => {
    const a = entry({ period_score: 3, valid_predictions: 3, wdl_hits: 1, exact_hits: 1 });
    const b = entry({ period_score: 3, valid_predictions: 3, wdl_hits: 1, exact_hits: 0 });
    expect(compareRankingEntry(a, b)).toBeLessThan(0);
  });

  it("K85 再同 last_scoring_match_at 早者优先", () => {
    const a = entry({
      period_score: 3,
      valid_predictions: 3,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: t("2026-08-08T18:00:00Z"),
    });
    const b = entry({
      period_score: 3,
      valid_predictions: 3,
      wdl_hits: 1,
      exact_hits: 0,
      last_scoring_match_at: t("2026-08-08T19:00:00Z"),
    });
    expect(compareRankingEntry(a, b)).toBeLessThan(0);
  });

  it("K86 0 分用户 last_scoring=null 并按规则排序（null 排后）", () => {
    const zero = entry({
      period_score: 0,
      valid_predictions: 3,
      wdl_hits: 0,
      last_scoring_match_at: t("2026-08-08T18:00:00Z"),
    });
    expect(lastScoringForPeriodScore(0, zero.last_scoring_match_at)).toBeNull();

    const withScore = entry({
      period_score: 3,
      valid_predictions: 3,
      wdl_hits: 1,
      last_scoring_match_at: t("2026-08-08T18:00:00Z"),
    });
    expect(compareRankingEntry(withScore, zero)).toBeLessThan(0);

    const a = entry({ period_score: 0, last_scoring_match_at: t("2026-08-08T18:00:00Z") });
    const b = entry({ period_score: 0, last_scoring_match_at: null });
    expect(compareRankingEntry(a, b)).toBeLessThan(0);
  });

  it("K87 完全一致 user_id ASC", () => {
    const a = entry({ user_id: "aaaa" });
    const b = entry({ user_id: "bbbb" });
    expect(compareRankingEntry(a, b)).toBeLessThan(0);
    expect(compareRankingEntry(b, a)).toBeGreaterThan(0);
  });

  it("K88 is_final=true 后 correction 仍可改变历史 rank", () => {
    const alice = { ...entry({ user_id: "alice", period_score: 12, valid_predictions: 3, wdl_hits: 1 }), is_final: true };
    const bob = { ...entry({ user_id: "bob", period_score: 3, valid_predictions: 3, wdl_hits: 1 }), is_final: true };

    const before: Array<RankingComparable> = [bob, alice];
    before.sort(compareRankingEntry);
    expect(before[0]!.user_id).toBe("alice");

    // correction：alice 12 -> 0，重排后 bob 领先
    const aliceCorrected = { ...entry({ user_id: "alice", period_score: 0, valid_predictions: 3, wdl_hits: 0 }), is_final: true };
    const after: Array<RankingComparable> = [aliceCorrected, bob];
    after.sort(compareRankingEntry);
    expect(after[0]!.user_id).toBe("bob");
  });

  it("last_scoring_for_period_score：非 0 分返回原值", () => {
    const d = t("2026-08-08T18:00:00Z");
    expect(lastScoringForPeriodScore(3, d)).toBe(d);
  });

  it("period_score=0 时强制 null 即使传入值", () => {
    expect(lastScoringForPeriodScore(0, t("2026-08-08T18:00:00Z"))).toBeNull();
  });
});
