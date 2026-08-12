import { describe, expect, it } from "vitest";
import { parseKickoff } from "./kickoff.js";

const TOLERANCE_MS = 60_000;

describe("UTC kickoff 解析与校验（规范 31.2）", () => {
  const ts = Date.parse("2026-08-08T14:00:00Z") / 1000;

  it("仅 timestamp 可用", () => {
    const r = parseKickoff(ts, undefined, TOLERANCE_MS);
    expect(r.kickoffAt?.toISOString()).toBe("2026-08-08T14:00:00.000Z");
    expect(r.missing).toBe(false);
    expect(r.mismatch).toBe(false);
  });

  it("仅 date 可用", () => {
    const r = parseKickoff(undefined, "2026-08-08T14:00:00Z", TOLERANCE_MS);
    expect(r.kickoffAt?.toISOString()).toBe("2026-08-08T14:00:00.000Z");
    expect(r.missing).toBe(false);
  });

  it("timestamp 与 date 一致（偏差 < 60s）优先 timestamp，偏差记录 delta", () => {
    const r = parseKickoff(
      ts,
      "2026-08-08T14:00:30Z",
      TOLERANCE_MS,
    );
    expect(r.kickoffAt?.toISOString()).toBe("2026-08-08T14:00:00.000Z");
    expect(r.mismatch).toBe(false);
    expect(r.deltaMs).toBe(30_000);
  });

  it("timestamp 与 date 偏差超过 60s -> PROVIDER_DATA_INVALID，不产出 kickoff", () => {
    const r = parseKickoff(ts, "2026-08-08T14:01:05Z", TOLERANCE_MS);
    expect(r.mismatch).toBe(true);
    expect(r.kickoffAt).toBeNull();
    expect(r.deltaMs).toBe(65_000);
  });

  it("两者都缺失 -> missing", () => {
    const r = parseKickoff(undefined, undefined, TOLERANCE_MS);
    expect(r.missing).toBe(true);
    expect(r.kickoffAt).toBeNull();
  });

  it("已提供但非法类型的来源使 kickoff fail closed", () => {
    const r = parseKickoff("not-a-number", "2026-08-08T14:00:00Z", TOLERANCE_MS);
    expect(r.missing).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.kickoffAt).toBeNull();
  });

  it("已提供但非法 date 字符串使 kickoff fail closed", () => {
    const r = parseKickoff(ts, "garbage-date", TOLERANCE_MS);
    expect(r.missing).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.kickoffAt).toBeNull();
  });

  it("有限但超出 Date 范围的 timestamp 标记 invalid", () => {
    const r = parseKickoff(Number.MAX_VALUE, undefined, TOLERANCE_MS);
    expect(r.kickoffAt).toBeNull();
    expect(r.invalid).toBe(true);
    expect(r.missing).toBe(false);
  });

  it("Invalid Date timestamp 不覆盖合法 date", () => {
    const r = parseKickoff(Number.MAX_VALUE, "2026-08-08T14:00:00Z", TOLERANCE_MS);
    expect(r.kickoffAt).toBeNull();
    expect(r.invalid).toBe(true);
    expect(r.missing).toBe(false);
  });

  it("已提供但非法的 timestamp/date 任何一个出现时 fail closed", () => {
    const invalidTimestamp = parseKickoff(
      Number.POSITIVE_INFINITY,
      "2026-08-08T14:00:00Z",
      TOLERANCE_MS,
    );
    expect(invalidTimestamp).toMatchObject({
      kickoffAt: null,
      invalid: true,
      missing: false,
    });

    const invalidDate = parseKickoff(
      ts,
      "2026-02-30T25:61:00Z",
      TOLERANCE_MS,
    );
    expect(invalidDate).toMatchObject({
      kickoffAt: null,
      invalid: true,
      missing: false,
    });
  });
});
