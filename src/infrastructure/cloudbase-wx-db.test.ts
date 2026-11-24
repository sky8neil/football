import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { SyncJobType } from "../domain/enums.js";
import { CloudBaseDocumentNotFoundError } from "./cloudbase-db.js";
import { CloudBaseProviderLeagueStateStore } from "./cloudbase-provider-league-state.js";
import { CloudBaseWxDb, type CloudBaseSdkDatabase } from "./cloudbase-wx-db.js";

function compareField(left: unknown, right: unknown): number {
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function fakeDatabase(format: "nested" | "top-level" = "nested") {
  const docs = new Map<string, Record<string, unknown>>();
  const getSizes: number[] = [];
  const queries: Array<{
    collection: string;
    filter: Record<string, unknown>;
    skip: number;
    limit: number;
    order: { field: string; direction: "asc" | "desc" } | null;
    orders: Array<{ field: string; direction: "asc" | "desc" }>;
    projection: Record<string, boolean> | null;
  }> = [];
  let committed = 0;
  let rolledBack = 0;
  const updateResult = (updated: number) => format === "nested" ? { stats: { updated } } : { updated };
  const command = {
    inc(value: number) { return { __operation: "inc", value }; },
    lt(value: number) { return { __operation: "lt", value }; },
    lte(value: number | Date) { return { __operation: "lte", value }; },
    gte(value: number | Date) { return { __operation: "gte", value }; },
    in(values: readonly string[]) { return { __operation: "in", value: values }; },
    neq(value: unknown) { return { __operation: "neq", value }; },
    or(conditions: ReadonlyArray<Record<string, unknown>>) {
      return { __operation: "or", value: conditions };
    },
  };
  const makeDatabase = (transaction = false) => ({
    command,
    collection(name: string) {
      let filter: Record<string, unknown> = {};
      let offset = 0;
      let limit = 1000;
      const orders: Array<{ field: string; direction: "asc" | "desc" }> = [];
      let projection: Record<string, boolean> | null = null;
      const matchesCondition = (value: Record<string, unknown>, key: string, expected: unknown) => {
        if (typeof expected === "object" && expected !== null && "__operation" in expected) {
          const condition = expected as { __operation: string; value: number | Date | string | readonly string[] };
          if (condition.__operation === "lt") {
            return typeof value[key] === "string" && typeof condition.value === "string"
              ? value[key] < condition.value
              : Number(value[key]) < Number(condition.value);
          }
          if (condition.__operation === "lte") {
            const left = value[key] instanceof Date ? (value[key] as Date).getTime() : Number(value[key]);
            const right = condition.value instanceof Date ? condition.value.getTime() : Number(condition.value);
            return left <= right;
          }
          if (condition.__operation === "gte") {
            const left = value[key] instanceof Date ? (value[key] as Date).getTime() : Number(value[key]);
            const right = condition.value instanceof Date ? condition.value.getTime() : Number(condition.value);
            return left >= right;
          }
          if (condition.__operation === "in") {
            return (condition.value as readonly string[]).includes(String(value[key] ?? ""));
          }
          if (condition.__operation === "neq") {
            return value[key] !== condition.value;
          }
          return false;
        }
        if (value[key] instanceof Date && expected instanceof Date) {
          return (value[key] as Date).getTime() === expected.getTime();
        }
        return value[key] === expected;
      };
      const matchesFilter = (value: Record<string, unknown>, active: Record<string, unknown>): boolean => {
        if (typeof active === "object" && active !== null && "__operation" in active) {
          const operation = active as { __operation: string; value: ReadonlyArray<Record<string, unknown>> };
          if (operation.__operation === "or") {
            return operation.value.some((condition) => matchesFilter(value, condition));
          }
          return false;
        }
        return Object.entries(active).every(([key, expected]) => matchesCondition(value, key, expected));
      };
      const matches = (value: Record<string, unknown>) => matchesFilter(value, filter);
      const rows = () => [...docs.entries()].filter(([key]) => key.startsWith(`${name}/`))
        .map(([, value]) => value).filter(matches);
      const chain = {
        where(value: Record<string, unknown>) { filter = value; return chain; },
        orderBy(field: string, direction: "asc" | "desc") { orders.push({ field, direction }); return chain; },
        skip(value: number) { offset = value; return chain; },
        limit(value: number) { limit = value; return chain; },
        field(value: Record<string, boolean>) { projection = value; return chain; },
        async get() {
          const values = rows();
          if (orders.length > 0) {
            values.sort((a, b) => {
              for (const spec of orders) {
                const cmp = compareField(a[spec.field], b[spec.field]);
                if (cmp !== 0) return cmp * (spec.direction === "desc" ? -1 : 1);
              }
              return 0;
            });
          }
          const page = values.slice(offset, offset + limit).map((row) => {
            if (projection === null) return row;
            const projected: Record<string, unknown> = { _id: row._id };
            for (const [field, included] of Object.entries(projection)) {
              if (included) projected[field] = row[field];
            }
            return projected;
          });
          getSizes.push(page.length);
          const order = orders.length > 0 ? orders[orders.length - 1]! : null;
          queries.push({ collection: name, filter, skip: offset, limit, order, orders: [...orders], projection });
          return { data: page };
        },
        async count() { return { total: rows().length }; },
        doc(id: string) {
          return {
            async get() {
              const value = docs.get(`${name}/${id}`);
              if (!value) throw Object.assign(new Error("document not exist"), { errCode: -502005 });
              return { data: value };
            },
            async create({ data }: { data: Record<string, unknown> }) {
              const key = `${name}/${id}`;
              if (docs.has(key)) throw Object.assign(new Error("duplicate key"), { errCode: "DATABASE_DUPLICATE_KEY" });
              docs.set(key, { ...data, _id: id });
            },
            async update({ data }: { data: Record<string, unknown> }) {
              const key = `${name}/${id}`;
              const existing = docs.get(key);
              if (!existing) return updateResult(0);
              const next = { ...existing, ...data, _id: id };
              const updated = isDeepStrictEqual(existing, next) ? 0 : 1;
              docs.set(key, next);
              return updateResult(updated);
            },
            async remove() { docs.delete(`${name}/${id}`); return { stats: { removed: 1 } }; },
          };
        },
        async add({ data }: { data: Record<string, unknown> }) {
          const id = String(data._id);
          const key = `${name}/${id}`;
          if (docs.has(key)) throw Object.assign(new Error("duplicate key"), { errCode: "DATABASE_DUPLICATE_KEY" });
          docs.set(key, { ...data, _id: id });
          return { _id: id };
        },
        async update({ data }: { data: Record<string, unknown> }) {
          const matched = [...docs.entries()].filter(([key, value]) => key.startsWith(`${name}/`) && matches(value));
          for (const [key, value] of matched) {
            const updated = { ...value };
            for (const [field, operation] of Object.entries(data)) {
              if (typeof operation === "object" && operation !== null && "__operation" in operation) {
                const command = operation as { __operation: string; value: number };
                if (command.__operation === "inc") {
                  updated[field] = (typeof updated[field] === "number" ? updated[field] as number : 0) + command.value;
                  continue;
                }
              }
              updated[field] = operation;
            }
            docs.set(key, updated);
          }
          return updateResult(matched.length);
        },
      };
      return chain;
    },
    async startTransaction() {
      return {
        ...makeDatabase(true),
        async commit() { committed += 1; },
        async rollback() { rolledBack += 1; },
      };
    },
  });
  return { db: makeDatabase() as unknown as CloudBaseSdkDatabase, docs, getSizes, queries, committed: () => committed, rolledBack: () => rolledBack };
}

describe("CloudBase wx-server-sdk database adapter", () => {
  it.each(["nested", "top-level"] as const)("accepts same-value updates and rejects missing documents with %s statistics", async (format) => {
    const fake = fakeDatabase(format);
    const db = new CloudBaseWxDb(fake.db, "football_test");
    const collection = "football_test_users";
    const document = { _id: "user-1", nickname: "A" };
    await db.add(collection, document._id, document);

    await expect(db.update(collection, document._id, { ...document, nickname: "B" })).resolves.toBeUndefined();
    await expect(db.update(collection, document._id, { ...document, nickname: "B" })).resolves.toBeUndefined();
    await expect(db.get(collection, document._id)).resolves.toMatchObject({ nickname: "B" });
    await expect(db.update(collection, "missing", { _id: "missing" })).rejects.toBeInstanceOf(CloudBaseDocumentNotFoundError);
  });

  it.each(["nested", "top-level"] as const)("records league success twice at the same task time with %s statistics", async (format) => {
    const fake = fakeDatabase(format);
    const db = new CloudBaseWxDb(fake.db, "football_test");
    const store = new CloudBaseProviderLeagueStateStore(db, "football_test");
    const now = new Date("2026-10-13T08:15:58.153Z");

    await store.markSuccess("fd", "premier_league", SyncJobType.FutureSchedule, now);
    await expect(store.markSuccess("fd", "premier_league", SyncJobType.FutureSchedule, new Date(now))).resolves.toBeUndefined();
    await expect(store.get("fd", "premier_league", SyncJobType.FutureSchedule)).resolves.toMatchObject({ last_success_at: now });
    expect(fake.docs.size).toBe(1);
  });

  it("uses deterministic document ids and maps duplicate and missing records", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test");
    await db.add("football_test_users", "user-1", { _id: "user-1", nickname: "A" });
    await expect(db.get("football_test_users", "user-1")).resolves.toMatchObject({ nickname: "A" });
    await expect(db.add("football_test_users", "user-1", { _id: "user-1" })).rejects.toMatchObject({ name: "CloudBaseDuplicateKeyError" });
    await expect(db.get("football_test_users", "missing")).resolves.toBeNull();
    await expect(db.update("football_test_users", "missing", { _id: "missing" })).rejects.toBeInstanceOf(CloudBaseDocumentNotFoundError);
  });

  it("queries in pages of at most 100, supports offset and count", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test");
    for (let index = 0; index < 230; index += 1) {
      await db.add("football_test_matches", String(index).padStart(3, "0"), { _id: String(index).padStart(3, "0"), league_id: index % 2 ? "a" : "b" });
    }
    const page = await db.query("football_test_matches", { league_id: "a" }, { offset: 3, limit: 107 });
    expect(page).toHaveLength(107);
    expect(fake.getSizes.every((size) => size <= 100)).toBe(true);
    await expect(db.count("football_test_matches", { league_id: "a" })).resolves.toBe(115);
  });

  it("commits successful transactions and rolls back failed work", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test");
    await expect(db.transaction(async (tx) => tx.add("football_test_users", "u1", { _id: "u1" }))).resolves.toBeUndefined();
    expect(fake.committed()).toBe(1);
    await expect(db.transaction(async () => { throw new Error("transaction failed"); })).rejects.toThrow("transaction failed");
    expect(fake.rolledBack()).toBe(1);
  });

  it.each(["nested", "top-level"] as const)("reserves a counter using %s statistics and rejects exhausted capacity", async (format) => {
    const fake = fakeDatabase(format);
    const db = new CloudBaseWxDb(fake.db, "football_test", false, fake.db.command);
    const initial = { _id: "provider_usage_fd_minute_202610130743", request_count: 0 };

    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(true);
    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(true);
    await expect(db.reserveCounter("football_test_provider_usage", initial._id, "request_count", 2, initial)).resolves.toBe(false);
    expect(fake.docs.get(`football_test_provider_usage/${initial._id}`)).toMatchObject({ request_count: 2 });
  });

  it("lteFilter 在 command.lte 可用时返回范围条件，缺省时退化为 undefined", () => {
    const fake = fakeDatabase();
    const withCommand = new CloudBaseWxDb(fake.db, "football_test", false, fake.db.command);
    const bound = new Date("2026-08-09T12:00:00.000Z");
    expect(withCommand.lteFilter("kickoff_at", bound)).toEqual({
      kickoff_at: { __operation: "lte", value: bound },
    });
    expect(withCommand.gteFilter("kickoff_at", bound)).toEqual({
      kickoff_at: { __operation: "gte", value: bound },
    });
    const withoutCommand = new CloudBaseWxDb(fake.db, "football_test");
    expect(withoutCommand.lteFilter("kickoff_at", bound)).toBeUndefined();
    expect(withoutCommand.gteFilter("kickoff_at", bound)).toBeUndefined();
  });
});

