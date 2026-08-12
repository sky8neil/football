import { describe, expect, it } from "vitest";
import { UserStatus } from "../domain/enums.js";
import { newUuid } from "../domain/ids.js";
import type { User } from "../domain/types.js";
import {
  InMemoryRepository,
  UniqueConstraintError,
  type AppRepository,
  type UnitOfWork,
} from "../infrastructure/repositories.js";
import { SessionService } from "./session.js";

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

/** insert 成功后仍抛唯一冲突，模拟并发请求先插入胜者。 */
class RaceInsertRepository implements AppRepository {
  private readonly base = new InMemoryRepository();

  get users() {
    const base = this.base;
    return {
      findByOpenid: (openid: string) => base.users.findByOpenid(openid),
      findById: (userId: string) => base.users.findById(userId),
      findAll: () => base.users.findAll(),
      insert: async (user: User) => {
        await base.users.insert(user);
        throw new UniqueConstraintError("users", "uk_openid", { openid: user.openid });
      },
      update: (user: User) => base.users.update(user),
    };
  }

  get matches() {
    return this.base.matches;
  }

  get predictions() {
    return this.base.predictions;
  }

  get matchResults() {
    return this.base.matchResults;
  }

  get settlements() {
    return this.base.settlements;
  }

  get settlementItems() {
    return this.base.settlementItems;
  }

  get unlocks() {
    return this.base.unlocks;
  }

  get jobLocks() {
    return this.base.jobLocks;
  }

  withTransaction<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    return this.base.withTransaction(fn);
  }
}

const serverNow = () => new Date("2026-08-08T00:00:00Z");

