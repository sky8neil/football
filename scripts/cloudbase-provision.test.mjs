import { describe, expect, it } from "vitest";
import {
  loadSchemaPlan,
  normalizeRemoteIndexes,
  provisionDatabase,
  sanitize,
} from "./cloudbase-provision.mjs";

/** 只实现 provisionDatabase 用到的方法，行为对齐 manager-node 的真实语义。 */
class FakeDatabase {
  constructor({ collections = [], indexes = {} } = {}) {
    this.collections = new Set(collections);
    this.indexes = new Map(Object.entries(indexes));
    this.calls = [];
  }

  async checkCollectionExists(name) {
    this.calls.push(["checkCollectionExists", name]);
    return { RequestId: "req", Exists: this.collections.has(name) };
  }

  async createCollection(name) {
    this.calls.push(["createCollection", name]);
    this.collections.add(name);
    return { RequestId: "req" };
  }

  async describeCollection(name) {
    this.calls.push(["describeCollection", name]);
    if (!this.collections.has(name)) throw new Error(`[DescribeTable] Db or Table not exist: ${name}`);
    const rows = this.indexes.get(name) ?? [];
    return {
      RequestId: "req",
      Indexes: rows.map((row) => ({
        Name: row.name,
        MgoKeySchema: { MgoIndexKeys: row.fields, MgoIsUnique: row.unique },
      })),
    };
  }

  async updateCollection(name, payload) {
    this.calls.push(["updateCollection", name, payload]);
    const rows = this.indexes.get(name) ?? [];
    const dropped = new Set((payload.DropIndexes ?? []).map((item) => item.IndexName));
    const kept = rows.filter((row) => !dropped.has(row.name));
    for (const item of payload.CreateIndexes ?? []) {
      kept.push({
        name: item.IndexName,
        fields: item.MgoKeySchema.MgoIndexKeys,
        unique: item.MgoKeySchema.MgoIsUnique,
      });
    }
    this.indexes.set(name, kept);
    return { RequestId: "req" };
  }

  createdCollections() {
    return this.calls.filter((call) => call[0] === "createCollection").map((call) => call[1]);
  }

  updateCalls() {
    return this.calls.filter((call) => call[0] === "updateCollection");
  }
}

const PLAN = {
  collections: [
    { logical: "users", name: "t_users" },
    { logical: "matches", name: "t_matches" },
  ],
  indexes: [
    {
      logical: "users",
      collection: "t_users",
      name: "uk_openid",
      unique: true,
      fields: [{ Name: "openid", Direction: "1" }],
    },
    {
      logical: "matches",
      collection: "t_matches",
      name: "ix_kickoff",
      unique: false,
      fields: [{ Name: "league_id", Direction: "1" }, { Name: "kickoff_at", Direction: "1" }],
    },
  ],
};

const noop = () => {};

describe("provisionDatabase：集合", () => {
  it("verify 模式不写库，缺集合与缺索引都报出来", async () => {
    const database = new FakeDatabase();
    const report = await provisionDatabase(PLAN, { apply: false, log: noop }, database);

    expect(database.createdCollections()).toEqual([]);
    expect(database.updateCalls()).toEqual([]);
    expect(report.collections.failed.map((item) => item.name)).toEqual(["t_users", "t_matches"]);
    expect(report.indexes.skipped).toBe(2);
  });

  it("apply 模式补齐缺失集合", async () => {
    const database = new FakeDatabase({ collections: ["t_users"] });
    const report = await provisionDatabase(PLAN, { apply: true, log: noop }, database);

    expect(database.createdCollections()).toEqual(["t_matches"]);
    expect(report.collections.existing).toBe(1);
    expect(report.collections.created).toBe(1);
    expect(report.collections.failed).toEqual([]);
  });

  it("幂等：连续两次 apply，第二次不产生任何写操作", async () => {
    const database = new FakeDatabase();
    await provisionDatabase(PLAN, { apply: true, log: noop }, database);
    database.calls = [];

    const second = await provisionDatabase(PLAN, { apply: true, log: noop }, database);

    expect(database.createdCollections()).toEqual([]);
    expect(database.updateCalls()).toEqual([]);
    expect(second.collections.created).toBe(0);
    expect(second.indexes.created).toBe(0);
    expect(second.collections.existing).toBe(2);
    expect(second.indexes.existing).toBe(2);
  });

  it("建集合失败时不继续给该集合建索引", async () => {
    const database = new FakeDatabase();
    database.createCollection = async (name) => {
      database.calls.push(["createCollection", name]);
      throw new Error("quota exceeded");
    };
    const report = await provisionDatabase(PLAN, { apply: true, log: noop }, database);

    expect(report.collections.failed).toHaveLength(2);
    expect(report.indexes.skipped).toBe(2);
    expect(database.updateCalls()).toEqual([]);
  });
});