describe("CloudBaseWxDb.findPredictionHistoryPage", () => {
  const predictions = "football_test_predictions";
  const matches = "football_test_matches";

  function historyDb() {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test", false, fake.db.command);
    return { fake, db };
  }

  function predictionQueriesOf(fake: ReturnType<typeof fakeDatabase>) {
    return fake.queries.filter((query) => query.collection === predictions);
  }

  it("下推 user_id 等值、submitted_at 倒序和有界 limit，不发无 user_id 且无 limit 的全集合查询", async () => {
    const { fake, db } = historyDb();
    const newer = new Date("2026-08-09T12:00:00.000Z");
    const cursorAt = new Date("2026-08-09T11:00:00.000Z");
    const older = new Date("2026-08-09T10:00:00.000Z");
    await db.add(matches, "m1", { _id: "m1", match_id: "m1", league_id: "premier", season_id: "2026" });
    await db.add(predictions, "p0", { _id: "p0", prediction_id: "p0", user_id: "u1", match_id: "m1", submitted_at: newer });
    await db.add(predictions, "p1", { _id: "p1", prediction_id: "p1", user_id: "u1", match_id: "m1", submitted_at: cursorAt });
    await db.add(predictions, "p2", { _id: "p2", prediction_id: "p2", user_id: "u1", match_id: "m1", submitted_at: older });
    await db.add(predictions, "other", { _id: "other", prediction_id: "other", user_id: "u2", match_id: "m1", submitted_at: older });

    const result = await db.findPredictionHistoryPage({
      predictions_collection: predictions,
      matches_collection: matches,
      user_id: "u1",
      league_id: "premier",
      season_id: "2026",
      cursor: { submitted_at: cursorAt, prediction_id: "p1" },
      limit: 10,
    });

    expect(result.documents.map((row) => row._id)).toEqual(["p2"]);
    expect(result.exhausted).toBe(true);
    expect(result.resumeCursor).toBeNull();
    const predictionQueries = predictionQueriesOf(fake);
    expect(predictionQueries.length).toBeGreaterThan(0);
    for (const query of predictionQueries) {
      expect(Number.isFinite(query.limit)).toBe(true);
      expect(query.limit).toBeGreaterThan(0);
      expect(query.limit).toBeLessThanOrEqual(100);
      expect(query.orders).toEqual([
        { field: "submitted_at", direction: "desc" },
        { field: "prediction_id", direction: "desc" },
      ]);
    }
    expect(predictionQueries[0]?.filter).toEqual({
      __operation: "or",
      value: [
        { user_id: "u1", submitted_at: { __operation: "lt", value: cursorAt } },
        { user_id: "u1", submitted_at: cursorAt, prediction_id: { __operation: "lt", value: "p1" } },
      ],
    });
    expect(fake.queries.some((query) => query.filter.user_id === undefined && !(Number.isFinite(query.limit) && query.limit < 1000))).toBe(false);
  });

  it("前一批比赛都不满足联赛/赛季时继续取下一批，直到凑满 limit", async () => {
    const { fake, db } = historyDb();
    await db.add(matches, "m_other", { _id: "m_other", match_id: "m_other", league_id: "other", season_id: "2026" });
    await db.add(matches, "m_ok", { _id: "m_ok", match_id: "m_ok", league_id: "premier", season_id: "2026" });
    const origin = Date.parse("2026-08-01T00:00:00.000Z");
    const failing = 100;
    const passing = 5;
    const total = failing + passing;
    for (let index = 0; index < total; index += 1) {
      const id = `p${String(index).padStart(3, "0")}`;
      await db.add(predictions, id, {
        _id: id,
        prediction_id: id,
        user_id: "u1",
        match_id: index < failing ? "m_other" : "m_ok",
        submitted_at: new Date(origin + (total - index) * 1000),
      });
    }

    const result = await db.findPredictionHistoryPage({
      predictions_collection: predictions,
      matches_collection: matches,
      user_id: "u1",
      league_id: "premier",
      season_id: "2026",
      cursor: null,
      limit: 3,
    });

    expect(result.documents.map((row) => row._id)).toEqual(["p100", "p101", "p102"]);
    expect(predictionQueriesOf(fake).length).toBeGreaterThan(1);
  });

  it("数据取尽时返回，预测查询次数有上界", async () => {
    const { fake, db } = historyDb();
    await db.add(matches, "m_other", { _id: "m_other", match_id: "m_other", league_id: "other", season_id: "2026" });
    const origin = Date.parse("2026-08-01T00:00:00.000Z");
    for (let index = 0; index < 10; index += 1) {
      const id = `p${index}`;
      await db.add(predictions, id, {
        _id: id,
        prediction_id: id,
        user_id: "u1",
        match_id: "m_other",
        submitted_at: new Date(origin + (10 - index) * 1000),
      });
    }

    const result = await db.findPredictionHistoryPage({
      predictions_collection: predictions,
      matches_collection: matches,
      user_id: "u1",
      league_id: "premier",
      season_id: "2026",
      cursor: null,
      limit: 5,
    });

    expect(result).toEqual({ documents: [], exhausted: true, resumeCursor: null });
    expect(predictionQueriesOf(fake).length).toBeGreaterThan(0);
    expect(predictionQueriesOf(fake).length).toBeLessThanOrEqual(10);
  });

  it("过滤后仍不足一页时查询批次数不超过上限", async () => {
    const { fake, db } = historyDb();
    fake.docs.set(`${matches}/m_other`, { _id: "m_other", match_id: "m_other", league_id: "other", season_id: "2026" });
    const origin = Date.parse("2026-08-01T00:00:00.000Z");
    const total = 6401;
    for (let index = 0; index < total; index += 1) {
      const id = `p${index}`;
      fake.docs.set(`${predictions}/${id}`, {
        _id: id,
        prediction_id: id,
        user_id: "u1",
        match_id: "m_other",
        submitted_at: new Date(origin + (total - index) * 1000),
      });
    }

    const result = await db.findPredictionHistoryPage({
      predictions_collection: predictions,
      matches_collection: matches,
      user_id: "u1",
      league_id: "premier",
      season_id: "2026",
      cursor: null,
      limit: 1,
    });

    expect(result.documents).toEqual([]);
    expect(result.exhausted).toBe(false);
    expect(result.resumeCursor).not.toBeNull();
    const predictionQueries = predictionQueriesOf(fake);
    expect(predictionQueries.length).toBeGreaterThan(1);
    expect(predictionQueries.length).toBeLessThanOrEqual(64);
  });

  it("[Slice 3.4] 250 条同 submitted_at 跨 100 行批边界时，lteFilter 与无 lteFilter 均不重不漏不死循环", async () => {
    const sameTs = new Date("2026-08-09T12:00:00.000Z");

    const runScenario = async (withCommand: boolean) => {
      const fake = fakeDatabase();
      const db = new CloudBaseWxDb(
        fake.db as unknown as CloudBaseSdkDatabase,
        "football_test",
        false,
        withCommand ? fake.db.command : undefined,
      );
      fake.docs.set(`${matches}/m_other`, { _id: "m_other", match_id: "m_other", league_id: "other", season_id: "2026" });
      fake.docs.set(`${matches}/m_ok`, { _id: "m_ok", match_id: "m_ok", league_id: "premier", season_id: "2026" });

      // 250 条相同 submitted_at（p000..p249，倒序 p249 最前 -> p000 最后）：
      // 前 220 条（p249..p030）是其他联赛（需跨过 2 个完整 100 行批），最后 30 条（p029..p000）命中目标联赛。
      for (let i = 0; i < 250; i += 1) {
        const id = `p${String(i).padStart(3, "0")}`;
        fake.docs.set(`${predictions}/${id}`, {
          _id: id,
          prediction_id: id,
          user_id: "u1",
          match_id: i < 30 ? "m_ok" : "m_other",
          submitted_at: sameTs,
        });
      }

      const collected: string[] = [];
      let cursor: { submitted_at: Date; prediction_id: string } | null = null;
      for (let pageNo = 0; pageNo < 10; pageNo += 1) {
        const result = await db.findPredictionHistoryPage({
          predictions_collection: predictions,
          matches_collection: matches,
          user_id: "u1",
          league_id: "premier",
          season_id: "2026",
          cursor,
          limit: 12,
        });
        const page = result.documents;
        if (page.length === 0 && result.exhausted) break;
        collected.push(...page.map((doc) => String(doc.prediction_id)));
        const last = page.at(-1);
        cursor = result.resumeCursor ?? (last === undefined ? null : {
          submitted_at: last.submitted_at as Date,
          prediction_id: String(last.prediction_id),
        });
        if (result.exhausted) break;
      }

      const expected = Array.from({ length: 30 }, (_, idx) => `p${String(29 - idx).padStart(3, "0")}`);
      expect(collected).toEqual(expected);
      expect(new Set(collected).size).toBe(30);
    };

    await runScenario(true);
    await runScenario(false);
  });

  it("[Slice 3.4] historyMaxBatches=1 下 250 条同 submitted_at 通过下推双键游标持续推进且不重不漏", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(
      fake.db as unknown as CloudBaseSdkDatabase,
      "football_test",
      false,
      fake.db.command,
      { historyMaxBatches: 1 },
    );
    const sameTs = new Date("2026-08-09T12:00:00.000Z");
    fake.docs.set(`${matches}/m_other`, { _id: "m_other", match_id: "m_other", league_id: "other", season_id: "2026" });
    fake.docs.set(`${matches}/m_ok`, { _id: "m_ok", match_id: "m_ok", league_id: "premier", season_id: "2026" });
    for (let i = 0; i < 250; i += 1) {
      const id = `p${String(i).padStart(3, "0")}`;
      fake.docs.set(`${predictions}/${id}`, {
        _id: id,
        prediction_id: id,
        user_id: "u1",
        match_id: i < 30 ? "m_ok" : "m_other",
        submitted_at: sameTs,
      });
    }

    const collected: string[] = [];
    let cursor: { submitted_at: Date; prediction_id: string } | null = null;
    const cursors: string[] = [];
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const result = await db.findPredictionHistoryPage({
        predictions_collection: predictions,
        matches_collection: matches,
        user_id: "u1",
        league_id: "premier",
        season_id: "2026",
        cursor,
        limit: 12,
      });
      collected.push(...result.documents.map((doc) => String(doc.prediction_id)));
      if (result.exhausted) break;
      const last = result.documents.at(-1);
      const next = result.resumeCursor ?? (last === undefined ? null : {
        submitted_at: last.submitted_at as Date,
        prediction_id: String(last.prediction_id),
      });
      expect(next).not.toBeNull();
      cursors.push(next!.prediction_id);
      if (cursor !== null) {
        expect(
          next!.submitted_at.getTime() < cursor.submitted_at.getTime()
          || (next!.submitted_at.getTime() === cursor.submitted_at.getTime()
            && next!.prediction_id < cursor.prediction_id),
        ).toBe(true);
      }
      cursor = next!;
    }

    const expected = Array.from({ length: 30 }, (_, idx) => `p${String(29 - idx).padStart(3, "0")}`);
    expect(collected).toEqual(expected);
    expect(cursors.length).toBeGreaterThan(1);
    const pushedBoundaries = predictionQueriesOf(fake).filter((query) => "__operation" in query.filter);
    expect(pushedBoundaries.length).toBeGreaterThan(0);
    for (const query of pushedBoundaries) {
      const conditions = (query.filter as unknown as {
        value: Array<Record<string, unknown>>;
      }).value;
      expect(conditions[0]).toMatchObject({
        user_id: "u1",
        submitted_at: { __operation: "lt" },
      });
      expect(conditions[1]).toMatchObject({
        user_id: "u1",
        prediction_id: { __operation: "lt" },
      });
    }
  });

  it("[Slice 3.4] 触及 historyMaxBatches 或 distinctMaxRows 上限时支持配置并记录告警日志", async () => {
    const fake = fakeDatabase();
    const log = vi.fn();
    const db = new CloudBaseWxDb(
      fake.db as unknown as CloudBaseSdkDatabase,
      "football_test",
      false,
      fake.db.command,
      { historyMaxBatches: 2, distinctMaxRows: 100, log },
    );
    fake.docs.set(`${matches}/m_other`, { _id: "m_other", match_id: "m_other", league_id: "other", season_id: "2026" });
    const origin = Date.parse("2026-08-01T00:00:00.000Z");
    for (let i = 0; i < 250; i += 1) {
      const id = `p${String(i).padStart(3, "0")}`;
      fake.docs.set(`${predictions}/${id}`, {
        _id: id,
        prediction_id: id,
        user_id: "u1",
        match_id: "m_other",
        submitted_at: new Date(origin + i * 1000),
      });
    }

    const hist = await db.findPredictionHistoryPage({
      predictions_collection: predictions,
      matches_collection: matches,
      user_id: "u1",
      league_id: "premier",
      season_id: "2026",
      cursor: null,
      limit: 5,
    });
    expect(hist.documents).toEqual([]);
    expect(hist.exhausted).toBe(false);
    expect(hist.resumeCursor).not.toBeNull();
    expect(predictionQueriesOf(fake)).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "cloudbase_history_scan_cap_reached",
      history_max_batches: 2,
    }));

    for (let i = 0; i < 150; i += 1) {
      fake.docs.set(`${matches}/m-${i}`, { _id: `m-${i}`, league_id: `L-${i}`, season_id: "2026" });
    }
    await db.distinctQuery(matches, ["league_id"]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "cloudbase_distinct_scan_cap_reached",
      distinct_max_rows: 100,
    }));
  });
});

