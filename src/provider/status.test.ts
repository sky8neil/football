import { describe, expect, it } from "vitest";
import { mapProviderStatus } from "./status.js";

describe("Provider status 映射（规范 31.3）", () => {
  it("TBD -> scheduled, kickoff_confirmed=false", () => {
    expect(mapProviderStatus("TBD")).toEqual({
      kind: "scheduled",
      kickoffConfirmed: false,
    });
  });

  it("NS -> scheduled, kickoff_confirmed=true", () => {
    expect(mapProviderStatus("NS")).toEqual({
      kind: "scheduled",
      kickoffConfirmed: true,
    });
  });

  it("1H / HT / 2H / SUSP / INT / LIVE -> live", () => {
    for (const raw of ["1H", "HT", "2H", "SUSP", "INT", "LIVE"]) {
      expect(mapProviderStatus(raw)).toEqual({ kind: "live" });
    }
  });

  it("PST -> postponed", () => {
    expect(mapProviderStatus("PST")).toEqual({ kind: "postponed" });
  });

  it("CANC / AWD / WO -> cancelled", () => {
    for (const raw of ["CANC", "AWD", "WO"]) {
      expect(mapProviderStatus(raw)).toEqual({ kind: "cancelled" });
    }
  });

  it("ABD -> abandoned", () => {
    expect(mapProviderStatus("ABD")).toEqual({ kind: "abandoned" });
  });

  it("FT -> finished", () => {
    expect(mapProviderStatus("FT")).toEqual({ kind: "finished" });
  });

  it("ET / BT / P / AET / PEN -> unexpected（MVP 英超不应出现）", () => {
    for (const raw of ["ET", "BT", "P", "AET", "PEN"]) {
      expect(mapProviderStatus(raw)).toEqual({ kind: "unexpected", raw });
    }
  });

  it("未知状态 -> unexpected 并保留原始值", () => {
    expect(mapProviderStatus("XYZ")).toEqual({ kind: "unexpected", raw: "XYZ" });
  });

  it("缺失状态 -> missing", () => {
    expect(mapProviderStatus(undefined)).toEqual({ kind: "missing" });
    expect(mapProviderStatus(null)).toEqual({ kind: "missing" });
    expect(mapProviderStatus("")).toEqual({ kind: "missing" });
  });
});