describe("provisionDatabase：索引", () => {
  it("apply 时每个集合只调用一次 updateCollection，且只带缺失的索引", async () => {
    const database = new FakeDatabase({
      collections: ["t_users", "t_matches"],
      indexes: {
        t_users: [{ name: "uk_openid", fields: [{ Name: "openid", Direction: "1" }], unique: true }],
      },
    });
    database.calls = [];

    const report = await provisionDatabase(PLAN, { apply: true, log: noop }, database);
    const updates = database.updateCalls();

    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toBe("t_matches");
    expect(updates[0][2].CreateIndexes).toEqual([{
      IndexName: "ix_kickoff",
      MgoKeySchema: {
        MgoIndexKeys: [{ Name: "league_id", Direction: "1" }, { Name: "kickoff_at", Direction: "1" }],
        MgoIsUnique: false,
      },
    }]);
    expect(updates[0][2].DropIndexes).toBeUndefined();
    expect(report.indexes.existing).toBe(1);
    expect(report.indexes.created).toBe(1);
    expect(report.indexes.failed).toEqual([]);
  });

  it("字段或唯一性与预期不一致时只报告，不擅自重建", async () => {
    const database = new FakeDatabase({
      collections: ["t_users", "t_matches"],
      indexes: {
        // 期望唯一索引，实际是普通索引
        t_users: [{ name: "uk_openid", fields: [{ Name: "openid", Direction: "1" }], unique: false }],
        t_matches: [{ name: "ix_kickoff", fields: [{ Name: "league_id", Direction: "1" }, { Name: "kickoff_at", Direction: "1" }], unique: false }],
      },
    });

    const report = await provisionDatabase(PLAN, { apply: true, log: noop }, database);

    expect(report.indexes.mismatched).toHaveLength(1);
    expect(report.indexes.mismatched[0].name).toBe("uk_openid");
    expect(database.updateCalls()).toEqual([]);
  });

  it("--fix-index-drift 时先删后建", async () => {
    const database = new FakeDatabase({
      collections: ["t_users", "t_matches"],
      indexes: {
        t_users: [{ name: "uk_openid", fields: [{ Name: "openid", Direction: "1" }], unique: false }],
        t_matches: [{ name: "ix_kickoff", fields: [{ Name: "league_id", Direction: "1" }, { Name: "kickoff_at", Direction: "1" }], unique: false }],
      },
    });

    const report = await provisionDatabase(PLAN, { apply: true, fixIndexDrift: true, log: noop }, database);
    const updates = database.updateCalls();

    expect(updates).toHaveLength(2);
    expect(updates[0][2]).toEqual({ DropIndexes: [{ IndexName: "uk_openid" }] });
    expect(updates[1][2].CreateIndexes[0].MgoKeySchema.MgoIsUnique).toBe(true);
    expect(report.indexes.recreated).toBe(1);
    expect(database.indexes.get("t_users")[0].unique).toBe(true);
  });

  it("同字段不同名的旧索引会被识别，并在 fixIndexDrift 下先删后建", async () => {
    const withDuplicate = () => new FakeDatabase({
      collections: ["t_users", "t_matches"],
      indexes: {
        // 控制台手工建的 _v2：键与 uk_openid 完全相同，规范名缺失
        t_users: [{ name: "uk_openid_v2", fields: [{ Name: "openid", Direction: "1" }], unique: true }],
        t_matches: [{ name: "ix_kickoff", fields: [{ Name: "league_id", Direction: "1" }, { Name: "kickoff_at", Direction: "1" }], unique: false }],
      },
    });

    const reporting = withDuplicate();
    const reportOnly = await provisionDatabase(PLAN, { apply: false, log: noop }, reporting);
    expect(reportOnly.indexes.conflicts).toEqual([
      { collection: "t_users", name: "uk_openid_v2", canonical: "uk_openid", resolved: false },
    ]);
    expect(reporting.updateCalls()).toEqual([]);

    const fixing = withDuplicate();
    const reportFix = await provisionDatabase(PLAN, { apply: true, fixIndexDrift: true, log: noop }, fixing);
    const updates = fixing.updateCalls();

    // 第一个集合：先删 _v2 再建 uk_openid；第二个集合：只有一次 CreateIndexes
    expect(updates[0][1]).toBe("t_users");
    expect(updates[0][2]).toEqual({ DropIndexes: [{ IndexName: "uk_openid_v2" }] });
    expect(updates[1][2].CreateIndexes[0].IndexName).toBe("uk_openid");
    expect(fixing.indexes.get("t_users").map((row) => row.name)).toEqual(["uk_openid"]);
    expect(reportFix.indexes.failed).toEqual([]);
  });

  it("无法解析的索引定义记为 unverified，而不是当作通过", async () => {
    const database = new FakeDatabase({ collections: ["t_users", "t_matches"] });
    database.describeCollection = async () => ({ RequestId: "req", Indexes: "unexpected-shape" });

    const report = await provisionDatabase(PLAN, { apply: true, log: noop }, database);

    expect(report.indexes.unverified).toBe(2);
    expect(report.indexes.created).toBe(0);
    expect(database.updateCalls()).toEqual([]);
  });
});

