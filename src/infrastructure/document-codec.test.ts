import { describe, expect, it } from "vitest";
import { defaultLevelState } from "../domain/types.js";
import { cloudBaseCollectionName, type CloudBaseDocument } from "./cloudbase-db.js";
import { decodeDocument, encodeDocument, encodeQueryValue } from "./document-codec.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const KICKOFF = new Date("2026-08-08T14:00:00.000Z");
const EVAL_AT = new Date("2026-08-04T02:00:00.000Z");

function userDoc(): CloudBaseDocument {
  return {
    _id: "u1",
    openid: "2026-08-09T12:00:00.000Z",
    unionid: null,
    nickname: "Sky",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_last_scoring_match_at: null,
    career_level: 1,
    career_best_level: 1,
    career_level_state: {
      ...defaultLevelState(),
      week_base_as_of: NOW,
      last_eval_as_of: EVAL_AT,
    },
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    schema_version: 1,
  };
}

describe("document-codec Date/JSONB 编解码", () => {
  it("把 Date 编码为规范 UTC ISO，且不改动入参", () => {
    const document = userDoc();
    const encoded = encodeDocument(document);
    expect(encoded.created_at).toBe("2026-08-09T12:00:00.000Z");
    expect(encoded.updated_at).toBe("2026-08-09T12:00:00.000Z");
    expect(encoded.career_last_scoring_match_at).toBeNull();
    expect((encoded.career_level_state as { week_base_as_of: string }).week_base_as_of).toBe(
      "2026-08-09T12:00:00.000Z",
    );
    expect((encoded.career_level_state as { last_eval_as_of: string }).last_eval_as_of).toBe(
      "2026-08-04T02:00:00.000Z",
    );
    expect(document.created_at).toBeInstanceOf(Date);
  });

  it("按 schema date 路径恢复 Date，含嵌套 level_state 与可空值", () => {
    const decoded = decodeDocument("users", encodeDocument(userDoc()));
    expect(decoded.created_at).toBeInstanceOf(Date);
    expect((decoded.created_at as Date).getTime()).toBe(NOW.getTime());
    expect(decoded.career_last_scoring_match_at).toBeNull();
    expect(decoded.deleted_at).toBeNull();
    const state = decoded.career_level_state as {
      week_base_as_of: Date | null;
      last_eval_as_of: Date | null;
      last_eval_rule_version: string | null;
    };
    expect(state.week_base_as_of).toBeInstanceOf(Date);
    expect(state.week_base_as_of?.getTime()).toBe(NOW.getTime());
    expect(state.last_eval_as_of).toBeInstanceOf(Date);
    expect(state.last_eval_as_of?.getTime()).toBe(EVAL_AT.getTime());
    expect(state.last_eval_rule_version).toBeNull();
  });

  it("不把长得像 ISO 的普通业务字符串变成 Date", () => {
    const decoded = decodeDocument("users", encodeDocument(userDoc()));
    expect(decoded.openid).toBe("2026-08-09T12:00:00.000Z");
    expect(typeof decoded.openid).toBe("string");

    const snapshot: CloudBaseDocument = {
      _id: "s1",
      snapshot_id: "s1",
      event_type: "discovered",
      entity_type: "match",
      entity_id: "m1",
      provider: "football_data",
      payload: { kickoff_at: "2026-08-08T14:00:00.000Z", note: "keep-string" },
      created_at: NOW,
      schema_version: 1,
    };
    const roundtrip = decodeDocument("provider_snapshots", encodeDocument(snapshot));
    expect(roundtrip.created_at).toBeInstanceOf(Date);
    expect((roundtrip.payload as { kickoff_at: string }).kickoff_at).toBe("2026-08-08T14:00:00.000Z");
    expect(typeof (roundtrip.payload as { kickoff_at: string }).kickoff_at).toBe("string");
  });

  it("物理集合名和别名都能找到 date 路径", () => {
    const encoded = encodeDocument({
      _id: "st1",
      user_id: "u1",
      level_season_id: "2026",
      points: 0,
      valid_predictions: 0,
      wdl_hits: 0,
      exact_hits: 0,
      last_scoring_match_at: KICKOFF,
      level: 1,
      best_level: 1,
      level_state: { ...defaultLevelState(), last_eval_as_of: EVAL_AT },
      is_level_frozen: false,
      created_at: NOW,
      updated_at: NOW,
      schema_version: 1,
    });
    const fromAlias = decodeDocument("stats", encoded);
    const fromPhysical = decodeDocument(cloudBaseCollectionName("football_test", "user_season_stats"), encoded);
    for (const decoded of [fromAlias, fromPhysical]) {
      expect(decoded.last_scoring_match_at).toBeInstanceOf(Date);
      expect((decoded.last_scoring_match_at as Date).getTime()).toBe(KICKOFF.getTime());
      expect((decoded.level_state as { last_eval_as_of: Date }).last_eval_as_of).toBeInstanceOf(Date);
    }
  });

  it("运行态 store 日期字段往返为 Date", () => {
    const usage = decodeDocument(
      "provider_usage",
      encodeDocument({
        _id: "usage1",
        source_id: "fd",
        bucket_type: "day",
        bucket_key: "2026-08-09",
        bucket_start: new Date("2026-08-09T00:00:00.000Z"),
        request_count: 1,
        created_at: NOW,
        updated_at: NOW,
        schema_version: 1,
      }),
    );
    expect(usage.bucket_start).toBeInstanceOf(Date);
    expect(usage.bucket_key).toBe("2026-08-09");

    const keyState = decodeDocument(
      cloudBaseCollectionName("football_test", "provider_key_state"),
      encodeDocument({
        _id: "k1",
        key_id: "fd#1",
        status: "cooldown",
        cooldown_until: NOW,
        network_errors: 0,
        last_error_code: "429",
        updated_at: NOW,
        schema_version: 1,
      }),
    );
    expect(keyState.cooldown_until).toBeInstanceOf(Date);

    const scheduler = decodeDocument("scheduler_state", {
      _id: "settlement_fallback",
      cursor_kickoff_at: KICKOFF.toISOString(),
      cursor_match_id: "m1",
      last_run_at: NOW.getTime(),
      updated_at: NOW.toISOString(),
    });
    expect(scheduler.cursor_kickoff_at).toBeInstanceOf(Date);
    expect((scheduler.cursor_kickoff_at as Date).getTime()).toBe(KICKOFF.getTime());
    expect((scheduler.last_run_at as Date).getTime()).toBe(NOW.getTime());

    const cycle = decodeDocument("scheduler_state", {
      _id: "period_finalize",
      job_type: "period_finalize",
      completed_cycle_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    expect(cycle.completed_cycle_at).toBeInstanceOf(Date);
    expect((cycle.completed_cycle_at as Date).getTime()).toBe(NOW.getTime());
  });

  it("未知集合不把 ISO 字符串一律变成 Date", () => {
    const document: CloudBaseDocument = {
      _id: "x",
      created_at: "2026-08-09T12:00:00.000Z",
      note: "2026-08-09T12:00:00.000Z",
    };
    const decoded = decodeDocument("not_a_collection", document);
    expect(decoded.created_at).toBe("2026-08-09T12:00:00.000Z");
    expect(decoded).toBe(document);
  });

  it("无效 Date 在编码时拒绝", () => {
    expect(() => encodeDocument({ _id: "x", created_at: new Date("invalid") })).toThrow("invalid Date");
    expect(() => encodeQueryValue(new Date(Number.NaN))).toThrow("invalid Date");
  });

  it("查询值中的 Date/嵌套条件编码为同一 UTC ISO", () => {
    expect(encodeQueryValue(KICKOFF)).toBe("2026-08-08T14:00:00.000Z");
    expect(encodeQueryValue({ kickoff_at: { __lte: NOW } })).toEqual({
      kickoff_at: { __lte: "2026-08-09T12:00:00.000Z" },
    });
    expect(encodeQueryValue(["a", NOW])).toEqual(["a", "2026-08-09T12:00:00.000Z"]);
    expect(encodeQueryValue(null)).toBeNull();
  });
});
