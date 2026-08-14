import { describe, expect, it } from "vitest";
import { FIXED_CONFIG_V1 } from "../domain/config.js";
import { UserStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { Match, User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { PredictionService } from "./predictions.js";

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

const NOW = () => new Date("2026-08-08T05:00:00Z");
const DEADLINE = () => new Date("2026-08-08T05:50:00Z");

async function setup(overrides: { user?: Partial<User>; match?: Partial<Match> } = {}) {
  const repo = new InMemoryRepository();
  const service = new PredictionService(repo);
  const user = makeUser({ openid: "openid_pred" });
  const match = makeMatch({});
  await repo.users.insert({ ...user, ...overrides.user } as User);
  await repo.matches.insert({ ...match, ...overrides.match } as Match);
  return { repo, service, user, match };
}

function payload(matchId: string, scores?: { home_score?: number; away_score?: number }, key?: string) {
  return {
    idempotency_key: key ?? newUuid(),
    match_id: matchId,
    home_score: scores?.home_score ?? 2,
    away_score: scores?.away_score ?? 1,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "NO_ERROR";
  } catch (err) {
    return (err as { code?: string }).code ?? "NO_ERROR";
  }
}

describe("PredictionService.submit - 成功路径", () => {
  it("首次提交创建预测（created=true），服务端字段由服务端推导", async () => {
    const { service, user, match, repo } = await setup();
    const result = await service.submit(user.user_id, payload(match.match_id), NOW());
    expect(result.created).toBe(true);
    const p = result.prediction;
    expect(p.user_id).toBe(user.user_id);
    expect(p.match_id).toBe(match.match_id);
    expect(p.pred_home_score).toBe(2);
    expect(p.pred_away_score).toBe(1);
    expect(p.derived_result).toBe("HOME");
    expect(p.submitted_at.getTime()).toBe(NOW().getTime());
    expect(p.scoring_rule_version).toBe(FIXED_CONFIG_V1.SCORING_RULE_VERSION);
    expect(p.match_score).toBeNull();
    expect(p.wdl_hit).toBeNull();
    expect(p.exact_hit).toBeNull();
    expect(p.applied_result_version).toBe(0);
    expect(await repo.predictions.findByUserAndMatch(user.user_id, match.match_id)).toBe(p);
  });

  it("D25 相同 idempotency_key + 相同 payload 返回第一次结果，不重复", async () => {
    const { service, user, match, repo } = await setup();
    const body = payload(match.match_id);
    const first = await service.submit(user.user_id, body, NOW());
    const second = await service.submit(user.user_id, body, NOW());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.prediction.prediction_id).toBe(first.prediction.prediction_id);
    const all = await Promise.all([
      repo.predictions.findByUserAndMatch(user.user_id, match.match_id),
      repo.predictions.findByUserAndIdempotencyKey(user.user_id, body.idempotency_key),
    ]);
    expect(all[0]?.prediction_id).toBe(first.prediction.prediction_id);
    expect(all[1]?.prediction_id).toBe(first.prediction.prediction_id);
  });

  it("比分边界 0..20 允许", async () => {
    const { service, user, match } = await setup();
    const result = await service.submit(
      user.user_id,
      payload(match.match_id, { home_score: 0, away_score: 20 }),
      NOW(),
    );
    expect(result.created).toBe(true);
  });
});

describe("PredictionService.submit - 幂等与冲突", () => {
  it("D26 相同 idempotency_key + 不同比分 => 409", async () => {
    const { service, user, match } = await setup();
    const key = newUuid();
    await service.submit(user.user_id, payload(match.match_id, undefined, key), NOW());
    const code = await codeOf(
      service.submit(user.user_id, payload(match.match_id, { home_score: 9 }, key), NOW()),
    );
    expect(code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("D27 不同 idempotency_key + 同 match => 409", async () => {
    const { service, user, match } = await setup();
    await service.submit(user.user_id, payload(match.match_id), NOW());
    const code = await codeOf(
      service.submit(user.user_id, payload(match.match_id), NOW()),
    );
    expect(code).toBe("PREDICTION_ALREADY_SUBMITTED");
  });

  it("D24 两个并发首次预测只有一条成功创建", async () => {
    const { service, user, match } = await setup();
    const results = await Promise.allSettled([
      service.submit(user.user_id, payload(match.match_id), NOW()),
      service.submit(user.user_id, payload(match.match_id), NOW()),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const first = fulfilled[0] as PromiseFulfilledResult<{ created: boolean }>;
    expect(first.status).toBe("fulfilled");
    expect(first.value.created).toBe(true);
    const rejectedReason = rejected[0] as PromiseRejectedResult;
    expect(rejectedReason.reason).toMatchObject({ code: "PREDICTION_ALREADY_SUBMITTED" });
  });
});

describe("PredictionService.submit - 服务端业务规则", () => {
  it("user 不存在抛 USER_NOT_FOUND", async () => {
    const { service, match } = await setup();
    const code = await codeOf(service.submit(newUuid(), payload(match.match_id), NOW()));
    expect(code).toBe("USER_NOT_FOUND");
  });

  it("match 不存在抛 MATCH_NOT_FOUND", async () => {
    const { service, user } = await setup();
    const code = await codeOf(service.submit(user.user_id, payload(newUuid()), NOW()));
    expect(code).toBe("MATCH_NOT_FOUND");
  });

  it("49.2 优先级2：deleted 用户抛 USER_DELETED", async () => {
    const { service, user, match } = await setup({
      user: { status: "deleted" as UserStatus, deleted_at: NOW() },
    });
    const code = await codeOf(service.submit(user.user_id, payload(match.match_id), NOW()));
    expect(code).toBe("USER_DELETED");
  });

  it("49.2 文末/§8.6：注销后同 key+同 payload 重放返回首次结果（不走 USER_DELETED）", async () => {
    const { service, user, match, repo } = await setup();
    const body = payload(match.match_id);
    const first = await service.submit(user.user_id, body, NOW());

    const current = await repo.users.findById(user.user_id);
    if (current === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({
      ...current,
      openid: `deleted:${current.user_id}`,
      unionid: null,
      nickname: null,
      favorite_team_id: null,
      status: UserStatus.Deleted,
      deleted_at: NOW(),
      updated_at: NOW(),
    });

    const replay = await service.submit(user.user_id, body, NOW());
    expect(replay.created).toBe(false);
    expect(replay.prediction.prediction_id).toBe(first.prediction.prediction_id);
  });

  it("注销后同 key+不同 payload 仍抛 IDEMPOTENCY_KEY_REUSED", async () => {
    const { service, user, match, repo } = await setup();
    const key = newUuid();
    const body = payload(match.match_id, undefined, key);
    await service.submit(user.user_id, body, NOW());

    const current = await repo.users.findById(user.user_id);
    if (current === null) {
      throw new Error("expected seeded user");
    }
    await repo.users.update({
      ...current,
      openid: `deleted:${current.user_id}`,
      status: UserStatus.Deleted,
      deleted_at: NOW(),
      updated_at: NOW(),
    });

    const code = await codeOf(
      service.submit(user.user_id, payload(match.match_id, { home_score: 9 }, key), NOW()),
    );
    expect(code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("注销后新 key 新提交抛 USER_DELETED", async () => {
    const { service, user, match, repo } = await setup({
      user: { status: "deleted" as UserStatus, deleted_at: NOW() },
    });
    const code = await codeOf(service.submit(user.user_id, payload(match.match_id), NOW()));
    expect(code).toBe("USER_DELETED");
  });

  it("49.2 优先级4：非 scheduled 比赛抛 MATCH_NOT_PREDICTABLE", async () => {
    const { service, user, match } = await setup({ match: { match_status: "postponed" } });
    const code = await codeOf(service.submit(user.user_id, payload(match.match_id), NOW()));
    expect(code).toBe("MATCH_NOT_PREDICTABLE");
  });

  it("49.2 优先级5：kickoff 未确认（deadline=null）抛 MATCH_NOT_PREDICTABLE", async () => {
    const { service, user, match } = await setup({
      match: { kickoff_confirmed: false, prediction_deadline_at: null },
    });
    const code = await codeOf(service.submit(user.user_id, payload(match.match_id), NOW()));
    expect(code).toBe("MATCH_NOT_PREDICTABLE");
  });

  it("49.2 优先级6：已关闭（prediction_closed_at != null）抛 PREDICTION_LOCKED", async () => {
    const { service, user, match } = await setup({ match: { prediction_closed_at: NOW() } });
    const code = await codeOf(service.submit(user.user_id, payload(match.match_id), NOW()));
    expect(code).toBe("PREDICTION_LOCKED");
  });

  it("截止边界：server_now == deadline 抛 PREDICTION_LOCKED，1ms 前允许", async () => {
    const { service, user, match } = await setup();
    const atDeadline = await codeOf(
      service.submit(user.user_id, payload(match.match_id), DEADLINE()),
    );
    expect(atDeadline).toBe("PREDICTION_LOCKED");
    const beforeDeadline = await service.submit(
      user.user_id,
      payload(match.match_id),
      new Date(DEADLINE().getTime() - 1),
    );
    expect(beforeDeadline.created).toBe(true);
  });

  it("截止后（server_now > deadline）抛 PREDICTION_LOCKED", async () => {
    const { service, user, match } = await setup();
    const code = await codeOf(
      service.submit(user.user_id, payload(match.match_id), new Date(DEADLINE().getTime() + 1000)),
    );
    expect(code).toBe("PREDICTION_LOCKED");
  });

  it("幂等重放（同 key+同 payload）在 deadline 已过后仍返回首次结果，不走失败表", async () => {
    const { service, user, match } = await setup();
    const body = payload(match.match_id);
    const first = await service.submit(user.user_id, body, NOW());
    const replay = await service.submit(
      user.user_id,
      body,
      new Date(DEADLINE().getTime() + 60_000),
    );
    expect(replay.created).toBe(false);
    expect(replay.prediction.prediction_id).toBe(first.prediction.prediction_id);
  });

  it("无效 server_now Fail Closed，且不写入预测", async () => {
    const { service, user, match, repo } = await setup();

    await expect(
      service.submit(user.user_id, payload(match.match_id), new Date("invalid")),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });
    await expect(repo.predictions.findByUserAndMatch(user.user_id, match.match_id)).resolves.toBeNull();
  });
});

describe("PredictionService.submit - 输入校验", () => {
  it("比分越界 / 非整数 / 字符串拒绝", async () => {
    const { service, user, match } = await setup();
    for (const bad of [
      { home_score: 21, away_score: 0 },
      { home_score: -1, away_score: 0 },
      { home_score: 2.5, away_score: 0 },
      { home_score: "2", away_score: 0 },
    ]) {
      const code = await codeOf(
        service.submit(user.user_id, payload(match.match_id, bad as never), NOW()),
      );
      expect(code).toBe("VALIDATION_ERROR");
    }
  });

  it("客户端派生/服务端字段拒绝", async () => {
    const { service, user, match } = await setup();
    const body = payload(match.match_id) as Record<string, unknown>;
    body.derived_result = "HOME";
    const code = await codeOf(service.submit(user.user_id, body, NOW()));
    expect(code).toBe("VALIDATION_ERROR");
  });

  it("未知字段拒绝", async () => {
    const { service, user, match } = await setup();
    const body = payload(match.match_id) as Record<string, unknown>;
    body.client_time = "2026-08-08T04:00:00Z";
    const code = await codeOf(service.submit(user.user_id, body, NOW()));
    expect(code).toBe("VALIDATION_ERROR");
  });

  it("user_id / match_id / idempotency_key 非 UUID 拒绝", async () => {
    const { service, user, match } = await setup();
    expect(await codeOf(service.submit("not-a-uuid", payload(match.match_id), NOW()))).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      await codeOf(service.submit(user.user_id, payload(newUuid().slice(0, 8)), NOW())),
    ).toBe("VALIDATION_ERROR");
    const badKey = payload(match.match_id);
    badKey.idempotency_key = "not-a-key";
    expect(await codeOf(service.submit(user.user_id, badKey, NOW()))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("不同比赛同幂等键视为 payload 不同 → IDEMPOTENCY_KEY_REUSED", async () => {
    const { service, user, match, repo } = await setup();
    const key = newUuid();
    await service.submit(user.user_id, payload(match.match_id, undefined, key), NOW());
    const otherMatch = makeMatch({});
    await repo.matches.insert(otherMatch);
    const code = await codeOf(
      service.submit(user.user_id, payload(otherMatch.match_id, undefined, key), NOW()),
    );
    expect(code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});
