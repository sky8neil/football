import { describe, expect, it } from "vitest";
import type { User } from "../domain/types.js";
import {
  CLOUDBASE_REPOSITORY_ENV_KEYS,
  CloudBaseUserRepository,
  assertCloudBaseRepositoryConfig,
  cloudBaseCollectionName,
  loadCloudBaseRepositoryConfig,
  type CloudBaseDatabase,
  type CloudBaseDocumentResult,
  type CloudBaseQueryResult,
  type CloudBaseRepositoryConfig,
  type CloudBaseUserDocument,
} from "./cloudbase-repository.js";
import { DocumentNotFoundError } from "./repositories.js";

const CREATED_AT = new Date("2026-08-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-08-02T00:00:00.000Z");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const OPENID = "openid_user_1";

function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    FOOTBALL_CLOUD_ENVIRONMENT_ID: "cloud-test",
    FOOTBALL_RESOURCE_NAMESPACE: "football-test",
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    schema_version: 1,
    user_id: USER_ID,
    openid: OPENID,
    unionid: null,
    nickname: "预言家",
    favorite_team_id: null,
    status: "active",
    career_points: 0,
    career_valid_predictions: 0,
    career_wdl_hits: 0,
    career_exact_hits: 0,
    career_level: 1,
    career_best_level: 1,
    deleted_at: null,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

class FakeCloudBaseDatabase implements CloudBaseDatabase {
  readonly whereCalls: { collection: string; filter: Record<string, unknown> }[] = [];
  readonly getCalls: { collection: string; id: string }[] = [];
  readonly setCalls: { collection: string; id: string; document: CloudBaseUserDocument }[] = [];
  private readonly documents = new Map<string, Record<string, unknown>>();

  seed(collection: string, id: string, document: Record<string, unknown>): void {
    this.documents.set(`${collection}/${id}`, { ...document, _id: id });
  }

  async where(collection: string, filter: Record<string, unknown>): Promise<CloudBaseQueryResult> {
    this.whereCalls.push({ collection, filter });
    const data: Record<string, unknown>[] = [];
    for (const [key, document] of this.documents) {
      if (!key.startsWith(`${collection}/`)) {
        continue;
      }
      const matched = Object.entries(filter).every(([field, value]) => document[field] === value);
      if (matched) {
        data.push({ ...document });
      }
    }
    return { data };
  }

  async get(collection: string, id: string): Promise<CloudBaseDocumentResult> {
    this.getCalls.push({ collection, id });
    const document = this.documents.get(`${collection}/${id}`);
    return { data: document === undefined ? undefined : { ...document } };
  }

  async set(collection: string, id: string, document: CloudBaseUserDocument): Promise<void> {
    this.setCalls.push({ collection, id, document });
    this.documents.set(`${collection}/${id}`, { ...document, _id: id });
  }
}

function createRepo(
  database: FakeCloudBaseDatabase = new FakeCloudBaseDatabase(),
  config: CloudBaseRepositoryConfig = loadCloudBaseRepositoryConfig(validEnv()),
): { repo: CloudBaseUserRepository; database: FakeCloudBaseDatabase } {
  return { repo: new CloudBaseUserRepository(config, database), database };
}

