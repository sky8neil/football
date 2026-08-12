import { describe, expect, it } from "vitest";
import { newUuid } from "../domain/ids.js";
import type { User } from "../domain/types.js";
import { InMemoryRepository } from "../infrastructure/repositories.js";
import { UnlockPersistenceService } from "./unlock-persistence.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

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
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("UnlockPersistenceService", () => {
  it("按 unlock_v1 阈值顺序持久化已满足的解锁", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ career_points: 100 });
    await repo.users.insert(user);

    const outcome = await new UnlockPersistenceService(repo).persistForUser(
      user.user_id,
      NOW,
    );

    expect(outcome.created.map((unlock) => unlock.unlock_code)).toEqual([
      "profile_card_style_1",
      "favorite_team_name_accent",
    ]);
    expect(outcome.created).toMatchObject([
      {
        user_id: user.user_id,
        threshold_points: 30,
        source_version: "unlock_v1",
        unlocked_at: NOW,
      },
      {
        user_id: user.user_id,
        threshold_points: 100,
        source_version: "unlock_v1",
        unlocked_at: NOW,
      },
    ]);
  });

  it("重复调用只返回新创建记录，不重复插入", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ career_points: 200 });
    await repo.users.insert(user);
    const service = new UnlockPersistenceService(repo);

    await service.persistForUser(user.user_id, NOW);
    const replay = await service.persistForUser(user.user_id, NOW);

    expect(replay.created).toEqual([]);
    expect(await repo.unlocks.findByUser(user.user_id)).toHaveLength(3);
  });

  it("并发调用在唯一约束下只保留一份解锁记录", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ career_points: 200 });
    await repo.users.insert(user);
    const service = new UnlockPersistenceService(repo);

    const outcomes = await Promise.all([
      service.persistForUser(user.user_id, NOW),
      service.persistForUser(user.user_id, NOW),
    ]);

    expect(outcomes.reduce((count, outcome) => count + outcome.created.length, 0)).toBe(3);
    expect(await repo.unlocks.findByUser(user.user_id)).toHaveLength(3);
  });

  it("积分下降时保留历史解锁，不产生回收", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ career_points: 30 });
    await repo.users.insert(user);
    const service = new UnlockPersistenceService(repo);
    await service.persistForUser(user.user_id, NOW);

    await repo.users.update({ ...user, career_points: 0, updated_at: NOW });
    const outcome = await service.persistForUser(user.user_id, NOW);

    expect(outcome.created).toEqual([]);
    expect(await repo.unlocks.findByUser(user.user_id)).toHaveLength(1);
  });

  it("用户不存在时拒绝持久化", async () => {
    const repo = new InMemoryRepository();

    await expect(
      new UnlockPersistenceService(repo).persistForUser(newUuid(), NOW),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("无效 server_now 时在事务前 Fail Closed，且不写入解锁", async () => {
    const repo = new InMemoryRepository();
    const user = makeUser({ career_points: 30 });
    await repo.users.insert(user);

    await expect(
      new UnlockPersistenceService(repo).persistForUser(
        user.user_id,
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });

    await expect(repo.unlocks.findByUser(user.user_id)).resolves.toEqual([]);
  });
});
