import { describe, expect, it } from "vitest";
import { decidePredictionClosedAt } from "./prediction-deadline.js";
import { MatchStatus } from "./enums.js";

describe("B. 截止时间 - prediction_closed_at 关闭（规范 6.4 / 44-B / 49.4 真值表）", () => {
  const deadline = new Date("2026-08-08T05:50:00Z");
  const earlyLiveNow = new Date("2026-08-08T05:20:00Z");
  const afterDeadline = new Date("2026-08-08T06:00:00Z");

  function scheduledOpenMatch() {
    return {
      prediction_closed_at: null,
      prediction_deadline_at: deadline,
      match_status: MatchStatus.Scheduled,
    };
  }

  it("B15 live 提前出现时立即永久关闭（写 server_now）", () => {
    expect(decidePredictionClosedAt(scheduledOpenMatch(), MatchStatus.Live, earlyLiveNow)).toBe(
      earlyLiveNow,
    );
  });

  it("B16 finished 首次发现时若仍未关闭，立即关闭（写 server_now）", () => {
    expect(
      decidePredictionClosedAt(scheduledOpenMatch(), MatchStatus.Finished, earlyLiveNow),
    ).toBe(earlyLiveNow);
  });

  it("6.4.2 一旦非 null 永不恢复：已关闭则不再变更", () => {
    const closed = { ...scheduledOpenMatch(), prediction_closed_at: new Date("2026-08-08T05:00:00Z") };
    expect(decidePredictionClosedAt(closed, MatchStatus.Live, earlyLiveNow)).toBe(null);
    expect(decidePredictionClosedAt(closed, MatchStatus.Finished, earlyLiveNow)).toBe(null);
  });

  it("6.4.4 正常到截止时间写 prediction_deadline_at", () => {
    const atDeadline = new Date(deadline.getTime() + 1);
    expect(decidePredictionClosedAt(scheduledOpenMatch(), MatchStatus.Scheduled, atDeadline)).toBe(
      deadline,
    );
  });

  it("scheduled 且 deadline 未到时保持开放", () => {
    expect(
      decidePredictionClosedAt(scheduledOpenMatch(), MatchStatus.Scheduled, new Date("2026-08-08T05:00:00Z")),
    ).toBe(null);
  });

  it("49.4 scheduled 未关闭且 now >= deadline 时写 closed_at=deadline（含截止后才延期的转入）", () => {
    expect(
      decidePredictionClosedAt(scheduledOpenMatch(), MatchStatus.Postponed, afterDeadline),
    ).toBe(deadline);
  });

  it("49.4 postponed 未关闭时，即使 now >= 旧 deadline 也不写 closed_at", () => {
    const postponedOpen = {
      prediction_closed_at: null,
      prediction_deadline_at: deadline,
      match_status: MatchStatus.Postponed,
    };
    expect(decidePredictionClosedAt(postponedOpen, MatchStatus.Postponed, afterDeadline)).toBe(null);
  });

  it("49.4 postponed 已关闭时保持（永不重开）", () => {
    const postponedClosed = {
      prediction_closed_at: new Date("2026-08-08T05:00:00Z"),
      prediction_deadline_at: deadline,
      match_status: MatchStatus.Postponed,
    };
    expect(decidePredictionClosedAt(postponedClosed, MatchStatus.Postponed, afterDeadline)).toBe(null);
  });

  it("postponed 不直接关闭", () => {
    expect(decidePredictionClosedAt(scheduledOpenMatch(), MatchStatus.Postponed, earlyLiveNow)).toBe(null);
  });
});
