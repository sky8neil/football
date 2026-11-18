import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const { buildCardState, REASON_TEXT } = (() => {
  const module = { exports: {} };
  const factory = runInThisContext(
    `(function(module, exports) {\n${readFileSync(join(HERE, "match-card-state.js"), "utf8")}\n})`,
    { filename: join(HERE, "match-card-state.js") },
  );
  factory(module, module.exports);
  return module.exports;
})();

const TIME = "20:00";

function item(overrides = {}) {
  return {
    match_status: "scheduled",
    can_predict: false,
    can_predict_reason: "CLOSED",
    regular_home_score: null,
    regular_away_score: null,
    display_time: TIME,
    result_type: null,
    ...overrides,
  };
}

function submitted(overrides = {}) {
  return {
    pred_home_score: 2,
    pred_away_score: 1,
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    ...overrides,
  };
}

function copy(state) {
  return [state.stateText, state.scoreSub, state.predText, state.chipText].join(" ");
}

function assertNoDuplication(state) {
  const locked = (copy(state).match(/不可修改/g) || []).length;
  expect(locked).toBeLessThanOrEqual(1);
  if (state.chipText && state.predText) expect(state.chipText).not.toBe(state.predText);
}

describe("buildCardState", () => {
  it("maps live matches to in-play copy only", () => {
    const state = buildCardState(item({ match_status: "live", can_predict_reason: "CLOSED" }), null);
    expect(state).toMatchObject({
      cardClass: "is-live",
      stateClass: "live",
      stateText: "进行中",
      scoreSub: "LIVE",
      predText: "未预测",
      chipText: "",
      showPredict: false,
    });
    expect(state.stateText).not.toContain("已提交");
    assertNoDuplication(state);
  });

  it("keeps submitted prediction on a live card without restating lock copy", () => {
    const state = buildCardState(item({ match_status: "live" }), submitted());
    expect(state.stateText).toBe("进行中");
    expect(state.scoreSub).toBe("LIVE");
    expect(state.predText).toBe("已提交 2 : 1 · 不可修改");
    expect(state.chipText).toBe("");
    expect(state.chipText).not.toMatch(/已锁定|不可修改/);
    assertNoDuplication(state);
  });

  it("maps finished complete scores with a prediction to FT", () => {
    const state = buildCardState(
      item({ match_status: "finished", regular_home_score: 2, regular_away_score: 1 }),
      submitted(),
    );
    expect(state).toMatchObject({
      cardClass: "is-done",
      stateClass: "done",
      stateText: "已结束",
      scoreSub: "FT",
      predText: "已提交 2 : 1 · 不可修改",
      chipText: "",
      showPredict: false,
    });
    assertNoDuplication(state);
  });

  it("maps finished complete scores without a prediction to 待结算", () => {
    const state = buildCardState(
      item({ match_status: "finished", regular_home_score: 1, regular_away_score: 0, can_predict_reason: "CLOSED" }),
      null,
    );
    expect(state.stateText).toBe("已结束");
    expect(state.scoreSub).toBe("待结算");
    expect(state.predText).toBe("未预测");
    expect(state.chipText).toBe("");
    assertNoDuplication(state);
  });

  it("maps finished incomplete scores to 待结算", () => {
    const state = buildCardState(
      item({ match_status: "finished", regular_home_score: null, regular_away_score: null }),
      submitted(),
    );
    expect(state.stateText).toBe("已结束");
    expect(state.scoreSub).toBe("待结算");
    expect(state.predText).toBe("已提交 2 : 1 · 不可修改");
    assertNoDuplication(state);
  });

  it("treats 0-0 as complete scores", () => {
    const state = buildCardState(
      item({ match_status: "finished", regular_home_score: 0, regular_away_score: 0 }),
      submitted({ match_score: 0 }),
    );
    expect(state.scoreSub).toBe("FT");
    expect(state.predText).toBe("我的预测 2 : 1 · 得分 +0");
  });

  it.each([
    ["postponed", "延期"],
    ["cancelled", "取消"],
    ["abandoned", "腰斩"],
  ])("maps %s to closed match status", (matchStatus, stateText) => {
    const state = buildCardState(item({ match_status: matchStatus, can_predict_reason: "CLOSED" }), null);
    expect(state).toMatchObject({
      cardClass: "is-closed",
      stateClass: "closed",
      stateText,
      scoreSub: TIME,
      predText: "未预测",
      showPredict: false,
    });
    expect(state.stateText).not.toContain("已提交");
    assertNoDuplication(state);
  });

  it("maps open scheduled matches to a predict action with empty predText", () => {
    const state = buildCardState(item({ can_predict: true, can_predict_reason: null }), null);
    expect(state).toMatchObject({
      cardClass: "is-open",
      stateClass: "",
      stateText: "未开赛",
      scoreSub: TIME,
      predText: "",
      chipText: "",
      showPredict: true,
    });
    assertNoDuplication(state);
  });

  it("maps ALREADY_SUBMITTED to unkickoff status without lock copy", () => {
    const state = buildCardState(
      item({ can_predict: false, can_predict_reason: "ALREADY_SUBMITTED" }),
      submitted({ home: 2, away: 1, pred_home_score: undefined, pred_away_score: undefined }),
    );
    expect(state).toMatchObject({
      cardClass: "is-submitted",
      stateClass: "lock",
      stateText: "未开赛",
      scoreSub: TIME,
      predText: "已提交 2 : 1 · 不可修改",
      chipText: "",
      chipClass: "",
      showPredict: false,
    });
    expect(state.stateText).not.toContain("已提交");
    expect(state.scoreSub).not.toBe("已锁定");
    expect(copy(state)).not.toMatch(/已锁定|查看详情/);
    expect(state.chipText).not.toMatch(/已锁定|不可修改/);
    assertNoDuplication(state);
  });

  it("treats a local submitted prediction on an otherwise open card as submitted", () => {
    const state = buildCardState(item({ can_predict: true, can_predict_reason: null }), submitted());
    expect(state.cardClass).toBe("is-submitted");
    expect(state.stateClass).toBe("lock");
    expect(state.stateText).toBe("未开赛");
    expect(state.stateText).not.toContain("已提交");
    expect(state.predText).toBe("已提交 2 : 1 · 不可修改");
    expect(state.chipText).toBe("");
    expect(state.showPredict).toBe(false);
    assertNoDuplication(state);
  });

  it.each(Object.entries(REASON_TEXT))("maps scheduled reason %s to chip %s", (reason, chipText) => {
    const state = buildCardState(item({ match_status: "scheduled", can_predict: false, can_predict_reason: reason }), null);
    expect(state).toMatchObject({
      cardClass: "is-closed",
      stateClass: "closed",
      stateText: "未开赛",
      scoreSub: TIME,
      predText: "未预测",
      chipText,
      chipClass: "closed",
      showPredict: false,
    });
    expect(state.stateText).not.toContain("已提交");
    expect(chipText).not.toMatch(/已锁定|不可修改/);
    assertNoDuplication(state);
  });

  it("uses settled predText when match_score is present", () => {
    const state = buildCardState(
      item({ match_status: "finished", regular_home_score: 2, regular_away_score: 1, result_type: "hit12" }),
      submitted({ match_score: 12, exact_hit: true, wdl_hit: true }),
    );
    expect(state.predText).toBe("我的预测 2 : 1 · 得分 +12");
    expect(state.scoreSub).toBe("FT");
    expect(state.chipText).toBe("");
    expect(state.stateText).toBe("已结束");
    assertNoDuplication(state);
  });

  it("uses unsettled predText when match_score is null", () => {
    const state = buildCardState(
      item({ match_status: "finished", regular_home_score: 1, regular_away_score: 1 }),
      submitted({ match_score: null }),
    );
    expect(state.predText).toBe("已提交 2 : 1 · 不可修改");
    expect(state.predText).not.toContain("得分");
  });

  it("never puts 已提交 into stateText and repeats 不可修改 at most once", () => {
    const cases = [
      buildCardState(item({ can_predict_reason: "ALREADY_SUBMITTED" }), submitted()),
      buildCardState(item({ can_predict: true, can_predict_reason: null }), submitted()),
      buildCardState(item({ match_status: "live" }), submitted()),
      buildCardState(item({ match_status: "finished", regular_home_score: 3, regular_away_score: 0 }), submitted({ match_score: 3 })),
      buildCardState(item({ can_predict: true, can_predict_reason: null }), null),
      buildCardState(item({ can_predict_reason: "CLOSED" }), null),
    ];
    for (const state of cases) {
      if (state.cardClass === "is-submitted" || state.predText.startsWith("已提交") || state.predText.startsWith("我的预测")) {
        expect(state.stateText).not.toContain("已提交");
      }
      assertNoDuplication(state);
    }
  });
});
