import { describe, expect, it } from "vitest";
import { AnomalyType } from "../domain/enums.js";
import { makeApiFixture } from "./fixture-factory.js";
import { normalizeFixture } from "./fixture-mapper.js";
import type { ApiFootballFixture } from "./types.js";

describe("fixture normalize mapper（31.3/31.4/31.5）", () => {
  it("关键 fixture 对象缺失时返回 fail-closed 结果而不是抛运行时错误", () => {
    const result = normalizeFixture({} as ApiFootballFixture);

    expect(result.entityFailed).toBe(true);
    expect(result.fixture.providerMatchId).toBe("");
    expect(result.fixture.status).toEqual({ kind: "missing" });
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        type: AnomalyType.ProviderDataInvalid,
        details: { field: "fixture" },
      }),
    );
  });

  it("NS fixture -> scheduled + kickoff_confirmed=true", () => {
    const result = normalizeFixture(makeApiFixture({ statusShort: "NS" }));
    expect(result.entityFailed).toBe(false);
    expect(result.anomalies).toEqual([]);
    expect(result.fixture.status).toEqual({ kind: "scheduled", kickoffConfirmed: true });
    expect(result.fixture.providerMatchId).toBe("1100001");
    expect(result.fixture.homeTeamProviderId).toBe("40");
    expect(result.fixture.awayTeamProviderId).toBe("41");
    expect(result.fixture.kickoffAt?.toISOString()).toBe("2026-08-08T14:00:00.000Z");
  });

  it("TBD -> scheduled + kickoff_confirmed=false", () => {
    const result = normalizeFixture(makeApiFixture({ statusShort: "TBD" }));
    expect(result.fixture.status).toEqual({ kind: "scheduled", kickoffConfirmed: false });
  });

  it("FT + 合法 fulltime -> finished + 正式比分抽取（31.4）", () => {
    const result = normalizeFixture(
      makeApiFixture({ statusShort: "FT", fulltimeHome: 2, fulltimeAway: 1 }),
    );
    expect(result.anomalies).toEqual([]);
    expect(result.fixture.status).toEqual({ kind: "finished" });
    expect(result.fixture.fulltime).toEqual({ home: 2, away: 1 });
  });

  it("FT + fulltime 为 null -> INVALID_FINAL_SCORE blocking，不产出比分", () => {
    const result = normalizeFixture(
      makeApiFixture({ statusShort: "FT", fulltimeHome: null, fulltimeAway: null }),
    );
    expect(result.fixture.fulltime).toBeNull();
    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        type: AnomalyType.InvalidFinalScore,
        blocking: true,
      }),
    );
  });

  it("FT + fulltime 非整数 / <0 / >99 -> INVALID_FINAL_SCORE blocking", () => {
    for (const bad of [
      { fulltimeHome: "2" as unknown as number, fulltimeAway: 1 },
      { fulltimeHome: -1, fulltimeAway: 1 },
      { fulltimeHome: 100, fulltimeAway: 1 },
      { fulltimeHome: 2, fulltimeAway: 2.5 },
    ] as const) {
      const result = normalizeFixture(
        makeApiFixture({ statusShort: "FT", ...bad }),
      );
      expect(result.fixture.fulltime).toBeNull();
      expect(result.entityFailed).toBe(true);
      expect(result.anomalies).toContainEqual(
        expect.objectContaining({
          type: AnomalyType.InvalidFinalScore,
          blocking: true,
        }),
      );
    }
  });

  it("ET/AET/PEN -> UNEXPECTED_PROVIDER_STATUS blocking；即使带 fulltime 也不抽取", () => {
    for (const raw of ["ET", "AET", "PEN", "P", "BT", "XYZ"]) {
      const result = normalizeFixture(
        makeApiFixture({ statusShort: raw, fulltimeHome: 3, fulltimeAway: 2 }),
      );
      expect(result.fixture.status).toEqual({ kind: "unexpected", raw });
      expect(result.fixture.fulltime).toBeNull();
      expect(result.entityFailed).toBe(true);
      expect(result.anomalies).toContainEqual(
        expect.objectContaining({
          type: AnomalyType.UnexpectedProviderStatus,
          blocking: true,
        }),
      );
    }
  });

  it("缺失 status -> PROVIDER_DATA_INVALID + entityFailed", () => {
    const result = normalizeFixture(makeApiFixture({ statusShort: "" }));
    expect(result.fixture.status).toEqual({ kind: "missing" });
    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({ type: AnomalyType.ProviderDataInvalid }),
    );
  });

  it("缺失 kickoff（date 与 timestamp 均缺）-> PROVIDER_DATA_INVALID + entityFailed，不清空已存值", () => {
    const result = normalizeFixture(
      makeApiFixture({ date: "garbage-date", timestamp: Number.NaN }),
    );
    expect(result.fixture.kickoffAt).toBeNull();
    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({ type: AnomalyType.ProviderDataInvalid }),
    );
  });

  it("timestamp 与 date 偏差 > 60s -> PROVIDER_DATA_INVALID + entityFailed，不产出 kickoff", () => {
    const result = normalizeFixture(
      makeApiFixture({
        timestamp: Date.parse("2026-08-08T14:00:00Z") / 1000,
        date: "2026-08-08T14:01:05Z",
      }),
    );
    expect(result.fixture.kickoffAt).toBeNull();
    expect(result.fixture.kickoffDeltaMs).toBe(65_000);
    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        type: AnomalyType.ProviderDataInvalid,
        blocking: false,
      }),
    );
  });

  it("缺失球队 -> PROVIDER_DATA_INVALID + entityFailed", () => {
    const fixture = makeApiFixture({});
    (fixture.teams.home as unknown) = { id: undefined };
    const result = normalizeFixture(fixture);
    expect(result.fixture.homeTeamProviderId).toBe("");
    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({ type: AnomalyType.ProviderDataInvalid }),
    );
  });

  it("缺失联赛 id -> PROVIDER_DATA_INVALID + entityFailed", () => {
    const fixture = makeApiFixture();
    delete (fixture.league as unknown as { id?: number }).id;

    const result = normalizeFixture(fixture);

    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        type: AnomalyType.ProviderDataInvalid,
        details: { field: "league.id" },
      }),
    );
  });

  it("非 MVP 英超联赛 -> PROVIDER_DATA_INVALID + entityFailed", () => {
    const result = normalizeFixture(makeApiFixture({ leagueId: 40 }));

    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        type: AnomalyType.ProviderDataInvalid,
        details: expect.objectContaining({
          field: "league.id",
          expected: "39",
          actual: "40",
        }),
      }),
    );
  });

  it("非 MVP 赛季 -> PROVIDER_DATA_INVALID + entityFailed", () => {
    const result = normalizeFixture(makeApiFixture({ season: "2025" }));

    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        type: AnomalyType.ProviderDataInvalid,
        details: expect.objectContaining({
          field: "league.season",
          expected: "2026",
          actual: "2025",
        }),
      }),
    );
  });

  it("缺失 round -> PROVIDER_DATA_INVALID + entityFailed", () => {
    const fixture = makeApiFixture();
    delete (fixture.league as unknown as { round?: string }).round;

    const result = normalizeFixture(fixture);

    expect(result.entityFailed).toBe(true);
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        type: AnomalyType.ProviderDataInvalid,
        details: { field: "league.round" },
      }),
    );
  });

  it("1H -> live，不抽取比分", () => {
    const result = normalizeFixture(
      makeApiFixture({ statusShort: "1H", fulltimeHome: 1, fulltimeAway: 0 }),
    );
    expect(result.fixture.status).toEqual({ kind: "live" });
    expect(result.fixture.fulltime).toBeNull();
  });

  it("round / league / season 透传；round 缺失时 null", () => {
    const result = normalizeFixture(
      makeApiFixture({ round: "Round 5", season: "2026", leagueId: 39 }),
    );
    expect(result.fixture.round).toBe("Round 5");
    expect(result.fixture.season).toBe("2026");
    expect(result.fixture.leagueProviderId).toBe("39");
  });
});
