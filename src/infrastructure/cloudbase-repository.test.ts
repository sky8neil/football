import { describe, expect, it } from "vitest";
import { GroupStatus } from "../domain/enums.js";
import type { BoardSnapshot, Group, User } from "../domain/types.js";
import { defaultLevelState } from "../domain/types.js";
import { GroupsService } from "../application/groups.js";
import { COLLECTION_DEFINITIONS } from "../schema/collections.js";
import { UNIQUE_INDEXES } from "../schema/indexes.js";
import {
  CLOUDBASE_REPOSITORY_ENV_KEYS,
  CloudBaseAppRepository,
  CloudBaseDocumentNotFoundError,
  CloudBaseDuplicateKeyError,
  CloudBaseUserRepository,
  assertCloudBaseRepositoryConfig,
  cloudBaseCollectionName,
  loadCloudBaseRepositoryConfig,
  type CloudBaseDb,
  type CloudBaseDocument,
  type CloudBaseQueryOptions,
  type CloudBaseRepositoryConfig,
} from "./cloudbase-repository.js";
import { InMemoryRepository } from "./repositories.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CURSOR_SECRET = "test-group-cursor-secret";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID_2 = "00000000-0000-4000-8000-000000000002";
const CONFIG: CloudBaseRepositoryConfig = {
  cloud_environment_id: "cloud-test",
  resource_namespace: "football-test",
};

function cloneValue<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

class MemoryCloudBaseDb implements CloudBaseDb {
  private documents = new Map<string, CloudBaseDocument>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly transactionView = false) {}

  async get(collection: string, id: string): Promise<CloudBaseDocument | null> {
    const document = this.documents.get(`${collection}/${id}`);
    return document === undefined ? null : cloneValue(document);
  }

  async add(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    if (this.documents.has(`${collection}/${id}`)) {
      const def = COLLECTION_DEFINITIONS.find((item) => collection.endsWith(`_${item.collection}`));
      const keyField = def ? Object.keys(def.fields).find((field) => def.fields[field]?.immutable) : undefined;
      throw new CloudBaseDuplicateKeyError(collection, `pk_${def?.collection ?? "document"}`, {
        [keyField ?? "_id"]: keyField ? document[keyField] : id,
      });
    }
    this.assertUnique(collection, document);
    this.documents.set(`${collection}/${id}`, cloneValue({ ...document, _id: id }));
  }

  async update(collection: string, id: string, document: CloudBaseDocument): Promise<void> {
    const storageKey = `${collection}/${id}`;
    if (!this.documents.has(storageKey)) {
      throw new CloudBaseDocumentNotFoundError(collection, id);
    }
    this.assertUnique(collection, document, id);
    this.documents.set(storageKey, cloneValue({ ...document, _id: id }));
  }

  async query(
    collection: string,
    filter: Record<string, unknown> = {},
    options: CloudBaseQueryOptions = {},
  ): Promise<CloudBaseDocument[]> {
    let result = [...this.documents.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, document]) => cloneValue(document))
      .filter((document) => Object.entries(filter).every(([field, value]) => equal(document[field], value)));
    if (options.order_by) {
      const direction = options.direction === "desc" ? -1 : 1;
      const field = options.order_by;
      result = result.sort((a, b) => {
        const left = a[field];
        const right = b[field];
        const compare = left instanceof Date && right instanceof Date
          ? left.getTime() - right.getTime()
          : String(left).localeCompare(String(right));
        return compare * direction;
      });
    }
    const offset = options.offset ?? 0;
    return options.limit === undefined
      ? result.slice(offset)
      : result.slice(offset, offset + options.limit);
  }

  async count(collection: string, filter: Record<string, unknown> = {}): Promise<number> {
    return (await this.query(collection, filter)).length;
  }

  async transaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    if (this.transactionView) return this.runTransaction(work);
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.runTransaction(work);
    } finally {
      release();
    }
  }

  private async runTransaction<T>(work: (transactionDb: CloudBaseDb) => Promise<T>): Promise<T> {
    const transaction = new MemoryCloudBaseDb(true);
    transaction.documents = new Map([...this.documents].map(([key, value]) => [key, cloneValue(value)]));
    const result = await work(transaction);
    this.documents = transaction.documents;
    return result;
  }

  private assertUnique(collection: string, document: CloudBaseDocument, excludeId?: string): void {
    const definition = COLLECTION_DEFINITIONS.find((item) => collection.endsWith(`_${item.collection}`));
    if (!definition) return;
    for (const index of UNIQUE_INDEXES.filter((item) => item.collection === definition.collection)) {
      const conflict = [...this.documents.entries()].some(([storageKey, existing]) => {
        if (!storageKey.startsWith(`${collection}/`) || storageKey === `${collection}/${excludeId ?? ""}`) return false;
        return index.fields.every((field) => equal(existing[field], document[field]));
      });
      if (conflict) {
        throw new CloudBaseDuplicateKeyError(
          collection,
          index.name,
          Object.fromEntries(index.fields.map((field) => [field, document[field]])),
        );
      }
    }
  }
}

