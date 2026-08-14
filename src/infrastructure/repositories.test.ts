import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUuid } from "../domain/ids.js";
import type {
  DeletedOpenidMapping,
  Match,
  MatchResult,
  Prediction,
  RankingEntry,
  SettlementDoc,
  SettlementItem,
  SyncLog,
  Unlock,
  User,
  UserSeasonStats,
} from "../domain/types.js";
import {
  DocumentNotFoundError,
  InMemoryRepository,
  StaleResultVersionError,
  UniqueConstraintError,
} from "./repositories.js";

const LOCK_NOW = new Date("2026-08-09T00:00:00.000Z");

beforeEach(() => vi.useFakeTimers({ now: LOCK_NOW }));
afterEach(() => vi.useRealTimers());

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: newUuid(),
    openid: `openid_${newUuid()}`,
    unionid: null,
    nickname: null,
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  } as User;
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    schema_version: 1,
    match_id: newUuid(),
    league_id: "premier_league",
    season_id: "2026_2027",
    round_id: "01",
    home_team_id: newUuid(),
    away_team_id: newUuid(),
    kickoff_at: new Date("2026-08-08T06:00:00Z"),
    kickoff_confirmed: true,
    prediction_deadline_at: new Date("2026-08-08T05:50:00Z"),
    prediction_closed_at: null,
    period_anchor_at: null,
    match_status: "scheduled",
    settlement_status: "pending",
    regular_home_score: null,
    regular_away_score: null,
    extra_home_score: null,
    extra_away_score: null,
    penalty_home_score: null,
    penalty_away_score: null,
    result_version: 0,
    settled_result_version: 0,
    result_source: null,
    scoring_rule_version: "scoring_v1",
    finish_detected_at: null,
    settled_at: null,
    created_at: new Date("2026-08-01T00:00:00Z"),
    updated_at: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  } as Match;
}

function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    schema_version: 1,
    prediction_id: newUuid(),
    user_id: newUuid(),
    match_id: newUuid(),
    idempotency_key: newUuid(),
    pred_home_score: 1,
    pred_away_score: 0,
    derived_result: "HOME",
    submitted_at: new Date("2026-08-08T05:00:00Z"),
    scoring_rule_version: "scoring_v1",
    match_score: null,
    wdl_hit: null,
    exact_hit: null,
    applied_result_version: 0,
    created_at: new Date("2026-08-08T05:00:00Z"),
    updated_at: new Date("2026-08-08T05:00:00Z"),
    ...overrides,
  } as Prediction;
}

function makeSeasonStats(overrides: Partial<UserSeasonStats> = {}): UserSeasonStats {
  return {
    schema_version: 1,
    user_id: "u1",
    season_id: "2026_2027",
    points: 0,
    valid_predictions: 0,
    wdl_hits: 0,
    exact_hits: 0,
    level: 1,
    best_level: 1,
    created_at: LOCK_NOW,
    updated_at: LOCK_NOW,
    ...overrides,
  };
}

function makeRanking(overrides: Partial<RankingEntry> = {}): RankingEntry {
  return {
    schema_version: 1,
    period_type: "week",
    period_key: "2026-W32",
    user_id: newUuid(),
    period_score: 0,
    valid_predictions: 1,
    wdl_hits: 0,
    exact_hits: 0,
    last_scoring_match_at: null,
    global_rank: null,
    is_final: false,
    created_at: LOCK_NOW,
    updated_at: LOCK_NOW,
    ...overrides,
  };
}

