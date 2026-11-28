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

  it("maps finished complete scores without a prediction to FT, not 待结算", () => {
    const state = buildCardState(
      item({
        match_status: "finished",
        regular_home_score: 1,
        regular_away_score: 0,
        can_predict_reason: "CLOSED",
        settlement_status: "waiting",
      }),
      null,
    );
    expect(state.stateText).toBe("已结束");
    expect(state.scoreSub).toBe("FT");
    expect(state.scoreSub).not.toBe("待结算");
    expect(state.predText).toBe("未预测");
    expect(state.chipText).toBe("");
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

  describe("finished copy matrix", () => {
    const noScore = {
      match_status: "finished",
      regular_home_score: null,
      regular_away_score: null,
      can_predict_reason: "CLOSED",
    };
    const complete = {
      match_status: "finished",
      regular_home_score: 2,
      regular_away_score: 1,
      can_predict_reason: "CLOSED",
    };
    const zeroZero = {
      match_status: "finished",
      regular_home_score: 0,
      regular_away_score: 0,
      can_predict_reason: "CLOSED",
    };
    const allowedScoreSub = new Set(["FT", "待结算", "", "已结束"]);

    it.each([
      ["pending"],
      ["not_ready"],
      ["waiting"],
      ["settling"],
      ["settled"],
      ["correcting"],
      ["voided"],
      [undefined],
      [null],
      ["unknown"],
    ])("non-participant missing score with settlement_status %j does not show 待结算", (settlement_status) => {
      const state = buildCardState(item({ ...noScore, settlement_status }), null);
      expect(state.stateText).toBe("已结束");
      expect(state.scoreSub).toBe("");
      expect(state.scoreSub).not.toBe("待结算");
      expect(state.predText).toBe("未预测");
      expect(state.chipText).toBe("");
      assertNoDuplication(state);
    });

    it.each([
      ["pending"],
      ["not_ready"],
      ["waiting"],
      ["settling"],
    ])("participant missing score with %s and no match_score shows 待结算", (settlement_status) => {
      const state = buildCardState(item({ ...noScore, settlement_status }), submitted({ match_score: null }));
      expect(state.stateText).toBe("已结束");
      expect(state.scoreSub).toBe("待结算");
      expect(state.predText).toBe("已提交 2 : 1 · 不可修改");
      expect(state.predText).not.toContain("得分");
      expect(state.chipText).toBe("");
      assertNoDuplication(state);
    });

    it.each([
      [0],
      [12],
    ])("participant settled missing score with match_score %s matches settlement facts", (match_score) => {
      const state = buildCardState(
        item({ ...noScore, settlement_status: "settled" }),
        submitted({ match_score }),
      );
      expect(state.stateText).toBe("已结束");
      expect(state.scoreSub).toBe("");
      expect(state.scoreSub).not.toBe("待结算");
      expect(state.predText).toBe(`我的预测 2 : 1 · 得分 +${match_score}`);
      expect(state.chipText).toBe("");
      assertNoDuplication(state);
    });

    it.each([
      ["pending"],
      ["not_ready"],
      ["waiting"],
    ])("participant %s missing score with match_score 0 follows personal score, not 待结算", (settlement_status) => {
      const state = buildCardState(
        item({ ...noScore, settlement_status }),
        submitted({ match_score: 0 }),
      );
      expect(state.stateText).toBe("已结束");
      expect(state.scoreSub).toBe("");
      expect(state.scoreSub).not.toBe("待结算");
      expect(state.predText).toBe("我的预测 2 : 1 · 得分 +0");
      assertNoDuplication(state);
    });

    it("does not treat null or unknown settlement_status as settled", () => {
      const unknownStatuses = [undefined, null, "unknown"];
      for (const settlement_status of unknownStatuses) {
        const withPred = buildCardState(
          item({ ...noScore, settlement_status }),
          submitted({ match_score: null }),
        );
        expect(withPred.stateText).toBe("已结束");
        expect(withPred.scoreSub).toBe("");
        expect(withPred.scoreSub).not.toBe("待结算");
        expect(withPred.predText).toBe("已提交 2 : 1 · 不可修改");
        expect(withPred.predText).not.toContain("得分");

        const settledOnlyByGuess = buildCardState(
          item({ ...complete, settlement_status }),
          submitted({ match_score: null }),
        );
        expect(settledOnlyByGuess.scoreSub).toBe("FT");
        expect(settledOnlyByGuess.predText).toBe("已提交 2 : 1 · 不可修改");
      }
    });

    it("keeps complete scores including 0-0 as FT regardless of settlement_status", () => {
      expect(buildCardState(item({ ...complete, settlement_status: "waiting" }), null).scoreSub).toBe("FT");
      expect(buildCardState(item({ ...complete, settlement_status: "settled" }), null).scoreSub).toBe("FT");
      expect(buildCardState(item({ ...complete, settlement_status: "correcting" }), submitted({ match_score: 12 })).scoreSub).toBe("FT");
      expect(buildCardState(item({ ...complete, settlement_status: "not_ready" }), submitted()).scoreSub).toBe("FT");
      expect(buildCardState(item({ ...complete, settlement_status: "pending" }), null).scoreSub).toBe("FT");
      expect(buildCardState(item(zeroZero), null).scoreSub).toBe("FT");
      expect(buildCardState(item({ ...zeroZero, settlement_status: "settled" }), submitted({ match_score: 0 })).scoreSub).toBe("FT");
      expect(buildCardState(item(complete), null).predText).toBe("未预测");
      expect(buildCardState(item({ ...complete, settlement_status: "waiting" }), submitted({ match_score: null })).predText).toBe("已提交 2 : 1 · 不可修改");
      expect(buildCardState(item({ ...complete, settlement_status: "settled" }), submitted({ match_score: 0 })).predText).toBe("我的预测 2 : 1 · 得分 +0");
      expect(buildCardState(item({ ...complete, settlement_status: "correcting" }), submitted({ match_score: 12 })).predText).toBe("我的预测 2 : 1 · 得分 +12");
      expect(buildCardState(item(complete), null).scoreSub).not.toBe("待结算");
    });

    it("does not invent copy for correcting, voided, or failed when score is missing", () => {
      for (const settlement_status of ["correcting", "voided", "failed"]) {
        const nonParticipant = buildCardState(item({ ...noScore, settlement_status }), null);
        expect(nonParticipant.stateText).toBe("已结束");
        expect(nonParticipant.predText).toBe("未预测");
        expect(nonParticipant.scoreSub).not.toBe("待结算");
        expect(allowedScoreSub.has(nonParticipant.scoreSub)).toBe(true);

        const pendingPersonal = buildCardState(
          item({ ...noScore, settlement_status }),
          submitted({ match_score: null }),
        );
        expect(pendingPersonal.stateText).toBe("已结束");
        expect(pendingPersonal.predText).toBe("已提交 2 : 1 · 不可修改");
        expect(allowedScoreSub.has(pendingPersonal.scoreSub)).toBe(true);

        const scored = buildCardState(
          item({ ...noScore, settlement_status }),
          submitted({ match_score: 0 }),
        );
        expect(scored.predText).toBe("我的预测 2 : 1 · 得分 +0");
        expect(scored.scoreSub).not.toBe("待结算");
        expect(allowedScoreSub.has(scored.scoreSub)).toBe(true);
      }
    });
  });

  it("keeps finished complete scores as FT when settlement_status is absent", () => {
    const state = buildCardState(
      item({ match_status: "finished", regular_home_score: 3, regular_away_score: 0, can_predict_reason: "CLOSED" }),
      null,
    );
    expect(state.scoreSub).toBe("FT");
    expect(state.predText).toBe("未预测");
    expect(state.scoreSub).not.toBe("待结算");
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

  it("[CR50-05] models pending-sync submitted state explicitly without showing 未预测 or undefined", () => {
    const fromMarker = buildCardState(
      item({ can_predict: true, can_predict_reason: null }),
      { pendingSync: true, loginGeneration: 0 },
    );
    expect(fromMarker).toMatchObject({
      cardClass: "is-submitted",
      stateClass: "lock",
      stateText: "未开赛",
      predText: "已提交 · 比分同步中",
      chipText: "",
      showPredict: false,
    });
    expect(fromMarker.predText).not.toContain("未预测");
    expect(fromMarker.predText).not.toContain("undefined");
    assertNoDuplication(fromMarker);

    const fromReasonOnly = buildCardState(
      item({ can_predict: false, can_predict_reason: "ALREADY_SUBMITTED" }),
      null,
    );
    expect(fromReasonOnly).toMatchObject({
      cardClass: "is-submitted",
      stateClass: "lock",
      stateText: "未开赛",
      predText: "已提交 · 比分同步中",
      chipText: "",
      showPredict: false,
    });
    expect(fromReasonOnly.predText).not.toContain("未预测");
    expect(fromReasonOnly.predText).not.toContain("undefined");
    assertNoDuplication(fromReasonOnly);
  });
});