function makeUser(userId = USER_ID): User {
  return {
    schema_version: 1,
    user_id: userId,
    openid: `openid-${userId}`,
    unionid: null,
    nickname: `user-${userId.slice(-1)}`,
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_last_scoring_match_at: null,
    career_level: 1,
    career_best_level: 1,
    career_level_state: defaultLevelState(),
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeGroup(groupId: string, inviteCode: string, ownerId = USER_ID): Group {
  return {
    schema_version: 1,
    group_id: groupId,
    owner_user_id: ownerId,
    invite_code: inviteCode,
    status: GroupStatus.Active,
    member_count: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeSeasonSnapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    schema_version: 1,
    snapshot_id: `snapshot-${Math.random()}`,
    board: "season",
    snapshot_at: NOW,
    level_season_id: "2026_2027",
    is_final: false,
    user_id: USER_ID,
    rank: 1,
    career_points: null,
    career_exact_hits: null,
    career_valid_predictions: null,
    career_last_scoring_match_at: null,
    window_score_sum: null,
    window_n: null,
    season_points: 12,
    season_exact_hits: 1,
    season_valid_predictions: 4,
    season_last_scoring_match_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

function createCloudBaseRepository(db = new MemoryCloudBaseDb()): CloudBaseAppRepository {
  return new CloudBaseAppRepository(CONFIG, db);
}

describe("CloudBase repository configuration", () => {
  it("loads only the repository environment keys and trims values", () => {
    expect(loadCloudBaseRepositoryConfig({
      FOOTBALL_CLOUD_ENVIRONMENT_ID: " cloud-test ",
      FOOTBALL_RESOURCE_NAMESPACE: " football-test ",
      FOOTBALL_OTHER_SECRET: "unused",
    })).toEqual(CONFIG);
    expect(CLOUDBASE_REPOSITORY_ENV_KEYS).toEqual({
      cloud_environment_id: "FOOTBALL_CLOUD_ENVIRONMENT_ID",
      resource_namespace: "FOOTBALL_RESOURCE_NAMESPACE",
    });
    expect(cloudBaseCollectionName("football-test", "users")).toBe("football-test_users");
  });

  it("requires both values", () => {
    expect(() => assertCloudBaseRepositoryConfig({
      cloud_environment_id: undefined,
      resource_namespace: "football",
    })).toThrow("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
    expect(() => assertCloudBaseRepositoryConfig({
      cloud_environment_id: "cloud",
      resource_namespace: " ",
    })).toThrow("FOOTBALL_RESOURCE_NAMESPACE is required");
  });
});

describe("CloudBaseAppRepository", () => {
  it("round-trips users using `_id = user_id` and exposes the full AppRepository ports", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    const user = makeUser();
    await repo.users.insert(user);
    await expect(repo.users.findById(USER_ID)).resolves.toEqual(user);
    await expect(repo.users.findByOpenid(user.openid)).resolves.toEqual(user);
    expect(Object.keys(repo).sort()).toEqual([
      "adminAuditLogs", "admins", "anomalies", "boardSnapshots", "config", "db", "deletedOpenidMappings",
      "groupMembers", "groups", "jobLocks", "levelHistory", "matchProviderMappings",
      "matchResults", "matches", "predictions", "providerSnapshots", "rankings",
      "settlementItems", "settlements", "syncLogs", "teamProviderMappings", "teams",
      "unlocks", "userSeasonStats", "users",
    ].sort());
  });

  it("marks grouped crowd counts for the pre-launch CloudBase wiring slice", async () => {
    const repo = createCloudBaseRepository();
    await expect(repo.predictions.countByMatchGroupedByResult("match-id"))
      .rejects.toThrow("尚未实现；待上线前接线切片");
  });

  it("retains soft-deleted users so identity resolution sees the tombstone", async () => {
    const memory = new InMemoryRepository();
    const cloudbase = createCloudBaseRepository();
    const deleted = {
      ...makeUser(USER_ID_2),
      status: "deleted" as const,
      nickname: null,
      deleted_at: NOW,
    };
    await memory.users.insert(deleted);
    await cloudbase.users.insert(deleted);
    await expect(memory.users.findByOpenid(deleted.openid)).resolves.toMatchObject({ status: "deleted" });
    await expect(cloudbase.users.findByOpenid(deleted.openid)).resolves.toMatchObject({ status: "deleted" });
  });

  it("maps native unique index conflicts to the repository contract without prechecking", async () => {
    const repo = createCloudBaseRepository();
    await repo.groups.insert(makeGroup("group-1", "ABCDEFGH"));
    await expect(repo.groups.insert(makeGroup("group-2", "ABCDEFGH"))).rejects.toMatchObject({
      name: "UniqueConstraintError",
      collection: "groups",
      indexName: "uk_invite_code",
    });
  });

  it("keeps latest regular season snapshots separate from final snapshots", async () => {
    const repo = createCloudBaseRepository();
    const regular = makeSeasonSnapshot();
    const final = makeSeasonSnapshot({
      snapshot_id: "final-snapshot",
      snapshot_at: new Date(NOW.getTime() + 1000),
      is_final: true,
      season_points: 15,
    });
    await repo.boardSnapshots.insert(regular);
    await repo.boardSnapshots.insert(final);
    await expect(repo.boardSnapshots.findLatestBySeason("2026_2027")).resolves.toEqual([regular]);
    await expect(repo.boardSnapshots.findFinalBySeason("2026_2027")).resolves.toEqual([final]);
    await expect(repo.boardSnapshots.listFinalSeasonIds()).resolves.toEqual(["2026_2027"]);
  });

  it("rejects a final snapshot colliding with a regular snapshot at the same unique key", async () => {
    const repo = createCloudBaseRepository();
    await repo.boardSnapshots.insert(makeSeasonSnapshot());
    await expect(repo.boardSnapshots.insert(makeSeasonSnapshot({
      snapshot_id: "same-time-final",
      is_final: true,
    }))).rejects.toMatchObject({
      name: "UniqueConstraintError",
      collection: "board_snapshots",
      indexName: "uk_board_snapshot_user",
    });
    await expect(repo.boardSnapshots.findByBoardAndSnapshotAt("season", NOW)).resolves.toHaveLength(1);
  });

  it("rolls back a failed transaction and keeps unique-key writes atomic", async () => {
    const repo = createCloudBaseRepository();
    const group = makeGroup("group-tx", "ABCDEFGH");
    await expect(repo.withTransaction(async (tx) => {
      await tx.groups!.insert(group);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await expect(repo.groups.findById(group.group_id)).resolves.toBeNull();
  });

  it("supports transaction-scoped savepoints", async () => {
    const repo = createCloudBaseRepository();
    await repo.withTransaction(async (tx) => {
      await tx.groups!.insert(makeGroup("group-kept", "ABCDEFGH"));
      await expect(tx.savepoint(async (inner) => {
        await inner.groups!.insert(makeGroup("group-rolled-back", "JKLMNPQR"));
        throw new Error("savepoint abort");
      })).rejects.toThrow("savepoint abort");
      expect(await tx.groups!.findById("group-rolled-back")).toBeNull();
    });
    expect(await repo.groups.findById("group-kept")).not.toBeNull();
  });

  it("matches InMemory group creation, soft membership filtering and cursor pages", async () => {
    async function exercise(repo: InMemoryRepository | CloudBaseAppRepository) {
      await repo.users.insert(makeUser());
      const codes = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
      const service = new GroupsService(repo, {
        cursorSecret: CURSOR_SECRET,
        inviteCodeFactory: () => codes.shift()!,
      });
      await service.createGroup(USER_ID, NOW);
      await service.createGroup(USER_ID, NOW);
      await service.createGroup(USER_ID, NOW);
      const first = await service.listMyGroups(USER_ID, { limit: 2, cursor: null });
      const second = await service.listMyGroups(USER_ID, { limit: 2, cursor: first.next_cursor });
      return { first, second };
    }

    const memory = await exercise(new InMemoryRepository());
    const cloudbase = await exercise(createCloudBaseRepository());
    for (const result of [memory, cloudbase]) {
      expect(result.first.items).toHaveLength(2);
      expect(result.first.has_more).toBe(true);
      expect(result.second.items).toHaveLength(1);
      expect(result.second.has_more).toBe(false);
    }
  });

  it("counts members from active membership rows, matching the groups service contract", async () => {
    const db = new MemoryCloudBaseDb();
    const repo = createCloudBaseRepository(db);
    await repo.users.insert(makeUser());
    await repo.users.insert(makeUser(USER_ID_2));
    const service = new GroupsService(repo, { cursorSecret: CURSOR_SECRET, inviteCodeFactory: () => "ABCDEFGH" });
    const created = await service.createGroup(USER_ID, NOW);
    await service.joinGroup(USER_ID_2, created.invite_code, NOW);
    await expect(service.getGroup(USER_ID, created.group_id)).resolves.toMatchObject({ member_count: 2 });
    expect(await repo.groupMembers.findByGroup(created.group_id)).toHaveLength(2);
    expect(await db.count("football-test_groups")).toBe(1);
  });
});

describe("CloudBaseUserRepository", () => {
  it("retains the standalone wrapper over the same CloudBaseDb port", async () => {
    const db = new MemoryCloudBaseDb();
    const users = new CloudBaseUserRepository(CONFIG, db);
    expect(users.collectionName).toBe("football-test_users");
    expect(users.cloudEnvironmentId).toBe("cloud-test");
    await users.insert(makeUser());
    await expect(users.findByOpenid(makeUser().openid)).resolves.toMatchObject({ user_id: USER_ID });
  });
});