describe("CloudBaseWxDb.distinctQuery", () => {
  it("对重复维度组合只返回一条，并通过 field 投影避免读整份文档", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test");
    const documents = [
      { _id: "m1", league_id: "L1", season_id: "S1", payload: "full-document-a" },
      { _id: "m2", league_id: "L1", season_id: "S1", payload: "full-document-b" },
      { _id: "m3", league_id: "L1", season_id: "S2", payload: "full-document-c" },
      { _id: "m4", league_id: "L2", season_id: "S1", payload: "full-document-d" },
    ];
    for (const document of documents) {
      await db.add("football_test_matches", document._id, document);
    }

    const rows = await db.distinctQuery("football_test_matches", ["league_id", "season_id"], { league_id: "L1" });

    expect(rows).toEqual([
      { league_id: "L1", season_id: "S1" },
      { league_id: "L1", season_id: "S2" },
    ]);
    expect(rows.every((row) => row.payload === undefined)).toBe(true);
    expect(fake.queries.length).toBeGreaterThan(0);
    for (const query of fake.queries) {
      expect(query.projection).toEqual({ league_id: true, season_id: true });
      expect(query.limit).toBeGreaterThan(0);
      expect(query.limit).toBeLessThanOrEqual(100);
      expect(query.orders).toContainEqual({ field: "_id", direction: "asc" });
    }
  });
});

describe("CloudBaseWxDb.patch", () => {
  it("通过 doc.update 仅局部写入传入字段，缺失文档抛 CloudBaseDocumentNotFoundError", async () => {
    const fake = fakeDatabase();
    const db = new CloudBaseWxDb(fake.db, "football_test");
    const id = "week|2026-W32|u1";
    await db.add("football_test_rankings", id, {
      _id: id,
      schema_version: 1,
      period_type: "week",
      period_key: "2026-W32",
      user_id: "u1",
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 2,
      exact_hits: 1,
      global_rank: null,
      updated_at: new Date(0),
    });
    const updatedAt = new Date("2026-08-09T01:00:00.000Z");

    await db.patch!("football_test_rankings", id, {
      global_rank: 2,
      updated_at: updatedAt,
    });

    expect(fake.docs.get(`football_test_rankings/${id}`)).toMatchObject({
      period_score: 12,
      valid_predictions: 3,
      wdl_hits: 2,
      exact_hits: 1,
      global_rank: 2,
      updated_at: updatedAt,
    });
    await expect(
      db.patch!("football_test_rankings", "missing", { global_rank: 1 }),
    ).rejects.toBeInstanceOf(CloudBaseDocumentNotFoundError);
  });
});