describe("loadCloudBaseRepositoryConfig", () => {
  it("reads only the named CloudBase config keys and trims values", () => {
    const config = loadCloudBaseRepositoryConfig({
      FOOTBALL_CLOUD_ENVIRONMENT_ID: " cloud-test ",
      FOOTBALL_RESOURCE_NAMESPACE: " football-test ",
      FOOTBALL_SOME_SECRET: "must-not-be-read",
    });
    expect(config).toEqual({
      cloud_environment_id: "cloud-test",
      resource_namespace: "football-test",
    });
    expect(CLOUDBASE_REPOSITORY_ENV_KEYS).toEqual({
      cloud_environment_id: "FOOTBALL_CLOUD_ENVIRONMENT_ID",
      resource_namespace: "FOOTBALL_RESOURCE_NAMESPACE",
    });
  });

  it("fails closed on missing FOOTBALL_CLOUD_ENVIRONMENT_ID without echoing secrets", () => {
    const distinctive = "must-not-appear-in-error";
    try {
      loadCloudBaseRepositoryConfig({
        FOOTBALL_RESOURCE_NAMESPACE: distinctive,
      });
      throw new Error("expected Fail Closed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
      expect(message).not.toContain(distinctive);
    }
  });

  it("fails closed on missing FOOTBALL_RESOURCE_NAMESPACE without echoing secrets", () => {
    const distinctive = "must-not-appear-in-error";
    try {
      loadCloudBaseRepositoryConfig({
        FOOTBALL_CLOUD_ENVIRONMENT_ID: distinctive,
      });
      throw new Error("expected Fail Closed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("FOOTBALL_RESOURCE_NAMESPACE is required");
      expect(message).not.toContain(distinctive);
    }
  });

  it("fails closed on blank keys without echoing the other injected secret", () => {
    const distinctive = "must-not-appear-in-error";
    try {
      loadCloudBaseRepositoryConfig({
        FOOTBALL_CLOUD_ENVIRONMENT_ID: "   ",
        FOOTBALL_RESOURCE_NAMESPACE: distinctive,
      });
      throw new Error("expected Fail Closed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
      expect(message).not.toContain(distinctive);
    }

    try {
      loadCloudBaseRepositoryConfig({
        FOOTBALL_CLOUD_ENVIRONMENT_ID: distinctive,
        FOOTBALL_RESOURCE_NAMESPACE: "  ",
      });
      throw new Error("expected Fail Closed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("FOOTBALL_RESOURCE_NAMESPACE is required");
      expect(message).not.toContain(distinctive);
    }
  });
});

describe("cloudBaseCollectionName", () => {
  it("maps users to ${namespace}_users", () => {
    expect(cloudBaseCollectionName("football-test", "users")).toBe("football-test_users");
  });
});

describe("CloudBaseUserRepository", () => {
  it("fails closed when injected config has a blank environment id", () => {
    const distinctive = "must-not-appear-in-error";
    const database = new FakeCloudBaseDatabase();
    try {
      new CloudBaseUserRepository(
        {
          cloud_environment_id: "   ",
          resource_namespace: distinctive,
        },
        database,
      );
      throw new Error("expected Fail Closed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
      expect(message).not.toContain(distinctive);
    }

    expect(() =>
      assertCloudBaseRepositoryConfig({
        cloud_environment_id: "",
        resource_namespace: "football-test",
      }),
    ).toThrow("FOOTBALL_CLOUD_ENVIRONMENT_ID is required");
  });

  it("exposes the namespaced users collection", () => {
    const { repo } = createRepo();
    expect(repo.collectionName).toBe("football-test_users");
    expect(repo.cloudEnvironmentId).toBe("cloud-test");
  });

  it("findByOpenid queries the namespaced users collection by openid and maps a hit", async () => {
    const { repo, database } = createRepo();
    const stored = makeUser();
    database.seed("football-test_users", stored.user_id, {
      _id: stored.user_id,
      user_id: stored.user_id,
      openid: stored.openid,
      unionid: null,
      nickname: stored.nickname,
      favorite_team_id: null,
      status: "active",
      career_points: 0,
      career_valid_predictions: 0,
      career_wdl_hits: 0,
      career_exact_hits: 0,
      career_level: 1,
      career_best_level: 1,
      deleted_at: null,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
      schema_version: 1,
    });

    await expect(repo.findByOpenid(OPENID)).resolves.toEqual(stored);
    expect(database.whereCalls).toEqual([
      { collection: "football-test_users", filter: { openid: OPENID } },
    ]);
  });

  it("findByOpenid returns null when no document matches", async () => {
    const { repo, database } = createRepo();
    await expect(repo.findByOpenid(OPENID)).resolves.toBeNull();
    expect(database.whereCalls).toEqual([
      { collection: "football-test_users", filter: { openid: OPENID } },
    ]);
  });

  it("insert writes schema_version=1, _id=user_id and created_at", async () => {
    const { repo, database } = createRepo();
    const user = makeUser();

    await repo.insert(user);

    expect(database.setCalls).toHaveLength(1);
    expect(database.setCalls[0]).toEqual({
      collection: "football-test_users",
      id: USER_ID,
      document: {
        _id: USER_ID,
        user_id: USER_ID,
        openid: OPENID,
        unionid: null,
        nickname: "预言家",
        favorite_team_id: null,
        status: "active",
        career_points: 0,
        career_valid_predictions: 0,
        career_wdl_hits: 0,
        career_exact_hits: 0,
        career_level: 1,
        career_best_level: 1,
        deleted_at: null,
        created_at: CREATED_AT,
        updated_at: UPDATED_AT,
        schema_version: 1,
      },
    });
  });

  it("update writes schema_version=1, _id=user_id and created_at onto the existing document", async () => {
    const { repo, database } = createRepo();
    const user = makeUser();
    await repo.insert(user);

    const updated = makeUser({
      nickname: "已更新",
      career_points: 12,
      updated_at: new Date("2026-08-03T00:00:00.000Z"),
    });
    await repo.update(updated);

    expect(database.getCalls).toEqual([{ collection: "football-test_users", id: USER_ID }]);
    const lastWrite = database.setCalls.at(-1);
    expect(lastWrite?.id).toBe(USER_ID);
    expect(lastWrite?.document).toMatchObject({
      _id: USER_ID,
      user_id: USER_ID,
      schema_version: 1,
      created_at: CREATED_AT,
      nickname: "已更新",
      career_points: 12,
    });
  });

  it("update fails closed when the user document does not exist", async () => {
    const { repo } = createRepo();
    await expect(repo.update(makeUser())).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it("fails closed on unwired methods and never returns empty stand-in data", async () => {
    const { repo } = createRepo();

    await expect(repo.findById(USER_ID)).rejects.toThrow(/待真环境集成验证/);
    await expect(repo.findAll()).rejects.toThrow(/待真环境集成验证/);

    await expect(repo.findById(USER_ID)).rejects.toThrow(
      "CloudBaseUserRepository.findById not wired; TODO(B1 接线后) 待真环境集成验证",
    );

    let findAllResult: User[] | undefined;
    try {
      findAllResult = await repo.findAll();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("待真环境集成验证");
    }
    expect(findAllResult).toBeUndefined();
  });
});
