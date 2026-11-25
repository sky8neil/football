import { describe, expect, it } from "vitest";
import { CloudBaseAppRepository } from "./cloudbase-app-repository.js";
import {
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  cloudBaseCollectionName,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-db.js";
import { DocumentNotFoundError, UniqueConstraintError, type UnitOfWork } from "./repositories.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "cloud-test",
  resource_namespace: "ft",
};

class LockPatchDb implements CloudBaseDb {
  gets: string[] = [];
  locks: Array<{ collection: string; id: string }> = [];
  patches: Array<{ collection: string; id: string; fields: Record<string, unknown> }> = [];
  updates: Array<{ collection: string; id: string; document: CloudBaseDocument }> = [];
  documents = new Map<string, CloudBaseDocument>();
  duplicateOnPatch = false;

  constructor(private readonly inTransaction = false) {}

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    this.gets.push(`${collection}/${id}`);
    return this.documents.get(`${collection}/${id}`) ?? null;
  }

  async getForUpdate(collection: string, id: string): Promise<CloudBaseDocument | null> {
    if (!this.inTransaction) throw new Error("getForUpdate requires an active transaction");
    this.locks.push({ collection, id });
    const document = this.documents.get(`${collection}/${id}`);
    return document === undefined ? null : { ...document };
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    this.documents.set(`${collection}/${id}`, { ...document, _id: id });
  }

  async update(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    this.updates.push({ collection, id, document });
    const key = `${collection}/${id}`;
    const current = this.documents.get(key);
    if (current === undefined) throw new CloudBaseDocumentNotFoundError(collection, id);
    this.documents.set(key, { ...current, ...document, _id: id });
  }

  async patch(collection: string, id: string, fields: Record<string, unknown>): Promise<void> {
    this.patches.push({ collection, id, fields: { ...fields } });
    if (this.duplicateOnPatch) {
      throw new CloudBaseDuplicateKeyError(collection, "uk_openid", { openid: fields.openid });
    }
    const key = `${collection}/${id}`;
    const current = this.documents.get(key);
    if (current === undefined) throw new CloudBaseDocumentNotFoundError(collection, id);
    this.documents.set(key, { ...current, ...fields, _id: id });
  }

  async query(): Promise<CloudBaseDocument[]> {
    return [];
  }

  async count(): Promise<number> {
    return 0;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    const tx = new LockPatchDb(true);
    tx.documents = this.documents;
    tx.gets = this.gets;
    tx.locks = this.locks;
    tx.patches = this.patches;
    tx.updates = this.updates;
    tx.duplicateOnPatch = this.duplicateOnPatch;
    return work(tx);
  }
}

class MergeUpdateDb implements CloudBaseDb {
  gets: string[] = [];
  updates: Array<{ collection: string; id: string; document: CloudBaseDocument }> = [];
  documents = new Map<string, CloudBaseDocument>();

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    this.gets.push(`${collection}/${id}`);
    return this.documents.get(`${collection}/${id}`) ?? null;
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    this.documents.set(`${collection}/${id}`, { ...document, _id: id });
  }

  async update(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    this.updates.push({ collection, id, document: { ...document } });
    const key = `${collection}/${id}`;
    const current = this.documents.get(key);
    if (current === undefined) throw new CloudBaseDocumentNotFoundError(collection, id);
    this.documents.set(key, { ...current, ...document, _id: id });
  }

  async query(
    _collection: string,
    _filter?: Record<string, unknown>,
    _options?: CloudBaseQueryOptions,
  ): Promise<CloudBaseDocument[]> {
    return [];
  }

  async count(): Promise<number> {
    return 0;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    return work(this);
  }
}