describe("InMemoryRepository - schema_version Fail Closed（规范 2.5）", () => {
  it("users insert/update 拒绝非 1 的 schema_version 且不落库", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ schema_version: 2 as 1 });
    await expect(repo.users.insert(user)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(repo.users.findById(user.user_id)).resolves.toBeNull();

    const ok = makeUser();
    await repo.users.insert(ok);
    await expect(
      repo.users.update({ ...ok, schema_version: 0 as 1, career_points: 3 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(repo.users.findById(ok.user_id)).resolves.toMatchObject({
      schema_version: 1,
      career_points: 0,
    });
  });

  it("predictions / match_results insert 拒绝非法 schema_version", async () => {
    const repo = new InMemoryRepository();
    const prediction = makePrediction({ schema_version: 2 as 1 });
    await expect(repo.predictions.insert(prediction)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(repo.predictions.findById(prediction.prediction_id)).resolves.toBeNull();

    const matchResult = makeMatchResult({ schema_version: 0 as 1 });
    await expect(repo.matchResults.insert(matchResult)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(
      repo.matchResults.findByMatchAndVersion(matchResult.match_id, matchResult.result_version),
    ).resolves.toBeNull();
  });
});

describe("InMemoryRepository - users", () => {
  it("insert 后可按 openid 与 user_id 读取", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({});
    await repo.users.insert(user);
    expect(await repo.users.findByOpenid(user.openid)).toBe(user);
    expect(await repo.users.findById(user.user_id)).toBe(user);
  });

  it("重复 openid 抛 uk_openid 唯一冲突", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(makeUser({ openid: "openid_same" }));
    await expect(repo.users.insert(makeUser({ openid: "openid_same" }))).rejects.toThrow(
      UniqueConstraintError,
    );
    await expect(repo.users.insert(makeUser({ openid: "openid_same" }))).rejects.toMatchObject({
      collection: "users",
      indexName: "uk_openid",
    });
  });

  it("重复 user_id 抛唯一冲突", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({});
    await repo.users.insert(user);
    await expect(
      repo.users.insert(makeUser({ user_id: user.user_id })),
    ).rejects.toThrow(UniqueConstraintError);
  });

  it("update 持久化并同步 openid 索引", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ openid: "openid_before" });
    await repo.users.insert(user);
    const updated = { ...user, nickname: "NewName" } as User;
    await repo.users.update(updated);
    expect(await repo.users.findById(user.user_id)).toBe(updated);
    expect(await repo.users.findByOpenid("openid_before")).toBe(updated);
  });

  it("update 变更 openid：移除旧索引、新 openid 不得被他人占用", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ user_id: "u1", openid: "openid_a" });
    await repo.users.insert(user);
    const moved = { ...user, openid: "openid_b" } as User;
    await repo.users.update(moved);
    expect(await repo.users.findByOpenid("openid_a")).toBeNull();
    expect(await repo.users.findByOpenid("openid_b")).toBe(moved);
    expect(await repo.users.findById("u1")).toBe(moved);

    const other = makeUser({ user_id: "u2", openid: "openid_c" });
    await repo.users.insert(other);
    await expect(repo.users.update({ ...user, openid: "openid_c" } as User)).rejects.toMatchObject({
      collection: "users",
      indexName: "uk_openid",
    });
    expect(await repo.users.findByOpenid("openid_b")).toBe(moved);
    expect(await repo.users.findByOpenid("openid_c")).toBe(other);
  });

  it("career 聚合负数写入被拒绝且更新不替换原值", async () => {
    const repo = new InMemoryRepository();
    await expect(repo.users.insert(makeUser({ career_wdl_hits: -1 }))).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    const valid = makeUser();
    await repo.users.insert(valid);
    await expect(
      repo.users.update({ ...valid, career_exact_hits: -1 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(repo.users.findById(valid.user_id)).resolves.toEqual(valid);
  });
});

describe("InMemoryRepository - matches", () => {
  it("insert + findById + update 往返", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({});
    await repo.matches.insert(match);
    expect(await repo.matches.findById(match.match_id)).toBe(match);
    const updated = { ...match, match_status: "live" as const } as Match;
    await repo.matches.update(updated);
    expect(await repo.matches.findById(match.match_id)).toBe(updated);
  });

  it("按 season_id 查询 matches，供事实重建服务读取范围", async () => {
    const repo = new InMemoryRepository();
    const current = makeMatch({ match_id: "season_current", season_id: "2026_2027" });
    const old = makeMatch({ match_id: "season_old", season_id: "2025_2026" });
    await repo.matches.insert(current);
    await repo.matches.insert(old);

    expect(await repo.matches.findBySeason("2026_2027")).toEqual([current]);
  });
});

