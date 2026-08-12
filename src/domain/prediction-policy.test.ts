import { describe, expect, it } from "vitest";
import {
  assertPredictionPayload,
  canSubmitPrediction,
  isDeadlineOpen,
  predictRejectCode,
  predictRejectReason,
  validatePredictionScores,
} from "./prediction-policy.js";
import { UserStatus } from "./enums.js";

const activeUser = { status: UserStatus.Active };
const deletedUser = { status: UserStatus.Deleted };

function openMatch(deadline: Date) {
  return {
    match_status: "scheduled" as const,
    kickoff_confirmed: true,
    prediction_closed_at: null,
    prediction_deadline_at: deadline,
  };
}

function dateAt(iso: string): Date {
  return new Date(iso);
}

describe("A. 预测与比分 - 输入校验（规范 44-A）", () => {
  it("A6 预测 -1 拒绝", () => {
    expect(() => validatePredictionScores(-1, 0)).toThrow(/超出允许范围/);
  });

  it("A7 预测 21 拒绝", () => {
    expect(() => validatePredictionScores(21, 0)).toThrow(/超出允许范围/);
  });

  it("A8 字符串 \"2\" 拒绝", () => {
    expect(() => validatePredictionScores("2", 0)).toThrow(/必须为整数/);
    expect(() => validatePredictionScores(0, "2")).toThrow(/必须为整数/);
  });

  it("A9 2.5 等非整数拒绝；JSON 2.0 解析为整数值 2 时允许", () => {
    expect(() => validatePredictionScores(2.5, 0)).toThrow(/必须为整数/);
    expect(() => validatePredictionScores(0, 2.5)).toThrow(/必须为整数/);

    const parsed = JSON.parse('{"home_score": 2.0, "away_score": 1.0}') as {
      home_score: number;
      away_score: number;
    };
    expect(Number.isInteger(parsed.home_score)).toBe(true);
    expect(() => validatePredictionScores(parsed.home_score, parsed.away_score)).not.toThrow();
  });

  it("null / 缺失比分拒绝", () => {
    expect(() => validatePredictionScores(null, 0)).toThrow(/必须为整数/);
    expect(() => validatePredictionScores(undefined, 0)).toThrow(/必须为整数/);
  });

  it("边界值 0 与 20 允许，范围外 20 分整 + 拒绝", () => {
    expect(() => validatePredictionScores(0, 20)).not.toThrow();
    expect(() => validatePredictionScores(20, 0)).not.toThrow();
    expect(() => validatePredictionScores(0, 20.5)).toThrow();
  });

  it("A10 用户提交 derived_result 字段拒绝", () => {
    expect(() => assertPredictionPayload({ derived_result: "HOME" })).toThrow(
      /未定义字段/,
    );
  });

  it("拒绝其余必须由服务端生成的字段", () => {
    for (const field of [
      "user_id",
      "match_score",
      "wdl_hit",
      "exact_hit",
      "submitted_at",
      "scoring_rule_version",
      "client_time",
    ]) {
      expect(() =>
        assertPredictionPayload({ idempotency_key: "k", match_id: "m", home_score: 1, away_score: 0, [field]: 1 }),
      ).toThrow(/未定义字段/);
    }
  });

  it("合法 payload 通过", () => {
    expect(() =>
      assertPredictionPayload({
        idempotency_key: "k",
        match_id: "m",
        home_score: 1,
        away_score: 0,
      }),
    ).not.toThrow();
  });
});