describe("SessionService.init", () => {
  it("无效 server_now 时 Fail Closed，且不创建用户", async () => {
    const repo = new InMemoryRepository();
    const service = new SessionService(repo);

    await expect(
      service.init(
        { openid: "openid_invalid_time", nickname: "Alice" },
        new Date("invalid"),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { field: "server_now" },
    });
    await expect(repo.users.findAll()).resolves.toEqual([]);
  });

  it("首次 init 创建 active 用户（created=true）", async () => {
    const repo = new InMemoryRepository();
    const service = new SessionService(repo);
    const result = await service.init({ openid: "openid_alice", nickname: "Alice" }, serverNow());
    expect(result.created).toBe(true);
    expect(result.user.openid).toBe("openid_alice");
    expect(result.user.nickname).toBe("Alice");
    expect(result.user.status).toBe(UserStatus.Active);
    expect(result.user.career_points).toBe(0);
    expect(result.user.career_level).toBe(1);
    expect(await repo.users.findByOpenid("openid_alice")).toBe(result.user);
  });

  it("已存在 active 用户时返回现有用户（created=false），不重复创建", async () => {
    const repo = new InMemoryRepository();
    const existing = makeUser({ openid: "openid_bob", nickname: "Bob" });
    await repo.users.insert(existing);
    const service = new SessionService(repo);
    const result = await service.init({ openid: "openid_bob", nickname: "Bob" }, serverNow());
    expect(result.created).toBe(false);
    expect(result.user).toBe(existing);
  });

  it("49.1 再 init 忽略 body 新 nickname：Bob 再 init Alice 仍返回 Bob 且不更新资料", async () => {
    const repo = new InMemoryRepository();
    const existing = makeUser({ openid: "openid_bob", nickname: "Bob" });
    await repo.users.insert(existing);
    const service = new SessionService(repo);
    const result = await service.init({ openid: "openid_bob", nickname: "Alice" }, serverNow());
    expect(result.created).toBe(false);
    expect(result.user.nickname).toBe("Bob");
    const stored = await repo.users.findByOpenid("openid_bob");
    expect(stored).not.toBeNull();
    expect(stored!.nickname).toBe("Bob");
  });

  it("nickname 缺失或 null 时拒绝", async () => {
    const repo = new InMemoryRepository();
    const service = new SessionService(repo);
    await expect(service.init({ openid: "openid_missing_nick" }, serverNow())).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      service.init({ openid: "openid_null_nick", nickname: null }, serverNow()),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("已删除用户 init 抛 USER_DELETED", async () => {
    const repo = new InMemoryRepository();
    await repo.users.insert(
      makeUser({ openid: "openid_deleted", status: "deleted", deleted_at: serverNow() }),
    );
    const service = new SessionService(repo);
    const err = await service
      .init({ openid: "openid_deleted", nickname: "Deleted" }, serverNow())
      .catch((e) => e);
    expect(err).toMatchObject({ code: "USER_DELETED" });
  });

  it("D28 session 并发创建同 openid 只有一个 active user", async () => {
    const repo = new RaceInsertRepository();
    const service = new SessionService(repo);
    const result = await service.init(
      { openid: "openid_race", nickname: "Racer" },
      serverNow(),
    );
    expect(result.created).toBe(false);
    expect(result.user.openid).toBe("openid_race");
    expect(result.user.nickname).toBe("Racer");
  });

  it("init 两次（真实内存实现）返回同一用户且不报错", async () => {
    const repo = new InMemoryRepository();
    const service = new SessionService(repo);
    const first = await service.init(
      { openid: "openid_twice", nickname: "Twice" },
      serverNow(),
    );
    const second = await service.init(
      { openid: "openid_twice", nickname: "Twice" },
      serverNow(),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.user.user_id).toBe(first.user.user_id);
  });
});

describe("SessionService.init - 输入校验", () => {
  it("未知字段拒绝", async () => {
    const service = new SessionService(new InMemoryRepository());
    const err = await service
      .init({ openid: "openid_x", token: "abc" } as Record<string, unknown>, serverNow())
      .catch((e) => e);
    expect(err).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("openid 缺失 / 空白 / 首尾空白拒绝", async () => {
    const service = new SessionService(new InMemoryRepository());
    for (const openid of [undefined, "", "   ", " abc "]) {
      const payload = openid === undefined ? {} : { openid };
      const err = await service
        .init(payload as Record<string, unknown>, serverNow())
        .catch((e) => e);
      expect(err).toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("nickname 首尾空白会 trim 后保存", async () => {
    const service = new SessionService(new InMemoryRepository());
    const result = await service.init(
      { openid: "openid_trimmed_nick", nickname: "  Alice\t" },
      serverNow(),
    );
    expect(result.user.nickname).toBe("Alice");
  });

  it("nickname 空白字符串 / 非字符串拒绝", async () => {
    const service = new SessionService(new InMemoryRepository());
    for (const nickname of ["", "   ", 123, true]) {
      const err = await service
        .init({ openid: "openid_nick2", nickname }, serverNow())
        .catch((e) => e);
      expect(err).toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("nickname 按 Unicode grapheme 计数，最多 32 个", async () => {
    const service = new SessionService(new InMemoryRepository());
    const grapheme = "👩‍💻";
    const accepted = await service.init(
      { openid: "openid_32_graphemes", nickname: ` ${grapheme.repeat(32)} ` },
      serverNow(),
    );
    expect(accepted.user.nickname).toBe(grapheme.repeat(32));

    await expect(
      service.init(
        { openid: "openid_33_graphemes", nickname: grapheme.repeat(33) },
        serverNow(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("nickname 必须在 trim 后至少保留 1 个 grapheme，并接受单个组合 grapheme", async () => {
    const service = new SessionService(new InMemoryRepository());
    const combiningGrapheme = "e\u0301";
    const accepted = await service.init(
      { openid: "openid_combining_grapheme", nickname: `  ${combiningGrapheme}  ` },
      serverNow(),
    );
    expect(accepted.user.nickname).toBe(combiningGrapheme);

    await expect(
      service.init({ openid: "openid_only_whitespace", nickname: " \t\n" }, serverNow()),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