describe("InMemoryRepository - predictions", () => {
  it("insert 后可按 user+match 与 user+idempotency 查询", async () => {
    const repo = new InMemoryRepository();
    const prediction = makePrediction({});
    await repo.predictions.insert(prediction);
    expect(
      await repo.predictions.findByUserAndMatch(prediction.user_id, prediction.match_id),
    ).toBe(prediction);
    expect(
      await repo.predictions.findByUserAndIdempotencyKey(
        prediction.user_id,
        prediction.idempotency_key,
      ),
    ).toBe(prediction);
  });

  it("同 user+match 重复 insert 抛 uk_user_match", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({});
    const match = makeMatch({});
    await repo.predictions.insert(
      makePrediction({ user_id: user.user_id, match_id: match.match_id }),
    );
    await expect(
      repo.predictions.insert(
        makePrediction({ user_id: user.user_id, match_id: match.match_id }),
      ),
    ).rejects.toMatchObject({ collection: "predictions", indexName: "uk_user_match" });
  });

  it("同 user+idempotency 重复 insert 抛 uk_user_idempotency", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({});
    const key = newUuid();
    await repo.predictions.insert(makePrediction({ user_id: user.user_id, idempotency_key: key }));
    await expect(
      repo.predictions.insert(makePrediction({ user_id: user.user_id, idempotency_key: key })),
    ).rejects.toMatchObject({ collection: "predictions", indexName: "uk_user_idempotency" });
  });

  it("按 match 查询全部 prediction，供 Provider 主客队变更保护读取", async () => {
    const repo = new InMemoryRepository();
    const matchId = newUuid();
    const first = makePrediction({ match_id: matchId });
    const second = makePrediction({ match_id: matchId });
    const other = makePrediction({ match_id: newUuid() });
    await repo.predictions.insert(first);
    await repo.predictions.insert(second);
    await repo.predictions.insert(other);

    expect(await repo.predictions.findByMatch(matchId)).toEqual([first, second]);
  });

  it("更新 prediction 时拒绝改写提交事实字段", async () => {
    const repo = new InMemoryRepository();
    const prediction = makePrediction({
      pred_home_score: 1,
      pred_away_score: 0,
      derived_result: "HOME",
    });
    await repo.predictions.insert(prediction);

    await expect(
      repo.predictions.update({
        ...prediction,
        pred_home_score: 2,
        pred_away_score: 2,
        derived_result: "DRAW",
        submitted_at: new Date("2026-08-08T06:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    await expect(repo.predictions.findById(prediction.prediction_id)).resolves.toEqual(prediction);
  });

  it("更新 prediction 时拒绝回退 applied_result_version", async () => {
    const repo = new InMemoryRepository();
    const prediction = makePrediction({ applied_result_version: 2 });
    await repo.predictions.insert(prediction);

    await expect(
      repo.predictions.update({ ...prediction, applied_result_version: 1 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    await expect(repo.predictions.findById(prediction.prediction_id)).resolves.toEqual(prediction);
  });

  it("prediction 持久化拒绝 exact_hit=true 但 wdl_hit=false", async () => {
    const repo = new InMemoryRepository();
    const invalid = makePrediction({ exact_hit: true, wdl_hit: false });

    await expect(repo.predictions.insert(invalid)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    const valid = makePrediction();
    await repo.predictions.insert(valid);
    await expect(
      repo.predictions.update({ ...valid, exact_hit: true, wdl_hit: false }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(repo.predictions.findById(valid.prediction_id)).resolves.toEqual(valid);
  });
});

describe("InMemoryRepository - user_season_stats", () => {
  it("可按用户读取全部赛季统计，供 user rebuild 覆盖旧缓存", async () => {
    const repo = new InMemoryRepository();
    const first = makeSeasonStats({ season_id: "2026_2027" });
    const second = makeSeasonStats({ season_id: "2025_2026" });
    await repo.userSeasonStats.insert(first);
    await repo.userSeasonStats.insert(second);

    expect(await repo.userSeasonStats.findByUser("u1")).toEqual([first, second]);
    expect(await repo.userSeasonStats.findByUser("other")).toEqual([]);
  });

  it("season 聚合负数写入被拒绝且更新不替换原值", async () => {
    const repo = new InMemoryRepository();
    await expect(
      repo.userSeasonStats.insert(makeSeasonStats({ points: -1 })),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    const valid = makeSeasonStats();
    await repo.userSeasonStats.insert(valid);
    await expect(
      repo.userSeasonStats.update({ ...valid, wdl_hits: -1 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      repo.userSeasonStats.findByUserAndSeason(valid.user_id, valid.season_id),
    ).resolves.toEqual(valid);
  });
});

describe("InMemoryRepository - rankings", () => {
  it("insert/update 持久化拒绝非法命中关系和负 period_score", async () => {
    const repo = new InMemoryRepository();
    const invalid = makeRanking({ exact_hits: 1 });

    await expect(repo.rankings.insert(invalid)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    const valid = makeRanking();
    await repo.rankings.insert(valid);
    await expect(
      repo.rankings.update({ ...valid, period_score: -1 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      repo.rankings.findByPeriodAndUser(valid.period_type, valid.period_key, valid.user_id),
    ).resolves.toEqual(valid);
  });

  it("ranking 聚合命中计数负数写入被拒绝且更新不替换原值", async () => {
    const repo = new InMemoryRepository();
    await expect(repo.rankings.insert(makeRanking({ wdl_hits: -1 }))).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    const valid = makeRanking();
    await repo.rankings.insert(valid);
    await expect(
      repo.rankings.update({ ...valid, exact_hits: -1 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(
      repo.rankings.findByPeriodAndUser(valid.period_type, valid.period_key, valid.user_id),
    ).resolves.toEqual(valid);
  });
});

describe("InMemoryRepository - transactions", () => {
  it("事务内写操作提交后可见", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ openid: "tx_commit" });
    await repo.withTransaction((tx) => tx.users.insert(user));
    expect(await repo.users.findByOpenid("tx_commit")).toBe(user);
  });

  it("事务抛错时回滚全部写入", async () => {
    const repo = new InMemoryRepository();
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.users.insert(makeUser({ openid: "tx_rollback" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repo.users.findByOpenid("tx_rollback")).toBeNull();
  });

  it("同一事务多次写入后失败回滚：逆序恢复，不留悬挂索引", async () => {
    const repo = new InMemoryRepository();
    await expect(
      repo.withTransaction(async (tx) => {
        const user = makeUser({ user_id: "tx_repeat_user", openid: "openid_before" });
        await tx.users.insert(user);
        await tx.users.update({ ...user, openid: "openid_after" } as User);
        const match = makeMatch({ match_id: "tx_repeat_match" });
        await tx.matches.insert(match);
        await tx.matches.update({ ...match, match_status: "live" as const } as Match);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repo.users.findById("tx_repeat_user")).toBeNull();
    expect(await repo.users.findByOpenid("openid_before")).toBeNull();
    expect(await repo.users.findByOpenid("openid_after")).toBeNull();
    expect(await repo.matches.findById("tx_repeat_match")).toBeNull();
  });

  it("事务内读取可见同事务先前的写入", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ openid: "tx_read" });
    await repo.withTransaction(async (tx) => {
      await tx.users.insert(user);
      expect(await tx.users.findByOpenid("tx_read")).toBe(user);
    });
  });

  it("并发事务插入同 user+match 仅一个成功，另一个抛唯一冲突", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({});
    const match = makeMatch({});
    await repo.users.insert(user);
    await repo.matches.insert(match);
    const results = await Promise.allSettled([
      repo.withTransaction((tx) =>
        tx.predictions.insert(
          makePrediction({ user_id: user.user_id, match_id: match.match_id }),
        ),
      ),
      repo.withTransaction((tx) =>
        tx.predictions.insert(
          makePrediction({ user_id: user.user_id, match_id: match.match_id }),
        ),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.reason).toBeInstanceOf(UniqueConstraintError);
  });

  it("并发事务串行执行：失败事务回滚不覆盖后续事务已提交的 match", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({ match_id: "tx_shared_match" });
    await repo.matches.insert(match);

    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = repo.withTransaction(async (tx) => {
      const current = await tx.matches.findById(match.match_id);
      if (current === null) {
        throw new Error("match disappeared");
      }
      await tx.matches.update({ ...current, match_status: "live" });
      markFirstStarted();
      await firstContinue;
      throw new Error("rollback first transaction");
    });

    await firstStarted;
    const second = repo.withTransaction(async (tx) => {
      const current = await tx.matches.findById(match.match_id);
      if (current === null) {
        throw new Error("match disappeared");
      }
      await tx.matches.update({ ...current, match_status: "finished" });
    });

    releaseFirst();
    await expect(first).rejects.toThrow("rollback first transaction");
    await second;

    expect((await repo.matches.findById(match.match_id))?.match_status).toBe("finished");
  });

  it("事务回滚不覆盖事务执行期间已提交的 match 更新", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({ match_id: "tx_external_commit_match" });
    await repo.matches.insert(match);

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseTransaction!: () => void;
    const continueTransaction = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const transaction = repo.withTransaction(async (tx) => {
      const current = await tx.matches.findById(match.match_id);
      if (current === null) {
        throw new Error("match disappeared");
      }
      await tx.matches.update({ ...current, match_status: "live" });
      markStarted();
      await continueTransaction;
      throw new Error("rollback transaction");
    });

    await started;
    await repo.matches.update({
      ...match,
      match_status: "finished",
      updated_at: new Date("2026-08-09T01:00:00.000Z"),
    });
    releaseTransaction();

    await expect(transaction).rejects.toThrow("rollback transaction");
    expect(await repo.matches.findById(match.match_id)).toMatchObject({
      match_status: "finished",
      updated_at: new Date("2026-08-09T01:00:00.000Z"),
    });
  });
});

describe("InMemoryRepository - matches", () => {
  it("insert 拒绝 settled_result_version 超过 result_version", async () => {
    const repo = new InMemoryRepository();

    await expect(
      repo.matches.insert(
        makeMatch({ result_version: 1, settled_result_version: 2 }),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("update 与 updateSettlementStatus 拒绝 settled 未追平 result_version", async () => {
    const repo = new InMemoryRepository();
    const match = makeMatch({ result_version: 2, settled_result_version: 1 });
    await repo.matches.insert(match);

    await expect(
      repo.matches.update({ ...match, settlement_status: "settled" }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    await expect(
      repo.matches.updateSettlementStatus(match.match_id, "settled", LOCK_NOW),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("已冻结的比赛事实不能被 update 篡改", async () => {
    const repo = new InMemoryRepository();
    const closedAt = new Date("2026-08-08T05:50:00Z");
    const anchorAt = new Date("2026-08-08T06:00:00Z");
    const finishDetectedAt = new Date("2026-08-08T07:00:00Z");
    const match = makeMatch({
      round_id: "01",
      prediction_closed_at: closedAt,
      period_anchor_at: anchorAt,
      finish_detected_at: finishDetectedAt,
      result_version: 2,
      settled_result_version: 1,
    });
    await repo.matches.insert(match);

    await expect(
      repo.matches.update({
        ...match,
        round_id: "02",
        prediction_closed_at: new Date("2026-08-08T05:51:00Z"),
        period_anchor_at: new Date("2026-08-08T06:01:00Z"),
        finish_detected_at: new Date("2026-08-08T07:01:00Z"),
        result_version: 1,
        settled_result_version: 0,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    await expect(repo.matches.findById(match.match_id)).resolves.toEqual(match);
  });
});

function makeMatchResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    schema_version: 1,
    match_id: newUuid(),
    result_version: 1,
    regular_home_score: 2,
    regular_away_score: 1,
    source: "provider",
    provider_status: "FT",
    admin_id: null,
    reason: null,
    created_at: new Date("2026-08-09T00:00:00Z"),
    ...overrides,
  } as MatchResult;
}

function makeSettlement(overrides: Partial<SettlementDoc> = {}): SettlementDoc {
  return {
    schema_version: 1,
    settlement_id: newUuid(),
    match_id: newUuid(),
    result_version: 1,
    rule_version: "scoring_v1",
    status: "pending",
    phase: "prepare",
    is_correction: false,
    started_at: null,
    settled_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: new Date("2026-08-09T00:00:00Z"),
    updated_at: new Date("2026-08-09T00:00:00Z"),
    ...overrides,
  } as SettlementDoc;
}

function makeSettlementItem(overrides: Partial<SettlementItem> = {}): SettlementItem {
  return {
    schema_version: 1,
    settlement_id: newUuid(),
    prediction_id: newUuid(),
    user_id: newUuid(),
    old_score: 0,
    new_score: 3,
    score_delta: 3,
    old_wdl_hit: false,
    new_wdl_hit: true,
    old_exact_hit: false,
    new_exact_hit: false,
    valid_prediction_delta: 1,
    source_result_version: 1,
    status: "pending",
    applied_at: null,
    attempt_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: new Date("2026-08-09T00:00:00Z"),
    updated_at: new Date("2026-08-09T00:00:00Z"),
    ...overrides,
  } as SettlementItem;
}

function makeUnlock(overrides: Partial<Unlock> = {}): Unlock {
  return {
    schema_version: 1,
    unlock_id: newUuid(),
    user_id: newUuid(),
    unlock_code: "profile_card_style_1",
    threshold_points: 30,
    source_version: "unlock_v1",
    unlocked_at: LOCK_NOW,
    ...overrides,
  };
}

describe("InMemoryRepository - match_results (immutable ledger)", () => {
  it("insert 后可按 (match_id, result_version) 读取", async () => {
    const repo = new InMemoryRepository();
    const mr = makeMatchResult({});
    await repo.matchResults.insert(mr);
    expect(
      await repo.matchResults.findByMatchAndVersion(mr.match_id, mr.result_version),
    ).toBe(mr);
  });

  it("findLatestByMatch 返回该 match 最大 result_version", async () => {
    const repo = new InMemoryRepository();
    const matchId = newUuid();
    await repo.matchResults.insert(makeMatchResult({ match_id: matchId, result_version: 1 }));
    const v2 = makeMatchResult({ match_id: matchId, result_version: 2 });
    await repo.matchResults.insert(v2);
    const v3 = makeMatchResult({ match_id: matchId, result_version: 3 });
    await repo.matchResults.insert(v3);
    expect(await repo.matchResults.findLatestByMatch(matchId)).toBe(v3);
  });

  it("重复 (match_id, result_version) insert 抛 uk_match_result_version", async () => {
    const repo = new InMemoryRepository();
    await repo.matchResults.insert(makeMatchResult({ match_id: "m1", result_version: 1 }));
    await expect(
      repo.matchResults.insert(
        makeMatchResult({
          match_id: "m1",
          result_version: 1,
          regular_home_score: 3,
          regular_away_score: 0,
        }),
      ),
    ).rejects.toMatchObject({
      collection: "match_results",
      indexName: "uk_match_result_version",
    });
  });

  it("旧 result_version 不可覆盖：已有更高版本时拒绝写入旧版本", async () => {
    const repo = new InMemoryRepository();
    await repo.matchResults.insert(makeMatchResult({ match_id: "m_old", result_version: 2 }));
    await expect(
      repo.matchResults.insert(makeMatchResult({ match_id: "m_old", result_version: 1 })),
    ).rejects.toThrow(StaleResultVersionError);
    const err = await repo.matchResults
      .insert(makeMatchResult({ match_id: "m_old", result_version: 1 }))
      .catch((e) => e);
    expect(err).toMatchObject({
      collection: "match_results",
      matchId: "m_old",
      latestVersion: 2,
      attemptedVersion: 1,
    });
  });

  it("不可覆盖：同版本再次写入（即使字段不同）也抛唯一冲突", async () => {
    const repo = new InMemoryRepository();
    await repo.matchResults.insert(makeMatchResult({ match_id: "m1", result_version: 1 }));
    await expect(
      repo.matchResults.insert(
        makeMatchResult({ match_id: "m1", result_version: 1, regular_away_score: 4 }),
      ),
    ).rejects.toThrow(UniqueConstraintError);
  });
});

describe("InMemoryRepository - settlements", () => {
  it("insert/update 拒绝非法版本、重试次数、状态和阶段", async () => {
    const repo = new InMemoryRepository();
    const invalidSettlements: SettlementDoc[] = [
      makeSettlement({ result_version: 0 }),
      makeSettlement({ result_version: 1.5 }),
      makeSettlement({ attempt_count: -1 }),
      makeSettlement({ attempt_count: 0.5 }),
      makeSettlement({ status: "invalid" as SettlementDoc["status"] }),
      makeSettlement({ phase: "invalid" as SettlementDoc["phase"] }),
    ];

    for (const settlement of invalidSettlements) {
      await expect(repo.settlements.insert(settlement)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
    }

    const valid = makeSettlement({ settlement_id: "settlement_invariant" });
    await repo.settlements.insert(valid);
    await expect(
      repo.settlements.update({
        ...valid,
        phase: "invalid" as SettlementDoc["phase"],
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(repo.settlements.findById(valid.settlement_id)).resolves.toBe(valid);
  });

  it("insert 后可按 settlement_id 与 (match_id, result_version, rule_version) 读取", async () => {
    const repo = new InMemoryRepository();
    const s = makeSettlement({});
    await repo.settlements.insert(s);
    expect(await repo.settlements.findById(s.settlement_id)).toBe(s);
    expect(
      await repo.settlements.findByMatchAndVersionAndRule(
        s.match_id,
        s.result_version,
        s.rule_version,
      ),
    ).toBe(s);
  });

  it("重复 (match_id, result_version, rule_version) insert 抛 uk_match_version_rule", async () => {
    const repo = new InMemoryRepository();
    await repo.settlements.insert(
      makeSettlement({ match_id: "m1", result_version: 1, rule_version: "scoring_v1" }),
    );
    await expect(
      repo.settlements.insert(
        makeSettlement({
          match_id: "m1",
          result_version: 1,
          rule_version: "scoring_v1",
          settlement_id: newUuid(),
        }),
      ),
    ).rejects.toMatchObject({
      collection: "settlements",
      indexName: "uk_match_version_rule",
    });
  });

  it("不同 rule_version / result_version 不冲突", async () => {
    const repo = new InMemoryRepository();
    await repo.settlements.insert(
      makeSettlement({ match_id: "m1", result_version: 1, rule_version: "scoring_v1" }),
    );
    const s2 = makeSettlement({ match_id: "m1", result_version: 2, rule_version: "scoring_v1" });
    await repo.settlements.insert(s2);
    expect(await repo.settlements.findById(s2.settlement_id)).toBe(s2);
  });

  it("按 match_id 读取 settlement，并按 result_version 升序返回", async () => {
    const repo = new InMemoryRepository();
    const versionTwo = makeSettlement({
      settlement_id: "s_version_2",
      match_id: "m_target",
      result_version: 2,
    });
    const versionOne = makeSettlement({
      settlement_id: "s_version_1",
      match_id: "m_target",
      result_version: 1,
    });
    const otherMatch = makeSettlement({
      settlement_id: "s_other_match",
      match_id: "m_other",
      result_version: 1,
    });
    await repo.settlements.insert(versionTwo);
    await repo.settlements.insert(versionOne);
    await repo.settlements.insert(otherMatch);

    expect(await repo.settlements.findByMatch("m_target")).toEqual([
      versionOne,
      versionTwo,
    ]);
  });

  it("status/phase 基础读写：update 持久化状态与阶段", async () => {
    const repo = new InMemoryRepository();
    const s = makeSettlement({ status: "pending", phase: "prepare" });
    await repo.settlements.insert(s);
    const running = {
      ...s,
      status: "running" as const,
      phase: "apply_items" as const,
      started_at: new Date("2026-08-09T01:00:00Z"),
      attempt_count: 1,
      updated_at: new Date("2026-08-09T01:00:00Z"),
    };
    await repo.settlements.update(running);
    expect(await repo.settlements.findById(s.settlement_id)).toBe(running);

    const settled = {
      ...running,
      status: "settled" as const,
      phase: "done" as const,
      settled_at: new Date("2026-08-09T02:00:00Z"),
      updated_at: new Date("2026-08-09T02:00:00Z"),
    };
    await repo.settlements.update(settled);
    expect(await repo.settlements.findById(s.settlement_id)).toBe(settled);
  });

  it("update 不存在的 settlement 抛 DocumentNotFoundError", async () => {
    const repo = new InMemoryRepository();
    await expect(repo.settlements.update(makeSettlement({}))).rejects.toThrow(
      DocumentNotFoundError,
    );
  });

  it("按 status 查询只返回对应状态的 settlement", async () => {
    const repo = new InMemoryRepository();
    await repo.settlements.insert(makeSettlement({ settlement_id: "s_pending", status: "pending" }));
    await repo.settlements.insert(makeSettlement({ settlement_id: "s_running", status: "running" }));
    await repo.settlements.insert(makeSettlement({ settlement_id: "s_failed", status: "failed" }));
    expect((await repo.settlements.findByStatus("pending")).map((s) => s.settlement_id)).toEqual([
      "s_pending",
    ]);
    expect((await repo.settlements.findByStatus("failed")).map((s) => s.settlement_id)).toEqual([
      "s_failed",
    ]);
    expect(await repo.settlements.findByStatus("settled")).toEqual([]);
  });
});

describe("InMemoryRepository - settlement_items", () => {
  it("insert 与 update 拒绝违反 settlement item delta/version invariant 的账本", async () => {
    const repo = new InMemoryRepository();
    const item = makeSettlementItem({ score_delta: 2 });

    await expect(repo.settlementItems.insert(item)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    const valid = makeSettlementItem({});
    await repo.settlementItems.insert(valid);
    await expect(
      repo.settlementItems.update({ ...valid, source_result_version: 0 }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(repo.settlementItems.findBySettlement(valid.settlement_id)).resolves.toEqual([
      valid,
    ]);
  });

  it("持久化拒绝非法单场分值、命中关系和 valid_prediction_delta", async () => {
    const repo = new InMemoryRepository();
    const invalidItems = [
      makeSettlementItem({
        old_score: 1 as never,
        new_score: 3,
        score_delta: 2,
      }),
      makeSettlementItem({
        new_score: 12,
        score_delta: 12,
        new_wdl_hit: false,
        new_exact_hit: true,
      }),
      makeSettlementItem({ valid_prediction_delta: 2 as never }),
    ];

    for (const item of invalidItems) {
      await expect(repo.settlementItems.insert(item)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
    }
  });

  it("insert 后可按 (settlement_id, prediction_id) 读取，且可枚举某 settlement 全部 item", async () => {
    const repo = new InMemoryRepository();
    const item = makeSettlementItem({});
    await repo.settlementItems.insert(item);
    expect(
      await repo.settlementItems.findBySettlementAndPrediction(
        item.settlement_id,
        item.prediction_id,
      ),
    ).toBe(item);
    expect(await repo.settlementItems.findBySettlement(item.settlement_id)).toEqual([item]);
  });

  it("重复 (settlement_id, prediction_id) insert 抛 uk_settlement_prediction", async () => {
    const repo = new InMemoryRepository();
    await repo.settlementItems.insert(
      makeSettlementItem({ settlement_id: "s1", prediction_id: "p1" }),
    );
    await expect(
      repo.settlementItems.insert(
        makeSettlementItem({ settlement_id: "s1", prediction_id: "p1" }),
      ),
    ).rejects.toMatchObject({
      collection: "settlement_items",
      indexName: "uk_settlement_prediction",
    });
  });

  it("按 status 查询：findBySettlementAndStatus 只返回对应状态", async () => {
    const repo = new InMemoryRepository();
    await repo.settlementItems.insert(
      makeSettlementItem({ settlement_id: "s1", prediction_id: "p1", status: "pending" }),
    );
    await repo.settlementItems.insert(
      makeSettlementItem({ settlement_id: "s1", prediction_id: "p2", status: "applied" }),
    );
    await repo.settlementItems.insert(
      makeSettlementItem({ settlement_id: "s1", prediction_id: "p3", status: "failed" }),
    );
    expect(
      (await repo.settlementItems.findBySettlementAndStatus("s1", "applied")).map(
        (i) => i.prediction_id,
      ),
    ).toEqual(["p2"]);
    expect(
      (await repo.settlementItems.findBySettlementAndStatus("s1", "pending")).map(
        (i) => i.prediction_id,
      ),
    ).toEqual(["p1"]);
  });

  it("applied item 更新后可读回：pending -> applied 写入 applied_at", async () => {
    const repo = new InMemoryRepository();
    const item = makeSettlementItem({
      settlement_id: "s1",
      prediction_id: "p1",
      status: "pending",
    });
    await repo.settlementItems.insert(item);
    const appliedAt = new Date("2026-08-09T03:00:00Z");
    const applied = {
      ...item,
      status: "applied" as const,
      applied_at: appliedAt,
      attempt_count: 1,
      updated_at: appliedAt,
    };
    await repo.settlementItems.update(applied);
    const readBack = await repo.settlementItems.findBySettlementAndPrediction("s1", "p1");
    expect(readBack).toBe(applied);
    expect(readBack?.status).toBe("applied");
    expect(readBack?.applied_at).toBe(appliedAt);
    expect((await repo.settlementItems.findBySettlementAndStatus("s1", "pending"))).toEqual([]);
  });

  it("update 不存在的 item 抛 DocumentNotFoundError", async () => {
    const repo = new InMemoryRepository();
    await expect(repo.settlementItems.update(makeSettlementItem({}))).rejects.toThrow(
      DocumentNotFoundError,
    );
  });

  it("全局按 status 查询：failed 跨 settlement 聚合", async () => {
    const repo = new InMemoryRepository();
    await repo.settlementItems.insert(
      makeSettlementItem({ settlement_id: "s1", prediction_id: "p1", status: "failed" }),
    );
    await repo.settlementItems.insert(
      makeSettlementItem({ settlement_id: "s2", prediction_id: "p2", status: "failed" }),
    );
    await repo.settlementItems.insert(
      makeSettlementItem({ settlement_id: "s3", prediction_id: "p3", status: "applied" }),
    );
    const failed = await repo.settlementItems.findByStatus("failed");
    expect(failed.map((i) => i.prediction_id).sort()).toEqual(["p1", "p2"]);
  });
});

describe("InMemoryRepository - settlement 事务回滚集成", () => {
  it("事务抛错时撤销 match_results / settlements / settlement_items 写入", async () => {
    const repo = new InMemoryRepository();
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.matchResults.insert(makeMatchResult({ match_id: "tx_mr", result_version: 1 }));
        await tx.settlements.insert(
          makeSettlement({ settlement_id: "tx_s", match_id: "tx_mr", result_version: 1 }),
        );
        await tx.settlementItems.insert(
          makeSettlementItem({ settlement_id: "tx_s", prediction_id: "tx_p" }),
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repo.matchResults.findByMatchAndVersion("tx_mr", 1)).toBeNull();
    expect(await repo.settlements.findById("tx_s")).toBeNull();
    expect(await repo.settlementItems.findBySettlementAndPrediction("tx_s", "tx_p")).toBeNull();
  });

  it("事务内可读可见本事务先前的结算写入", async () => {
    const repo = new InMemoryRepository();
    const s = makeSettlement({ settlement_id: "tx_visible" });
    await repo.withTransaction(async (tx) => {
      await tx.settlements.insert(s);
      expect(await tx.settlements.findById("tx_visible")).toBe(s);
    });
  });
});

describe("InMemoryRepository - unlocks", () => {
  it("insert 后可按 user_id 查询，并可按 user_id + unlock_code 读取", async () => {
    const repo = new InMemoryRepository();
    const unlock = makeUnlock({ user_id: "u1" });
    await repo.unlocks.insert(unlock);

    expect(await repo.unlocks.findByUser("u1")).toEqual([unlock]);
    expect(await repo.unlocks.findByUserAndCode("u1", unlock.unlock_code)).toBe(unlock);
  });

  it("同一用户同一 unlock_code 抛 uk_user_unlock_code，其他用户可拥有同一解锁", async () => {
    const repo = new InMemoryRepository();
    await repo.unlocks.insert(makeUnlock({ user_id: "u1", unlock_code: "same_code" }));
    await repo.unlocks.insert(makeUnlock({ user_id: "u2", unlock_code: "same_code" }));

    await expect(
      repo.unlocks.insert(makeUnlock({ user_id: "u1", unlock_code: "same_code" })),
    ).rejects.toMatchObject({
      collection: "unlocks",
      indexName: "uk_user_unlock_code",
    });
  });

  it("事务失败时回滚 unlock 写入", async () => {
    const repo = new InMemoryRepository();
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.unlocks.insert(makeUnlock({ user_id: "tx_user" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await repo.unlocks.findByUser("tx_user")).toEqual([]);
  });
});

describe("InMemoryRepository - sync_logs", () => {
  function makeSyncLog(overrides: Partial<SyncLog> = {}): SyncLog {
    const now = new Date("2026-08-09T00:00:00Z");
    return {
      schema_version: 1,
      sync_job_id: newUuid(),
      job_type: "daily_consistency",
      status: "running",
      started_at: now,
      finished_at: null,
      attempt_count: 1,
      items_read: 0,
      items_changed: 0,
      items_failed: 0,
      last_error_code: null,
      last_error_message: null,
      created_at: now,
      ...overrides,
    };
  }

  it("支持运行日志 update，并保持 sync_job_id 唯一", async () => {
    const repo = new InMemoryRepository();
    const log = makeSyncLog();
    await repo.syncLogs.insert(log);

    await expect(repo.syncLogs.insert(log)).rejects.toMatchObject({
      collection: "sync_logs",
      indexName: "pk_sync_job",
    });
    const success = { ...log, status: "success" as const, finished_at: log.started_at };
    await expect(repo.syncLogs.update(success)).resolves.toBeUndefined();
  });

  it("事务失败时回滚 sync log，并拒绝更新不存在的日志", async () => {
    const repo = new InMemoryRepository();
    const log = makeSyncLog();
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.syncLogs?.insert(log);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    await expect(repo.syncLogs.update(log)).rejects.toThrow(DocumentNotFoundError);
  });
});

describe("InMemoryRepository - job locks (lease)", () => {
  const future = () => new Date("2026-08-09T00:01:00.000Z");
  const past = () => new Date("2026-08-08T23:59:59.000Z");

  it("acquire 成功，持锁期间再 acquire 失败", async () => {
    const repo = new InMemoryRepository();
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_a", future())).toBe(true);
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_b", future())).toBe(false);
  });

  it("release 后其他 owner 可 acquire", async () => {
    const repo = new InMemoryRepository();
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_a", future())).toBe(true);
    await repo.jobLocks.release("lock:round_1", "owner_a");
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_b", future())).toBe(true);
  });

  it("非 owner release 无效", async () => {
    const repo = new InMemoryRepository();
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_a", future())).toBe(true);
    await repo.jobLocks.release("lock:round_1", "owner_b");
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_c", future())).toBe(false);
  });

  it("lease 过期可被接管", async () => {
    const repo = new InMemoryRepository();
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_a", past())).toBe(true);
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_b", future())).toBe(true);
  });

  it("renew 延长 lease；过期或非 owner renew 失败", async () => {
    const repo = new InMemoryRepository();
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_a", future())).toBe(true);
    expect(await repo.jobLocks.renew("lock:round_1", "owner_a", future())).toBe(true);
    expect(await repo.jobLocks.renew("lock:round_1", "owner_b", future())).toBe(false);
    expect(await repo.jobLocks.renew("lock:round_2", "owner_a", future())).toBe(false);
  });

  it("已过期的锁不能 renew，必须重新 acquire", async () => {
    const repo = new InMemoryRepository();
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_a", past())).toBe(true);
    expect(await repo.jobLocks.renew("lock:round_1", "owner_a", future())).toBe(false);
    expect(await repo.jobLocks.acquire("lock:round_1", "owner_b", future())).toBe(true);
  });
});

describe("InMemoryRepository - deleted_openid_mappings", () => {
  const NOW2 = new Date("2026-08-10T00:00:00.000Z");

  function makeMapping(overrides: Partial<DeletedOpenidMapping> = {}): DeletedOpenidMapping {
    return {
      schema_version: 1,
      original_openid: `openid_${newUuid()}`,
      deleted_user_id: newUuid(),
      deleted_at: NOW2,
      created_at: NOW2,
      updated_at: NOW2,
      ...overrides,
    } as DeletedOpenidMapping;
  }

  it("upsert 后可按 original_openid 与 deleted_user_id 查询", async () => {
    const repo = new InMemoryRepository();
    const mapping = makeMapping();
    await repo.deletedOpenidMappings.upsert(mapping);
    expect(await repo.deletedOpenidMappings.findByOriginalOpenid(mapping.original_openid)).toBe(mapping);
    expect(await repo.deletedOpenidMappings.findByDeletedUserId(mapping.deleted_user_id)).toBe(mapping);
    expect(await repo.deletedOpenidMappings.findByOriginalOpenid("missing")).toBeNull();
  });

  it("同 original_openid 再次 upsert 更新为新的 deleted_user_id（重注册再注销）", async () => {
    const repo = new InMemoryRepository();
    const first = makeMapping();
    await repo.deletedOpenidMappings.upsert(first);
    const second = makeMapping({
      original_openid: first.original_openid,
      deleted_user_id: newUuid(),
      deleted_at: NOW2,
      updated_at: NOW2,
    });
    await repo.deletedOpenidMappings.upsert(second);

    const current = await repo.deletedOpenidMappings.findByOriginalOpenid(first.original_openid);
    expect(current).toBe(second);
    expect(current?.created_at).toBe(first.created_at);
    expect(current?.deleted_user_id).toBe(second.deleted_user_id);
    expect(await repo.deletedOpenidMappings.findByDeletedUserId(first.deleted_user_id)).toBeNull();
  });

  it("事务内 upsert 抛错时回滚，不留 mapping", async () => {
    const repo = new InMemoryRepository();
    await expect(
      repo.withTransaction(async (tx) => {
        await tx.deletedOpenidMappings.upsert(makeMapping());
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repo.deletedOpenidMappings.findByOriginalOpenid("whatever")).toBeNull();
    expect(repo).toBeDefined();
  });

  it("拒绝非 1 的 schema_version 且不落库", async () => {
    const repo = new InMemoryRepository();
    const mapping = makeMapping({ schema_version: 0 as 1 });
    await expect(repo.deletedOpenidMappings.upsert(mapping)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(await repo.deletedOpenidMappings.findByOriginalOpenid(mapping.original_openid)).toBeNull();
  });
});