describe("B. 截止时间 - 提交边界（规范 44-B）", () => {
  const deadline = dateAt("2026-08-08T05:50:00Z");

  it("B11 deadline 前 1ms 可提交", () => {
    const before = new Date(deadline.getTime() - 1);
    expect(canSubmitPrediction(activeUser, openMatch(deadline), null, before)).toBe(true);
  });

  it("B12 恰好 deadline 拒绝", () => {
    expect(canSubmitPrediction(activeUser, openMatch(deadline), null, deadline)).toBe(false);
  });

  it("B13 deadline 后拒绝", () => {
    const after = new Date(deadline.getTime() + 1);
    expect(canSubmitPrediction(activeUser, openMatch(deadline), null, after)).toBe(false);
  });

  it("B14 修改客户端手机时间不能绕过：只使用服务端 server_now，且客户端无法夹带时间字段", () => {
    const before = new Date(deadline.getTime() - 60_000);
    const after = new Date(deadline.getTime() + 60_000);
    expect(canSubmitPrediction(activeUser, openMatch(deadline), null, before)).toBe(true);
    expect(canSubmitPrediction(activeUser, openMatch(deadline), null, after)).toBe(false);
    expect(() =>
      assertPredictionPayload({
        idempotency_key: "k",
        match_id: "m",
        home_score: 1,
        away_score: 0,
        client_time: before.toISOString(),
      }),
    ).toThrow(/未定义字段/);
  });

  it("isDeadlineOpen：null deadline 永不开放", () => {
    expect(isDeadlineOpen(null, new Date("2026-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("B. 截止时间 - can_submit_prediction 其它条件（规范 8.4）", () => {
  const deadline = dateAt("2026-08-08T05:50:00Z");
  const now = dateAt("2026-08-08T05:00:00Z");

  it("deleted 用户拒绝", () => {
    expect(canSubmitPrediction(deletedUser, openMatch(deadline), null, now)).toBe(false);
  });

  it("非 scheduled 比赛拒绝", () => {
    const match = { ...openMatch(deadline), match_status: "postponed" as const };
    expect(canSubmitPrediction(activeUser, match, null, now)).toBe(false);
  });

  it("kickoff 未确认（deadline=null）拒绝", () => {
    const match = { ...openMatch(deadline), kickoff_confirmed: false, prediction_deadline_at: null };
    expect(canSubmitPrediction(activeUser, match, null, now)).toBe(false);
  });

  it("已关闭（prediction_closed_at != null）拒绝", () => {
    const match = { ...openMatch(deadline), prediction_closed_at: now };
    expect(canSubmitPrediction(activeUser, match, null, now)).toBe(false);
  });

  it("已有 prediction 拒绝（不可覆盖）", () => {
    expect(
      canSubmitPrediction(activeUser, openMatch(deadline), { prediction_id: "p1" }, now),
    ).toBe(false);
  });
});

describe("49.2 predictRejectReason 优先级 1→6 命中即停", () => {
  const deadline = dateAt("2026-08-08T05:50:00Z");
  const now = dateAt("2026-08-08T05:00:00Z");
  const openMatch = () => ({
    match_status: "scheduled" as const,
    kickoff_confirmed: true,
    prediction_closed_at: null,
    prediction_deadline_at: deadline,
  });

  it("优先级1：无可信用户 → AUTH_REQUIRED（即使比赛可预测）", () => {
    expect(
      predictRejectReason({ user: null, match: openMatch(), existingPrediction: null, serverNow: now }),
    ).toBe("AUTH_REQUIRED");
  });

  it("优先级2：用户已注销 → USER_DELETED", () => {
    expect(
      predictRejectReason({ user: deletedUser, match: openMatch(), existingPrediction: null, serverNow: now }),
    ).toBe("USER_DELETED");
  });

  it("优先级3：已有预测 → ALREADY_SUBMITTED（优先于非 scheduled 等后置条件）", () => {
    const postponed = { ...openMatch(), match_status: "postponed" as const };
    expect(
      predictRejectReason({ user: activeUser, match: postponed, existingPrediction: { prediction_id: "p1" }, serverNow: now }),
    ).toBe("ALREADY_SUBMITTED");
  });

  it("优先级4：match_status != scheduled → NOT_SCHEDULED（含 postponed）", () => {
    for (const status of ["live", "finished", "postponed", "cancelled", "abandoned"]) {
      expect(
        predictRejectReason({
          user: activeUser,
          match: { ...openMatch(), match_status: status as never },
          existingPrediction: null,
          serverNow: now,
        }),
      ).toBe("NOT_SCHEDULED");
    }
  });

  it("优先级5：kickoff 未确认或 deadline=null → KICKOFF_UNCONFIRMED", () => {
    expect(
      predictRejectReason({
        user: activeUser,
        match: { ...openMatch(), kickoff_confirmed: false, prediction_deadline_at: null },
        existingPrediction: null,
        serverNow: now,
      }),
    ).toBe("KICKOFF_UNCONFIRMED");
    expect(
      predictRejectReason({
        user: activeUser,
        match: { ...openMatch(), prediction_deadline_at: null },
        existingPrediction: null,
        serverNow: now,
      }),
    ).toBe("KICKOFF_UNCONFIRMED");
  });

  it("优先级6：closed_at != null 或墙钟已过 deadline → CLOSED", () => {
    expect(
      predictRejectReason({
        user: activeUser,
        match: { ...openMatch(), prediction_closed_at: now },
        existingPrediction: null,
        serverNow: now,
      }),
    ).toBe("CLOSED");
    expect(
      predictRejectReason({ user: activeUser, match: openMatch(), existingPrediction: null, serverNow: deadline }),
    ).toBe("CLOSED");
    expect(
      predictRejectReason({
        user: activeUser,
        match: openMatch(),
        existingPrediction: null,
        serverNow: new Date(deadline.getTime() + 1),
      }),
    ).toBe("CLOSED");
  });

  it("全部满足 → null 可预测", () => {
    expect(
      predictRejectReason({ user: activeUser, match: openMatch(), existingPrediction: null, serverNow: now }),
    ).toBeNull();
  });

  it("predictRejectCode 按 49.2 表映射到 POST 错误码", () => {
    expect(predictRejectCode("AUTH_REQUIRED")).toBe("UNAUTHORIZED");
    expect(predictRejectCode("USER_DELETED")).toBe("USER_DELETED");
    expect(predictRejectCode("ALREADY_SUBMITTED")).toBe("PREDICTION_ALREADY_SUBMITTED");
    expect(predictRejectCode("NOT_SCHEDULED")).toBe("MATCH_NOT_PREDICTABLE");
    expect(predictRejectCode("KICKOFF_UNCONFIRMED")).toBe("MATCH_NOT_PREDICTABLE");
    expect(predictRejectCode("CLOSED")).toBe("PREDICTION_LOCKED");
  });
});