describe("normalizeRemoteIndexes", () => {
  it("认得 MgoKeySchema 形态", () => {
    const normalized = normalizeRemoteIndexes({
      Indexes: [{
        Name: "uk_openid",
        MgoKeySchema: { MgoIndexKeys: [{ Name: "openid", Direction: "1" }], MgoIsUnique: true },
      }],
    });
    expect(normalized).toEqual([{ name: "uk_openid", fields: [{ Name: "openid", Direction: "1" }], unique: true }]);
  });

  it("也认得 Keys / Unique 形态", () => {
    const normalized = normalizeRemoteIndexes({
      Indexes: [{ Name: "ix_a", Keys: [{ Name: "a", Direction: "-1" }], Unique: false }],
    });
    expect(normalized).toEqual([{ name: "ix_a", fields: [{ Name: "a", Direction: "-1" }], unique: false }]);
  });

  it("结构不是数组时返回 null", () => {
    expect(normalizeRemoteIndexes({})).toBeNull();
    expect(normalizeRemoteIndexes({ Indexes: null })).toBeNull();
  });
});

describe("sanitize", () => {
  it("遮住 key=value 形态的密钥", () => {
    expect(sanitize(new Error("secretId=AKIDxxxx secretKey=abcd"))).toBe("secretId=[redacted] secretKey=[redacted]");
  });

  it("不误伤中文正文里的 SecretId 字样", () => {
    const message = "当前凭据所属账号看不到环境 footballfree-x，请核对 SecretId 与 SecretKey 是否属于同一账号。";
    expect(sanitize(new Error(message))).toBe(message);
  });
});

describe("loadSchemaPlan：与 src/schema 同源", () => {
  it("命名空间前缀与别名都来自 cloudBaseCollectionName", async () => {
    const plan = await loadSchemaPlan("football_test");
    expect(plan.collections).toHaveLength(28);
    expect(plan.indexes).toHaveLength(47);
    expect(plan.indexes.filter((index) => index.unique)).toHaveLength(20);
    // 别名：逻辑名 provider_key_state → 集合名 provider_keys
    expect(plan.collections.map((item) => item.name)).toContain("football_test_provider_keys");
    expect(plan.collections.map((item) => item.name)).not.toContain("football_test_provider_key_state");
  });

  it("field:desc 映射为 CloudBase 的 -1 方向", async () => {
    const plan = await loadSchemaPlan("football_test");
    const submitted = plan.indexes.find((index) => index.name === "ix_predictions_user_submitted");
    expect(submitted.fields).toEqual([
      { Name: "user_id", Direction: "1" },
      { Name: "submitted_at", Direction: "-1" },
    ]);
  });
});