function seedUser(db: { documents: Map<string, CloudBaseDocument> }, userId: string): void {
  const collection = cloudBaseCollectionName(CONFIG.resource_namespace, "users");
  db.documents.set(`${collection}/${userId}`, {
    _id: userId,
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
    nickname: "Ada",
    career_points: 4,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
}

describe("CloudBaseAppRepository 事务内行锁与局部 patch [Slice 2]", () => {
  it("事务外锁读取拒绝且不调用 get", async () => {
    const db = new LockPatchDb();
    seedUser(db, "u1");
    const repo = new CloudBaseAppRepository(CONFIG, db);
    await expect(repo.users.findByIdForUpdate!("u1")).rejects.toThrow(/active transaction/);
    await expect(repo.matches.findByIdForUpdate!("m1")).rejects.toThrow(/active transaction/);
    await expect(repo.groups.findByIdForUpdate!("g1")).rejects.toThrow(/active transaction/);
    await expect(repo.userSeasonStats.findByUserAndSeasonForUpdate!("u1", "2026_2027"))
      .rejects.toThrow(/active transaction/);
    await expect(repo.rankings.findByPeriodAndUserForUpdate!("week", "2026-W32", "u1"))
      .rejects.toThrow(/active transaction/);
    expect(db.gets).toEqual([]);
    expect(db.locks).toEqual([]);
  });

  it("底层无 getForUpdate 时拒绝且不退化为 get", async () => {
    const db = new MergeUpdateDb();
    const repo = new CloudBaseAppRepository(CONFIG, db);
    await expect(repo.withTransaction((tx) => tx.users.findByIdForUpdate!("u1")))
      .rejects.toThrow(/not implemented|active transaction/);
    expect(db.gets).toEqual([]);
  });

  it("事务内 getForUpdate 解码日期，缺失返回 null，且不走 get", async () => {
    const db = new LockPatchDb();
    seedUser(db, "u1");
    const users = cloudBaseCollectionName(CONFIG.resource_namespace, "users");
    const matches = cloudBaseCollectionName(CONFIG.resource_namespace, "matches");
    const groups = cloudBaseCollectionName(CONFIG.resource_namespace, "groups");
    const stats = cloudBaseCollectionName(CONFIG.resource_namespace, "user_season_stats");
    const rankings = cloudBaseCollectionName(CONFIG.resource_namespace, "rankings");
    db.documents.set(`${matches}/m1`, {
      _id: "m1",
      match_id: "m1",
      settlement_status: "settling",
      kickoff_at: NOW.toISOString(),
    });
    db.documents.set(`${groups}/g1`, { _id: "g1", group_id: "g1", member_count: 1, status: "active" });
    const repo = new CloudBaseAppRepository(CONFIG, db);

    await repo.withTransaction(async (tx) => {
      const locked = await tx.users.findByIdForUpdate!("u1");
      expect(locked?.created_at).toBeInstanceOf(Date);
      expect((locked?.created_at as Date).toISOString()).toBe(NOW.toISOString());
      expect(locked).toMatchObject({ openid: "openid-u1", nickname: "Ada", career_points: 4 });
      await expect(tx.users.findByIdForUpdate!("missing")).resolves.toBeNull();
      await expect(tx.matches.findByIdForUpdate!("m1")).resolves.toMatchObject({
        settlement_status: "settling",
        kickoff_at: NOW,
      });
      await expect(tx.groups!.findByIdForUpdate!("g1")).resolves.toMatchObject({ member_count: 1 });
      await expect(tx.userSeasonStats!.findByUserAndSeasonForUpdate!("u1", "2026_2027")).resolves.toBeNull();
      await expect(tx.rankings!.findByPeriodAndUserForUpdate!("week", "2026-W32", "u1")).resolves.toBeNull();
    });

    expect(db.gets).toEqual([]);
    expect(db.locks.map((item) => item.collection)).toEqual([
      users,
      users,
      matches,
      groups,
      stats,
      rankings,
    ]);
    expect(db.locks[0]).toEqual({ collection: users, id: "u1" });
    expect(db.locks[2]).toEqual({ collection: matches, id: "m1" });
    expect(db.locks[3]).toEqual({ collection: groups, id: "g1" });
    expect(db.locks[4]?.id).toMatch(/^key_/);
    expect(db.locks[5]?.id).toMatch(/^key_/);
    expect(db.locks[4]?.id).not.toBe(db.locks[5]?.id);
  });

  it("patch 只提交传入字段且不先读，缺失映射为 DocumentNotFoundError", async () => {
    const db = new LockPatchDb();
    seedUser(db, "u1");
    const users = cloudBaseCollectionName(CONFIG.resource_namespace, "users");
    const repo = new CloudBaseAppRepository(CONFIG, db);
    const updatedAt = new Date("2026-08-10T00:00:00.000Z");

    await repo.users.patchFields!("u1", { user_id: "u1", nickname: "Moon", updated_at: updatedAt });
    expect(db.gets).toEqual([]);
    expect(db.locks).toEqual([]);
    expect(db.updates).toEqual([]);
    expect(db.patches).toEqual([
      { collection: users, id: "u1", fields: { nickname: "Moon", updated_at: updatedAt } },
    ]);
    await expect(repo.users.findById("u1")).resolves.toMatchObject({
      nickname: "Moon",
      career_points: 4,
      openid: "openid-u1",
    });

    await expect(repo.users.patchFields!("missing", { nickname: "x" })).rejects.toMatchObject({
      name: "DocumentNotFoundError",
      collection: "users",
      id: "missing",
    });
    expect(db.gets).toEqual([`${users}/u1`]);
  });

  it("五个集合的 patch 使用同一文档 ID，且不覆盖未传入字段", async () => {
    const db = new LockPatchDb();
    const repo = new CloudBaseAppRepository(CONFIG, db);
    const updatedAt = new Date("2026-08-10T00:00:00.000Z");
    const specs = [
      {
        collection: "users",
        seedId: "u1",
        seed: { user_id: "u1", nickname: "Ada", career_points: 4 },
        patch: (tx: UnitOfWork) => tx.users.patchFields!("u1", { nickname: "Moon", updated_at: updatedAt }),
      },
      {
        collection: "matches",
        seedId: "m1",
        seed: { match_id: "m1", settlement_status: "settling", settled_result_version: 2 },
        patch: (tx: UnitOfWork) => tx.matches.patchFields!("m1", {
          regular_home_score: 1,
          updated_at: updatedAt,
        }),
      },
      {
        collection: "groups",
        seedId: "g1",
        seed: { group_id: "g1", status: "active", member_count: 4, invite_code: "INVITE01" },
        patch: (tx: UnitOfWork) => tx.groups!.patchFields!("g1", { member_count: 5, updated_at: updatedAt }),
      },
    ] as const;

    for (const spec of specs) {
      const collection = cloudBaseCollectionName(CONFIG.resource_namespace, spec.collection);
      db.documents.set(`${collection}/${spec.seedId}`, { _id: spec.seedId, ...spec.seed });
    }

    let statsId = "";
    let rankingId = "";
    await repo.withTransaction(async (tx) => {
      await tx.userSeasonStats!.findByUserAndSeasonForUpdate!("u1", "2026_2027");
      await tx.rankings!.findByPeriodAndUserForUpdate!("week", "2026-W32", "u1");
      statsId = db.locks.at(-2)?.id ?? "";
      rankingId = db.locks.at(-1)?.id ?? "";
    });
    const statsCollection = cloudBaseCollectionName(CONFIG.resource_namespace, "user_season_stats");
    const rankingsCollection = cloudBaseCollectionName(CONFIG.resource_namespace, "rankings");
    db.documents.set(`${statsCollection}/${statsId}`, {
      _id: statsId,
      user_id: "u1",
      level_season_id: "2026_2027",
      points: 9,
      level: 2,
      best_level: 3,
    });
    db.documents.set(`${rankingsCollection}/${rankingId}`, {
      _id: rankingId,
      period_type: "week",
      period_key: "2026-W32",
      user_id: "u1",
      period_score: 11,
      global_rank: 5,
      is_final: false,
    });

    await repo.withTransaction(async (tx) => {
      for (const spec of specs) await spec.patch(tx);
      await tx.userSeasonStats!.patchFields!("u1", "2026_2027", { points: 15, updated_at: updatedAt });
      await tx.rankings!.patchFields!("week", "2026-W32", "u1", { is_final: true, updated_at: updatedAt });
    });

    const patched = db.patches.slice(-5);
    expect(patched.map((item) => [item.collection, item.id, item.fields])).toEqual([
      [cloudBaseCollectionName(CONFIG.resource_namespace, "users"), "u1", { nickname: "Moon", updated_at: updatedAt }],
      [cloudBaseCollectionName(CONFIG.resource_namespace, "matches"), "m1", { regular_home_score: 1, updated_at: updatedAt }],
      [cloudBaseCollectionName(CONFIG.resource_namespace, "groups"), "g1", { member_count: 5, updated_at: updatedAt }],
      [statsCollection, statsId, { points: 15, updated_at: updatedAt }],
      [rankingsCollection, rankingId, { is_final: true, updated_at: updatedAt }],
    ]);
    expect(db.documents.get(`${cloudBaseCollectionName(CONFIG.resource_namespace, "matches")}/m1`)).toMatchObject({
      settlement_status: "settling",
      settled_result_version: 2,
      regular_home_score: 1,
    });
    expect(db.documents.get(`${statsCollection}/${statsId}`)).toMatchObject({
      points: 15,
      level: 2,
      best_level: 3,
    });
    expect(db.documents.get(`${rankingsCollection}/${rankingId}`)).toMatchObject({
      is_final: true,
      period_score: 11,
      global_rank: 5,
    });
    expect(db.updates).toEqual([]);
  });

  it("无 patch 能力时只把传入字段交给 update，不先读整行", async () => {
    const db = new MergeUpdateDb();
    const userId = "u1";
    const collection = cloudBaseCollectionName(CONFIG.resource_namespace, "users");
    db.documents.set(`${collection}/${userId}`, {
      _id: userId,
      user_id: userId,
      nickname: "Ada",
      career_points: 4,
      created_at: NOW,
      updated_at: NOW,
    });
    const repo = new CloudBaseAppRepository(CONFIG, db);
    const updatedAt = new Date("2026-08-10T00:00:00.000Z");
    await repo.users.patchFields!(userId, { nickname: "Moon", updated_at: updatedAt });
    expect(db.gets).toEqual([]);
    expect(db.updates).toEqual([
      { collection, id: userId, document: { nickname: "Moon", updated_at: updatedAt } },
    ]);
    await expect(repo.users.findById(userId)).resolves.toMatchObject({
      nickname: "Moon",
      career_points: 4,
    });
    await expect(repo.matches.patchFields!("missing", { regular_home_score: 1 })).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it("主键与路径不一致时拒绝且不写库；唯一冲突映射为 UniqueConstraintError", async () => {
    const db = new LockPatchDb();
    seedUser(db, "u1");
    const repo = new CloudBaseAppRepository(CONFIG, db);
    await expect(repo.users.patchFields!("u1", { user_id: "other", nickname: "Moon" })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(repo.matches.patchFields!("m1", { match_id: "other" })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(repo.groups.patchFields!("g1", { group_id: "other" })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(repo.userSeasonStats.patchFields!("u1", "2026_2027", { user_id: "other" })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await expect(repo.rankings.patchFields!("week", "2026-W32", "u1", { period_key: "2026-W99" }))
      .rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(db.patches).toEqual([]);
    expect(db.updates).toEqual([]);

    db.duplicateOnPatch = true;
    await expect(repo.users.patchFields!("u1", { openid: "taken" })).rejects.toBeInstanceOf(UniqueConstraintError);
  });
});
