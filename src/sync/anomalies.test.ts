import { describe, expect, it } from "vitest";
import { MatchStatus } from "../domain/enums.js";
import {
  finishedNoScoreDecision,
  liveSyncStaleDecision,
  liveTooLongDecision,
  type AnomalyDecision,
} from "./anomalies.js";

const { Live, Finished, Scheduled } = MatchStatus;

const NOW = new Date("2026-08-08T14:30:00Z");
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const after = (n: number) => new Date(NOW.getTime() + n * 60_000);

function openList(decisions: AnomalyDecision[]): AnomalyDecision[] {
  return decisions.filter((d) => d.open);
}

describe("LIVE_SYNC_STALE（33.1）", () => {
  it("live 且连续 10 分钟无成功同步 -> open，blocking=false", () => {
    const d = liveSyncStaleDecision(Live, min(11), NOW);
    expect(d.open).toBe(true);
    expect(d.blocking).toBe(false);
  });

  it("live 且从未成功同步 -> open", () => {
    expect(liveSyncStaleDecision(Live, null, NOW).open).toBe(true);
  });

  it("live 且 10 分钟内成功同步 -> resolve（恢复成功自动 resolve）", () => {
    const d = liveSyncStaleDecision(Live, min(1), NOW);
    expect(d.open).toBe(false);
    expect(d.resolve?.resolution).toBeTruthy();
  });

  it("非 live -> resolve", () => {
    expect(liveSyncStaleDecision(Finished, min(11), NOW).open).toBe(false);
  });
});

describe("LIVE_TOO_LONG（33.2）", () => {
  it("live 且 server_now >= period_anchor_at + 150min -> open", () => {
    const d = liveTooLongDecision(Live, min(151), NOW);
    expect(d?.open).toBe(true);
  });

  it("live 且未超过 150min -> resolve（触发条件消失）", () => {
    const d = liveTooLongDecision(Live, min(149), NOW);
    expect(d?.open).toBe(false);
  });

  it("非 live -> resolve", () => {
    const d = liveTooLongDecision(Finished, min(151), NOW);
    expect(d?.open).toBe(false);
  });

  it("无 period_anchor_at -> 无法判定，返回 null", () => {
    expect(liveTooLongDecision(Live, null, NOW)).toBeNull();
  });
});

describe("FINISHED_NO_SCORE（33.3）", () => {
  it("finished 后 20 分钟仍无合法 score -> open，blocking=true", () => {
    const d = finishedNoScoreDecision(Finished, min(21), false, NOW);
    expect(d.open).toBe(true);
    expect(d.blocking).toBe(true);
  });

  it("finished 但未到 20 分钟 -> resolve（尚未触发）", () => {
    expect(finishedNoScoreDecision(Finished, min(19), false, NOW).open).toBe(false);
  });

  it("finished 且已有合法 score -> resolve（确定性规则：分数已到）", () => {
    const d = finishedNoScoreDecision(Finished, min(21), true, NOW);
    expect(d.open).toBe(false);
  });

  it("非 finished -> resolve", () => {
    expect(finishedNoScoreDecision(Scheduled, min(21), false, NOW).open).toBe(false);
    expect(finishedNoScoreDecision(Live, min(21), false, NOW).open).toBe(false);
  });

  it("finish_detected_at 缺失 -> 不触发", () => {
    expect(finishedNoScoreDecision(Finished, null, false, NOW).open).toBe(false);
  });
});

describe("异常决策边界", () => {
  it("resolve 决策附带 resolution 说明（33.6 确定性规则）", () => {
    const d = liveTooLongDecision(Live, after(10), NOW);
    expect(d?.open).toBe(false);
    expect(d?.resolve?.resolution.length).toBeGreaterThan(0);
  });
});
